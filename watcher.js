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
  minReference: 25,     // skip low-value records: the reference (VG+ suggestion) must be >= this €.
                        //   Safe for diamonds — a high-value record always clears it; kills only noise.
  shippingEstimate: 5,  // € added to the item price; the deal threshold uses the TOTAL (shipping counts).
  mode: 'balanced',     // 'balanced' | 'sensitive' | 'strict' (see engine.shouldFire)
  ownDropFactor: 0.4,   // balanced/strict: how far under its OWN usual lowest a copy must dip
  warmupMin: 4,         // observations before a release can alert (learns its floor first)
  rareGems: true,       // 💎 alert when a release with ZERO copies for sale gets its first one (price-blind)
  rareCooldownMs: 12 * 60 * 60 * 1000, // per-release cooldown between rare-gem alerts (guards against
                        //   num_for_sale flapping 0<->1 on Discogs' side re-firing the same copy)
  trailingN: 30,
  wantlistRefreshMs: 6 * 60 * 60 * 1000,
  dashboardPort: 8787,
  perReleaseGapMs: 0, // extra spacing on top of the client's own throttle
};

// configPath is optional: the cloud watcher reads config.json next to this file, but the desktop
// dashboard (packaged) passes a path inside its per-user app-data dir written by the setup wizard.
function loadConfig(configPath) {
  let file = {};
  const p = configPath || path.join(__dirname, 'config.json');
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
    minReference: env.MIN_REFERENCE ? parseFloat(env.MIN_REFERENCE) : (file.minReference ?? DEFAULTS.minReference),
    shippingEstimate: env.SHIPPING_ESTIMATE ? parseFloat(env.SHIPPING_ESTIMATE) : (file.shippingEstimate ?? DEFAULTS.shippingEstimate),
    mode: env.MODE || file.mode || DEFAULTS.mode,
    rareGems: env.RARE_GEMS != null ? !/^(0|false|off)$/i.test(env.RARE_GEMS) : (file.rareGems ?? DEFAULTS.rareGems),
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
        replyTo: env.MAIL_REPLY_TO || fe.replyTo || g.replyTo || '',
      };
    })(),
    // Telegram push (redundant second alert channel next to email — see telegram.js). Off unless
    // both are set (secrets TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or the config.json telegram block).
    telegram: (() => {
      const ft = file.telegram || {};
      return {
        botToken: env.TELEGRAM_BOT_TOKEN || ft.botToken || '',
        chatId: env.TELEGRAM_CHAT_ID || ft.chatId || '',
      };
    })(),
  };
  return cfg;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The rarities we're waiting on: wantlist releases whose LATEST observation counted ZERO copies
// for sale — the 💎 watch list the dashboard shows. History only stores ids, so join with the
// wantlist for titles/art. Shared by watcher.js (server mode) and watch-once.js (committed gems.json).
function zeroWatch(store, wantlist) {
  const zero = new Set(store.listZeroStock());
  return (wantlist || [])
    .filter((r) => zero.has(String(r.releaseId)))
    .map((r) => ({ releaseId: r.releaseId, title: r.title, artist: r.artist, year: r.year, thumb: r.thumb }));
}

