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

let allDeals = [];
let allNearMisses = [];   // releases that looked cheap but didn't qualify (scan only) — see "Show near-misses"
let seenIds = new Set();
let firstLoad = true;
let viewMode = 'cloud';   // 'cloud' | 'scan'
let scanning = false;

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
  return Object.assign({}, d, { _ship: ship, _shipReal: shipReal, _total: total, _eff: eff, _savings: savings, _score: score });
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
    : 'Estimated shipping (slider) — this deal has no per-copy shipping; run ⚡ Scan now for the real amount';
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
  return `<article class="card${d.freshListing ? ' is-fresh' : ''}${d.conditionConfirmed ? ' is-verified' : ''}${isHidden ? ' is-hidden' : ''}">
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
      <div class="meta">${fresh}${conditionChip(d)}${ships}</div>
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
  if (d.reasonCode === 'vgplus-not-cheap') {
    const ship = d.shipping != null && d.shipping > 0 ? ` + ${money(d.shipping, d.currency)} ship` : '';
    return `Cheapest VG+ copy is ${money(d.bestPrice, d.currency)}${ship} = <b>${pct(d.effectiveDiscount)} off</b> vs ${ref} — under the 40% scan threshold.`;
  }
  if (d.reasonCode === 'unconfirmed-not-cheap') {
    return `Couldn't read condition. Cheapest ${money(d.lowest, d.currency)} ≈ <b>${pct(d.discount)} off</b> vs ${ref} — under 40%.`;
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

