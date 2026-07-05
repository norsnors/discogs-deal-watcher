'use strict';
/*
 * watch-once.js — ONE sweep of a rotating slice of the wantlist, then exit.
 *
 * This is the "GitHub Actions every few minutes" model (vs watcher.js, the always-on loop):
 * each scheduled run checks `sliceSize` releases starting where the last run left off
 * (cursor persisted in state/cursor.json), advancing the cursor so successive runs cover the
 * whole wantlist over time. State (history, alert memory, suggestions, cursor) lives in state/
 * and is carried between runs via the Actions cache. Detected deals are emailed (Resend) and
 * written to deals.json (committed by the workflow so the desktop dashboard can read it).
 *
 * Env (set as GitHub Secrets): DISCOGS_TOKEN, DISCOGS_USERNAME, RESEND_API_KEY, MAIL_TO,
 * MAIL_FROM, SLICE_SIZE. Run: `node watch-once.js`.
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { makeClient } = require('./discogs');
const { makeStore } = require('./store');
const { makeMailer } = require('./mailer');
const { processRelease, loadConfig, zeroWatch } = require('./watcher');

const STATE_DIR = path.join(__dirname, 'state');
const cursorFile = () => path.join(STATE_DIR, 'cursor.json');
const readCursor = () => { try { return JSON.parse(fs.readFileSync(cursorFile(), 'utf8')); } catch { return { wantlistAt: 0, wantlist: [] }; } };
const writeCursor = (c) => fs.writeFileSync(cursorFile(), JSON.stringify(c));

async function main() {
  const config = loadConfig();
  if (!config.username) { console.error('Missing DISCOGS_USERNAME / config.username.'); process.exit(1); }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const store = makeStore(STATE_DIR);

  // Seed REAL sales-history medians committed from local scans. They live at the repo root (the
  // state/ dir is gitignored, so it can't carry them to GitHub) and are NOT in the Actions cache, so
  // checkout always brings the freshest committed copy. With them, emailed deals are judged against
  // true market value instead of Discogs's often-inflated VG+ suggestion; without them, nothing
  // changes (processRelease falls back to the suggestion). Read-only here — the cloud never scrapes them.
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(__dirname, 'soldmedians.json'), 'utf8'));
    const n = sm && typeof sm === 'object' ? Object.keys(sm).length : 0;
    if (n) { store.primeSoldMedians(sm); console.log(`Loaded ${n} committed sold-medians (real-market references).`); }
  } catch { /* none committed yet -> suggestion fallback (unchanged behaviour) */ }

  // Restore warm-up counts + alert dedupe from the committed seed for any release the Actions cache
  // lost (eviction after 7d unused / under the 10 GB cap). Without this, a wiped cache resets every
  // release to "cold" (~4 sweeps of no alerts) AND wipes dedupe (a one-time re-flood). The cache,
  // when present, is always the fresher copy — primeSeed only fills releases it doesn't already have.
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-seed.json'), 'utf8'));
    const restored = store.primeSeed(seed);
    if (restored) console.log(`Cache miss recovery: re-seeded warm-up/dedupe for ${restored} release(s) from state-seed.json.`);
  } catch { /* no seed committed yet, or cache already warm -> nothing to recover */ }

  const client = makeClient({ token: config.token, userAgent: config.userAgent });
  const mailer = makeMailer(config.email);
  const sliceSize = config.sliceSize || 50;

  // Deliverability guard: the Resend SANDBOX sender (onboarding@resend.dev) is testing-only — Resend
  // flags it as spam-prone and only delivers to your own verified address. For a tool whose whole
  // value is "an email arrives", a spam-foldered mail = silent total failure. Warn loudly here; the
  // real fix is verifying a sending domain in Resend (see README "Email deliverability").
  if (mailer.enabled && mailer.provider === 'resend' && /onboarding@resend\.dev/i.test(config.email.from || '')) {
    console.warn('⚠ Using the Resend SANDBOX sender (onboarding@resend.dev) — high spam risk. Verify a domain in Resend and set MAIL_FROM. See README.');
  }

  // Refresh the wantlist at most every wantlistRefreshMs (it changes rarely).
  const cur = readCursor();
  if (!cur.wantlist || !cur.wantlist.length || Date.now() - (cur.wantlistAt || 0) > config.wantlistRefreshMs) {
    cur.wantlist = await client.getWantlist(config.username);
    cur.wantlistAt = Date.now();
    console.log(`Refreshed wantlist: ${cur.wantlist.length} releases.`);
  }
  const N = cur.wantlist.length;
  if (!N) { console.log('Empty wantlist — nothing to do.'); writeCursor(cur); publishDeals(store, cur.wantlist); return; }

  const now = Date.now();
  const take = Math.min(sliceSize, N);
  // Priority sweep: rank every release by how urgently it deserves a re-check (staleness +
  // recent activity + rarity) and take the top `take`. This spends each run's API budget on the
  // releases most likely to surface a JUST-LISTED bargain, while staleness still guarantees full
  // coverage over time. (Replaces the old blind round-robin cursor.)
  const ranked = cur.wantlist
    .map((rel) => ({ rel, score: engine.releaseWatchScore(store.getHistory(rel.releaseId), now, { recentMs: config.minRecheckMs || 0 }) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  const slice = (ranked.length ? ranked.map((x) => x.rel) : cur.wantlist).slice(0, take);
  writeCursor(cur); // persist the wantlist cache (selection no longer needs a cursor index)
  console.log(`Sweeping the ${slice.length} highest-priority of ${N} (mode=${config.mode}, email=${mailer.enabled ? mailer.provider : 'off'}).`);

  const deals = [];
  const gems = []; // 💎 rare appearances (0 for sale -> first copy) — emailed regardless of price
  let checked = 0;
  for (const rel of slice) {
    try {
      const { deal, gem } = await processRelease(rel, { client, store, engine, config });
      if (deal) deals.push(deal);
      if (gem) gems.push(gem);
      checked++;
    } catch (e) { console.log(`  release ${rel.releaseId} error: ${e.message}`); }
  }

  const sweepsToCover = Math.ceil(N / take);
  console.log(`Checked ${checked}. Deals this run: ${deals.length}. Rare gems: ${gems.length}. (Full wantlist covered every ~${sweepsToCover} runs.)`);

  // Lead with the strongest diamond: the email subject + first card come from deals[0], so order
  // best-first (just-listed + real-sold-price + biggest discount rank highest).
  deals.sort((a, b) => engine.dealValueScore(b) - engine.dealValueScore(a));

  let emailError = null;
  // 💎 Gems first — the rare-appearance email is the most time-critical alert there is (a truly
  // rare copy can sell within the hour), and it's sent SEPARATELY from the deals email so the
  // subject line screams the event even when this sweep also found ordinary price deals.
  if (gems.length) {
    for (const g of gems) console.log(`  GEM 💎 ${g.artist} – ${g.title}  first copy for sale at ${g.currency} ${g.lowest} (was 0 for sale)`);
    if (mailer.enabled) {
      try { await mailer.sendGems(gems); console.log(`Emailed ${gems.length} rare gem(s) to ${config.email.to}.`); }
      catch (e) { emailError = e; console.log('Gem email FAILED:', e.message); }
    } else {
      console.log('Email disabled — gems saved for the dashboard.');
    }
  }
  if (deals.length) {
    for (const d of deals) console.log(`  DEAL${d.freshListing ? ' 🆕just-listed' : ''} ${d.artist} – ${d.title}  ${d.currency} ${d.lowest} (${Math.round(d.discount * 100)}% off${d.suspicious ? ', ⚠maybe<VG+' : ''})`);
    if (mailer.enabled) {
      try { await mailer.sendDeals(deals); console.log(`Emailed ${deals.length} deal(s) to ${config.email.to}.`); }
      catch (e) { emailError = e; console.log('Email FAILED:', e.message); }
    } else {
      console.log('Email disabled — deals saved for the dashboard.');
    }
  }

  publishDeals(store, cur.wantlist);

  // Turn a silent email failure into a LOUD one: exit non-zero so the GitHub Actions step fails and
  // GitHub's built-in "your workflow failed" notification reaches you. For a tool whose core output IS
  // the email, a swallowed send error means you simply stop getting deals and never find out. The
  // deals are already saved to deals.json above, so the dashboard still updates regardless.
  if (emailError) { console.error('Exiting non-zero because the deal email failed to send.'); process.exit(1); }
}

// Write deals.json + gems.json (for the dashboard) + state-seed.json (durable warm-up/dedupe backup)
// at the repo root; the workflow commits all three. The seed is a tiny digest that's stable
// run-to-run once releases warm up, so it adds almost no git churn — but it lets a future run rebuild
// warm-up + dedupe if the Actions cache is ever evicted (the cache is the only other place that state
// lives). gems.json also carries the zero-stock WATCH list (wantlist releases with 0 copies for sale)
// so the dashboard's 💎 tab can show what's being waited on, not just what already appeared.
function publishDeals(store, wantlist) {
  fs.writeFileSync(path.join(__dirname, 'deals.json'), JSON.stringify(store.getDeals(200)));
  try {
    fs.writeFileSync(path.join(__dirname, 'gems.json'), JSON.stringify({ ts: Date.now(), gems: store.getGems(100), zeroWatch: zeroWatch(store, wantlist) }));
  } catch (e) { console.log('Could not write gems.json:', e.message); }
  try { fs.writeFileSync(path.join(__dirname, 'state-seed.json'), JSON.stringify(store.exportSeed())); }
  catch (e) { console.log('Could not write state-seed.json:', e.message); }
}

main().catch((e) => { console.error('watch-once FAILED:', e.stack || e); process.exit(1); });
