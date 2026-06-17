'use strict';
/*
 * engine.js — pure deal-evaluation logic for the Discogs wantlist deal watcher.
 *
 * Pure Node (no deps, no I/O) so it can be unit-tested with `node engine.js --selftest`.
 * Everything network-facing lives in discogs.js; everything that decides "is this a deal?"
 * lives here so the rule is testable in isolation and identical across every deployment
 * shape (cloud API-only, local scraper, or hybrid).
 *
 * Core rule (from the goal):
 *   - condition must be VG+ or better (media condition)
 *   - total price (item + shipping) must be <= (1 - minDiscount) * reference price
 *     e.g. minDiscount 0.5  ==>  at least 50% under the reference
 */

// ---------------------------------------------------------------------------
// Discogs media-condition grading, best -> worst. Index = rank (lower is better).
// ---------------------------------------------------------------------------
const CONDITIONS = [
  'Mint (M)',
  'Near Mint (NM or M-)',
  'Very Good Plus (VG+)',
  'Very Good (VG)',
  'Good Plus (G+)',
  'Good (G)',
  'Fair (F)',
  'Poor (P)',
];

// Map every spelling Discogs/sellers use onto a canonical rank index.
const COND_ALIASES = new Map([
  ['m', 0], ['mint', 0], ['mint (m)', 0],
  ['nm', 1], ['m-', 1], ['near mint', 1], ['near mint (nm or m-)', 1], ['nm or m-', 1],
  ['vg+', 2], ['vgplus', 2], ['very good plus', 2], ['very good plus (vg+)', 2],
  ['vg', 3], ['very good', 3], ['very good (vg)', 3],
  ['g+', 4], ['good plus', 4], ['good plus (g+)', 4],
  ['g', 5], ['good', 5], ['good (g)', 5],
  ['f', 6], ['fair', 6], ['fair (f)', 6],
  ['p', 7], ['poor', 7], ['poor (p)', 7],
]);

// Normalize a condition label to its canonical rank, or null if unrecognized.
function conditionRank(label) {
  if (label == null) return null;
  const key = String(label).trim().toLowerCase().replace(/\s+/g, ' ');
  if (COND_ALIASES.has(key)) return COND_ALIASES.get(key);
  // Tolerate trailing/leading junk by trying the longest alias contained in the label.
  let best = null;
  for (const [alias, rank] of COND_ALIASES) {
    if (alias.length < 2) continue; // skip single-letter aliases for containment
    if (key.includes(alias)) { if (best == null || alias.length > best.len) best = { rank, len: alias.length }; }
  }
  return best ? best.rank : null;
}

// True when `label` is at least as good as `minLabel` (default VG+).
function meetsCondition(label, minLabel = 'Very Good Plus (VG+)') {
  const r = conditionRank(label);
  const min = conditionRank(minLabel);
  if (r == null || min == null) return false;
  return r <= min;
}

// ---------------------------------------------------------------------------
// Deal evaluation
// ---------------------------------------------------------------------------
/*
 * evaluateDeal(listing, opts) -> {
 *   isDeal, discount, total, reasons[]
 * }
 *   listing: { price, shipping, condition, currency }
 *      price     number  (item price)
 *      shipping  number|null  (null = unknown -> excluded from total but flagged)
 *      condition string|null  (media condition; null = unknown)
 *   opts: {
 *      reference   number      reference price to discount against (median / suggestion)
 *      minDiscount number      0..1, fraction below reference required (default 0.5)
 *      minCondition string     default 'Very Good Plus (VG+)'
 *      requireCondition bool    if true, unknown/below condition rejects (default true)
 *      requireShipping  bool    if true, unknown shipping rejects (default false; we just flag)
 *   }
 */
