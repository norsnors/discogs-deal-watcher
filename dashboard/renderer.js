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
  { id: 'demo1', releaseId: 249504, artist: 'Imagination', title: 'Night Dubbing', lowest: 8.5, currency: 'EUR', shipping: 4.5, shipsFrom: 'Germany', numForSale: 14, vgPlusCount: 5, cheapVgPlusCount: 4, cheapVgPlusLow: 13, cheapVgPlusHigh: 17, altGrade: 'Near Mint (NM or M-)', altPrice: 14.5, altUrl: 'https://www.discogs.com/sell/item/112', reference: 32, referenceSource: 'sold-median', soldLow: 18, soldHigh: 45, discount: 0.73, conditionConfirmed: true, mediaCondition: 'Very Good Plus (VG+)', sleeveCondition: 'Very Good Plus (VG+)', cheaperWornPrice: 4.0, cheaperWornCondition: 'Good (G)', freshListing: true, ownDrop: 0.5, listingUrl: 'https://www.discogs.com/sell/item/111', url: 'https://www.discogs.com/sell/item/111', ts: Date.now() - 4 * 60000, thumb: '' },
  { id: 'demo2', releaseId: 67890, artist: 'Gino Soccio', title: 'Outline', lowest: 11.0, currency: 'EUR', shipping: 0, shipsFrom: 'Netherlands', numForSale: 22, vgPlusCount: 8, reference: 30, referenceSource: 'suggestion', discount: 0.63, conditionConfirmed: true, mediaCondition: 'Near Mint (NM or M-)', sleeveCondition: 'Very Good (VG)', freshListing: false, ownDrop: 0.2, listingUrl: 'https://www.discogs.com/sell/item/222', url: 'https://www.discogs.com/sell/item/222', ts: Date.now() - 90 * 60000, thumb: '' },
  // Unconfirmed (cloud/API) deals: condition unknown -> only a price-proxy estimate, hidden by "VG+ only".
  { id: 'demo3', releaseId: 12345, artist: 'Klein & M.B.O.', title: 'Dirty Talk', lowest: 4.0, currency: 'EUR', numForSale: 3, reference: 26, referenceSource: 'trailing-median', discount: 0.85, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: false, ownDrop: 0.7, url: 'https://www.discogs.com/sell/release/12345?sort=price%2Casc', ts: Date.now() - 32 * 60000, thumb: '' },
  { id: 'demo4', releaseId: 1111, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 2.0, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'suggestion', discount: 0.98, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: true, ownDrop: 0.9, url: 'https://www.discogs.com/sell/release/1111?sort=price%2Casc', ts: Date.now() - 1 * 60000, thumb: '' },
];

let allDeals = [];
let seenIds = new Set();
let firstLoad = true;
let viewMode = 'cloud';   // 'cloud' | 'scan'
let scanning = false;

const $ = (id) => document.getElementById(id);
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

function card(d) {
  const fresh = d.freshListing ? `<span class="tag fresh">🆕 just listed</span>` : '';
  const ships = d.shipsFrom ? `<span class="tag">from ${esc(d.shipsFrom)}</span>` : '';
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  const shipNote = d._shipReal
    ? (d._ship > 0 ? `${money(d.lowest, d.currency)} item + ${money(d._ship, d.currency)} shipping` : `${money(d.lowest, d.currency)} item · free shipping`)
    : (d._ship > 0 ? `${money(d.lowest, d.currency)} item + ${money(d._ship, d.currency)} ship est.` : `${money(d.lowest, d.currency)} item · no shipping added`);
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
  return `<article class="card${d.freshListing ? ' is-fresh' : ''}${d.conditionConfirmed ? ' is-verified' : ''}">
    <span class="when">${viewMode === 'scan' ? 'live' : ago(d.ts)}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="price-row">
        <span class="price">${money(d._total, d.currency)}</span>
        <span class="discount">${pct(d._eff)} off</span>
      </div>
      <div class="subprice">${shipNote}</div>
      <div class="ref">vs ${money(d.reference, d.currency)} ${REF_LABEL[d.referenceSource] || 'ref'}${d.soldLow != null && d.soldHigh != null ? ` (${money(d.soldLow, d.currency)}–${money(d.soldHigh, d.currency)})` : ''}${save} · ${forSale}</div>
      ${cluster}
      ${worn}
      ${alt}
      <div class="meta">${fresh}${conditionChip(d)}${ships}</div>
      <button class="buy" data-url="${esc(d.url)}">${buyLabel}</button>
    </div>
  </article>`;
}

