'use strict';
/*
 * renderer.js — dashboard UI. Talks to the main process only through window.api (preload IPC).
 * When window.api is absent (a plain browser preview), it falls back to DEMO data so the layout
 * is still viewable.
 *
 * Two view modes:
 *   'cloud' — passive: deals the cloud watcher already found (polled every 30s). The default.
 *   'scan'  — the results of a local "⚡ Scan now" full sweep. Polling pauses while shown.
 */

const hasApi = typeof window.api !== 'undefined';

const DEMO = [
  { id: 'demo1', releaseId: 249504, artist: 'Imagination', title: 'Night Dubbing', lowest: 8.5, currency: 'EUR', numForSale: 14, reference: 32, referenceSource: 'suggestion', discount: 0.73, confidence: 2, suspicious: false, freshListing: true, url: 'https://www.discogs.com/sell/release/249504?sort=price%2Casc', ts: Date.now() - 4 * 60000, thumb: '' },
  { id: 'demo2', releaseId: 12345, artist: 'Klein & M.B.O.', title: 'Dirty Talk', lowest: 4.0, currency: 'EUR', numForSale: 3, reference: 26, referenceSource: 'trailing-median', discount: 0.85, confidence: 1, suspicious: true, freshListing: false, url: 'https://www.discogs.com/sell/release/12345?sort=price%2Casc', ts: Date.now() - 32 * 60000, thumb: '' },
  { id: 'demo3', releaseId: 67890, artist: 'Gino Soccio', title: 'Outline', lowest: 11.0, currency: 'EUR', numForSale: 22, reference: 24, referenceSource: 'suggestion', discount: 0.54, confidence: 2, suspicious: false, freshListing: false, url: 'https://www.discogs.com/sell/release/67890?sort=price%2Casc', ts: Date.now() - 90 * 60000, thumb: '' },
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
const REF_LABEL = { suggestion: 'VG+ suggested price', 'trailing-median': 'its usual lowest' };

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function card(d) {
  const conf = typeof d.confidence === 'number' ? `<span class="tag conf-${d.confidence}">confidence ${d.confidence}/2</span>` : '';
  const susp = d.suspicious ? `<span class="tag warn">⚠ maybe below VG+</span>` : '';
  const fresh = d.freshListing ? `<span class="tag fresh">🆕 just listed</span>` : '';
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  return `<article class="card${d.freshListing ? ' is-fresh' : ''}">
    <span class="when">${viewMode === 'scan' ? 'live' : ago(d.ts)}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="price-row">
        <span class="price">${money(d.lowest, d.currency)}</span>
        <span class="discount">${pct(d.discount)} off</span>
      </div>
      <div class="ref">vs ${money(d.reference, d.currency)} · ${REF_LABEL[d.referenceSource] || 'reference'} · ${esc(String(d.numForSale ?? '?'))} for sale</div>
      <div class="meta">${fresh}${conf}${susp}</div>
      <button class="buy" data-url="${esc(d.url)}">View &amp; buy on Discogs →</button>
    </div>
  </article>`;
}

function applyFilters(deals) {
  const q = $('search').value.trim().toLowerCase();
  const minD = parseInt($('minDiscount').value, 10) / 100;
  const hideSusp = $('hideSuspicious').checked;
  const freshOnly = $('freshOnly').checked;
  return deals.filter((d) => {
    if (hideSusp && d.suspicious) return false;
    if (freshOnly && !d.freshListing) return false;
    if ((d.discount ?? 0) < minD) return false;
    if (q) {
      const hay = `${d.artist || ''} ${d.title || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const deals = applyFilters(allDeals);
  const wrap = $('deals');
  const empty = $('empty');
  $('resultCount').textContent = deals.length ? `${deals.length} deal${deals.length > 1 ? 's' : ''}${viewMode === 'scan' ? ' · live scan' : ''}` : '';
  if (!deals.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = allDeals.length ? 'No deals match your filters.'
      : (viewMode === 'scan' ? 'Scan finished — no copies are currently below your discount threshold.'
        : 'No deals yet — the watcher fills this in as cheap copies appear. Or hit ⚡ Scan now.');
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = deals.map(card).join('');
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => {
    const url = b.getAttribute('data-url');
    if (hasApi) window.api.openExternal(url); else window.open(url, '_blank');
  }));
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
  if (m.phase === 'done') {
    $('scan-fill').style.width = '100%';
    $('scan-text').textContent = `Done — checked ${m.checked}, ${m.found} bargain${m.found === 1 ? '' : 's'}${m.aborted ? ' (stopped early)' : ''}.`;
    return;
  }
  const total = m.total || 1;
  const pctDone = Math.min(100, Math.round((m.checked / total) * 100));
  $('scan-fill').style.width = pctDone + '%';
  $('scan-text').textContent = `Scanning ${m.checked}/${total} · ${m.found} bargain${m.found === 1 ? '' : 's'} · ${fmtEta(total - m.checked)}`;
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
  $('hideSuspicious').addEventListener('change', render);
  $('freshOnly').addEventListener('change', render);
  $('minDiscount').addEventListener('input', () => { $('minDiscountVal').textContent = $('minDiscount').value + '%'; render(); });

  if (hasApi) window.api.onScrapeProgress(onScanProgress);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  refresh();
  if (hasApi) setInterval(refresh, 30_000); // poll the cloud every 30s (paused during a local scan)
});
