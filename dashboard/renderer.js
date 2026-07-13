'use strict';
/*
 * renderer.js — dashboard UI. Talks to the main process only through window.api (preload IPC).
 * When window.api is absent (a plain browser preview), it falls back to DEMO data so the layout
 * is still viewable.
 *
 * Philosophy: detect PERMISSIVELY (the scan / cloud collect every bargain), then filter POWERFULLY
 * here. All the sliders (min value, % off, max total, shipping estimate) and the sort run live in
 * the browser over the loaded deals — so dialling in "show me the real diamonds" never needs a
 * re-scan and never throws away the €2-for-€100 outlier.
 *
 * Two view modes:
 *   'cloud' — passive: deals the cloud watcher already found (polled every 30s). The default.
 *   'scan'  — the results of a local "⚡ Scan now" full sweep. Polling pauses while shown.
 */

const hasApi = typeof window.api !== 'undefined';

const DEMO = [
  // Confirmed (scan) deals: real media condition read off the live listing.
  { id: 'demo1', releaseId: 249504, artist: 'Imagination', title: 'Night Dubbing', lowest: 8.5, currency: 'EUR', shipping: 4.5, shipsFrom: 'Germany', numForSale: 14, vgPlusCount: 5, cheapVgPlusCount: 4, cheapVgPlusLow: 13, cheapVgPlusHigh: 17, altGrade: 'Near Mint (NM or M-)', altPrice: 14.5, altUrl: 'https://www.discogs.com/sell/item/112', reference: 32, referenceSource: 'sold-median', soldLow: 18, soldHigh: 45, discount: 0.73, conditionConfirmed: true, mediaCondition: 'Very Good Plus (VG+)', sleeveCondition: 'Very Good Plus (VG+)', cheaperWornPrice: 4.0, cheaperWornCondition: 'Good (G)', freshListing: true, ownDrop: 0.5, spark: [22, 20, 21, 19, 18, 17, 16, 15, 14, 12, 10, 8.5], listingUrl: 'https://www.discogs.com/sell/item/111', url: 'https://www.discogs.com/sell/item/111', ts: Date.now() - 4 * 60000, thumb: '' },
  { id: 'demo2', releaseId: 67890, artist: 'Gino Soccio', title: 'Outline', lowest: 11.0, currency: 'EUR', shipping: 0, shipsFrom: 'Netherlands', numForSale: 22, vgPlusCount: 8, reference: 30, referenceSource: 'suggestion', discount: 0.63, conditionConfirmed: true, mediaCondition: 'Near Mint (NM or M-)', sleeveCondition: 'Very Good (VG)', freshListing: false, ownDrop: 0.2, spark: [13, 12, 12.5, 11.5, 12, 11.5, 12, 11.5, 11, 11.5, 11, 11], listingUrl: 'https://www.discogs.com/sell/item/222', url: 'https://www.discogs.com/sell/item/222', ts: Date.now() - 90 * 60000, thumb: '' },
  // Unconfirmed (cloud/API) deals: condition unknown -> only a price-proxy estimate, hidden by "VG+ only".
  { id: 'demo3', releaseId: 12345, artist: 'Klein & M.B.O.', title: 'Dirty Talk', lowest: 4.0, currency: 'EUR', numForSale: 3, reference: 26, referenceSource: 'trailing-median', discount: 0.85, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: false, ownDrop: 0.7, url: 'https://www.discogs.com/sell/release/12345?sort=price%2Casc', ts: Date.now() - 32 * 60000, thumb: '' },
  { id: 'demo4', releaseId: 1111, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 2.0, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'suggestion', discount: 0.98, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: true, ownDrop: 0.9, url: 'https://www.discogs.com/sell/release/1111?sort=price%2Casc', ts: Date.now() - 1 * 60000, thumb: '' },
];

// Demo data for the 💎 Rare tab (browser preview only).
const DEMO_GEMS = {
  ts: Date.now(),
  gems: [
    { id: 'dg1', releaseId: 1111, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 95, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'sold-median', url: 'https://www.discogs.com/sell/release/1111?sort=price%2Casc', ts: Date.now() - 12 * 60000, thumb: '' },
    { id: 'dg2', releaseId: 2222, artist: 'Squash Gang', title: 'I Want An Illusion', lowest: 40, currency: 'EUR', numForSale: 2, reference: null, referenceSource: null, url: 'https://www.discogs.com/sell/release/2222?sort=price%2Casc', ts: Date.now() - 3 * 3600000, thumb: '' },
  ],
  zeroWatch: [
    { releaseId: 3333, artist: 'Fockewulf 190', title: 'Body Heat', year: 1984 },
    { releaseId: 4444, artist: 'Ago', title: 'You Make Me Do It', year: 1985 },
    { releaseId: 5555, artist: 'Cellophane', title: 'Music Colours', year: 1983 },
  ],
};

let allDeals = [];
let allNearMisses = [];   // releases that looked cheap but didn't qualify (scan only) — see "Show near-misses"
let seenIds = new Set();
let firstLoad = true;
let viewMode = 'cloud';   // 'cloud' | 'scan'

let activeTab = 'deals';  // 'deals' | 'gems' — the 💎 Rare tab shows rare appearances + the zero-stock watch list
let gemsData = { ts: null, gems: [], zeroWatch: [] };
let seenGemIds = new Set();
let firstGemLoad = true;
let scanning = false;
let scannedOnce = false;  // has a local scan run (or its results been loaded) this session? Distinguishes
                          // "no scan yet — go scan" from "scanned, nothing matched right now".

const $ = (id) => document.getElementById(id);
const openUrl = (url) => { if (!url) return; if (hasApi) window.api.openExternal(url); else window.open(url, '_blank'); };

// --- Dismiss / snooze (client-side, persisted) ---
// Keyed by releaseId (deal ids change every sweep; the release is the stable identity). A dismissed
// release is hidden until you tick "show hidden" and restore it — keeps deals you've already judged
// out of the way without losing them.
const DISMISS_KEY = 'ddw-dismissed';
function loadDismissed() { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]').map(String)); } catch { return new Set(); } }
let dismissed = loadDismissed();
const saveDismissed = () => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed])); } catch { /* private mode */ } };
const sym = (c) => ({ EUR: '€', USD: '$', GBP: '£' }[c] || '');
const money = (v, c) => (v == null ? '—' : sym(c) + Number(v).toFixed(2));
const pct = (d) => (d == null ? '—' : Math.round(d * 100) + '%');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const REF_LABEL = { 'sold-median': 'real sold median', suggestion: 'VG+ suggested', 'trailing-median': 'usual lowest' };

// "Very Good Plus (VG+)" -> "VG+"
const gradeShort = (g) => { if (!g) return null; const m = String(g).match(/\(([^)]+)\)/); return m ? m[1] : g; };
const GOOD_GRADES = new Set(['M', 'NM or M-', 'NM', 'M-', 'VG+']); // VG+ or better
const VGPLUS_RANK = 2; // Discogs grade ladder: M=0, NM=1, VG+=2, VG=3, G+=4, G=5, F=6, P=7

// Rank a (possibly messy) condition label on the Discogs ladder. Confirmed conditions arrive in
// the full "Very Good Plus (VG+)" form, so the short-code map covers them; the text fallback
// tolerates anything else. Returns null when unrecognized.
const RANK_BY_SHORT = { M: 0, 'NM or M-': 1, NM: 1, 'M-': 1, 'VG+': 2, VG: 3, 'G+': 4, G: 5, F: 6, P: 7 };
function gradeRank(label) {
  if (!label) return null;
  const s = gradeShort(label);
  if (s != null && s in RANK_BY_SHORT) return RANK_BY_SHORT[s];
  const t = String(label).toLowerCase();
  if (t.includes('near mint') || /\bnm\b/.test(t)) return 1;
  if (t.includes('mint') || /\bm\b/.test(t)) return 0;
  if (t.includes('very good plus') || t.includes('vg+')) return 2;
  if (t.includes('very good') || /\bvg\b/.test(t)) return 3;
  if (t.includes('good plus') || t.includes('g+')) return 4;
  if (t.includes('good')) return 5;
  if (t.includes('fair')) return 6;
  if (t.includes('poor')) return 7;
  return null;
}

