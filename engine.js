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

// Pull a clean { gradeLabel: value } ladder out of the raw price_suggestions response.
function extractLadder(raw) {
  if (!raw) return null;
  const ladder = {};
  for (const g of CONDITIONS) { const v = raw[g] && raw[g].value; if (typeof v === 'number') ladder[g] = v; }
  return Object.keys(ladder).length ? ladder : null;
}

/*
 * impliedGrade(lowest, ladder) — what condition the cheapest copy is *priced* like.
 * Sellers price by grade, so the best grade whose suggested price the listing still meets is a
 * rough read on its condition (the API never tells us the real grade). Returns a grade label, or
 * null when the price is below even the worst listed grade (priced like a damaged copy — which,
 * crucially, is ALSO what a once-in-a-lifetime mispriced steal looks like, so we never auto-exclude
 * on this; it's surfaced for the user to judge).
 */
function impliedGrade(lowest, ladder) {
  const low = num(lowest);
  if (low == null || !ladder) return null;
  for (const g of CONDITIONS) { const v = num(ladder[g]); if (v != null && low >= v) return g; } // best -> worst
  return null;
}

// "Priced like a Good-or-worse (worn) copy" — for an optional "hide possibly-damaged" filter.
function pricedAsWorn(lowest, ladder) {
  if (!ladder) return false;
  const g = impliedGrade(lowest, ladder);
  return g == null || conditionRank(g) >= conditionRank('Good (G)');
}

/*
 * selectByCondition(listings, opts) — the REAL-condition deal picker.
 *
 * Given the actual marketplace copies for a release (each with a real media condition + price +
 * optional shipping — scraped from the live listing, NOT guessed from a price ladder), pick the
 * CHEAPEST copy that meets the minimum condition (default VG+). This is what makes a scan-confirmed
 * deal trustworthy: the discount is judged against a copy we KNOW is VG+ or better, instead of the
 * absolute-cheapest copy (which on vinyl is very often a worn Good/VG copy). Ordering is by TOTAL
 * (price + shipping) so a cheap-item/expensive-shipping copy doesn't masquerade as the best buy.
 *
 *   listings: [{ price, shipping?, media, sleeve?, url?, itemId?, shipsFrom? }]
 *   opts.minCondition  default 'Very Good Plus (VG+)'
 * returns {
 *   best,            // cheapest copy meeting the bar, or null  { price, shipping, total, media, mediaRank, sleeve, url, itemId, shipsFrom }
 *   cheapestAny,     // the absolute cheapest copy of any grade, or null (for "a worn copy is cheaper" context)
 *   acceptableCount, // how many copies meet the condition bar
 *   totalCount,      // copies with a usable price
 *   unknownCount,    // copies whose grade we couldn't parse (counted, never selected)
 * }
 */
function selectByCondition(listings, opts = {}) {
  const minRank = conditionRank(opts.minCondition || 'Very Good Plus (VG+)');
  const nearFactor = opts.nearFactor != null ? opts.nearFactor : 0.25; // "slightly more" = +25% of total ...
  const nearAbs = opts.nearAbs != null ? opts.nearAbs : 3;             // ... or +€3, whichever is larger
  const norm = (Array.isArray(listings) ? listings : [])
    .map((l) => {
      const price = num(l.price);
      const shipping = num(l.shipping); // null = unknown shipping (excluded from total, but kept)
      const mediaRank = conditionRank(l.media);
      return {
        price,
        shipping,
        total: price == null ? null : price + (shipping == null ? 0 : shipping),
        media: l.media || null,
        mediaRank,
        sleeve: l.sleeve || null,
        itemId: l.itemId || null,
        url: l.url || (l.itemId ? listingUrl(l.itemId) : null),
        shipsFrom: l.shipsFrom || null,
      };
    })
    .filter((l) => l.price != null && l.price > 0)
    .sort((a, b) => (a.total ?? a.price) - (b.total ?? b.price));
  const acceptable = minRank == null ? [] : norm.filter((l) => l.mediaRank != null && l.mediaRank <= minRank);
  const best = acceptable[0] || null;

  // "Slightly dearer but better" — the cheapest acceptable copy of a STRICTLY better grade than
  // `best`, priced within `near` of best's total. Lets the UI offer "€8 VG+ · or €10 NM".
  let betterAlt = null;
  if (best && best.mediaRank != null) {
    const bestTotal = best.total ?? best.price;
    const ceiling = bestTotal + Math.max(nearAbs, bestTotal * nearFactor);
    betterAlt = acceptable.find((l) => l.mediaRank != null && l.mediaRank < best.mediaRank && (l.total ?? l.price) <= ceiling) || null;
  }

  return {
    best,
    betterAlt,
    acceptable,           // all VG+-or-better copies, sorted by total asc (for cluster analysis)
    cheapestAny: norm[0] || null,
    acceptableCount: acceptable.length,
    totalCount: norm.length,
    unknownCount: norm.filter((l) => l.mediaRank == null).length,
  };
}