function evaluateDeal(listing, opts = {}) {
  const {
    reference,
    minDiscount = 0.5,
    minCondition = 'Very Good Plus (VG+)',
    requireCondition = true,
    requireShipping = false,
  } = opts;

  const reasons = [];
  const price = num(listing.price);
  const shipping = num(listing.shipping);
  const shippingKnown = shipping != null;
  const total = price == null ? null : price + (shippingKnown ? shipping : 0);

  let isDeal = true;

  if (price == null) { isDeal = false; reasons.push('no item price'); }

  if (!(reference > 0)) {
    isDeal = false;
    reasons.push('no reference price');
  }

  // Condition gate.
  const condOk = meetsCondition(listing.condition, minCondition);
  if (requireCondition && !condOk) {
    isDeal = false;
    reasons.push(conditionRank(listing.condition) == null ? 'condition unknown' : 'below min condition');
  }

  if (requireShipping && !shippingKnown) {
    isDeal = false;
    reasons.push('shipping unknown');
  }

  // Discount gate (uses total = item + shipping when shipping known).
  let discount = null;
  if (price != null && reference > 0) {
    discount = 1 - total / reference;
    if (discount < minDiscount) { isDeal = false; reasons.push('not cheap enough'); }
  }

  if (!shippingKnown) reasons.push('shipping unknown (excluded from total)');

  return { isDeal, discount, total, shippingKnown, condition: listing.condition, reasons };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Market-signal evaluation (API-only mode)
// ---------------------------------------------------------------------------
// The official API gives us, per release, only the single cheapest price (no
// condition) plus a per-condition *suggested* price. So we decide "much too cheap"
// against the best reference we can get, and dedupe on *new lows* so a standing
// cheap listing isn't emailed every sweep.

function median(nums) {
  const a = (nums || []).filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/*
 * evaluateMarketSignal(input, opts) where
 *   input: {
 *     lowest            number   current cheapest price (any condition)
 *     suggestion        number?  suggested price for VG+ (preferred reference)
 *     suggestionLow     number?  suggested price for VG (used for "suspiciously low")
 *     trailingMedian    number?  median of this release's own recent lowest-prices
 *     prevAlertedLowest number?  lowest we last alerted on (for new-low dedupe)
 *   }
 *   opts: { minDiscount=0.5, newLowFactor=0.9 }
 * returns { isDeal, meetsThreshold, discount, reference, referenceSource,
 *           confidence, isNewLow, suspicious, reasons[] }
 */
function evaluateMarketSignal(input, opts = {}) {
  const { lowest, suggestion, suggestionLow, trailingMedian, prevAlertedLowest } = input;
  const { minDiscount = 0.5, newLowFactor = 0.9 } = opts;
  const reasons = [];
  const low = num(lowest);
  const sug = num(suggestion);
  const tm = num(trailingMedian);

  // "Own dip": how far below the release's OWN usual lowest the current price sits.
  // This is the flood-killer — a standing cheap copy has ownDrop ~0; only a genuinely
  // new, cheaper-than-usual copy has a big ownDrop.
  const ownDrop = (tm != null && tm > 0 && low != null && low > 0) ? 1 - low / tm : null;

  // Prefer the condition-matched suggested price; fall back to the release's own
  // trailing median-of-lows (what it has normally been selling at).
  let reference = null;
  let referenceSource = null;
  if (sug != null && sug > 0) { reference = sug; referenceSource = 'suggestion'; }
  else if (tm != null && tm > 0) { reference = tm; referenceSource = 'trailing-median'; }

  const base = { isDeal: false, meetsThreshold: false, discount: null, ownDrop, reference, referenceSource, confidence: 0, isNewLow: false, suspicious: false, reasons };
  if (low == null || low <= 0) { reasons.push('no current price'); return base; }
  if (reference == null) { reasons.push('no reference price'); return base; }

  const discount = 1 - low / reference;
  const meetsThreshold = discount >= minDiscount;
  if (!meetsThreshold) reasons.push('not cheap enough');

  // Agreement across independent references raises confidence.
  let agree = 0;
  if (sug != null && sug > 0 && 1 - low / sug >= minDiscount) agree++;
  if (tm != null && tm > 0 && 1 - low / tm >= minDiscount) agree++;

  // Below a VG copy's fair price => the cheapest copy may itself be sub-VG+
  // (the API can't tell us its condition), so flag it and dock confidence.
  const sLow = num(suggestionLow);
  const suspicious = sLow != null && sLow > 0 && low < sLow;
  if (suspicious) reasons.push('suspiciously low — cheapest copy may be below VG+ (condition not exposed by API)');

  // New-low dedupe: only alert when meaningfully cheaper than the last alert.
  const prev = num(prevAlertedLowest);
  const isNewLow = prev == null || low <= prev * newLowFactor;
  if (!isNewLow) reasons.push('not a new low since last alert');

  let confidence = agree;
  if (suspicious) confidence = Math.max(0, confidence - 1);

  return { isDeal: meetsThreshold && isNewLow, meetsThreshold, discount, ownDrop, reference, referenceSource, confidence, isNewLow, suspicious, reasons };
}

/*
 * shouldFire(sig, historyCount, opts) — applies the chosen sensitivity profile + warm-up
 * on top of a signal from evaluateMarketSignal. Returns true when an alert should be sent.
 *
 *   warm-up:  no alerts until we've seen the release `warmupMin` times (learn its floor)
 *   sensitive: any copy >= minDiscount under the reference (standing cheap copies included)
 *   balanced:  + must also be ~ownDropFactor under the release's OWN usual lowest (a real dip)
 *              OR be a brand-new listing (a copy that JUST appeared) at a new-low deal price —
 *              "just listed and cheap" is exactly what we're hunting, so it bypasses the own-dip gate.
 *   strict:    balanced AND not "suspiciously low" (priced like a decent-grade copy)
 *
 *   opts.freshListing — true when num_for_sale rose since the last check (a copy was just listed).
 */
function shouldFire(sig, historyCount, opts = {}) {
  const { mode = 'balanced', ownDropFactor = 0.4, warmupMin = 4, warmupSensitive = 2, freshListing = false } = opts;
  const warm = historyCount >= (mode === 'sensitive' ? warmupSensitive : warmupMin);
  if (!warm) return false;
  if (mode === 'sensitive') return sig.isDeal;
  const ownDipOk = sig.ownDrop != null && sig.ownDrop >= ownDropFactor;
  if (mode === 'strict') return sig.isDeal && ownDipOk && !sig.suspicious;
  // balanced: a real dip under its own floor, OR a just-listed copy at a fresh new-low deal price.
  return sig.isDeal && (ownDipOk || freshListing);
}

// ---------------------------------------------------------------------------
// Freshness — catching copies that were JUST listed (API-only)
// ---------------------------------------------------------------------------
// The official API exposes no "date listed", so the only signal that a new copy
// appeared is num_for_sale rising between two checks. Combined with a price drop
// it means "a new (cheaper) copy was just listed" — the highest-value event.
function isFreshListing(prevObs, curObs) {
  if (!prevObs || !curObs) return false;
  const pn = num(prevObs.numForSale);
  const cn = num(curObs.numForSale);
  return pn != null && cn != null && cn > pn;
}

/*
 * releaseWatchScore(history, now, opts) — how urgently a release deserves re-checking.
 * Higher = check sooner. Lets the rotating sweep spend its limited per-run API budget on
 * the releases most likely to surface a just-listed bargain, instead of pure round-robin.
 *
 *   staleness  — minutes since last checked (never-checked sorts first); the coverage term
 *   activity   — the last check showed a new listing or a price drop (it's "hot")
 *   rarity     — few copies for sale: a cheap copy is rarer and more urgent to grab
 */
function releaseWatchScore(history, now, opts = {}) {
  const { activityBoost = 30, dropBoost = 40, rarityCap = 12, rarityWeight = 1.5, recentMs = 0 } = opts;
  const hist = history || [];
  const last = hist[hist.length - 1];
  const lastTs = last ? last.ts : 0;
  if (recentMs && lastTs && now - lastTs < recentMs) return -1; // checked too recently — skip this round
  const stalenessMin = (now - lastTs) / 60000; // never-checked (lastTs 0) => huge => first

  let activity = 0;
  if (hist.length >= 2) {
    const prev = hist[hist.length - 2];
    if (isFreshListing(prev, last)) activity += activityBoost;
    const pl = num(prev.lowest), cl = num(last.lowest);
    if (pl != null && cl != null && cl < pl) activity += dropBoost;
  }

  const n = last ? num(last.numForSale) : null;
  const rarity = n != null && n > 0 && n <= rarityCap ? (rarityCap - n) * rarityWeight : 0;

  return stalenessMin + activity + rarity;
}

// ---------------------------------------------------------------------------
// URL builders + dedupe identity
// ---------------------------------------------------------------------------
const releaseMarketUrl = (releaseId) => `https://www.discogs.com/sell/release/${releaseId}`;
const listingUrl = (listingId) => `https://www.discogs.com/sell/item/${listingId}`;
const releaseUrl = (releaseId) => `https://www.discogs.com/release/${releaseId}`;

// Stable key so the same offer isn't emailed twice. Prefer the listing id; fall back
// to a release+price+condition signature when we only have aggregate (API) data.
function dealKey(d) {
  if (d.listingId) return `listing:${d.listingId}`;
  return `release:${d.releaseId}|${d.total ?? d.price}|${conditionRank(d.condition) ?? 'x'}`;
}

module.exports = {
  CONDITIONS,
  conditionRank,
  meetsCondition,
  evaluateDeal,
  evaluateMarketSignal,
  shouldFire,
  isFreshListing,
  releaseWatchScore,
  median,
  num,
  releaseMarketUrl,
  listingUrl,
  releaseUrl,
  dealKey,
};

// --- tiny self-test (node engine.js --selftest) ----------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');

  // Condition ranking + threshold.
  assert.strictEqual(conditionRank('VG+'), 2);
  assert.strictEqual(conditionRank('Very Good Plus (VG+)'), 2);
  assert.strictEqual(conditionRank('NM'), 1);
  assert.strictEqual(conditionRank('Mint (M)'), 0);
  assert.strictEqual(conditionRank('vg'), 3);
  assert.strictEqual(conditionRank('garbage label'), null);
  assert.ok(meetsCondition('NM'), 'NM meets VG+');
  assert.ok(meetsCondition('VG+'), 'VG+ meets VG+');
  assert.ok(!meetsCondition('VG'), 'VG does NOT meet VG+');
  assert.ok(!meetsCondition('Good (G)'), 'G does not meet VG+');
  assert.ok(!meetsCondition(null), 'unknown does not meet VG+');

  // Deal: 50% under median, VG+, with shipping.
  let r = evaluateDeal({ price: 8, shipping: 2, condition: 'VG+' }, { reference: 30, minDiscount: 0.5 });
  assert.ok(r.isDeal, 'item 8 + ship 2 = 10 vs ref 30 (67% off), VG+ -> deal');
  assert.ok(Math.abs(r.discount - (1 - 10 / 30)) < 1e-9);

  // Shipping pushes it over the line -> not a deal.
  r = evaluateDeal({ price: 14, shipping: 5, condition: 'NM' }, { reference: 30, minDiscount: 0.5 });
  assert.ok(!r.isDeal, '14+5=19 vs 30 is only 37% off -> not a deal');

  // Cheap but VG (below VG+) -> rejected on condition.
  r = evaluateDeal({ price: 5, shipping: 2, condition: 'VG' }, { reference: 30, minDiscount: 0.5 });
  assert.ok(!r.isDeal, 'cheap VG copy rejected on condition');
  assert.ok(r.reasons.includes('below min condition'));

  // Unknown condition rejected by default, flagged in reasons.
  r = evaluateDeal({ price: 5, shipping: 2, condition: null }, { reference: 30 });
  assert.ok(!r.isDeal && r.reasons.includes('condition unknown'));

  // Unknown shipping: still a deal on item price alone, but flagged.
  r = evaluateDeal({ price: 8, shipping: null, condition: 'VG+' }, { reference: 30, minDiscount: 0.5 });
  assert.ok(r.isDeal, 'item 8 vs 30 is a deal even with unknown shipping');
  assert.ok(r.reasons.some((x) => /shipping unknown/.test(x)), 'unknown shipping is flagged');
  assert.strictEqual(r.total, 8, 'unknown shipping excluded from total');

  // No reference -> never a deal.
  r = evaluateDeal({ price: 1, shipping: 0, condition: 'M' }, { reference: 0 });
  assert.ok(!r.isDeal && r.reasons.includes('no reference price'));

  // Dedupe identity.
  assert.strictEqual(dealKey({ listingId: 123 }), 'listing:123');
  assert.strictEqual(dealKey({ releaseId: 9, total: 10, condition: 'VG+' }), 'release:9|10|2');

  // median helper.
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 2, 3]), 2.5);
  assert.strictEqual(median([]), null);

  // --- evaluateMarketSignal (API-only signal) ---
  // VG+ suggestion 30, lowest 12 -> 60% off, no previous alert -> deal.
  // VG suggestion 10 sits below 12, so not "suspiciously low".
  let s = evaluateMarketSignal({ lowest: 12, suggestion: 30, suggestionLow: 10, trailingMedian: 28, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(s.isDeal, 'lowest 12 vs VG+ suggestion 30 (60% off) is a deal');
  assert.strictEqual(s.referenceSource, 'suggestion');
  assert.strictEqual(s.confidence, 2, 'both suggestion and trailing-median agree -> confidence 2');
  assert.ok(!s.suspicious, '12 is above VG suggestion 10 -> not suspicious');

  // Same price but we already alerted at 12 -> not a new low.
  s = evaluateMarketSignal({ lowest: 12, suggestion: 30, trailingMedian: 28, prevAlertedLowest: 12 }, { minDiscount: 0.5 });
  assert.ok(!s.isDeal && s.meetsThreshold, 'still under threshold but not a new low -> no re-alert');
  assert.ok(s.reasons.some((r) => /new low/.test(r)));

  // A meaningfully lower new low re-alerts.
  s = evaluateMarketSignal({ lowest: 10, suggestion: 30, trailingMedian: 28, prevAlertedLowest: 12 }, { minDiscount: 0.5 });
  assert.ok(s.isDeal, '10 <= 12*0.9 -> new low -> re-alert');

  // Below the VG suggestion (18) -> suspicious, confidence docked.
  s = evaluateMarketSignal({ lowest: 6, suggestion: 30, suggestionLow: 18, trailingMedian: 28, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(s.isDeal && s.suspicious, '6 is below VG suggestion 18 -> deal but suspicious');
  assert.strictEqual(s.confidence, 1, 'suspicion docks one confidence point');

  // No suggestion -> falls back to trailing median.
  s = evaluateMarketSignal({ lowest: 5, suggestion: null, trailingMedian: 20, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(s.isDeal && s.referenceSource === 'trailing-median', 'falls back to trailing median');

  // Not cheap enough.
  s = evaluateMarketSignal({ lowest: 20, suggestion: 30, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(!s.isDeal && !s.meetsThreshold, '33% off does not meet 50% threshold');

  // No reference at all -> never a deal.
  s = evaluateMarketSignal({ lowest: 1, suggestion: null, trailingMedian: null, prevAlertedLowest: null });
  assert.ok(!s.isDeal && s.reasons.includes('no reference price'));

  // ownDrop: current 5 vs own usual lowest 20 -> 75% under its own floor.
  s = evaluateMarketSignal({ lowest: 5, suggestion: 40, suggestionLow: 22, trailingMedian: 20, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(Math.abs(s.ownDrop - 0.75) < 1e-9, 'ownDrop computed vs trailing median');

  // --- shouldFire (warm-up + profiles) ---
  // A genuine dip: cheap vs suggestion AND a big own-dip.
  const dip = evaluateMarketSignal({ lowest: 5, suggestion: 40, suggestionLow: 22, trailingMedian: 12, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(!shouldFire(dip, 3, { mode: 'balanced' }), 'warm-up: 3 obs < warmupMin 4 -> no fire');
  assert.ok(shouldFire(dip, 4, { mode: 'balanced' }), 'balanced: warmed + own-dip + cheap -> fire');

  // A standing cheap copy: cheap vs suggestion but NO own-dip (price == its usual lowest).
  const standing = evaluateMarketSignal({ lowest: 12, suggestion: 40, suggestionLow: 22, trailingMedian: 12, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(standing.meetsThreshold, 'standing copy is still under the 50% threshold');
  assert.ok(!shouldFire(standing, 10, { mode: 'balanced' }), 'balanced: standing cheap copy does NOT fire (flood killer)');
  assert.ok(shouldFire(standing, 10, { mode: 'sensitive' }), 'sensitive: standing cheap copy DOES fire');

  // strict: the dip is "suspicious" (5 < VG suggestion 22) so strict rejects it.
  assert.ok(!shouldFire(dip, 4, { mode: 'strict' }), 'strict: rejects suspiciously-low (likely sub-VG+) copy');
  const cleanDip = evaluateMarketSignal({ lowest: 25, suggestion: 60, suggestionLow: 22, trailingMedian: 50, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(shouldFire(cleanDip, 4, { mode: 'strict' }), 'strict: accepts a dip priced above the VG suggestion');

  // fresh-listing override: a just-listed cheap copy fires in balanced even without an own-dip.
  // standingFresh: price == its usual lowest (no own-dip) but it's a new-low deal vs suggestion.
  const standingFresh = evaluateMarketSignal({ lowest: 12, suggestion: 40, suggestionLow: 22, trailingMedian: 12, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.ok(!shouldFire(standingFresh, 10, { mode: 'balanced' }), 'balanced: cheap copy with no own-dip does NOT fire when not fresh');
  assert.ok(shouldFire(standingFresh, 10, { mode: 'balanced', freshListing: true }), 'balanced: a JUST-LISTED cheap new-low copy fires (the target event)');
  assert.ok(!shouldFire(standingFresh, 10, { mode: 'strict', freshListing: true }), 'strict ignores the fresh-listing shortcut');

  // --- isFreshListing ---
  assert.ok(isFreshListing({ numForSale: 3 }, { numForSale: 4 }), 'num_for_sale rose -> a copy was just listed');
  assert.ok(!isFreshListing({ numForSale: 5 }, { numForSale: 5 }), 'unchanged count -> not fresh');
  assert.ok(!isFreshListing({ numForSale: 5 }, { numForSale: 2 }), 'count fell (a copy sold) -> not fresh');
  assert.ok(!isFreshListing(null, { numForSale: 2 }), 'no previous observation -> not fresh');

  // --- releaseWatchScore ---
  const t = 10_000_000;
  const never = releaseWatchScore([], t);
  const stale = releaseWatchScore([{ ts: t - 60 * 60000, lowest: 20, numForSale: 5 }], t); // 60 min ago
  assert.ok(never > stale, 'a never-checked release outranks any checked one');
  const hot = releaseWatchScore([{ ts: t - 70 * 60000, lowest: 20, numForSale: 8 }, { ts: t - 10 * 60000, lowest: 12, numForSale: 9 }], t);
  const cold = releaseWatchScore([{ ts: t - 70 * 60000, lowest: 20, numForSale: 8 }, { ts: t - 10 * 60000, lowest: 20, numForSale: 8 }], t);
  assert.ok(hot > cold, 'a release that just dropped + got a new listing outranks a quiet one checked at the same time');
  assert.strictEqual(releaseWatchScore([{ ts: t - 60_000, lowest: 20, numForSale: 5 }], t, { recentMs: 5 * 60000 }), -1, 'checked < recentMs ago -> skipped this round');

  console.log('engine selftest: all assertions passed');
}