// Process ONE release: fetch stats, update history, refresh suggestion if stale, evaluate, and
// record what fired. Pure of the loop, so testable. Returns { deal, gem } (both nullable):
//   deal — a new-low price deal (the classic alert, price-gated)
//   gem  — a 💎 rare appearance: the release had ZERO copies for sale and just got its first,
//          fired REGARDLESS of price (dedupe via a per-release cooldown only)
async function processRelease(rel, deps) {
  const { client, store, engine, config } = deps;
  const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
  // Read the previous observation BEFORE pushing the new one so we can spot a just-listed copy
  // (num_for_sale rising between checks) — the only "freshly listed" signal the API gives us.
  const prevObs = store.lastObservation(rel.releaseId);
  const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
  store.pushObservation(rel.releaseId, curObs);
  const freshListing = engine.isFreshListing(prevObs, curObs);
  const rareAppearance = config.rareGems !== false && engine.isRareAppearance(prevObs, curObs);

  // Cached, weekly-refreshed price suggestions (token required; ignore failures).
  // We keep the FULL per-condition ladder now (for impliedGrade), not just VG+/VG.
  let sug = store.getSuggestion(rel.releaseId);
  if (config.token && (!sug || !sug.ladder || Date.now() - sug.ts > SUGGESTION_TTL_MS)) {
    try {
      const raw = await client.getPriceSuggestions(rel.releaseId);
      if (raw) {
        const ladder = engine.extractLadder(raw);
        sug = { ts: Date.now(), vgplus: raw['Very Good Plus (VG+)']?.value ?? null, vg: raw['Very Good (VG)']?.value ?? null, ladder };
        store.setSuggestion(rel.releaseId, sug);
      }
    } catch (e) { /* unavailable -> trailing-median fallback */ }
  }

  const trailingMedian = store.trailingMedianLowest(rel.releaseId, config.trailingN);
  const alerted = store.getAlerted(rel.releaseId);
  // Real sales-history median (what copies ACTUALLY sell for) is the truest reference — far better
  // than Discogs's often-inflated VG+ suggestion. It can only be scraped from a residential IP (the
  // local dashboard scan), so the cloud reads it from the committed soldmedians.json seeded at startup;
  // absent (a release never scanned) it falls back to the suggestion exactly as before.
  const sold = store.getSoldMedian(rel.releaseId);

  // 💎 Rare gem: the release had ZERO copies for sale and just got its first. Fired regardless of
  // price or warm-up (the previous observation existing IS the warm-up — we knew it was at zero).
  // The only gate is a per-release cooldown so a num_for_sale count flapping 0<->1 on Discogs' side
  // can't re-fire the same copy every sweep; a copy that appears, sells, and is re-listed after the
  // cooldown alerts again — that's a genuinely new chance at a rare record, exactly what we want.
  let gem = null;
  if (rareAppearance) {
    const ra = store.getRareAlerted(rel.releaseId);
    const cooldown = config.rareCooldownMs ?? DEFAULTS.rareCooldownMs;
    if (!ra || Date.now() - ra.ts > cooldown) {
      const refSource = sold && sold.median != null ? 'sold-median' : (sug && sug.vgplus != null ? 'suggestion' : null);
      gem = {
        id: `${rel.releaseId}-gem-${Date.now()}`,
        type: 'gem',
        releaseId: rel.releaseId,
        title: rel.title,
        artist: rel.artist,
        year: rel.year,
        thumb: rel.thumb,
        lowest: stats.lowestPrice,
        currency: stats.currency || config.currency,
        numForSale: stats.numForSale,
        reference: refSource === 'sold-median' ? sold.median : (refSource === 'suggestion' ? sug.vgplus : null),
        referenceSource: refSource,
        url: `${engine.releaseMarketUrl(rel.releaseId)}?sort=price%2Casc&limit=25&currency=${config.currency}`,
        releaseUrl: engine.releaseUrl(rel.releaseId),
        ts: Date.now(),
      };
      store.addGem(gem);
      store.setRareAlerted(rel.releaseId, { ts: Date.now(), numForSale: stats.numForSale });
    }
  }

  const sig = engine.evaluateMarketSignal({
    lowest: stats.lowestPrice,
    soldMedian: sold ? sold.median : null,
    suggestion: sug ? sug.vgplus : null,
    suggestionLow: sug ? sug.vg : null,
    ladder: sug ? sug.ladder : null,
    trailingMedian,
    prevAlertedLowest: alerted ? alerted.lowest : null,
  }, { minDiscount: config.minDiscount, minReference: config.minReference, shippingEstimate: config.shippingEstimate });

  // Apply the sensitivity profile + warm-up (warm-up uses how many times we've seen this release).
  // A just-listed copy at a new-low deal price fires in balanced mode even without an own-dip.
  const fire = engine.shouldFire(sig, store.historyCount(rel.releaseId), {
    mode: config.mode, ownDropFactor: config.ownDropFactor, warmupMin: config.warmupMin, freshListing,
  });
  if (!fire) return { deal: null, gem };

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
    soldMedian: sold ? sold.median : null,
    soldLow: sold ? sold.low : null,
    soldHigh: sold ? sold.high : null,
    lastSold: sold ? sold.lastSold : null,
    discount: sig.discount,
    effectiveDiscount: sig.effectiveDiscount,
    total: sig.total,
    shippingEstimate: config.shippingEstimate,
    impliedGrade: sig.impliedGrade,
    pricedAsWorn: sig.pricedAsWorn,
    ownDrop: sig.ownDrop,
    // Recent lowest-price trail (oldest -> newest) so the dashboard can draw a sparkline and the user
    // can see at a glance whether this is a real dip or just the release's normal floor.
    spark: store.getHistory(rel.releaseId).slice(-12).map((o) => o.lowest).filter((x) => typeof x === 'number' && x > 0),
    confidence: sig.confidence,
    suspicious: sig.suspicious,
    freshListing,
    url: `${engine.releaseMarketUrl(rel.releaseId)}?sort=price%2Casc&limit=25&currency=${config.currency}`,
    releaseUrl: engine.releaseUrl(rel.releaseId),
    ts: Date.now(),
  };
  store.addDeal(deal);
  store.setAlerted(rel.releaseId, { lowest: stats.lowestPrice, ts: Date.now() });
  return { deal, gem };
}