/*
 * cheapCluster(copies, reference, minDiscount) — how many of these copies are ALL meaningfully
 * cheap vs the reference, and their price band. The signal: one copy far under a high median can be
 * a fluke/mispricing, but a CLUSTER of copies far under means the market actually moved (the median
 * is just stale) — a real, low-risk opportunity. Counts by TOTAL (price + shipping when known).
 * Returns { count, low, high }.
 */
function cheapCluster(copies, reference, minDiscount = 0.5) {
  const ref = num(reference);
  if (!(ref > 0) || !Array.isArray(copies)) return { count: 0, low: null, high: null };
  const cheap = copies
    .map((c) => num(c.total != null ? c.total : c.price))
    .filter((t) => t != null && t > 0 && 1 - t / ref >= minDiscount)
    .sort((a, b) => a - b);
  return { count: cheap.length, low: cheap[0] ?? null, high: cheap[cheap.length - 1] ?? null };
}

/*
 * dealValueScore(d) — ranks EMAILED deals so the strongest diamond leads the inbox (the subject line
 * + first card). Combines the discount with the live signals that matter most for "best deals fastest":
 * a JUST-LISTED copy and a deal judged against the REAL sold price both rank higher; a "may be below
 * VG+" copy is docked. Nothing is excluded — this is purely ordering (the user always sees every deal).
 */
function dealValueScore(d) {
  if (!d) return 0;
  const eff = num(d.effectiveDiscount);
  let s = eff != null ? eff : (num(d.discount) || 0);
  if (d.freshListing) s += 0.25;                       // the live event we hunt for
  if (d.referenceSource === 'sold-median') s += 0.15;  // judged against true market value, not a guess
  if (d.suspicious) s -= 0.1;                          // possibly sub-VG+ — still shown, just lower
  return s;
}

/*
 * evaluateMarketSignal(input, opts) where
 *   input: {
 *     lowest            number   current cheapest price (any condition)
 *     soldMedian        number?  REAL sales-history median (web-only; the best reference when present)
 *     suggestion        number?  suggested price for VG+ (Discogs's algorithmic guess; fallback)
 *     suggestionLow     number?  suggested price for VG (used for "suspiciously low")
 *     ladder            object?  full { gradeLabel: value } suggestion ladder (for impliedGrade)
 *     trailingMedian    number?  median of this release's own recent lowest-prices
 *     prevAlertedLowest number?  lowest we last alerted on (for new-low dedupe)
 *   }
 *   Reference preference: soldMedian (real market value) > VG+ suggestion > our trailing median.
 *   opts: { minDiscount=0.5, newLowFactor=0.9, minReference=0, shippingEstimate=0 }
 *     minReference     — skip cheap records: require the reference price >= this (€). Safe for
 *                        diamonds (a €100 record always clears it); only kills low-value noise.
 *     shippingEstimate — added to the item price; the threshold uses the TOTAL (shipping matters).
 * returns { isDeal, meetsThreshold, discount, effectiveDiscount, total, reference, referenceSource,
 *           minReferenceOk, confidence, isNewLow, suspicious, impliedGrade, pricedAsWorn, reasons[] }
 */
