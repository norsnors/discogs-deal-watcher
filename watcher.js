'use strict';
/*
 * watcher.js — the cloud-side loop.
 *
 *   1. Pull the Discogs wantlist (refreshed every few hours).
 *   2. Continuously sweep it, one release per paced API call (the client self-throttles
 *      to stay under 60 req/min). Each release: marketplace stats (+ cached price
 *      suggestions). Record the lowest price into rolling history.
 *   3. evaluateMarketSignal -> if a NEW low is >= minDiscount under the reference,
 *      record a deal, dedupe, and email it (Gmail).
 *   4. Serve the deals over a tiny HTTP API for the desktop dashboard.
 *
 * Config: config.json (gitignored) merged with env vars (env wins) so secrets can be
 * injected on the host without a file. See config.example.json.
 *
 * Tests: `node watcher.js --itest` runs the loop's unit (processRelease) over a fake
 * client across two ticks to verify deal detection + new-low dedupe, no network.
 */

const fs = require('fs');
const path = require('path');

const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const DEFAULTS = {
  currency: 'EUR',
  minDiscount: 0.5,
  mode: 'balanced',     // 'balanced' | 'sensitive' | 'strict' (see engine.shouldFire)
  ownDropFactor: 0.4,   // balanced/strict: how far under its OWN usual lowest a copy must dip
  warmupMin: 4,         // observations before a release can alert (learns its floor first)
  trailingN: 30,
  wantlistRefreshMs: 6 * 60 * 60 * 1000,
  dashboardPort: 8787,
  perReleaseGapMs: 0, // extra spacing on top of the client's own throttle
};