function applyFilters(deals) {
  const q = $('search').value.trim().toLowerCase();
  const minV = parseFloat($('minValue').value) || 0;
  const minD = parseInt($('minDiscount').value, 10) / 100;
  const maxT = parseFloat($('maxTotal').value) || 0;
  const freshOnly = $('freshOnly').checked;
  const vgOnly = $('vgPlusOnly').checked;
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

function render() {
  const enriched = allDeals.map(enrich);
  let deals = applyFilters(enriched);
  deals = sortDeals(deals, $('sortBy').value);
  // Near-misses: opt-in, scan-only. Rendered below the deals with the reason each didn't qualify.
  const showMiss = $('showNearMiss').checked && viewMode === 'scan' && allNearMisses.length > 0;
  const misses = showMiss ? filterNearMisses(allNearMisses) : [];
  const wrap = $('deals');
  const empty = $('empty');
  const hiddenCount = allDeals.reduce((acc, d) => acc + (dismissed.has(String(d.releaseId)) ? 1 : 0), 0);
  const hiddenNote = hiddenCount ? ` · ${hiddenCount} hidden` : '';
  $('pill-deals').textContent = `${allDeals.length} deal${allDeals.length === 1 ? '' : 's'}`;
  $('resultCount').textContent = deals.length ? `${deals.length} of ${allDeals.length}${hiddenNote}${viewMode === 'scan' ? ' · live scan' : ''}` : '';
  if (!deals.length && !misses.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = allDeals.length ? 'No deals match your filters — loosen the sliders or untick “VG+ only”.'
      : (viewMode === 'scan' ? 'Scan finished — no confirmed VG+ copies meet your discount threshold right now.'
        : 'No deals yet — the watcher fills this in as cheap copies appear. Or hit ⚡ Scan now.');
    return;
  }
  empty.classList.add('hidden');
  let html = deals.map(card).join('');
  if (misses.length) {
    html += `<div class="nearmiss-head">↓ Near-misses — looked cheap but didn’t qualify (${misses.length})</div>`;
    html += misses.map(nearMissCard).join('');
  }
  wrap.innerHTML = html;
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

async function refreshHealth() {
  if (scanning) { setServiceBadge(lastHealth); return; } // the scan owns the badge while it runs
  if (!hasApi) { setServiceBadge({ mode: 'demo' }); return; }
  let h = null;
  try { h = await window.api.getHealth(); } catch { h = null; }
  if (h && h.mode === 'github' && h.ok && h.run) lastGithubRun = h.run;
  lastHealth = h;
  setServiceBadge(h);
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
  } catch (e) {
    refreshHealth(); // let the badge show the authoritative service state (down/rate-limited/etc.)
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Cannot reach the watcher: ' + e.message + '  — or just hit ⚡ Scan now.';
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
  $('btn-scan').disabled = on;
  $('btn-quickscan').disabled = on;
  $('btn-scan').textContent = on ? '⏳ Scanning…' : '⚡ Scan now';
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
    viewMode = 'scan';
    allDeals = (res && res.deals) || [];
    allNearMisses = (res && res.nearMisses) || [];
    seenIds = new Set(allDeals.map((d) => d.id));
    setStatus({ wantlistSize: res ? (res.wantlistTotal ?? res.total) : '—' });
    render();
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
  if (!hasApi || scanning || viewMode === 'scan') return;
  let s; try { s = await window.api.getSettings(); } catch { return; }
  const hrs = Number(s.autoScanOnLaunchHours || 0);
  if (!hrs) return;
  let last; try { last = await window.api.scrapeLast(); } catch { last = null; }
  const ageH = last && last.ts ? (Date.now() - last.ts) / 3600000 : Infinity;
  if (ageH >= hrs) startScan();
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
    $('scan-text').textContent = `Building sold-median coverage ${m.checked}/${m.total}… (so cloud emails judge against real market value)`;
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
    const warm = m.warmedReal ? ` · ${m.warmedReal} new sold-median${m.warmedReal === 1 ? '' : 's'} learned` : '';
    $('scan-text').textContent = `Done — ${m.found} VG+ deal${m.found === 1 ? '' : 's'}${ship}${dropped}${cov}${m.aborted ? ' (stopped early)' : ''}.${push}${warm}${miss}`;
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
  const s = hasApi ? await window.api.getSettings() : { sourceType: 'github', githubRepo: 'norsnors/discogs-deal-watcher', githubToken: '', apiBase: '', token: '', autoScanOnLaunchHours: 24 };
  $('set-sourceType').value = s.sourceType || 'github';
  $('set-apiBase').value = s.apiBase || '';
  $('set-token').value = s.token || '';
  $('set-githubRepo').value = s.githubRepo || '';
  $('set-githubToken').value = s.githubToken || '';
  $('set-autoScan').value = String(s.autoScanOnLaunchHours ?? 24);
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
  viewMode = 'cloud'; firstLoad = true; seenIds = new Set();
  lastGithubRun = null; // source may have changed (server <-> github) — don't carry a stale run
  refresh();
  refreshHealth();
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

// --- wire up ---
window.addEventListener('DOMContentLoaded', () => {
  $('btn-scan').addEventListener('click', () => startScan());
  $('btn-quickscan').addEventListener('click', () => startScan({ quick: true }));
  $('btn-scan-cancel').addEventListener('click', () => { if (hasApi) window.api.scrapeCancel(); $('scan-text').textContent = 'Stopping…'; });
  $('btn-refresh').addEventListener('click', () => { viewMode = 'cloud'; refresh(); refreshHealth(); });
  $('btn-settings').addEventListener('click', openSettings);
  $('svc-badge').addEventListener('click', () => { const u = $('svc-badge').dataset.url; if (u) openUrl(u); });
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', saveSettings);
  $('set-test-btn').addEventListener('click', testConnection);
  $('set-sourceType').addEventListener('change', toggleSrc);

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
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  refresh();
  refreshHealth();                // light up the live-service badge on first paint
  if (hasApi) {
    setInterval(refresh, 30_000); // poll the cloud every 30s (paused during a local scan)
    // Check the real service heartbeat every 2 min. Slow on purpose: the cron only fires every
    // ~15 min, and this is the only api.github.com traffic (deals come from the raw CDN), so 30
    // req/hr stays well under the 60/hr unauthenticated limit.
    setInterval(refreshHealth, 120_000);
    maybeAutoScan();              // auto-scan on launch if the last scan is stale (keeps emails sharp)
    setInterval(maybeAutoScan, 60 * 60_000); // re-check hourly while the app stays open
  }
});