async function run() {
  const engine = require('./engine');
  const { makeClient } = require('./discogs');
  const { makeStore } = require('./store');
  const { makeMailer } = require('./mailer');
  const { makeTelegram } = require('./telegram');
  const { makeServer } = require('./server');

  const config = loadConfig();
  if (!config.username) { console.error('Missing DISCOGS_USERNAME / config.username — cannot read a wantlist.'); process.exit(1); }
  if (!config.token) log('WARNING: no Discogs token — running anonymously (25 req/min, no price suggestions).');

  const store = makeStore(path.join(__dirname, 'state'));
  const client = makeClient({ token: config.token, userAgent: config.userAgent });
  const mailer = makeMailer(config.email);
  log(mailer.enabled ? `Email on (${mailer.provider}) -> ${config.email.to || config.email.user}` : 'Email OFF (no email creds) — deals saved to dashboard only.');
  if (mailer.enabled) mailer.verify().then((ok) => log(`Mailer (${mailer.provider}) ${ok ? 'verified' : 'ready'}.`)).catch((e) => log('Mailer verify FAILED:', e.message));
  const telegram = makeTelegram(config.telegram);
  log(telegram.enabled ? 'Telegram push on (redundant second channel).' : 'Telegram push off (no telegram.botToken/chatId).');

  const state = { wantlistSize: 0, lastSweepAt: null, sweepCount: 0, lastReleaseAt: null, lastError: null, mailer: mailer.enabled };
  const server = makeServer({
    store,
    token: config.dashboardToken,
    getStatus: () => ({ ...state, dealsStored: store.countDeals(), rateRemaining: client.rateRemaining }),
    getZeroWatch: () => zeroWatch(store, wantlist),
  });
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

      const { deal, gem } = await processRelease(rel, { client, store, engine, config });
      state.lastReleaseAt = Date.now();
      state.lastError = null;

      if (gem) {
        log(`GEM 💎 ${gem.artist} – ${gem.title}  first copy for sale at ${gem.currency} ${gem.lowest}  (was 0 for sale)`);
        if (mailer.enabled) {
          try { await mailer.sendGems([gem]); log('  gem emailed.'); }
          catch (e) { log('  gem email FAILED:', e.message); }
        }
        if (telegram.enabled) {
          try { await telegram.sendGems([gem]); log('  gem pushed to Telegram.'); }
          catch (e) { log('  gem Telegram push failed (best-effort):', e.message); }
        }
      }
      if (deal) {
        log(`DEAL${deal.freshListing ? ' 🆕' : '  '} ${deal.artist} – ${deal.title}  ${deal.currency} ${deal.lowest}  (${Math.round(deal.discount * 100)}% off ${deal.referenceSource}${deal.suspicious ? ', suspicious' : ''})`);
        if (mailer.enabled) {
          try { await mailer.sendDeals([deal]); log('  emailed.'); }
          catch (e) { log('  email FAILED:', e.message); }
        }
        if (telegram.enabled) {
          try { await telegram.sendDeals([deal]); log('  pushed to Telegram.'); }
          catch (e) { log('  Telegram push failed (best-effort):', e.message); }
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

module.exports = { processRelease, loadConfig, zeroWatch, DEFAULTS };

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

    // Balanced mode: VG+ suggestion 40, VG 10. A release that normally bottoms out at ~25, then a
    // genuine €12 dip appears that is priced like a VG copy (above the VG suggestion -> NOT worn/
    // suspicious). Warm-up (4 obs) must suppress early alerts; the standing €25 copy must NOT fire
    // (no own-dip); only the trustworthy €12 dip fires, once. (A worn-priced dip would be suppressed
    // by the balanced trustworthy-discount gate — covered by engine.shouldFire's selftest.)
    let seq = [25, 24, 26, 25, 12, 12];
    let k = 0;
    const client = {
      async getMarketplaceStats() { const v = seq[Math.min(k++, seq.length - 1)]; return { lowestPrice: v, numForSale: 10, currency: 'EUR' }; },
      async getPriceSuggestions() { return { 'Very Good Plus (VG+)': { value: 40, currency: 'EUR' }, 'Very Good (VG)': { value: 10, currency: 'EUR' } }; },
    };
    const config = { ...DEFAULTS, token: 'X', currency: 'EUR', minDiscount: 0.5, mode: 'balanced' };
    const rel = { releaseId: 555, title: 'Test', artist: 'Tester', year: 1984 };
    const deps = { client, store, engine, config };

    // Obs 1-3 (25, 24, 26): under warmupMin=4 -> no alerts even though 25 vs 40 is "cheap".
    for (let i = 0; i < 3; i++) assert.strictEqual((await processRelease(rel, deps)).deal, null, 'warm-up suppresses early observations');

    // Obs 4 (25): warmed up now, but 25 == its own usual lowest -> no own-dip -> NO fire (flood killer).
    assert.strictEqual((await processRelease(rel, deps)).deal, null, 'standing cheap copy does not fire in balanced mode');

    // Obs 5 (12): a genuine dip ~52% under its own median, >50% under VG+ suggestion, priced like VG -> FIRE.
    const dip = (await processRelease(rel, deps)).deal;
    assert.ok(dip, 'genuine new-low trustworthy dip fires');
    assert.ok(dip.ownDrop > 0.4, 'dip is well under its own usual lowest');
    assert.ok(!dip.suspicious, '12 is above the VG suggestion 10 -> priced like a real copy, not worn/suspicious');

    // Obs 6 (12): same price -> not a new low -> no re-alert.
    assert.strictEqual((await processRelease(rel, deps)).deal, null, 'same dip price does not re-alert');

    assert.strictEqual(store.countDeals(), 1, 'exactly one deal recorded in balanced mode');

    // --- sold-median seeding: a committed REAL median becomes the reference (the cloud-email quality fix).
    // A just-listed copy (num_for_sale rising) fires on the light warm-up and is judged against the
    // primed median (50), NOT the VG+ suggestion (30) — proving the cloud now uses true market value.
    store.primeSoldMedians({ 777: { median: 50, low: 35, high: 70 } });
    const sq = [{ lowest: 20, numForSale: 2 }, { lowest: 9, numForSale: 3 }];
    let j = 0;
    const client2 = {
      async getMarketplaceStats() { const v = sq[Math.min(j++, sq.length - 1)]; return { lowestPrice: v.lowest, numForSale: v.numForSale, currency: 'EUR' }; },
      async getPriceSuggestions() { return { 'Very Good Plus (VG+)': { value: 30, currency: 'EUR' }, 'Very Good (VG)': { value: 18, currency: 'EUR' } }; },
    };
    const rel2 = { releaseId: 777, title: 'Diamond', artist: 'Rare', year: 1983 };
    const deps2 = { client: client2, store, engine, config };
    assert.strictEqual((await processRelease(rel2, deps2)).deal, null, 'obs1: not warmed (no prior obs, not fresh) -> no fire');
    const freshDeal = (await processRelease(rel2, deps2)).deal;
    assert.ok(freshDeal, 'obs2: a just-listed copy fires on the light warm-up');
    assert.strictEqual(freshDeal.referenceSource, 'sold-median', 'the primed REAL median is the reference, not the VG+ suggestion');
    assert.strictEqual(freshDeal.reference, 50, 'reference is the committed sold-median (50), not the suggestion (30)');
    assert.strictEqual(freshDeal.soldMedian, 50, 'deal carries the sold-median for the email/dashboard');
    assert.ok(freshDeal.freshListing, 'tagged as just-listed');

    // --- 💎 rare gem: a release at ZERO for sale gets its first copy — alert regardless of price.
    // The €60 asking price is DOUBLE the €30 VG+ suggestion (never a "deal"), yet the gem fires:
    // availability is the signal here, not price.
    const gq = [
      { lowest: null, numForSale: 0 }, // obs1: nothing for sale (baseline)
      { lowest: 60, numForSale: 1 },   // obs2: first copy appears -> GEM
      { lowest: 60, numForSale: 2 },   // obs3: another copy (1->2): fresh, but NOT rare
      { lowest: null, numForSale: 0 }, // obs4: sold out again
      { lowest: 55, numForSale: 1 },   // obs5: re-appears within the cooldown -> suppressed
      { lowest: null, numForSale: 0 }, // obs6: sold out again
      { lowest: 55, numForSale: 1 },   // obs7: re-appears after the cooldown -> fires again
    ];
    let gk = 0;
    const client3 = {
      async getMarketplaceStats() { const v = gq[Math.min(gk++, gq.length - 1)]; return { lowestPrice: v.lowest, numForSale: v.numForSale, currency: 'EUR' }; },
      async getPriceSuggestions() { return { 'Very Good Plus (VG+)': { value: 30, currency: 'EUR' }, 'Very Good (VG)': { value: 18, currency: 'EUR' } }; },
    };
    const rel3 = { releaseId: 888, title: 'Holy Grail', artist: 'Obscure', year: 1985 };
    const deps3 = { client: client3, store, engine, config };
    let r3 = await processRelease(rel3, deps3);
    assert.strictEqual(r3.gem, null, 'obs1: first-ever observation cannot be a rare appearance');
    r3 = await processRelease(rel3, deps3);
    assert.ok(r3.gem, 'obs2: 0 -> 1 fires the rare-gem alert');
    assert.strictEqual(r3.deal, null, 'the €60 copy is NOT a deal (price-blind gem, price-gated deal)');
    assert.strictEqual(r3.gem.lowest, 60, 'gem carries the asking price');
    assert.strictEqual(r3.gem.numForSale, 1, 'gem carries the for-sale count');
    assert.strictEqual(r3.gem.reference, 30, 'gem carries the VG+ suggestion as context');
    assert.strictEqual(r3.gem.referenceSource, 'suggestion');
    r3 = await processRelease(rel3, deps3);
    assert.strictEqual(r3.gem, null, 'obs3: 1 -> 2 is fresh but not rare (a copy was already for sale)');
    r3 = await processRelease(rel3, deps3);
    assert.strictEqual(r3.gem, null, 'obs4: back to zero -> nothing appeared');
    r3 = await processRelease(rel3, deps3);
    assert.strictEqual(r3.gem, null, 'obs5: re-appearance within the cooldown is suppressed (anti-flap)');
    store.setRareAlerted(888, { ts: Date.now() - 13 * 60 * 60 * 1000, numForSale: 1 }); // age the memory past the 12h cooldown
    r3 = await processRelease(rel3, deps3); // obs6: back to zero
    assert.strictEqual(r3.gem, null, 'obs6: sold out again');
    r3 = await processRelease(rel3, deps3);
    assert.ok(r3.gem, 'obs7: a NEW appearance after the cooldown fires again');
    assert.strictEqual(store.countGems(), 2, 'two gems recorded for the dashboard feed');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('watcher itest: all assertions passed');
  })().catch((e) => { console.error('itest FAILED:', e.stack || e); process.exit(1); });
}