function loadConfig() {
  let file = {};
  const p = path.join(__dirname, 'config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* no file: env-only (cloud) */ }
  const env = process.env;
  const cfg = {
    ...DEFAULTS,
    ...file,
    token: env.DISCOGS_TOKEN || file.token || '',
    username: env.DISCOGS_USERNAME || file.username || '',
    userAgent: env.DISCOGS_USER_AGENT || file.userAgent || undefined,
    currency: env.CURRENCY || file.currency || DEFAULTS.currency,
    minDiscount: env.MIN_DISCOUNT ? parseFloat(env.MIN_DISCOUNT) : (file.minDiscount ?? DEFAULTS.minDiscount),
    mode: env.MODE || file.mode || DEFAULTS.mode,
    dashboardPort: env.PORT ? parseInt(env.PORT, 10) : (env.DASHBOARD_PORT ? parseInt(env.DASHBOARD_PORT, 10) : (file.dashboardPort ?? DEFAULTS.dashboardPort)),
    dashboardToken: env.DASHBOARD_TOKEN || file.dashboardToken || '',
    sliceSize: env.SLICE_SIZE ? parseInt(env.SLICE_SIZE, 10) : (file.sliceSize || 50),
    email: (() => {
      const fe = file.email || {};
      const g = file.gmail || {}; // backward-compat with the old gmail block
      const apiKey = env.RESEND_API_KEY || fe.apiKey || '';
      const user = env.GMAIL_USER || fe.user || g.user || '';
      const appPassword = env.GMAIL_APP_PASSWORD || fe.appPassword || g.appPassword || '';
      const provider = env.EMAIL_PROVIDER || fe.provider || (apiKey ? 'resend' : (user && appPassword ? 'gmail' : null));
      return {
        provider, apiKey, user, appPassword,
        to: env.MAIL_TO || fe.to || g.to || '',
        from: env.MAIL_FROM || fe.from || g.from || '',
      };
    })(),
  };
  return cfg;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Process ONE release: fetch stats, update history, refresh suggestion if stale,
// evaluate, and (if a new-low deal) record + return the deal. Pure of the loop, so testable.
async function processRelease(rel, deps) {
  const { client, store, engine, config } = deps;
  const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
  // Read the previous observation BEFORE pushing the new one so we can spot a just-listed copy
  // (num_for_sale rising between checks) — the only "freshly listed" signal the API gives us.
  const prevObs = store.lastObservation(rel.releaseId);
  const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
  store.pushObservation(rel.releaseId, curObs);
  const freshListing = engine.isFreshListing(prevObs, curObs);

  // Cached, weekly-refreshed price suggestions (token required; ignore failures).
  let sug = store.getSuggestion(rel.releaseId);
  if (config.token && (!sug || Date.now() - sug.ts > SUGGESTION_TTL_MS)) {
    try {
      const raw = await client.getPriceSuggestions(rel.releaseId);
      if (raw) {
        sug = { ts: Date.now(), vgplus: raw['Very Good Plus (VG+)']?.value ?? null, vg: raw['Very Good (VG)']?.value ?? null };
        store.setSuggestion(rel.releaseId, sug);
      }
    } catch (e) { /* unavailable -> trailing-median fallback */ }
  }

  const trailingMedian = store.trailingMedianLowest(rel.releaseId, config.trailingN);
  const alerted = store.getAlerted(rel.releaseId);
  const sig = engine.evaluateMarketSignal({
    lowest: stats.lowestPrice,
    suggestion: sug ? sug.vgplus : null,
    suggestionLow: sug ? sug.vg : null,
    trailingMedian,
    prevAlertedLowest: alerted ? alerted.lowest : null,
  }, { minDiscount: config.minDiscount });

  // Apply the sensitivity profile + warm-up (warm-up uses how many times we've seen this release).
  // A just-listed copy at a new-low deal price fires in balanced mode even without an own-dip.
  const fire = engine.shouldFire(sig, store.historyCount(rel.releaseId), {
    mode: config.mode, ownDropFactor: config.ownDropFactor, warmupMin: config.warmupMin, freshListing,
  });
  if (!fire) return null;

  const deal = {
    id: `${rel.releaseId}-${Date.now()}`,
    releaseId: rel.releaseId,
    title: rel.title,
    artist: rel.artist,
    year: rel.year,
    thumb: rel.thumb,
    lowest: stats.lowestPrice,
    currency: stats.currency || config.currency,
    numForSale: stats.numForSale,
    reference: sig.reference,
    referenceSource: sig.referenceSource,
    discount: sig.discount,
    ownDrop: sig.ownDrop,
    confidence: sig.confidence,
    suspicious: sig.suspicious,
    freshListing,
    url: `${engine.releaseMarketUrl(rel.releaseId)}?sort=price%2Casc&limit=25&currency=${config.currency}`,
    releaseUrl: engine.releaseUrl(rel.releaseId),
    ts: Date.now(),
  };
  store.addDeal(deal);
  store.setAlerted(rel.releaseId, { lowest: stats.lowestPrice, ts: Date.now() });
  return deal;
}

async function run() {
  const engine = require('./engine');
  const { makeClient } = require('./discogs');
  const { makeStore } = require('./store');
  const { makeMailer } = require('./mailer');
  const { makeServer } = require('./server');

  const config = loadConfig();
  if (!config.username) { console.error('Missing DISCOGS_USERNAME / config.username — cannot read a wantlist.'); process.exit(1); }
  if (!config.token) log('WARNING: no Discogs token — running anonymously (25 req/min, no price suggestions).');

  const store = makeStore(path.join(__dirname, 'state'));
  const client = makeClient({ token: config.token, userAgent: config.userAgent });
  const mailer = makeMailer(config.email);
  log(mailer.enabled ? `Email on (${mailer.provider}) -> ${config.email.to || config.email.user}` : 'Email OFF (no email creds) — deals saved to dashboard only.');
  if (mailer.enabled) mailer.verify().then((ok) => log(`Mailer (${mailer.provider}) ${ok ? 'verified' : 'ready'}.`)).catch((e) => log('Mailer verify FAILED:', e.message));

  const state = { wantlistSize: 0, lastSweepAt: null, sweepCount: 0, lastReleaseAt: null, lastError: null, mailer: mailer.enabled };
  const server = makeServer({ store, token: config.dashboardToken, getStatus: () => ({ ...state, dealsStored: store.countDeals(), rateRemaining: client.rateRemaining }) });
  server.listen(config.dashboardPort, () => log(`Dashboard API on :${config.dashboardPort}${config.dashboardToken ? ' (token-protected)' : ' (OPEN — set DASHBOARD_TOKEN!)'}`));

  let wantlist = [];
  let idx = 0;
  let lastWantlistRefresh = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (!wantlist.length || Date.now() - lastWantlistRefresh > config.wantlistRefreshMs) {
        wantlist = await client.getWantlist(config.username);
        lastWantlistRefresh = Date.now();
        idx = 0;
        state.wantlistSize = wantlist.length;
        log(`Wantlist: ${wantlist.length} releases. At ~1 check/sec a full sweep takes ~${Math.ceil(wantlist.length / 50)} min.`);
        if (!wantlist.length) { await sleep(60_000); continue; }
      }

      const rel = wantlist[idx % wantlist.length];
      idx++;
      if (idx % wantlist.length === 0) { state.sweepCount++; state.lastSweepAt = Date.now(); }

      const deal = await processRelease(rel, { client, store, engine, config });
      state.lastReleaseAt = Date.now();
      state.lastError = null;

      if (deal) {
        log(`DEAL${deal.freshListing ? ' 🆕' : '  '} ${deal.artist} – ${deal.title}  ${deal.currency} ${deal.lowest}  (${Math.round(deal.discount * 100)}% off ${deal.referenceSource}${deal.suspicious ? ', suspicious' : ''})`);
        if (mailer.enabled) {
          try { await mailer.sendDeals([deal]); log('  emailed.'); }
          catch (e) { log('  email FAILED:', e.message); }
        }
      }

      if (config.perReleaseGapMs) await sleep(config.perReleaseGapMs);
    } catch (e) {
      state.lastError = e.message;
      log('loop error:', e.message);
      await sleep(5_000);
    }
  }
}