// Is this deal VG+ or better? Confirmed deals use the REAL media grade (a guarantee); unconfirmed
// deals fall back to the price proxy (not flagged worn or suspiciously low) — best effort only.
function isVgPlus(d) {
  if (d.conditionConfirmed && d.mediaCondition) { const r = gradeRank(d.mediaCondition); return r != null && r <= VGPLUS_RANK; }
  return !d.pricedAsWorn && !d.suspicious;
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

const shipVal = () => parseFloat($('shipEst').value) || 0;

// "No longer listed" means exactly that: the release has NO copies for sale right now — not merely
// that the price rose since the alert. A copy that's still there at a higher price is upgraded to
// that price (see applyVerify) and left to the % slider, so cloud and scan agree on what's a deal.
// (Earlier this also fired when the lowest price crept above the alerted price, which wrongly exiled
// still-buyable copies to history — and made them "reappear" the moment a scan re-evaluated them.)
// Scan deals never carry `current` (they're live by definition), so this is naturally cloud-only.
function dealGone(d) {
  if (!d.current) return false;
  const cur = d.current;
  return cur.numForSale === 0 || cur.lowest == null;
}

// --- Automatic live verification of the cloud feed --------------------------
// On every refresh the visible cloud deals + gems are re-checked against the LIVE marketplace
// through the same residential-IP pipeline the scan uses (main.js caches results 30 min, so the
// 30s poll is free). A verified card gets the copy's REAL condition + shipping + a direct buy
// link — so "VG+ only" and Best-first mean the same thing everywhere — and a card whose price no
// longer exists moves to the collapsed history section instead of posing as a live deal.
let verifyInfo = { running: false, done: 0, total: 0 };
let verifyBusy = false;
let goneHistoryOpen = false; // remember the <details> state across re-renders

async function maybeVerify() {
  if (!hasApi || scanning || verifyBusy) return;
  // In the (default) scan view the deal cards are already live/condition-verified by the scan
  // itself — only the 💎 gems need the live check. Cloud deal cards (if that view is ever shown)
  // get the full treatment.
  const items = [
    ...(viewMode === 'cloud' ? allDeals.map((d) => ({ releaseId: d.releaseId, currency: d.currency })) : []),
    ...((gemsData.gems || []).map((g) => ({ releaseId: g.releaseId, currency: g.currency }))),
  ].filter((x) => x.releaseId != null);
  if (!items.length) return;
  verifyBusy = true;
  try {
    const res = await window.api.verifyDeals(items);
    if (res && res.results && Object.keys(res.results).length) applyVerify(res.results);
  } catch { /* verification is best-effort — the cards just keep their API-only estimates */ }
  finally { verifyBusy = false; }
}

function applyVerify(results) {
  // Scan deals are already live data — never overwrite them with a (release-level) verify result;
  // only cloud alert cards get upgraded. Gems are handled below in every view.
  if (viewMode === 'cloud') allDeals = allDeals.map((d) => {
    const r = results[d.releaseId];
    if (!r || r.error) return d; // unverifiable -> keep the honest API-only estimate
    const cur = r.cheapest;
    const copies = r.copies || 0;
    // `current` feeds dealGone() + the badge. numForSale is what decides "no longer listed": only a
    // release with ZERO copies is history. A copy that merely got pricier is upgraded below and left
    // to the % slider — the same call a scan makes, so the two views can't diverge.
    const base = { ...d, verified: true, current: { lowest: cur ? cur.price : null, numForSale: copies, ts: r.ts } };
    if (!cur || copies === 0) return base; // nothing for sale -> history
    // Upgrade the card to the LIVE cheapest copy: real grade, real shipping, direct listing link.
    // If it's no longer cheap enough vs the reference, enrich()'s recomputed discount drops it below
    // the % slider and it falls out naturally (exactly as a scan would treat it) — no dead price shown.
    const alt = (r.bestVgPlus && (!cur.itemId || r.bestVgPlus.itemId !== cur.itemId)) ? r.bestVgPlus : null;
    return {
      ...base,
      lowest: cur.price, currency: cur.currency || d.currency,
      conditionConfirmed: !!cur.media, mediaCondition: cur.media, sleeveCondition: cur.sleeve,
      shipping: cur.shipping, shippingSource: cur.shippingSource, shipsFrom: cur.shipsFrom || d.shipsFrom,
      vgPlusCount: r.vgPlusCount, copiesSeen: copies,
      listingUrl: cur.url || d.listingUrl || null, url: cur.url || d.url,
      altGrade: alt ? alt.media : null, altPrice: alt ? (alt.price != null ? alt.price + (alt.shipping || 0) : null) : null, altUrl: alt ? alt.url : null,
    };
  });
  if (gemsData.gems && gemsData.gems.length) {
    gemsData = {
      ...gemsData,
      gems: gemsData.gems.map((g) => {
        const r = results[g.releaseId];
        if (!r || r.error) return g;
        const cur = r.cheapest;
        return { ...g, verified: true, gone: !cur, currentLowest: cur ? cur.price : null, currentMedia: cur ? cur.media : null };
      }),
    };
    updateGemsBadge();
  }
  render();
}

// Attach shipping-aware totals + a ranking score to a deal. When the deal carries REAL per-copy
// shipping (a scan-confirmed copy), use it (incl. €0 = free); otherwise fall back to the slider.
function enrich(d) {
  const shipReal = d.shipping != null;
  const ship = shipReal ? d.shipping : shipVal();
  const ref = d.reference;
  const total = d.lowest != null ? d.lowest + ship : null;
  const eff = (ref && total != null) ? 1 - total / ref : (d.discount ?? null);
  const savings = (ref && total != null) ? ref - total : null;
  let score = (eff || 0) * 40 + Math.min(Math.max(savings || 0, 0), 80) / 80 * 40 + (d.ownDrop || 0) * 20;
  const n = d.numForSale;
  if (n != null) score += n <= 3 ? 15 : (n <= 10 ? 7 : 0);
  if (d.freshListing) score += 10;
  if (d.conditionConfirmed) score += 14;           // a KNOWN-VG+ copy beats a price-guess
  else { if (d.pricedAsWorn) score -= 12; if (d.suspicious) score -= 5; }
  if (d.cheapVgPlusCount > 1) score += Math.min(d.cheapVgPlusCount, 8) * 2; // a cluster = real drop, low risk
  const gone = dealGone(d);
  if (gone) score -= 60; // a dead price should never outrank a live deal in Best-first
  return Object.assign({}, d, { _ship: ship, _shipReal: shipReal, _total: total, _eff: eff, _savings: savings, _score: score, _gone: gone });
}

// The condition chip. For a scan-confirmed deal it shows the REAL media grade read off the live
// listing (green ✓ when VG+ or better) — the certainty the user asked for. For an unconfirmed
// (cloud/API) deal it falls back to the old price-proxy ESTIMATE (≈), clearly marked as a guess.
function conditionChip(d) {
  if (d.conditionConfirmed && d.mediaCondition) {
    const g = gradeShort(d.mediaCondition);
    const ok = isVgPlus(d);
    const sleeve = d.sleeveCondition ? ` · sleeve ${esc(gradeShort(d.sleeveCondition))}` : '';
    return `<span class="tag ${ok ? 'good' : 'warn'}" title="Confirmed from the live marketplace listing">✓ media ${esc(g)}${sleeve}</span>`;
  }
  // Unconfirmed: a price-proxy estimate only.
  if (d.impliedGrade) {
    const g = gradeShort(d.impliedGrade);
    const cls = d.pricedAsWorn ? 'warn' : (GOOD_GRADES.has(g) ? 'good' : '');
    return `<span class="tag ${cls}" title="Estimate from price only — condition not verified">≈ priced as ${esc(g)}</span>`;
  }
  if (d.impliedGrade === null && (d.pricedAsWorn || d.suspicious)) return `<span class="tag warn" title="Estimate from price only — condition not verified">≈ ≤ Good · very cheap</span>`;
  if (d.suspicious) return `<span class="tag warn" title="Estimate from price only — condition not verified">⚠ maybe below VG+</span>`;
  return `<span class="tag" title="Condition not verified — check on Discogs">condition unknown</span>`;
}

// Tiny inline SVG of the release's recent lowest-price trail (oldest -> newest). Lets you see at a
// glance whether the current price is a real dip or just the release's normal floor. The last point
// is dotted green when it's the lowest in the window (a genuine new low), amber otherwise.
function sparkline(spark) {
  if (!Array.isArray(spark) || spark.length < 3) return '';
  const w = 72, h = 20, pad = 2;
  const min = Math.min(...spark), max = Math.max(...spark);
  const span = max - min || 1;
  const n = spark.length;
  const x = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = spark.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = spark[n - 1];
  const isLow = last <= min + 1e-9;
  const dotColor = isLow ? 'var(--green)' : 'var(--amber)';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--muted)" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2" fill="${dotColor}" />
  </svg>`;
}

function card(d) {
  const fresh = d.freshListing ? `<span class="tag fresh">🆕 just listed</span>` : '';
  const isHidden = dismissed.has(String(d.releaseId));
  const dismissBtn = isHidden
    ? `<button class="dismiss restore" data-rid="${esc(String(d.releaseId))}" title="Restore this deal">↩</button>`
    : `<button class="dismiss" data-rid="${esc(String(d.releaseId))}" title="Hide this deal">×</button>`;
  const spark = sparkline(d.spark);
  const ships = d.shipsFrom ? `<span class="tag">from ${esc(d.shipsFrom)}</span>` : '';
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  // Shipping line. A scan-confirmed copy carries the REAL shipping Discogs charges to ship to us
  // (shown plainly, no "est."); a cloud/unconfirmed deal has no per-copy shipping, so it falls back
  // to the slider estimate — clearly marked "(est.)" so the two are never confused.
  const itemTxt = `${money(d.lowest, d.currency)} item`;
  const shipNote = d._shipReal
    ? (d._ship > 0 ? `${itemTxt} + ${money(d._ship, d.currency)} shipping` : `${itemTxt} · free shipping`)
    : (d._ship > 0 ? `${itemTxt} + ${money(d._ship, d.currency)} shipping (est.)` : `${itemTxt} · shipping unknown`);
  const shipTitle = d._shipReal
    ? (d.shippingSource === 'base' ? 'Real shipping (seller&#39;s flat rate, from the live listing)' : 'Real shipping to your location, from the live listing')
    : 'Estimated shipping (slider) — this deal has no per-copy shipping; run ⚡ Full scan for the real amount';
  const save = d._savings != null ? ` · save ${money(d._savings, d.currency)}` : '';
  const forSale = d.vgPlusCount != null
    ? `${esc(String(d.vgPlusCount))} VG+ of ${esc(String(d.numForSale ?? '?'))} for sale`
    : `${esc(String(d.numForSale ?? '?'))} for sale`;
  const worn = d.cheaperWornPrice != null
    ? `<div class="note">↘ a worse copy is cheaper at ${money(d.cheaperWornPrice, d.currency)}${d.cheaperWornCondition ? ` (${esc(gradeShort(d.cheaperWornCondition))})` : ''} — we picked the VG+ one</div>` : '';
  // Cluster: several VG+ copies all far under the reference = a real price drop, not a lone fluke.
  const cluster = d.cheapVgPlusCount > 1
    ? `<div class="note drop">📉 ${d.cheapVgPlusCount} VG+ copies ${money(d.cheapVgPlusLow, d.currency)}–${money(d.cheapVgPlusHigh, d.currency)} — likely a real price drop</div>` : '';
  // Slightly-dearer-but-better-grade alternative.
  const alt = (d.altGrade && d.altPrice != null)
    ? `<div class="note">↑ or ${money(d.altPrice, d.currency)} for a ${esc(gradeShort(d.altGrade))} copy${d.altUrl ? ` <a class="altlink" data-url="${esc(d.altUrl)}" href="#">view</a>` : ''}</div>` : '';
  const buyLabel = d.listingUrl ? 'Buy this copy on Discogs &rarr;' : 'View &amp; buy on Discogs &rarr;';
  // The alerted price is gone from the marketplace — state the fact, no guessing about why.
  const gone = d._gone
    ? `<span class="tag gone" title="The cloud watcher's latest check shows this price is no longer on the marketplace">⌛ no longer listed — ${d.current && d.current.lowest != null ? `cheapest is now ${money(d.current.lowest, d.currency)}` : 'no copies for sale'}</span>` : '';
  return `<article class="card${d.freshListing ? ' is-fresh' : ''}${d.conditionConfirmed ? ' is-verified' : ''}${isHidden ? ' is-hidden' : ''}${d._gone ? ' is-gone' : ''}">
    ${dismissBtn}
    <span class="when">${viewMode === 'scan' ? 'live' : ago(d.ts)}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="price-row">
        <span class="price">${money(d._total, d.currency)}</span>
        <span class="discount">${pct(d._eff)} off</span>
        ${spark}
      </div>
      <div class="subprice ${d._shipReal ? 'ship-real' : 'ship-est'}" title="${shipTitle}">${shipNote}</div>
      <div class="ref">vs ${money(d.reference, d.currency)} ${REF_LABEL[d.referenceSource] || 'ref'}${d.soldLow != null && d.soldHigh != null ? ` (${money(d.soldLow, d.currency)}–${money(d.soldHigh, d.currency)})` : ''}${save} · ${forSale}</div>
      ${cluster}
      ${worn}
      ${alt}
      <div class="meta">${gone}${fresh}${conditionChip(d)}${ships}</div>
      <button class="buy" data-url="${esc(d.url)}">${buyLabel}</button>
    </div>
  </article>`;
}

// --- Near-misses -----------------------------------------------------------
// A release that LOOKED cheap (passed the scan's Phase-1 prelim) but was rejected in confirmation.
// Opt-in (the "Show near-misses" box) and scan-only — it answers "why isn't release X showing?".
function nearMissReason(d) {
  const ref = d.reference != null ? `${money(d.reference, d.currency)} ${REF_LABEL[d.referenceSource] || 'ref'}` : 'its reference';
  if (d.reasonCode === 'no-vgplus') {
    const cheap = d.cheapestPrice != null ? money(d.cheapestPrice, d.currency) : 'the cheapest copy';
    const g = d.cheapestGrade ? ` (${esc(gradeShort(d.cheapestGrade))})` : '';
    const seen = d.copiesSeen ? ` ${d.copiesSeen} copies for sale, none VG+.` : '';
    return `No VG+ copy for sale — cheapest is ${cheap}${g}, below VG+.${seen}`;
  }
  // How far under the 40% bar was it? "2% short" is worth a look; "30% short" isn't — surfacing the
  // gap makes the near-miss list scannable (it's already sorted closest-first within each reason).
  const gapTxt = (eff) => {
    if (eff == null) return '';
    const gap = Math.round((0.4 - eff) * 100);
    return gap <= 0 ? '' : (gap <= 5 ? ` <b>Only ${gap}% short of the bar.</b>` : ` ${gap}% short of the bar.`);
  };
  if (d.reasonCode === 'vgplus-not-cheap') {
    const ship = d.shipping != null && d.shipping > 0 ? ` + ${money(d.shipping, d.currency)} ship` : '';
    return `Cheapest VG+ copy is ${money(d.bestPrice, d.currency)}${ship} = <b>${pct(d.effectiveDiscount)} off</b> vs ${ref} — under the 40% scan threshold.${gapTxt(d.effectiveDiscount ?? d.discount)}`;
  }
  if (d.reasonCode === 'unconfirmed-not-cheap') {
    return `Couldn't read condition. Cheapest ${money(d.lowest, d.currency)} ≈ <b>${pct(d.discount)} off</b> vs ${ref} — under 40%.${gapTxt(d.discount)}`;
  }
  return 'Looked cheap but didn’t qualify.';
}