function applyFilters(deals) {
  const q = $('search').value.trim().toLowerCase();
  const minV = parseFloat($('minValue').value) || 0;
  const minD = parseInt($('minDiscount').value, 10) / 100;
  const maxT = parseFloat($('maxTotal').value) || 0;
  const freshOnly = $('freshOnly').checked;
  const vgOnly = $('vgPlusOnly').checked;
  return deals.filter((d) => {
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
  const wrap = $('deals');
  const empty = $('empty');
  $('resultCount').textContent = deals.length ? `${deals.length} of ${allDeals.length}${viewMode === 'scan' ? ' · live scan' : ''}` : '';
  if (!deals.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = allDeals.length ? 'No deals match your filters — loosen the sliders or untick “VG+ only”.'
      : (viewMode === 'scan' ? 'Scan finished — no confirmed VG+ copies meet your discount threshold right now.'
        : 'No deals yet — the watcher fills this in as cheap copies appear. Or hit ⚡ Scan now.');
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = deals.map(card).join('');
  const open = (url) => { if (!url) return; if (hasApi) window.api.openExternal(url); else window.open(url, '_blank'); };
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => open(b.getAttribute('data-url'))));
  wrap.querySelectorAll('.altlink').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); open(a.getAttribute('data-url')); }));
}

function setStatus(ok, statusObj) {
  const conn = $('pill-conn');
  conn.textContent = viewMode === 'scan' ? 'local scan' : (ok ? 'connected' : 'offline');
  conn.className = 'pill ' + (viewMode === 'scan' ? 'ok' : (ok ? 'ok' : 'bad'));
  if (statusObj) {
    $('pill-wantlist').textContent = `wantlist ${statusObj.wantlistSize ?? '—'}`;
    $('pill-deals').textContent = `${statusObj.dealsStored ?? allDeals.length} deals`;
    $('pill-sweep').textContent = statusObj.lastSweepAt ? `last sweep ${ago(statusObj.lastSweepAt)}` : (statusObj.sweepCount != null ? `sweep #${statusObj.sweepCount}` : 'cloud');
  }
}

function notifyNew(deals) {
  if (firstLoad) { firstLoad = false; deals.forEach((d) => seenIds.add(d.id)); return; }
  const fresh = deals.filter((d) => !seenIds.has(d.id));
  fresh.forEach((d) => seenIds.add(d.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const d = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    new Notification(`💸 Discogs deal: ${money(d.lowest, d.currency)} (${pct(d.discount)} off)`, {
      body: `${d.artist || ''} – ${d.title || ''}${extra}`,
    });
  }
}

async function refresh() {
  if (viewMode === 'scan') return; // don't clobber live scan results
  if (!hasApi) {
    try {
      const r = await fetch('deals.json', { cache: 'no-store' });
      allDeals = r.ok ? await r.json() : DEMO;
    } catch { allDeals = DEMO; }
    setStatus(true, { wantlistSize: '—', dealsStored: allDeals.length });
    render();
    return;
  }
  try {
    const [deals, status] = await Promise.all([window.api.getDeals(200), window.api.getStatus().catch(() => null)]);
    allDeals = Array.isArray(deals) ? deals : [];
    notifyNew(allDeals);
    setStatus(true, status || {});
    render();
  } catch (e) {
    setStatus(false);
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Cannot reach the watcher: ' + e.message + '  — or just hit ⚡ Scan now.';
    $('deals').innerHTML = '';
  }
}

// --- Local "Scan now" full sweep ---
function fmtEta(remaining) {
  const secs = Math.round(remaining * 1.1); // ~1.1s per release at the authenticated rate limit
  if (secs < 60) return `~${secs}s left`;
  return `~${Math.ceil(secs / 60)} min left`;
}

function setScanUI(on) {
  scanning = on;
  $('scanbar').classList.toggle('hidden', !on);
  $('btn-scan').disabled = on;
  $('btn-scan').textContent = on ? '⏳ Scanning…' : '⚡ Scan now';
}

async function startScan() {
  if (!hasApi) { alert('Local scan needs the desktop app (run it with npm start).'); return; }
  if (scanning) return;
  setScanUI(true);
  $('scan-fill').style.width = '0%';
  $('scan-text').textContent = 'Fetching your wantlist…';
  try {
    const res = await window.api.scrapeRun();
    viewMode = 'scan';
    allDeals = (res && res.deals) || [];
    seenIds = new Set(allDeals.map((d) => d.id));
    setStatus(true, { wantlistSize: res ? res.total : '—', dealsStored: allDeals.length });
    render();
  } catch (e) {
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Scan failed: ' + e.message;
  } finally {
    setScanUI(false);
  }
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
    $('scan-text').textContent = `Done — ${m.found} VG+ deal${m.found === 1 ? '' : 's'}${dropped}${m.aborted ? ' (stopped early)' : ''}.${push}`;
    return;
  }
  const total = m.total || 1;
  const pctDone = Math.min(100, Math.round((m.checked / total) * 100));
  $('scan-fill').style.width = pctDone + '%';
  $('scan-text').textContent = `Scanning ${m.checked}/${total} · ${m.found} found · ${fmtEta(total - m.checked)}`;
}