module.exports = { processRelease, loadConfig, DEFAULTS };

if (require.main === module && !process.argv.includes('--itest')) run();

// --- integration test (node watcher.js --itest) ----------------------------
if (require.main === module && process.argv.includes('--itest')) {
  const assert = require('assert');
  const os = require('os');
  const engine = require('./engine');
  const { makeStore } = require('./store');

  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-itest-'));
    const store = makeStore(tmp);

    // Balanced mode: VG+ suggestion 40, VG 22. A release that normally bottoms out at ~12,
    // then a genuine €5 dip appears. Warm-up (4 obs) must suppress early alerts; the standing
    // €12 copy must NOT fire (no own-dip); only the €5 dip fires, once.
    let seq = [12, 11, 13, 12, 5, 5];
    let k = 0;
    const client = {
      async getMarketplaceStats() { const v = seq[Math.min(k++, seq.length - 1)]; return { lowestPrice: v, numForSale: 10, currency: 'EUR' }; },
      async getPriceSuggestions() { return { 'Very Good Plus (VG+)': { value: 40, currency: 'EUR' }, 'Very Good (VG)': { value: 22, currency: 'EUR' } }; },
    };
    const config = { ...DEFAULTS, token: 'X', currency: 'EUR', minDiscount: 0.5, mode: 'balanced' };
    const rel = { releaseId: 555, title: 'Test', artist: 'Tester', year: 1984 };
    const deps = { client, store, engine, config };

    // Obs 1-3 (12, 11, 13): under warmupMin=4 -> no alerts even though 12 vs 40 is "cheap".
    for (let i = 0; i < 3; i++) assert.strictEqual(await processRelease(rel, deps), null, 'warm-up suppresses early observations');

    // Obs 4 (12): warmed up now, but 12 == its own usual lowest -> no own-dip -> NO fire (flood killer).
    assert.strictEqual(await processRelease(rel, deps), null, 'standing cheap copy does not fire in balanced mode');

    // Obs 5 (5): a genuine dip ~58% under its own median AND >50% under VG+ suggestion -> FIRE.
    const dip = await processRelease(rel, deps);
    assert.ok(dip, 'genuine new-low dip fires');
    assert.ok(dip.ownDrop > 0.4, 'dip is well under its own usual lowest');
    assert.ok(dip.suspicious, '5 is below VG suggestion 22 -> flagged suspicious (but balanced still fires)');

    // Obs 6 (5): same price -> not a new low -> no re-alert.
    assert.strictEqual(await processRelease(rel, deps), null, 'same dip price does not re-alert');

    assert.strictEqual(store.countDeals(), 1, 'exactly one deal recorded in balanced mode');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('watcher itest: all assertions passed');
  })().catch((e) => { console.error('itest FAILED:', e.stack || e); process.exit(1); });
}