function evaluateMarketSignal(input, opts = {}) {
  const { lowest, soldMedian, suggestion, suggestionLow, ladder, trailingMedian, prevAlertedLowest } = input;
  const { minDiscount = 0.5, newLowFactor = 0.9, minReference = 0, shippingEstimate = 0 } = opts;
  const reasons = [];
  const low = num(lowest);
  const sm = num(soldMedian);
  const sug = num(suggestion);
  const tm = num(trailingMedian);
  const ship = num(shippingEstimate) || 0;

  // "Own dip": how far below the release's OWN usual lowest the current price sits.
  // This is the flood-killer — a standing cheap copy has ownDrop ~0; only a genuinely
  // new, cheaper-than-usual copy has a big ownDrop.
  const ownDrop = (tm != null && tm > 0 && low != null && low > 0) ? 1 - low / tm : null;

  // Reference preference: the REAL sales-history median (what copies actually sell for) is the
  // truest market value; then Discogs's VG+ suggestion (an algorithmic guess, often off); then our
  // own trailing median-of-lows (asking prices we've observed).
  let reference = null;
  let referenceSource = null;
  if (sm != null && sm > 0) { reference = sm; referenceSource = 'sold-median'; }
  else if (sug != null && sug > 0) { reference = sug; referenceSource = 'suggestion'; }
  else if (tm != null && tm > 0) { reference = tm; referenceSource = 'trailing-median'; }

  const grade = impliedGrade(low, ladder);
  const worn = pricedAsWorn(low, ladder);
  const base = { isDeal: false, meetsThreshold: false, discount: null, effectiveDiscount: null, total: null, ownDrop, reference, referenceSource, minReferenceOk: false, confidence: 0, isNewLow: false, suspicious: false, impliedGrade: grade, pricedAsWorn: worn, reasons };
  if (low == null || low <= 0) { reasons.push('no current price'); return base; }
  if (reference == null) { reasons.push('no reference price'); return base; }

  const total = low + ship;
  const discount = 1 - low / reference;            // item-only
  const effectiveDiscount = 1 - total / reference; // including the shipping estimate
  const meetsThreshold = effectiveDiscount >= minDiscount;
  if (!meetsThreshold) reasons.push('not cheap enough (incl. shipping estimate)');

  const minReferenceOk = reference >= minReference;
  if (!minReferenceOk) reasons.push('reference below min value');

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

  return { isDeal: meetsThreshold && isNewLow && minReferenceOk, meetsThreshold, discount, effectiveDiscount, total, ownDrop, reference, referenceSource, minReferenceOk, confidence, isNewLow, suspicious, impliedGrade: grade, pricedAsWorn: worn, reasons };
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
  // Warm-up: learn the release's usual floor before alerting (kills the cold-start flood). But a
  // JUST-LISTED copy is the highest-value event and bypasses the own-dip gate anyway, so it doesn't
  // need a long trailing history — in balanced mode it qualifies on the lighter warm-up (we only need
  // one prior observation to have detected the num_for_sale rise). Sensitive is always light; strict
  // stays conservative (it ignores the fresh-listing shortcut, so it keeps the full warm-up too).
  const lightWarmup = mode === 'sensitive' || (mode === 'balanced' && freshListing);
  if (historyCount < (lightWarmup ? warmupSensitive : warmupMin)) return false;
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
  dealValueScore,
  shouldFire,
  isFreshListing,
  releaseWatchScore,
  extractLadder,
  impliedGrade,
  pricedAsWorn,
  selectByCondition,
  cheapCluster,
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

  // --- sold-median is the preferred reference ---
  s = evaluateMarketSignal({ lowest: 10, soldMedian: 40, suggestion: 25, trailingMedian: 22, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.strictEqual(s.referenceSource, 'sold-median', 'real sold-median wins over suggestion + trailing');
  assert.ok(Math.abs(s.discount - (1 - 10 / 40)) < 1e-9, 'discount computed against the sold-median');
  s = evaluateMarketSignal({ lowest: 10, suggestion: 25, trailingMedian: 22, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.strictEqual(s.referenceSource, 'suggestion', 'no sold-median -> fall back to suggestion');

  // --- minReference (value floor) ---
  // 60% off a €30 record is a deal; the SAME 60% off a €10 record is filtered by a €25 floor.
  s = evaluateMarketSignal({ lowest: 12, suggestion: 30, prevAlertedLowest: null }, { minDiscount: 0.5, minReference: 25 });
  assert.ok(s.isDeal && s.minReferenceOk, 'reference 30 >= 25 -> passes the value floor');
  s = evaluateMarketSignal({ lowest: 4, suggestion: 10, prevAlertedLowest: null }, { minDiscount: 0.5, minReference: 25 });
  assert.ok(!s.isDeal && !s.minReferenceOk && s.meetsThreshold, 'reference 10 < 25 -> below value floor, not a deal (but still met the discount)');
  // The diamond survives the floor: a €2 copy of a €100 record.
  s = evaluateMarketSignal({ lowest: 2, suggestion: 100, prevAlertedLowest: null }, { minDiscount: 0.5, minReference: 25 });
  assert.ok(s.isDeal && s.minReferenceOk, 'the €2-for-€100 diamond clears the value floor');

  // --- shipping estimate folds into the threshold ---
  // item €10 vs €30 = 67% off, but +€8 shipping = €18 total = 40% off -> below 50%.
  s = evaluateMarketSignal({ lowest: 10, suggestion: 30, prevAlertedLowest: null }, { minDiscount: 0.5, shippingEstimate: 8 });
  assert.ok(!s.meetsThreshold, 'shipping pushes the total over the threshold');
  assert.strictEqual(s.total, 18, 'total = item + shipping estimate');
  assert.ok(Math.abs(s.discount - (1 - 10 / 30)) < 1e-9, 'item discount unchanged');
  assert.ok(Math.abs(s.effectiveDiscount - (1 - 18 / 30)) < 1e-9, 'effective discount includes shipping');
  // the diamond still wins even with shipping: €2 + €15 ship = €17 vs €100 = 83% off.
  s = evaluateMarketSignal({ lowest: 2, suggestion: 100, prevAlertedLowest: null }, { minDiscount: 0.5, shippingEstimate: 15 });
  assert.ok(s.meetsThreshold && s.effectiveDiscount > 0.8, 'shipping barely dents a true diamond');

  // --- impliedGrade / extractLadder / pricedAsWorn ---
  const raw = { 'Mint (M)': { value: 50 }, 'Near Mint (NM or M-)': { value: 40 }, 'Very Good Plus (VG+)': { value: 30 }, 'Very Good (VG)': { value: 18 }, 'Good Plus (G+)': { value: 12 }, 'Good (G)': { value: 8 } };
  const ladder = extractLadder(raw);
  assert.strictEqual(ladder['Very Good Plus (VG+)'], 30, 'extractLadder pulls grade values');
  assert.strictEqual(impliedGrade(30, ladder), 'Very Good Plus (VG+)', 'priced at the VG+ suggestion -> implied VG+');
  assert.strictEqual(impliedGrade(15, ladder), 'Good Plus (G+)', '€15 is priced like a G+ copy');
  assert.strictEqual(impliedGrade(5, ladder), null, '€5 is below even the Good suggestion -> null (likely worn OR a steal)');
  assert.strictEqual(pricedAsWorn(20, ladder), false, '€20 (priced as VG) is not "worn"');
  assert.strictEqual(pricedAsWorn(9, ladder), true, '€9 (priced as Good) is "worn"');
  assert.strictEqual(pricedAsWorn(5, ladder), true, '€5 (below Good) is "worn"');
  // signal carries the implied grade through
  s = evaluateMarketSignal({ lowest: 6, suggestion: 30, suggestionLow: 18, ladder, prevAlertedLowest: null }, { minDiscount: 0.5 });
  assert.strictEqual(s.impliedGrade, null, '€6 cheapest -> priced below Good');
  assert.ok(s.pricedAsWorn && s.suspicious && s.isDeal, 'still a deal, but flagged worn + suspicious for the user to judge');

  // --- selectByCondition (REAL per-copy condition picker) ---
  // A release with a worn cheap copy AND a VG+ copy: we must pick the VG+ one, not the cheapest.
  const copies = [
    { itemId: 1, media: 'Very Good (VG)', price: 4, shipping: 3 },
    { itemId: 2, media: 'Very Good Plus (VG+)', price: 9, shipping: 4 }, // total 13
    { itemId: 3, media: 'Near Mint (NM or M-)', price: 12, shipping: 3 }, // total 15
    { itemId: 4, media: 'Mint (M)', price: 20, shipping: 0 },
    { itemId: 5, media: 'Good (G)', price: 2, shipping: 2 }, // absolute cheapest, but worn
  ];
  let sel = selectByCondition(copies);
  assert.strictEqual(sel.cheapestAny.itemId, 5, 'cheapestAny is the €2 Good copy');
  assert.strictEqual(sel.best.itemId, 2, 'cheapest VG+-or-better is the €9 VG+ (total 13) over the NM (total 15)');
  assert.strictEqual(sel.best.media, 'Very Good Plus (VG+)');
  assert.ok(/\/sell\/item\/2$/.test(sel.best.url), 'best gets a direct listing URL from its itemId');
  assert.strictEqual(sel.acceptableCount, 3, 'VG+, NM and M meet the VG+ bar');
  assert.strictEqual(sel.totalCount, 5);

  // No VG+ copy exists -> best is null (the scan drops the release; no false VG+ deal).
  sel = selectByCondition([{ media: 'Very Good (VG)', price: 5 }, { media: 'Good (G)', price: 3 }]);
  assert.strictEqual(sel.best, null, 'no copy meets VG+ -> best null');
  assert.strictEqual(sel.cheapestAny.price, 3);

  // Unparseable grades are counted but never selected.
  sel = selectByCondition([{ media: 'Generic placeholder', price: 5 }, { media: 'VG+', price: 8 }]);
  assert.strictEqual(sel.best.price, 8, 'unknown-grade copy skipped; the VG+ copy is chosen');
  assert.strictEqual(sel.unknownCount, 1, 'the unparseable grade is counted as unknown');

  // Shipping folds into the ordering: a VG+ at 10+0 beats an NM at 9+8 on total.
  sel = selectByCondition([
    { itemId: 10, media: 'VG+', price: 10, shipping: 0 },
    { itemId: 11, media: 'NM', price: 9, shipping: 8 },
  ]);
  assert.strictEqual(sel.best.itemId, 10, 'cheapest by TOTAL (incl. shipping), not item price');

  // Empty / junk input is safe.
  assert.strictEqual(selectByCondition([]).best, null);
  assert.strictEqual(selectByCondition(null).totalCount, 0);

  // betterAlt: a strictly-better grade copy that is only slightly dearer than the cheapest VG+.
  sel = selectByCondition([
    { itemId: 1, media: 'VG+', price: 8, shipping: 0 },   // best (total 8)
    { itemId: 2, media: 'NM', price: 10, shipping: 0 },   // better grade, +€2 -> within near -> alt
    { itemId: 3, media: 'Mint (M)', price: 40, shipping: 0 }, // better grade but way dearer -> not alt
  ]);
  assert.strictEqual(sel.best.itemId, 1, 'cheapest VG+ is best');
  assert.strictEqual(sel.betterAlt.itemId, 2, 'NM at +€2 is the slightly-dearer-but-better alternative');
  // No better grade nearby -> no alt.
  sel = selectByCondition([{ itemId: 1, media: 'VG+', price: 8 }, { itemId: 2, media: 'VG+', price: 9 }]);
  assert.strictEqual(sel.betterAlt, null, 'no strictly-better grade -> no alternative');
  // acceptable list is exposed and sorted by total.
  assert.ok(Array.isArray(sel.acceptable) && sel.acceptable[0].itemId === 1, 'acceptable copies exposed, cheapest first');

  // --- cheapCluster (the price-drop / market-moved signal) ---
  // Reference 40; copies at 8,10,12 are all >=50% under -> a cluster of 3 (band €8–€12); the 30 isn't.
  const clusterCopies = [{ total: 8 }, { total: 10 }, { total: 12 }, { total: 30 }];
  let cl = cheapCluster(clusterCopies, 40, 0.5);
  assert.strictEqual(cl.count, 3, 'three copies sit >=50% under the €40 reference');
  assert.strictEqual(cl.low, 8, 'cluster low');
  assert.strictEqual(cl.high, 12, 'cluster high');
  // A lone cheap copy is a cluster of 1 (weaker signal, but reported).
  cl = cheapCluster([{ total: 8 }, { total: 35 }, { total: 38 }], 40, 0.5);
  assert.strictEqual(cl.count, 1, 'only one copy is meaningfully cheap');
  // No reference -> empty (can't judge cheapness).
  assert.strictEqual(cheapCluster([{ total: 8 }], null).count, 0, 'no reference -> no cluster');
  assert.strictEqual(cheapCluster(null, 40).count, 0, 'null copies safe');

  // --- dealValueScore (email ordering: the strongest diamond leads) ---
  const dA = { discount: 0.6, freshListing: true, referenceSource: 'sold-median' };
  const dB = { discount: 0.6, freshListing: false, referenceSource: 'suggestion' };
  assert.ok(dealValueScore(dA) > dealValueScore(dB), 'a just-listed, real-sold-price deal outranks an equal-discount estimate');
  const dSusp = { discount: 0.7, suspicious: true, referenceSource: 'suggestion' };
  const dClean = { discount: 0.65, suspicious: false, referenceSource: 'sold-median' };
  assert.ok(dealValueScore(dClean) > dealValueScore(dSusp), 'a clean real-sold deal outranks a slightly-bigger suspicious estimate');
  assert.ok(dealValueScore({ effectiveDiscount: 0.5, discount: 0.7 }) === 0.5, 'effectiveDiscount (incl. shipping) is preferred over item-only discount');
  assert.strictEqual(dealValueScore(null), 0, 'null deal scores 0');

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

  // fresh-listing gets the LIGHTER warm-up in balanced: a just-listed deal fires after 2 obs, while a
  // non-fresh deal still needs the full warm-up (4). Catches diamonds on releases we've only just begun
  // tracking — without re-opening the cold-start flood for ordinary standing-price observations.
  assert.ok(shouldFire(dip, 2, { mode: 'balanced', freshListing: true }), 'balanced: a fresh-listing deal fires after the light warm-up (2 obs)');
  assert.ok(!shouldFire(dip, 2, { mode: 'balanced' }), 'balanced: a non-fresh deal still needs the full warm-up (4)');
  assert.ok(!shouldFire(dip, 1, { mode: 'balanced', freshListing: true }), 'even a fresh listing needs >=2 obs (a prior observation to have detected the rise)');
  assert.ok(!shouldFire(dip, 2, { mode: 'strict', freshListing: true }), 'strict keeps the full warm-up even for a fresh listing');

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
