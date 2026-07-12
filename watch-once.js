'use strict';
/*
 * watch-once.js — sweep the wantlist (once, or repeatedly within a time budget), then exit.
 *
 * This is the "GitHub Actions" model (vs watcher.js, the always-on loop). GitHub deprioritizes
 * public-repo schedule crons hard: a `*\/15` cron fires every ~60–90 min in practice (measured),
 * with night gaps up to ~4 h — so a single sweep per tick means hours of detection latency for a
 * just-listed copy. RUN_BUDGET_MINUTES counters that: with it set, one job keeps sweeping
 * BACK-TO-BACK (emailing after every sweep) until the budget is spent, so the sparse ticks still
 * yield near-continuous ~14-min coverage. Unset/0 = the original single sweep (local use).
 *
 * State (history, alert memory, suggestions, cursor) lives in state/ and is carried between runs
 * via the Actions cache. Detected deals are emailed (Resend) and written to deals.json (committed
 * by the workflow so the desktop dashboard can read it). 💎 rare gems are emailed the MOMENT they
 * are found, not after the sweep — they're the most time-critical alert there is.
 *
 * Env (set as GitHub Secrets): DISCOGS_TOKEN, DISCOGS_USERNAME, RESEND_API_KEY, MAIL_TO,
 * MAIL_FROM, SLICE_SIZE, RUN_BUDGET_MINUTES. Run: `node watch-once.js`.
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { makeClient } = require('./discogs');
const { makeStore } = require('./store');
const { makeMailer } = require('./mailer');
const { makeTelegram } = require('./telegram');
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

  // Same recovery for the 💎 gem feed: if the Actions cache was evicted, state/gems.json is empty
  // and this run would otherwise commit an EMPTY gems.json — erasing the dashboard's rare-gem
  // history. The committed copy restores it (only into an empty store; the cache stays fresher).
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'gems.json'), 'utf8'));
    if (g && Array.isArray(g.gems)) store.primeGems(g.gems);
  } catch { /* not committed yet */ }

  // Same recovery for the 💸 deal feed: without it a cache eviction would publish an EMPTY
  // deals.json, erasing every previously-emailed deal from the dashboard in one sweep.
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'deals.json'), 'utf8'));
    store.primeDeals(d);
  } catch { /* not committed yet */ }

  const client = makeClient({ token: config.token, userAgent: config.userAgent });
  const mailer = makeMailer(config.email);
  // Telegram = the redundant push channel: best-effort (a failure only logs — email keeps the
  // loud non-zero-exit guard) and sent INDEPENDENTLY of the email result, so a spam-foldered or
  // failed mail still buzzes the phone.
  const telegram = makeTelegram(config.telegram);
  const sliceSize = config.sliceSize || 50;

  // Deliverability guard: the Resend SANDBOX sender (onboarding@resend.dev) is testing-only — Resend
  // flags it as spam-prone and only delivers to your own verified address. For a tool whose whole
  // value is "an email arrives", a spam-foldered mail = silent total failure. Warn loudly here; the
  // real fix is verifying a sending domain in Resend (see README "Email deliverability").
  if (mailer.enabled && mailer.provider === 'resend' && /onboarding@resend\.dev/i.test(config.email.from || '')) {
    console.warn('⚠ Using the Resend SANDBOX sender (onboarding@resend.dev) — high spam risk. Verify a domain in Resend and set MAIL_FROM. See README.');
  }

  // Multi-sweep budget: 0/unset = one sweep and exit (the original model). With a budget (the
  // Actions workflow sets ~50 min), keep sweeping back-to-back — each sweep re-ranks, re-checks and
  // EMAILS — until the next sweep wouldn't fit. This is what turns GitHub's sparse cron ticks
  // (~1/hour in practice, despite the */15 request) into near-continuous coverage.
  const budgetMs = Math.max(0, parseFloat(process.env.RUN_BUDGET_MINUTES) || 0) * 60_000;
  const runStart = Date.now();
  const cur = readCursor();
  let sweepNo = 0;
  let lastSweepMs = 0;
  let emailError = null;

  for (;;) {
    sweepNo++;

    // Refresh the wantlist at most every wantlistRefreshMs (it changes rarely).
    if (!cur.wantlist || !cur.wantlist.length || Date.now() - (cur.wantlistAt || 0) > config.wantlistRefreshMs) {
      cur.wantlist = await client.getWantlist(config.username);
      cur.wantlistAt = Date.now();
      writeCursor(cur);
      console.log(`Refreshed wantlist: ${cur.wantlist.length} releases.`);
    }
    const N = cur.wantlist.length;
    if (!N) { console.log('Empty wantlist — nothing to do.'); writeCursor(cur); publishDeals(store, cur.wantlist); return; }

    const now = Date.now();
    const take = Math.min(sliceSize, N);
    // Priority sweep: rank every release by how urgently it deserves a re-check (staleness +
    // recent activity + rarity) and take the top `take`. This spends each sweep's API budget on the
    // releases most likely to surface a JUST-LISTED bargain, while staleness still guarantees full
    // coverage over time. (Replaces the old blind round-robin cursor.) In budget mode a small
    // recheck floor stops a tiny wantlist from being hammered back-to-back within one run.
    const minRecheckMs = config.minRecheckMs || (budgetMs > 0 ? 3 * 60_000 : 0);
    const ranked = cur.wantlist
      .map((rel) => ({ rel, score: engine.releaseWatchScore(store.getHistory(rel.releaseId), now, { recentMs: minRecheckMs }) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length && budgetMs > 0) {
      // Everything was checked within the recheck floor (small wantlist) — wait it out instead of
      // re-burning the API on releases we just saw, unless the budget is nearly spent anyway.
      if (Date.now() - runStart + 60_000 > budgetMs) break;
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    const slice = (ranked.length ? ranked.map((x) => x.rel) : cur.wantlist).slice(0, take);
    writeCursor(cur); // persist the wantlist cache (selection no longer needs a cursor index)
    const sweepStart = Date.now();
    console.log(`[sweep ${sweepNo}] Checking the ${slice.length} highest-priority of ${N} (mode=${config.mode}, email=${mailer.enabled ? mailer.provider : 'off'}, telegram=${telegram.enabled ? 'on' : 'off'}).`);

    const deals = [];
    let gemCount = 0;
    let checked = 0;
    for (const rel of slice) {
      try {
        const { deal, gem } = await processRelease(rel, { client, store, engine, config });
        if (deal) deals.push(deal);
        if (gem) {
          gemCount++;
          console.log(`  GEM 💎 ${gem.artist} – ${gem.title}  first copy for sale at ${gem.currency} ${gem.lowest} (was 0 for sale)`);
          // 💎 Sent the MOMENT it's found — a truly rare copy can sell within the hour, so it must
          // not wait out the rest of a ~14-min sweep. Sent separately from the deals email so the
          // subject line screams the event. A send failure doesn't abort the sweep (the gem is
          // already saved for the dashboard); it fails the run loudly at the end instead.
          if (mailer.enabled) {
            try { await mailer.sendGems([gem]); console.log(`  Emailed the rare gem to ${config.email.to}.`); }
            catch (e) { emailError = e; console.log('  Gem email FAILED:', e.message); }
          }
          if (telegram.enabled) {
            try { await telegram.sendGems([gem]); console.log('  Telegram gem push sent.'); }
            catch (e) { console.log('  Telegram gem push failed (best-effort; email is the guarded channel):', e.message); }
          }
        }
        checked++;
      } catch (e) { console.log(`  release ${rel.releaseId} error: ${e.message}`); }
    }

    const coverage = take >= N ? 'Full wantlist every sweep.' : `Full wantlist covered every ~${Math.ceil(N / take)} sweeps.`;
    console.log(`[sweep ${sweepNo}] Checked ${checked}. Deals: ${deals.length}. Rare gems: ${gemCount}. (${coverage})`);

    // Lead with the strongest diamond: the email subject + first card come from deals[0], so order
    // best-first (just-listed + real-sold-price + biggest discount rank highest).
    deals.sort((a, b) => engine.dealValueScore(b) - engine.dealValueScore(a));

    if (deals.length) {
      for (const d of deals) console.log(`  DEAL${d.freshListing ? ' 🆕just-listed' : ''} ${d.artist} – ${d.title}  ${d.currency} ${d.lowest} (${Math.round(d.discount * 100)}% off${d.suspicious ? ', ⚠maybe<VG+' : ''})`);
      if (mailer.enabled) {
        try { await mailer.sendDeals(deals); console.log(`Emailed ${deals.length} deal(s) to ${config.email.to}.`); }
        catch (e) { emailError = e; console.log('Email FAILED:', e.message); }
      } else {
        console.log('Email disabled — deals saved for the dashboard.');
      }
      if (telegram.enabled) {
        try { await telegram.sendDeals(deals); console.log(`Telegram push sent (${deals.length} deal(s)).`); }
        catch (e) { console.log('Telegram push failed (best-effort; email is the guarded channel):', e.message); }
      }
    }

    // Publish after every sweep so the committed files are as fresh as possible whenever the job
    // ends (the workflow commits once, after the last sweep).
    publishDeals(store, cur.wantlist);

    if (emailError) break; // stop sweeping — the loud non-zero exit below is the alert
    lastSweepMs = Date.now() - sweepStart;
    // Continue only if a next sweep (assumed ~as long as this one) still fits the budget.
    if (!budgetMs || Date.now() - runStart + lastSweepMs > budgetMs) break;
    console.log(`[sweep ${sweepNo}] took ${(lastSweepMs / 60_000).toFixed(1)} min — budget allows another sweep.`);
  }

  // Turn a silent email failure into a LOUD one: exit non-zero so the GitHub Actions step fails and
  // GitHub's built-in "your workflow failed" notification reaches you. For a tool whose core output IS
  // the email, a swallowed send error means you simply stop getting deals and never find out. The
  // deals are already saved to deals.json above, so the dashboard still updates regardless.
  if (emailError) { console.error('Exiting non-zero because a deal/gem email failed to send.'); process.exit(1); }
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