// --- Settings modal ---
function toggleSrc() {
  const t = $('set-sourceType').value;
  document.querySelector('.src-server').classList.toggle('hidden', t !== 'server');
  document.querySelector('.src-github').classList.toggle('hidden', t !== 'github');
}

async function openSettings() {
  const s = hasApi ? await window.api.getSettings() : { sourceType: 'github', githubRepo: 'norsnors/discogs-deal-watcher', githubToken: '', apiBase: '', token: '' };
  $('set-sourceType').value = s.sourceType || 'github';
  $('set-apiBase').value = s.apiBase || '';
  $('set-token').value = s.token || '';
  $('set-githubRepo').value = s.githubRepo || '';
  $('set-githubToken').value = s.githubToken || '';
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
  };
}

async function saveSettings() {
  if (hasApi) await window.api.saveSettings(collectSettings());
  closeSettings();
  viewMode = 'cloud'; firstLoad = true; seenIds = new Set();
  refresh();
}

async function testConnection() {
  const el = $('set-test');
  el.textContent = 'Testing…'; el.className = 'test-result';
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; return; }
  await window.api.saveSettings(collectSettings());
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
  $('btn-scan').addEventListener('click', startScan);
  $('btn-scan-cancel').addEventListener('click', () => { if (hasApi) window.api.scrapeCancel(); $('scan-text').textContent = 'Stopping…'; });
  $('btn-refresh').addEventListener('click', () => { viewMode = 'cloud'; refresh(); });
  $('btn-settings').addEventListener('click', openSettings);
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', saveSettings);
  $('set-test-btn').addEventListener('click', testConnection);
  $('set-sourceType').addEventListener('change', toggleSrc);

  $('search').addEventListener('input', render);
  $('sortBy').addEventListener('change', render);
  $('freshOnly').addEventListener('change', render);
  $('vgPlusOnly').addEventListener('change', render);
  $('minValue').addEventListener('input', () => { const v = parseInt($('minValue').value, 10); $('minValueVal').textContent = v > 0 ? `€${v}+` : 'any'; render(); });
  $('minDiscount').addEventListener('input', () => { $('minDiscountVal').textContent = $('minDiscount').value + '%'; render(); });
  $('maxTotal').addEventListener('input', () => { const v = parseInt($('maxTotal').value, 10); $('maxTotalVal').textContent = v > 0 ? `€${v}` : 'any'; render(); });
  $('shipEst').addEventListener('input', () => { $('shipEstVal').textContent = '€' + $('shipEst').value; render(); });

  if (hasApi) window.api.onScrapeProgress(onScanProgress);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  refresh();
  if (hasApi) setInterval(refresh, 30_000); // poll the cloud every 30s (paused during a local scan)
});