function nearMissCard(d) {
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  return `<article class="card is-nearmiss">
    <span class="when">missed</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="why">${nearMissReason(d)}</div>
      <button class="buy ghostbuy" data-url="${esc(d.url || d.releaseUrl)}">View on Discogs &rarr;</button>
    </div>
  </article>`;
}

// Near-misses ignore the deal sliders (they explicitly DIDN'T qualify) — only the search box applies,
// so you can look one up by name.
function filterNearMisses(list) {
  const q = $('search').value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((d) => `${d.artist || ''} ${d.title || ''}`.toLowerCase().includes(q));
}

// --- 💎 Rare gems tab ---------------------------------------------------------
// A gem = a wantlist release that had ZERO copies for sale and just got its first. Price is
// deliberately not a filter here (availability IS the signal), so the tab bypasses the deal
// sliders entirely — only the search box applies (to gems AND the watch list).
function gemCard(g) {
  const thumb = g.thumb
    ? `<img class="thumb" src="${esc(g.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  const appeared = g.numForSale === 1 ? 'first copy appeared' : `${esc(String(g.numForSale))} copies appeared`;
  const ref = g.reference != null
    ? `<div class="ref">worth ~${money(g.reference, g.currency)} (${REF_LABEL[g.referenceSource] || 'reference'})</div>` : '';
  // Live verification (same pipeline as the deals): still for sale, and in what condition?
  const live = g.gone
    ? `<span class="tag gone" title="The live marketplace check no longer finds any copy for sale">⌛ no longer listed</span>`
    : (g.verified && g.currentMedia
        ? `<span class="tag good" title="Confirmed from the live marketplace listing">✓ media ${esc(gradeShort(g.currentMedia))}${g.currentLowest != null && g.currentLowest !== g.lowest ? ` · now ${money(g.currentLowest, g.currency)}` : ''}</span>`
        : '');
  return `<article class="card is-gem${g.gone ? ' is-gone' : ''}">
    <span class="when">${g.ts ? ago(g.ts) : ''}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(g.title || 'Release ' + g.releaseId)}</p>
      <p class="artist">${esc(g.artist || '')}${g.year ? ` · ${esc(String(g.year))}` : ''}</p>
      <div class="meta"><span class="tag gem">💎 was 0 for sale — ${appeared}</span>${live}</div>
      <div class="price-row"><span class="price gem-price">${money(g.lowest, g.currency)}</span><span class="gem-ask">asking price — unfiltered</span></div>
      ${ref}
      <button class="buy gembuy" data-url="${esc(g.url)}">View &amp; buy on Discogs &rarr;</button>
    </div>
  </article>`;
}

function zwRow(r) {
  const name = `${r.artist ? r.artist + ' – ' : ''}${r.title || 'Release ' + r.releaseId}`;
  return `<div class="zw-row">
    <span class="zw-dot"></span>
    <span class="zw-title" title="${esc(name)}">${esc(name)}</span>
    ${r.year ? `<span class="zw-year">${esc(String(r.year))}</span>` : ''}
    <a class="zw-link" data-url="${esc('https://www.discogs.com/release/' + r.releaseId)}" href="#">view</a>
  </div>`;
}

function renderGems() {
  const wrap = $('deals');
  const empty = $('empty');
  const q = $('search').value.trim().toLowerCase();
  const match = (x) => !q || `${x.artist || ''} ${x.title || ''}`.toLowerCase().includes(q);
  const gems = (gemsData.gems || []).filter(match);
  const zw = (gemsData.zeroWatch || []).filter(match);
  $('resultCount').textContent = '';
  $('pill-deals').textContent = `${(gemsData.gems || []).length} gem${(gemsData.gems || []).length === 1 ? '' : 's'}`;

  if (!gems.length && !zw.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = q
      ? 'Nothing on the Rare tab matches your search.'
      : 'No rare gems yet. Once your wantlist has been swept, releases with ZERO copies for sale are watched here — and the moment the first copy appears it shows up (and lands in your inbox), whatever the price.';
    return;
  }
  empty.classList.add('hidden');

  let html = '';
  if (gems.length) {
    html += `<div class="gems-head">💎 Rare appearances — the first copy showed up after none at all</div>`;
    html += gems.map(gemCard).join('');
  } else if (!q) {
    html += `<div class="gems-head muted">💎 No rare appearances yet — the list below is being watched. The moment a first copy shows up it lands here and in your inbox, whatever the price.</div>`;
  }
  if (zw.length) {
    html += `<div class="zw-head">👁 Watching ${zw.length} wantlist release${zw.length === 1 ? '' : 's'} with <b>0 copies for sale</b> — the moment one appears it alerts, at any price</div>`;
    html += `<div class="zw-list">${zw.map(zwRow).join('')}</div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => openUrl(b.getAttribute('data-url'))));
  wrap.querySelectorAll('.zw-link').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUrl(a.getAttribute('data-url')); }));
}

function updateGemsBadge() {
  const n = (gemsData.gems || []).length;
  const el = $('gems-count');
  el.textContent = n ? String(n) : '';
  el.classList.toggle('hidden', !n);
}

function normalizeGems(g) {
  if (Array.isArray(g)) return { ts: null, gems: g, zeroWatch: [] };
  if (!g || typeof g !== 'object') return { ts: null, gems: [], zeroWatch: [] };
  return { ts: g.ts || null, gems: Array.isArray(g.gems) ? g.gems : [], zeroWatch: Array.isArray(g.zeroWatch) ? g.zeroWatch : [] };
}

function notifyNewGems(gems) {
  if (firstGemLoad) { firstGemLoad = false; gems.forEach((g) => seenGemIds.add(g.id)); return; }
  const fresh = gems.filter((g) => !seenGemIds.has(g.id));
  fresh.forEach((g) => seenGemIds.add(g.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const g = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    const n = new Notification(`💎 Rare find: ${g.artist || ''} – ${g.title || ''}`, {
      body: `Had 0 copies for sale — first one appeared at ${money(g.lowest, g.currency)}${extra}`,
    });
    n.onclick = () => { openUrl(g.url); window.focus(); };
  }
}

async function refreshGems() {
  if (!hasApi) { gemsData = DEMO_GEMS; updateGemsBadge(); if (activeTab === 'gems') render(); return; }
  try {
    gemsData = normalizeGems(await window.api.getGems());
    notifyNewGems(gemsData.gems);
    updateGemsBadge();
    if (activeTab === 'gems') render();
    maybeVerify(); // gems join the same live listings check (cached in main, usually free)
  } catch { /* keep the last known gems — the deals path surfaces connectivity problems */ }
}

function setTab(tab) {
  activeTab = tab;
  document.body.classList.toggle('tab-gems', tab === 'gems');
  $('tab-deals').classList.toggle('active', tab === 'deals');
  $('tab-gems').classList.toggle('active', tab === 'gems');
  render();
}

function applyFilters(deals, opts = {}) {
  const q = $('search').value.trim().toLowerCase();
  const minV = parseFloat($('minValue').value) || 0;
  const minD = parseInt($('minDiscount').value, 10) / 100;
  const maxT = parseFloat($('maxTotal').value) || 0;
  const freshOnly = $('freshOnly').checked;
  // opts.ignoreVg lets render() count how many deals are removed SOLELY by "VG+ only".
  const vgOnly = opts.ignoreVg ? false : $('vgPlusOnly').checked;
  const showHidden = $('showHidden').checked;
  return deals.filter((d) => {
    if (!showHidden && dismissed.has(String(d.releaseId))) return false;
    if (minV > 0 && (d.reference == null || d.reference < minV)) return false;
    if ((d._eff ?? 0) < minD) return false;
    if (maxT > 0 && (d._total == null || d._total > maxT)) return false;
    if (freshOnly && !d.freshListing) return false;
    if (vgOnly && !isVgPlus(d)) return false;
    if (q) {
      const hay = `${d.artist || ''} ${d.title || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortDeals(list, mode) {
  const c = list.slice();
  if (mode === 'discount') c.sort((a, b) => (b._eff ?? 0) - (a._eff ?? 0));
  else if (mode === 'total') c.sort((a, b) => (a._total ?? 1e9) - (b._total ?? 1e9));
  else if (mode === 'savings') c.sort((a, b) => (b._savings ?? 0) - (a._savings ?? 0));
  else if (mode === 'newest') c.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  else c.sort((a, b) => (b._score ?? 0) - (a._score ?? 0)); // best
  return c;
}

// Enrichment cache: enrich() only depends on the loaded deals + the shipping slider, but render()
// runs on every keypress/slider move — re-enriching hundreds of deals per keystroke made the filter
// inputs laggy. allDeals is only ever REASSIGNED (never mutated in place), so a reference check is
// a safe cache key.
let enrichCache = { src: null, ship: null, list: [] };

function render() {
  if (activeTab === 'gems') return renderGems();
  const ship = shipVal();
  if (enrichCache.src !== allDeals || enrichCache.ship !== ship) enrichCache = { src: allDeals, ship, list: allDeals.map(enrich) };
  const enriched = enrichCache.list;
  let deals = applyFilters(enriched);
  // How many deals pass every OTHER filter but are removed SOLELY by "VG+ only"? Cloud/email deals
  // can never carry a confirmed grade, so "VG+ only" silently hides every one of them — which is
  // exactly why a deal you were emailed can be invisible here. Surface the number so it's never silent.
  const vgHidden = $('vgPlusOnly').checked ? Math.max(0, applyFilters(enriched, { ignoreVg: true }).length - deals.length) : 0;
  deals = sortDeals(deals, $('sortBy').value);
  // Cards whose price no longer exists on the marketplace are history, not deals: they move to a
  // collapsed section at the bottom instead of sitting (struck-through) between the live cards.
  const goneDeals = deals.filter((d) => d._gone);
  deals = deals.filter((d) => !d._gone);
  // Near-misses: opt-in, scan-only. Rendered below the deals with the reason each didn't qualify.
  const showMiss = $('showNearMiss').checked && viewMode === 'scan' && allNearMisses.length > 0;
  const misses = showMiss ? filterNearMisses(allNearMisses) : [];
  const wrap = $('deals');
  const empty = $('empty');
  const hiddenCount = allDeals.reduce((acc, d) => acc + (dismissed.has(String(d.releaseId)) ? 1 : 0), 0);
  const hiddenNote = hiddenCount ? ` · ${hiddenCount} hidden` : '';
  const vgNote = vgHidden ? ` · ${vgHidden} hidden by “VG+ only”` : '';
  $('pill-deals').textContent = `${allDeals.length} deal${allDeals.length === 1 ? '' : 's'}`;
  const verifyNote = verifyInfo.running ? ` · ✓ checking listings ${Math.min(verifyInfo.done + 1, verifyInfo.total)}/${verifyInfo.total}…` : '';
  $('resultCount').textContent = (deals.length || verifyNote) ? `${deals.length} of ${allDeals.length}${hiddenNote}${vgNote}${viewMode === 'scan' ? ' · live scan' : ''}${verifyNote}` : '';
  if (!deals.length && !misses.length && !goneDeals.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = allDeals.length
      ? (vgHidden
          ? `${vgHidden} deal${vgHidden === 1 ? '' : 's'} hidden by “VG+ only” — untick it to see ${vgHidden === 1 ? 'it' : 'them'} (cloud/email deals can’t be condition-verified).`
          : 'No deals match your filters — loosen the sliders.')
      : (viewMode === 'scan'
          ? (scannedOnce
              ? 'Scan finished — no confirmed VG+ copies meet your discount threshold right now.'
              : 'No scan yet. Hit ⚡ Full scan to sweep your wantlist for verified-VG+ bargains.')
          : 'No deals yet — hit ⚡ Full scan.');
    return;
  }
  empty.classList.add('hidden');
  let html = deals.map(card).join('');
  if (misses.length) {
    html += `<div class="nearmiss-head">↓ Near-misses — looked cheap but didn’t qualify (${misses.length})</div>`;
    html += misses.map(nearMissCard).join('');
  }
  if (goneDeals.length) {
    html += `<details class="gone-history"${goneHistoryOpen ? ' open' : ''}><summary>⌛ No longer listed — kept as history (${goneDeals.length})</summary><div class="gone-grid">${goneDeals.map(card).join('')}</div></details>`;
  }
  wrap.innerHTML = html;
  const hist = wrap.querySelector('.gone-history');
  if (hist) hist.addEventListener('toggle', () => { goneHistoryOpen = hist.open; });
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => openUrl(b.getAttribute('data-url'))));
  wrap.querySelectorAll('.altlink').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUrl(a.getAttribute('data-url')); }));
  wrap.querySelectorAll('.dismiss').forEach((b) => b.addEventListener('click', () => {
    const rid = b.getAttribute('data-rid');
    if (dismissed.has(rid)) dismissed.delete(rid); else dismissed.add(rid);
    saveDismissed();
    render();
  }));
}

// Supporting pills only (wantlist size). Connectivity + freshness now live in the service badge.
function setStatus(statusObj) {
  if (!statusObj) return;
  $('pill-wantlist').textContent = `wantlist ${statusObj.wantlistSize ?? '—'}`;
}

// --- Live-service badge ---------------------------------------------------
// Turns the health object from main into a colored, pulsing "is the watcher running?" indicator.
// This is the thing the user watches to know the email/sweep service is alive — not just that the
// deals source happens to be reachable.
let lastHealth = null;
let lastGithubRun = null; // remembered so a transient GitHub rate-limit doesn't blank the badge

function setServiceBadge(h) {
  const badge = $('svc-badge'), label = $('svc-label'), sweep = $('pill-sweep');
  let state = 'idle', text = 'checking…', sub = '', title = 'Service status', url = null;

  if (scanning) {
    state = 'scan'; text = 'Scanning…'; title = 'A local scan is running right now.';
  } else if (!h || h.mode === 'demo') {
    state = 'idle'; text = h ? 'demo' : 'checking…';
    title = h ? 'Preview mode — no live service connection.' : 'Checking the service…';
  } else if (h.mode === 'server') {
    if (!h.ok) { state = 'down'; text = 'Offline'; title = 'Cannot reach the watcher server: ' + (h.error || 'unknown'); }
    else {
      const last = h.status && h.status.lastSweepAt;
      const ageM = last ? (Date.now() - last) / 60000 : 0; // reachable but no sweep yet = freshly up, treat as live
      state = ageM < 30 ? 'live' : (ageM < 120 ? 'delayed' : 'down');
      text = state === 'live' ? 'Live' : (state === 'delayed' ? 'Idle' : 'Stale');
      sub = last ? `swept ${ago(last)}` : 'connected';
      title = `Watcher server reachable${last ? ` · last sweep ${ago(last)}` : ''}.`;
    }
  } else if (h.mode === 'local') {
    // Local-scan mode: no cloud service to monitor. The badge reflects the last scan instead.
    const last = h.lastScanAt;
    state = 'idle'; text = 'Local';
    sub = last ? `scanned ${ago(last)}` : 'no scan yet';
    title = 'Local-scan mode — no cloud watcher. Use ⚡ Full scan to refresh deals.';
  } else { // github
    const run = (h.ok && h.run) ? h.run : (h.rateLimited ? lastGithubRun : null);
    if (!run) {
      if (h.rateLimited) { state = 'idle'; text = 'checking…'; title = 'GitHub status check is rate-limited; retrying shortly. (The cron itself is unaffected.)'; }
      else if (h.notFound) { state = 'down'; text = 'No runs'; title = 'No workflow runs found for this repo yet.'; }
      else if (!h.ok) { state = 'down'; text = 'Unknown'; title = 'Cannot reach GitHub to check the service: ' + (h.error || 'unknown'); }
      else { state = 'down'; text = 'Never run'; title = 'The scheduled workflow has not run yet.'; }
    } else {
      const when = run.startedAt || run.updatedAt;
      const ageM = when ? (Date.now() - when) / 60000 : Infinity;
      const running = run.status && run.status !== 'completed';
      const failed = run.conclusion === 'failure';
      const concl = running ? 'in progress' : (run.conclusion || 'unknown');
      // GitHub deprioritizes scheduled runs on public repos and often delays/skips ticks, so the
      // bands are forgiving: amber "Delayed" (not red) absorbs the normal hiccups, and only a long
      // silence (>90 min ≈ 6 missed ticks) goes red. A FAILED run is always red — that's the case
      // that actually stops the deal emails.
      if (running && ageM < 45) { state = 'live'; text = 'Running now'; }
      else if (failed && ageM < 120) { state = 'fail'; text = 'Run failed'; }
      else if (ageM < 30) { state = 'live'; text = 'Live'; }
      else if (ageM < 90) { state = 'delayed'; text = 'Delayed'; }
      else { state = 'down'; text = 'Down'; }
      sub = when ? `ran ${ago(when)}` : '';
      if (h.rateLimited) sub = sub ? sub + ' · rechecking' : 'rechecking';
      title = state === 'fail'
        ? `Last scheduled run FAILED (${ago(when)}) — deal emails may not be sending. Click to inspect on GitHub.`
        : state === 'delayed'
          ? `Last run ${ago(when)} (${concl}). GitHub sometimes delays scheduled runs under load — usually self-corrects. Click to open Actions.`
          : state === 'down'
            ? `No scheduled run in over 90 minutes (last ${when ? ago(when) : 'never'}). The cron may be paused or broken — click to check GitHub Actions.`
            : `Live — sweeps every ~15 min. Last run ${ago(when)} (${concl}). Click to open Actions.`;
      url = run.url;
    }
    if (!url && h.repo) url = `https://github.com/${h.repo}/actions`;
  }

  badge.className = 'svc ' + state;
  label.textContent = text;
  badge.title = title;
  badge.dataset.url = url || '';
  if (sweep) sweep.textContent = sub;
}

// --- Cron pill: "when did the cloud cron actually FIRE?" -------------------
// Shows the last real firing of the email watcher's GitHub Actions cron — and how long ago — in
// EVERY source mode (in local-scan mode the repo is auto-derived from the checkout's git remote).
// The tooltip lists the recent fires + the measured cadence: GitHub deprioritizes public-repo
// schedule crons, so the REQUESTED */15 fires every ~60-90 min in practice — this pill is the
// honest view of that. Click opens the Actions page.
function setCronPill(h) {
  const el = $('pill-cron');
  if (!el) return;
  const c = h && (h.mode === 'github' ? h : h.cron); // github mode: the health object IS the cron info
  const run = (c && c.ok && c.run) ? c.run : null;
  if (!run) { if (!(c && c.rateLimited)) el.classList.add('hidden'); return; } // keep last known text through a rate-limit blip
  el.classList.remove('hidden');
  const when = run.startedAt || run.updatedAt;
  const running = run.status && run.status !== 'completed';
  if (running) el.textContent = `☁ cloud scan running · started ${ago(when)}`;
  else el.textContent = `☁ cloud scan ran ${ago(when)}${run.conclusion === 'failure' ? ' · ⚠ failed' : ''}`;
  el.classList.toggle('bad', run.conclusion === 'failure');

  const recent = (c.recent || []).filter((r) => r.startedAt);
  const lines = recent.slice(0, 6).map((r) => {
    const state = (r.status && r.status !== 'completed') ? 'running'
      : (r.conclusion === 'success' ? '✓' : (r.conclusion || '?'));
    const dur = (r.updatedAt && r.startedAt && r.status === 'completed') ? ` · ${Math.max(1, Math.round((r.updatedAt - r.startedAt) / 60000))} min` : '';
    return `• ${ago(r.startedAt)} — ${r.event === 'schedule' ? 'auto' : 'manual'} ${state}${dur}`;
  }).join('\n');
  // Measured cadence over the recent SCHEDULED runs (manual/dispatch runs excluded).
  const sched = recent.filter((r) => r.event === 'schedule').map((r) => r.startedAt).sort((a, b) => b - a);
  let cadence = '';
  if (sched.length >= 3) {
    const gaps = [];
    for (let i = 0; i < sched.length - 1; i++) gaps.push(sched[i] - sched[i + 1]);
    cadence = `\nRuns automatically every ~${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000)} min in practice (GitHub delays the requested 15-min schedule on free repos).`;
  }
  el.title = `Cloud scan — the watcher on GitHub that sweeps your wantlist and emails deals. Recent runs:\n${lines}${cadence}\nClick to open the run on GitHub.`;
  el.dataset.url = run.url || (c.repo ? `https://github.com/${c.repo}/actions` : '');
}

async function refreshHealth() {
  if (scanning) { setServiceBadge(lastHealth); return; } // the scan owns the badge while it runs
  if (!hasApi) { setServiceBadge({ mode: 'demo' }); return; }
  let h = null;
  try { h = await window.api.getHealth(); } catch { h = null; }
  if (h && h.mode === 'github' && h.ok && h.run) lastGithubRun = h.run;
  lastHealth = h;
  setServiceBadge(h);
  setCronPill(h);
}

// --- Sold-medians push badge -------------------------------------------------
// The local scan's git push of soldmedians.json is what keeps the CLOUD emails judging against
// real market value. A failed push used to flash by in the scan-status line and vanish — weeks of
// silently-stale references. This badge persists the last outcome: green "medians ✓", red "push
// failed" (click = retry). Hidden entirely when pushing doesn't apply (packaged install / disabled).
let pushRetrying = false;
async function refreshPushStatus() {
  if (!hasApi || typeof window.api.getPushStatus !== 'function') return;
  const el = $('push-badge');
  if (!el || pushRetrying) return;
  let st = null;
  try { st = await window.api.getPushStatus(); } catch { st = null; }
  if (!st) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (st.ok) {
    el.className = 'pill push ok';
    el.textContent = `medians ✓ ${st.ts ? ago(st.ts) : ''}`.trim();
    el.title = st.pushed
      ? 'Sold-medians pushed to GitHub — the cloud emails judge against fresh real-market references.'
      : 'Sold-medians already up to date on GitHub.';
  } else {
    el.className = 'pill push bad';
    el.textContent = '⚠ medians push failed';
    el.title = `Pushing soldmedians.json to GitHub failed: ${st.reason || 'git error'}\nThe cloud emails are judging against stale references until this succeeds. Click to retry.`;
  }
}
async function retryPushClick() {
  if (!hasApi || typeof window.api.retryPush !== 'function' || pushRetrying) return;
  const el = $('push-badge');
  // Only a failed state needs the retry; a green badge click is a no-op.
  if (!el || !el.classList.contains('bad')) return;
  pushRetrying = true;
  el.textContent = 'pushing…';
  try { await window.api.retryPush(); } catch { /* outcome is persisted by main either way */ }
  pushRetrying = false;
  refreshPushStatus();
}

function notifyNew(deals) {
  if (firstLoad) { firstLoad = false; deals.forEach((d) => seenIds.add(d.id)); return; }
  const fresh = deals.filter((d) => !seenIds.has(d.id));
  fresh.forEach((d) => seenIds.add(d.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const d = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    const n = new Notification(`💸 Discogs deal: ${money(d.lowest, d.currency)} (${pct(d.discount)} off)`, {
      body: `${d.artist || ''} – ${d.title || ''}${extra}`,
    });
    // Click the notification -> open the deal straight on Discogs.
    n.onclick = () => { openUrl(d.url); window.focus(); };
  }
}

async function refresh() {
  if (viewMode === 'scan') return; // don't clobber live scan results
  allNearMisses = []; // cloud deals.json carries no near-misses — they exist only in a local scan
  if (!hasApi) {
    try {
      const r = await fetch('deals.json', { cache: 'no-store' });
      allDeals = r.ok ? await r.json() : DEMO;
    } catch { allDeals = DEMO; }
    setStatus({ wantlistSize: '—' });
    render();
    return;
  }
  try {
    const [deals, status] = await Promise.all([window.api.getDeals(200), window.api.getStatus().catch(() => null)]);
    allDeals = Array.isArray(deals) ? deals : [];
    notifyNew(allDeals);
    setStatus(status || {});
    render();
    maybeVerify(); // fire-and-forget: live-check the visible cards (cached in main, so usually free)
  } catch (e) {
    refreshHealth(); // let the badge show the authoritative service state (down/rate-limited/etc.)
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Cannot reach the watcher: ' + e.message + '  — or just hit ⚡ Full scan.';
    $('deals').innerHTML = '';
  }
}

// --- Local "Scan now" full sweep ---
function fmtEta(remaining) {
  const secs = Math.round(remaining * 1.05); // ~1.05s per release at the scan's tightened pacing (1050ms)
  if (secs < 60) return `~${secs}s left`;
  return `~${Math.ceil(secs / 60)} min left`;
}

function setScanUI(on) {
  scanning = on;
  $('scanbar').classList.toggle('hidden', !on);
  $('btn-fullscan').disabled = on;
  $('btn-fullscan').textContent = on ? '⏳ Scanning…' : '⚡ Full scan';
  // While a scan runs the badge says "Scanning…"; once it ends, re-check the real service state.
  if (on) setServiceBadge(lastHealth); else refreshHealth();
}

async function startScan(opts = {}) {
  if (!hasApi) { alert('Local scan needs the desktop app (run it with npm start).'); return; }
  if (scanning) return;
  setScanUI(true);
  $('scan-fill').style.width = '0%';
  $('scan-text').textContent = opts.quick ? 'Ranking your wantlist for a quick scan…' : 'Fetching your wantlist…';
  try {
    const res = await window.api.scrapeRun(opts);
    // A BACKGROUND auto-scan in a cloud source (github/server) runs only for its side effects —
    // refreshing sold-medians (which sharpen the cloud emails) and keeping the cron alive. It must
    // NOT hijack the view: the cloud feed (now auto-verified live) stays the shown truth, so a
    // launch never silently "jumps back" to a smaller local-scan snapshot. A MANUAL scan, or an
    // auto-scan when the user's source already IS local, switches to the scan results as before.
    if (opts.background) {
      // If the scan view is what's on screen (restored by boot after a restart), a background scan
      // just produced FRESHER results for that very view — show them instead of the stale snapshot.
      if (viewMode === 'scan') {
        scannedOnce = true;
        allDeals = (res && res.deals) || [];
        allNearMisses = (res && res.nearMisses) || [];
        seenIds = new Set(allDeals.map((d) => d.id));
        setStatus({ wantlistSize: res ? (res.wantlistTotal ?? res.total) : '—' });
        render();
      }
      refreshGems();
      refresh(); // no-op in scan view; otherwise re-pull + re-verify the cloud feed
    } else {
      viewMode = 'scan';
      scannedOnce = true;
      allDeals = (res && res.deals) || [];
      allNearMisses = (res && res.nearMisses) || [];
      seenIds = new Set(allDeals.map((d) => d.id));
      setStatus({ wantlistSize: res ? (res.wantlistTotal ?? res.total) : '—' });
      refreshGems(); // the scan may have found rare gems / refreshed the zero-stock watch list
      render();
    }
  } catch (e) {
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Scan failed: ' + e.message;
  } finally {
    setScanUI(false);
  }
}

// Auto-scan: keep the real per-copy condition + sold-medians fresh (and thus the cloud emails sharp)
// without the user having to remember to click "Scan now". Runs on launch — and periodically while
// the app stays open — only when the last scan is older than the configured age (0 = off). Because a
// scan pushes soldmedians.json as YOU, regular auto-scans also keep the GitHub cron from being
// disabled after 60 days of no user activity.
async function maybeAutoScan() {
  if (!hasApi || scanning) return; // the age check below prevents redundant scans; don't gate on viewMode
  // Need a configured Discogs token, or a scan can't run (and would just error).
  let cfg; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!cfg || !cfg.hasToken || !cfg.username) return;
  let s; try { s = await window.api.getSettings(); } catch { return; }
  const hrs = Number(s.autoScanOnLaunchHours || 0);
  if (!hrs) return;
  let last; try { last = await window.api.scrapeLast(); } catch { last = null; }
  const ageH = last && last.ts ? (Date.now() - last.ts) / 3600000 : Infinity;
  // In a cloud source the auto-scan is a background medians refresh — it must not replace the
  // (auto-verified) cloud view. Only when the user's source IS the local scan does it drive the view.
  const cloud = s.sourceType === 'github' || s.sourceType === 'server';
  if (ageH >= hrs) startScan({ background: cloud });
}

function onScanProgress(m) {
  if (!m) return;
  if (m.phase === 'wantlist') { $('scan-text').textContent = 'Fetching your wantlist…'; $('scan-fill').style.width = '3%'; return; }
  if (m.phase === 'prices') {
    const total = m.total || 1;
    $('scan-fill').style.width = Math.min(100, Math.round((m.checked / total) * 100)) + '%';
    $('scan-text').textContent = `Confirming condition ${m.checked}/${total} · ${m.found} VG+ deal${m.found === 1 ? '' : 's'}`;
    return;
  }
  if (m.phase === 'warmup') {
    $('scan-fill').style.width = '100%';
    $('scan-text').textContent = `Refreshing sold-medians ${m.checked}/${m.total}… (real market value — also sharpens cloud emails)`;
    return;
  }
  if (m.phase === 'pushing') { $('scan-text').textContent = 'Saving sold-medians to GitHub for the email watcher…'; return; }
  if (m.phase === 'done') {
    $('scan-fill').style.width = '100%';
    const dropped = m.droppedNoVgPlus ? ` · ${m.droppedNoVgPlus} skipped (no VG+ copy)` : '';
    // Surface the auto-push outcome so the user knows the cloud emails were updated (or why not).
    let push = '';
    if (m.mediansPush) {
      if (m.mediansPush.pushed) push = ' · medians pushed to GitHub ✓';
      else if (m.mediansPush.ok) push = ' · medians already up to date';
      else push = ` · ⚠ medians push failed (${m.mediansPush.reason || 'git error'}) — commit manually`;
    }
    const ship = m.realShip != null && m.found ? ` · ${m.realShip}/${m.found} with real shipping` : '';
    const cov = m.quick ? ` · quick scan (top ${m.total} of ${m.wantlistTotal})` : '';
    const miss = m.nearMisses ? ` · ${m.nearMisses} near-miss${m.nearMisses === 1 ? '' : 'es'} (tick “Show near-misses”)` : '';
    const warm = m.warmedReal ? ` · ${m.warmedReal} sold-median${m.warmedReal === 1 ? '' : 's'} ${m.fullMedians ? 'refreshed' : 'learned'}` : '';
    const gem = m.gems ? ` · 💎 ${m.gems} rare gem${m.gems === 1 ? '' : 's'} (see the Rare tab)` : '';
    const cf = m.cfFailed ? ` · ⚠ ${m.cfFailed} release${m.cfFailed === 1 ? '' : 's'} didn’t clear Cloudflare (estimate shown — retried next scan)` : '';
    $('scan-text').textContent = `Done — ${m.found} VG+ deal${m.found === 1 ? '' : 's'}${gem}${ship}${dropped}${cf}${cov}${m.aborted ? ' (stopped early)' : ''}.${push}${warm}${miss}`;
    refreshPushStatus(); // the scan may just have pushed (or failed to push) the medians
    return;
  }
  // 'scan' phase: the API sweep and the browser confirmation run concurrently now, so one message
  // carries both — the bar tracks the sweep (the dominant timeline) and the text adds the live deal
  // count plus, once the sweep is done, how many candidates are still being confirmed.
  const total = m.total || 1;
  const pctDone = Math.min(100, Math.round((m.checked / total) * 100));
  $('scan-fill').style.width = pctDone + '%';
  const found = m.found || 0;
  const remaining = Math.max(0, (m.candidates || 0) - (m.processed || 0));
  const tail = (m.checked >= total && remaining > 0)
    ? ` · confirming last ${remaining}`
    : ` · ${fmtEta(total - m.checked)}`;
  $('scan-text').textContent = `Scanning ${m.checked}/${total} · ${found} deal${found === 1 ? '' : 's'}${tail}`;
}

// --- Settings modal ---
function toggleSrc() {
  const t = $('set-sourceType').value;
  document.querySelector('.src-server').classList.toggle('hidden', t !== 'server');
  document.querySelector('.src-github').classList.toggle('hidden', t !== 'github');
}

async function openSettings() {
  const s = hasApi ? await window.api.getSettings() : { sourceType: 'scan', githubRepo: '', githubToken: '', apiBase: '', token: '', autoScanOnLaunchHours: 1 };
  $('set-sourceType').value = s.sourceType || 'scan';
  $('set-apiBase').value = s.apiBase || '';
  $('set-token').value = s.token || '';
  $('set-githubRepo').value = s.githubRepo || '';
  $('set-githubToken').value = s.githubToken || '';
  $('set-autoScan').value = String(s.autoScanOnLaunchHours ?? 1);
  toggleSrc();
  $('set-test').textContent = '';
  $('set-test').className = 'test-result';
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

function collectSettings() {
  return {
    sourceType: $('set-sourceType').value,
    apiBase: $('set-apiBase').value.trim(),
    token: $('set-token').value.trim(),
    githubRepo: $('set-githubRepo').value.trim(),
    githubToken: $('set-githubToken').value.trim(),
    autoScanOnLaunchHours: parseInt($('set-autoScan').value, 10) || 0,
  };
}

// Merge over the persisted settings so saving the modal never drops keys it doesn't render
// (e.g. autoPushMedians, githubBranch).
async function persistSettings() {
  if (!hasApi) return;
  const cur = await window.api.getSettings().catch(() => ({}));
  await window.api.saveSettings({ ...cur, ...collectSettings() });
}

async function saveSettings() {
  await persistSettings();
  closeSettings();
  firstLoad = true; seenIds = new Set();
  firstGemLoad = true; seenGemIds = new Set(); // gems come from the (possibly changed) source too
  lastGithubRun = null; // source may have changed (scan <-> github <-> server) — don't carry a stale run
  boot(); // re-evaluate the (possibly changed) source: scan view, cloud poll, or server
  refreshGems();
}

async function testConnection() {
  const el = $('set-test');
  el.textContent = 'Testing…'; el.className = 'test-result';
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; return; }
  await persistSettings();
  try {
    const deals = await window.api.getDeals(200);
    let extra = '';
    try { const st = await window.api.getStatus(); if (st && st.wantlistSize != null) extra = ` · wantlist ${st.wantlistSize}`; } catch { /* github mode has no status */ }
    el.textContent = `OK — ${Array.isArray(deals) ? deals.length : 0} deal(s) available${extra}.`;
    el.className = 'test-result ok';
  } catch (e) {
    el.textContent = 'Failed: ' + e.message;
    el.className = 'test-result bad';
  }
}

// --- First-run / Discogs account wizard ---
async function openWizard(firstRun) {
  let c = null;
  if (hasApi) { try { c = await window.api.getConfig(); } catch { c = null; } }
  $('wiz-username').value = (c && c.username) || '';
  $('wiz-token').value = '';
  $('wiz-token').placeholder = (c && c.hasToken) ? 'leave blank to keep your saved token' : 'paste your token here';
  $('wiz-currency').value = (c && c.currency) || 'EUR';
  $('wiz-title').textContent = firstRun ? 'Welcome 👋' : 'Discogs account';
  $('wiz-intro').classList.toggle('hidden', !firstRun);
  $('wiz-cancel').textContent = firstRun ? 'Later' : 'Cancel';
  $('wiz-test').textContent = ''; $('wiz-test').className = 'test-result';
  $('wizard-modal').classList.remove('hidden');
  $('wiz-username').focus();
}
function closeWizard() { $('wizard-modal').classList.add('hidden'); }

async function wizardTest() {
  const el = $('wiz-test');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result'; return; }
  const username = $('wiz-username').value.trim();
  const token = $('wiz-token').value.trim();
  if (!token) { el.textContent = 'Enter your token first.'; el.className = 'test-result bad'; return; }
  el.textContent = 'Testing…'; el.className = 'test-result';
  try {
    const r = await window.api.testConfig({ username, token });
    if (r && r.ok) {
      el.textContent = `OK — signed in as ${r.username}${r.wantlist != null ? ` · ${r.wantlist} releases on the wantlist` : ''}.`;
      el.className = 'test-result ok';
    } else {
      el.textContent = (r && r.error) || 'Failed.';
      el.className = 'test-result bad';
    }
  } catch (e) { el.textContent = 'Failed: ' + e.message; el.className = 'test-result bad'; }
}

async function wizardSave() {
  if (!hasApi) { closeWizard(); return; }
  const el = $('wiz-test');
  const username = $('wiz-username').value.trim();
  const token = $('wiz-token').value.trim();
  const currency = $('wiz-currency').value;
  if (!username) { el.textContent = 'Please enter your Discogs username.'; el.className = 'test-result bad'; return; }
  let cfg = null; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!token && !(cfg && cfg.hasToken)) { el.textContent = 'Please enter your Discogs token.'; el.className = 'test-result bad'; return; }
  const patch = { username, currency };
  if (token) patch.token = token; // blank = keep the saved token
  await window.api.saveConfig(patch);
  closeWizard();
  // Creds now exist — surface deals by kicking off a scan (the core action for a fresh install).
  viewMode = 'scan';
  startScan();
}

// --- ☁ Cloud setup wizard (24/7 email alerts on the user's own GitHub fork) ---
let cloudRunning = false;

function cloudResetSteps() {
  document.querySelectorAll('#cloud-steps li').forEach((li) => { li.className = ''; li.removeAttribute('data-detail'); });
}

async function openCloud() {
  closeSettings();
  cloudResetSteps();
  $('cloud-steps').classList.add('hidden');
  $('cloud-open-btn').classList.add('hidden');
  $('cloud-result').textContent = ''; $('cloud-result').className = 'test-result';
  $('cloud-run').disabled = false;
  // Prefill the alert address from an earlier attempt is not possible (tokens are never stored) —
  // but a missing Discogs account is a hard prerequisite, so surface that immediately.
  if (hasApi) {
    try {
      const c = await window.api.getConfig();
      if (!c || !c.hasToken || !c.username) {
        $('cloud-result').textContent = 'Set up your Discogs account first (Settings → Discogs account) — the cloud watcher scans that wantlist.';
        $('cloud-result').className = 'test-result bad';
        $('cloud-run').disabled = true;
      }
    } catch { /* leave enabled; the main process re-checks anyway */ }
  }
  $('cloud-modal').classList.remove('hidden');
  $('cloud-github').focus();
}
function closeCloud() { if (!cloudRunning) $('cloud-modal').classList.add('hidden'); }

function onCloudProgress(m) {
  if (!m || !m.step) return;
  const li = document.querySelector(`#cloud-steps li[data-step="${m.step}"]`);
  if (!li) return;
  li.className = m.state === 'ok' ? 'ok' : m.state === 'busy' ? 'busy' : '';
  if (m.detail) li.setAttribute('data-detail', m.detail);
}

async function runCloudSetup() {
  if (cloudRunning) return;
  const el = $('cloud-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; return; }
  cloudRunning = true;
  $('cloud-run').disabled = true;
  cloudResetSteps();
  $('cloud-steps').classList.remove('hidden');
  el.textContent = 'Setting up — this takes a minute or two…'; el.className = 'test-result';
  try {
    const r = await window.api.cloudSetup({
      githubToken: $('cloud-github').value,
      mailTo: $('cloud-mailto').value,
      resendKey: $('cloud-resend').value,
    });
    if (r && r.ok) {
      el.textContent = `✓ Done! Your cloud watcher (${r.fork}) is live and running its first scan now. `
        + 'Deal emails start arriving after it has watched your wantlist for a few scans (it learns normal prices first). '
        + 'GitHub runs it roughly every 1–1.5 hours. Check your spam folder for the first email.';
      el.className = 'test-result ok';
      const btn = $('cloud-open-btn');
      btn.classList.remove('hidden');
      btn.dataset.url = r.url;
      $('cloud-github').value = ''; $('cloud-resend').value = ''; // tokens are never kept around
      refreshHealth(); // light up the ☁ pill / badge against the fresh fork
    } else {
      el.textContent = (r && r.error) || 'Setup failed.';
      el.className = 'test-result bad';
      $('cloud-run').disabled = false;
    }
  } catch (e) {
    el.textContent = 'Setup failed: ' + e.message;
    el.className = 'test-result bad';
    $('cloud-run').disabled = false;
  } finally {
    cloudRunning = false;
  }
}

// --- ✈ Telegram push setup ---
// Telegram alerts are sent by the CLOUD watcher (the fork), so connecting = saving two secrets to it.
// Flow: paste bot token → Test (resolve chat id + send a test message) → Connect (store on the fork,
// needs the GitHub token + the cloud email watcher to exist). Test works standalone so the user can
// verify their bot even before the cloud is set up.
let tgRunning = false;
let tgChatId = '';

function tgResetSteps() {
  document.querySelectorAll('#tg-steps li').forEach((li) => { li.className = ''; li.removeAttribute('data-detail'); });
}

async function openTelegram() {
  closeSettings();
  tgChatId = '';
  $('tg-token').value = ''; $('tg-github').value = '';
  $('tg-test-result').textContent = ''; $('tg-test-result').className = 'test-result';
  $('tg-result').textContent = ''; $('tg-result').className = 'test-result';
  $('tg-connect-wrap').classList.add('hidden');
  $('tg-connect').classList.add('hidden');
  $('tg-steps').classList.add('hidden');
  tgResetSteps();
  // Whether the user has a cloud watcher to save the secrets onto (set by the email-alerts setup).
  let hasFork = false;
  if (hasApi) { try { const s = await window.api.getSettings(); hasFork = !!(s && s.githubRepo); } catch { /* ignore */ } }
  if (!hasFork) {
    $('tg-test-result').textContent = 'Tip: you can test your bot now, but saving it needs the cloud watcher. Set up “24/7 email alerts” first (Settings), then come back here.';
    $('tg-test-result').className = 'test-result';
  }
  $('telegram-modal').classList.remove('hidden');
  $('tg-token').focus();
}
function closeTelegram() { if (!tgRunning) $('telegram-modal').classList.add('hidden'); }

async function runTelegramTest() {
  const el = $('tg-test-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result bad'; return; }
  const botToken = $('tg-token').value.trim();
  if (!botToken) { el.textContent = 'Paste your bot token first (from @BotFather).'; el.className = 'test-result bad'; return; }
  el.textContent = 'Testing — check Telegram for a message…'; el.className = 'test-result';
  $('tg-test-btn').disabled = true;
  try {
    const r = await window.api.telegramTest({ botToken });
    if (r && r.ok) {
      tgChatId = r.chatId;
      el.textContent = `✓ Test message sent${r.name ? ' to ' + r.name : ''}. Check your Telegram.`;
      el.className = 'test-result ok';
      // Reveal the connect step only if there's a cloud watcher to save it to.
      let hasFork = false;
      try { const s = await window.api.getSettings(); hasFork = !!(s && s.githubRepo); } catch { /* ignore */ }
      if (hasFork) {
        $('tg-connect-wrap').classList.remove('hidden');
        $('tg-connect').classList.remove('hidden');
      } else {
        $('tg-result').textContent = 'Bot works! To make alerts arrive when the app is closed, set up “24/7 email alerts” first (Settings → Set up cloud alerts…), then reopen this to Connect.';
        $('tg-result').className = 'test-result';
      }
    } else {
      el.textContent = (r && r.error) || 'Test failed.';
      el.className = 'test-result bad';
    }
  } catch (e) {
    el.textContent = 'Test failed: ' + e.message; el.className = 'test-result bad';
  } finally {
    $('tg-test-btn').disabled = false;
  }
}

function onTelegramProgress(m) {
  if (!m || !m.step) return;
  const li = document.querySelector(`#tg-steps li[data-step="${m.step}"]`);
  if (!li) return;
  li.className = m.state === 'ok' ? 'ok' : m.state === 'busy' ? 'busy' : '';
  if (m.detail) li.setAttribute('data-detail', m.detail);
}

async function runTelegramSetup() {
  if (tgRunning) return;
  const el = $('tg-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result bad'; return; }
  const githubToken = $('tg-github').value.trim();
  if (!githubToken) { el.textContent = 'Paste your GitHub token to save this to your cloud watcher.'; el.className = 'test-result bad'; return; }
  tgRunning = true;
  $('tg-connect').disabled = true;
  tgResetSteps();
  $('tg-steps').classList.remove('hidden');
  el.textContent = 'Saving to your cloud watcher…'; el.className = 'test-result';
  try {
    const r = await window.api.telegramSetup({ githubToken, botToken: $('tg-token').value.trim(), chatId: tgChatId });
    if (r && r.ok) {
      el.textContent = '✓ Connected! Telegram alerts are on. Your cloud watcher will push deals here from its next run.';
      el.className = 'test-result ok';
      $('tg-github').value = ''; $('tg-token').value = ''; // tokens are never kept around
      $('tg-connect').classList.add('hidden');
      setTelegramBadge(true);
    } else {
      el.textContent = (r && r.error) || 'Setup failed.'; el.className = 'test-result bad';
      $('tg-connect').disabled = false;
    }
  } catch (e) {
    el.textContent = 'Setup failed: ' + e.message; el.className = 'test-result bad';
    $('tg-connect').disabled = false;
  } finally {
    tgRunning = false;
  }
}

function setTelegramBadge(connected) {
  const b = $('btn-telegram');
  if (!b) return;
  b.classList.toggle('ok', !!connected);
  b.title = connected
    ? 'Telegram alerts are connected — click to change'
    : 'Telegram alerts — get deals instantly on your phone (backup for the email)';
}

// Decide what to show on launch: the first-run wizard if there are no Discogs creds, otherwise the
// configured deal source ('scan' by default).
async function boot() {
  if (!hasApi) { refresh(); return; }
  let cfg = null; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!cfg || !cfg.hasToken || !cfg.username) {
    viewMode = 'scan';
    $('deals').innerHTML = '';
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Welcome! Enter your Discogs username + token to start (⚙ Settings → Discogs account), then hit ⚡ Full scan.';
    openWizard(true);
    refreshHealth();
    return;
  }
  let s = null; try { s = await window.api.getSettings(); } catch { s = {}; }
  setTelegramBadge(!!(s && s.telegramConnected));
  // The deals tab ALWAYS shows the local scan: condition-verified VG+ copies with real shipping —
  // the only view worth buying from. The cloud alert feed exists to drive the EMAILS (be-there-fast
  // channel); it is deliberately not a dashboard view. Gems + the service badge/pills still ride
  // the configured cloud source, so 💎 finds and watcher health stay visible.
  viewMode = 'scan';
  let last = null; try { last = await window.api.scrapeLast(); } catch { last = null; }
  if (last && Array.isArray(last.deals)) {
    scannedOnce = true;
    allDeals = last.deals; allNearMisses = last.nearMisses || []; seenIds = new Set(allDeals.map((d) => d.id));
    setStatus({ wantlistSize: last.wantlistTotal != null ? last.wantlistTotal : '—' });
  } else {
    allDeals = []; allNearMisses = [];
  }
  render();
  refreshHealth();
}

// --- wire up ---
window.addEventListener('DOMContentLoaded', () => {
  $('tab-deals').addEventListener('click', () => setTab('deals'));
  $('tab-gems').addEventListener('click', () => setTab('gems'));
  $('btn-fullscan').addEventListener('click', () => startScan({ fullMedians: true }));
  $('btn-scan-cancel').addEventListener('click', () => { if (hasApi) window.api.scrapeCancel(); $('scan-text').textContent = 'Stopping…'; });
  $('btn-settings').addEventListener('click', openSettings);
  $('svc-badge').addEventListener('click', () => { const u = $('svc-badge').dataset.url; if (u) openUrl(u); });
  $('pill-cron').addEventListener('click', () => { const u = $('pill-cron').dataset.url; if (u) openUrl(u); });
  $('push-badge').addEventListener('click', retryPushClick);
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', saveSettings);
  $('set-test-btn').addEventListener('click', testConnection);
  $('set-sourceType').addEventListener('change', toggleSrc);
  $('set-account-btn').addEventListener('click', () => { closeSettings(); openWizard(false); });

  // ☁ Cloud setup wizard
  $('set-cloud-btn').addEventListener('click', openCloud);
  $('cloud-cancel').addEventListener('click', closeCloud);
  $('cloud-run').addEventListener('click', runCloudSetup);
  $('cloud-open-btn').addEventListener('click', () => { const u = $('cloud-open-btn').dataset.url; if (u) openUrl(u); });
  $('cloud-github-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://github.com/settings/tokens/new?scopes=repo,workflow&description=Discogs%20Deal%20Watcher%20cloud'); });
  $('cloud-resend-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://resend.com/api-keys'); });
  if (hasApi) window.api.onCloudProgress(onCloudProgress);

  // ✈ Telegram push setup
  $('btn-telegram').addEventListener('click', openTelegram);
  $('tg-cancel').addEventListener('click', closeTelegram);
  $('tg-test-btn').addEventListener('click', runTelegramTest);
  $('tg-connect').addEventListener('click', runTelegramSetup);
  $('tg-botfather-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://t.me/BotFather'); });
  if (hasApi) window.api.onTelegramProgress(onTelegramProgress);

  // Wizard
  $('wiz-test-btn').addEventListener('click', wizardTest);
  $('wiz-save').addEventListener('click', wizardSave);
  $('wiz-cancel').addEventListener('click', closeWizard);
  $('wiz-token-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://www.discogs.com/settings/developers'); });

  $('search').addEventListener('input', render);
  $('sortBy').addEventListener('change', render);
  $('freshOnly').addEventListener('change', render);
  $('vgPlusOnly').addEventListener('change', render);
  $('showHidden').addEventListener('change', render);
  $('showNearMiss').addEventListener('change', render);
  $('minValue').addEventListener('input', () => { const v = parseInt($('minValue').value, 10); $('minValueVal').textContent = v > 0 ? `€${v}+` : 'any'; render(); });
  $('minDiscount').addEventListener('input', () => { $('minDiscountVal').textContent = $('minDiscount').value + '%'; render(); });
  $('maxTotal').addEventListener('input', () => { const v = parseInt($('maxTotal').value, 10); $('maxTotalVal').textContent = v > 0 ? `€${v}` : 'any'; render(); });
  $('shipEst').addEventListener('input', () => { $('shipEstVal').textContent = '€' + $('shipEst').value; render(); });

  if (hasApi) window.api.onScrapeProgress(onScanProgress);
  if (hasApi && window.api.onVerifyProgress) window.api.onVerifyProgress((m) => {
    verifyInfo = { running: m.phase === 'verifying', done: m.done || 0, total: m.total || 0 };
    if (activeTab === 'deals' && viewMode !== 'scan') render(); // updates the "checking listings n/m" note
  });
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  boot();                         // first-run wizard, last scan, or cloud poll — and lights up the badge
  refreshGems();                  // fill the 💎 Rare tab (works in every source mode; demo in preview)
  if (hasApi) {
    setInterval(refresh, 30_000); // poll the cloud every 30s (paused during a local scan)
    setInterval(refreshGems, 60_000); // 💎 gems change rarely; a slower poll is plenty (raw CDN / local file)
    // Check the real service heartbeat every 2 min. Slow on purpose: the cron only fires every
    // ~15 min, and this is the only api.github.com traffic (deals come from the raw CDN), so 30
    // req/hr stays well under the 60/hr unauthenticated limit.
    setInterval(refreshHealth, 120_000);
    refreshPushStatus();          // sold-medians push badge (persists a failed push until it succeeds)
    setInterval(refreshPushStatus, 5 * 60_000);
    maybeAutoScan();              // auto-scan on launch if the last scan is stale (keeps emails sharp)
    setInterval(maybeAutoScan, 15 * 60_000); // re-check every 15 min so the configured cadence (e.g. hourly) is actually honored while the app stays open
  }
});
