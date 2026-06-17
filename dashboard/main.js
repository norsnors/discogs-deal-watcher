'use strict';
/*
 * main.js — Electron main process for the Discogs Deal dashboard.
 *
 * Two ways to get deals:
 *   1. PASSIVE (default) — read the deals the cloud watcher already found:
 *        • GitHub Actions: read the committed deals.json (public repo: raw CDN, no token).
 *        • Live server:    watcher.js's token-protected /api/* endpoints.
 *      Ships pre-pointed at norsnors/discogs-deal-watcher so it works on first launch, no setup.
 *   2. ACTIVE — the "Scan now" button runs a full local sweep of the whole wantlist right here
 *      (using the watcher's own engine + your local config.json token) and shows every current
 *      bargain immediately. See runScrape().
 *
 * All network I/O lives in this main process (Node fetch), so tokens never reach the renderer
 * and there are no CORS concerns. The renderer talks to us over IPC (see preload.js).
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// The watcher project lives one level up (this dashboard is a sibling Electron app).
const WATCHER_DIR = path.join(__dirname, '..');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
// Ship working defaults: the public repo, GitHub source, no token needed → deals on first launch.
const DEFAULT_SETTINGS = {
  sourceType: 'github',
  githubRepo: 'norsnors/discogs-deal-watcher',
  githubBranch: 'main',
  githubToken: '',
  apiBase: 'http://localhost:8787',
  token: '',
};

function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// Live-server mode (watcher.js on Fly/locally): token-protected /api/* endpoints.
async function serverGet(s, pathname) {
  const base = (s.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('No server URL set — open Settings.');
  const to = withTimeout(12_000);
  try {
    const res = await fetch(base + pathname, { headers: s.token ? { authorization: 'Bearer ' + s.token } : {}, signal: to.signal });
    if (res.status === 401) throw new Error('Unauthorized — check the dashboard token in Settings.');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { to.done(); }
}

// GitHub mode (watch-once.js via Actions): read the committed deals.json.
//  - public repo (no token): raw CDN — no auth, no 60-req/hour API limit.
//  - private repo (token):   authenticated Contents API.
async function githubDeals(s) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const branch = (s.githubBranch || 'main').trim();
  const to = withTimeout(12_000);
  try {
    let res;
    if (s.githubToken) {
      res = await fetch(`https://api.github.com/repos/${repo}/contents/deals.json?ref=${branch}`, {
        headers: { Accept: 'application/vnd.github.raw', authorization: 'Bearer ' + s.githubToken },
        signal: to.signal,
      });
    } else {
      res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/deals.json?t=${Date.now()}`, {
        cache: 'no-store', signal: to.signal,
      });
    }
    if (res.status === 404) return []; // not committed yet (no deals so far)
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check the access token in Settings.');
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    return await res.json();
  } finally { to.done(); }
}

async function getDeals(limit) {
  const s = readSettings();
  if ((s.sourceType || 'github') === 'server') return serverGet(s, '/api/deals?limit=' + (limit || 200));
  return githubDeals(s);
}
async function getStatus() {
  const s = readSettings();
  if ((s.sourceType || 'github') === 'server') return serverGet(s, '/api/status');
  return { sourceType: 'github', repo: s.githubRepo };
}

// ---------------------------------------------------------------------------
// "Scan now" — a full local sweep of the entire wantlist, on demand.
// ---------------------------------------------------------------------------
// Reuses the watcher's own pure modules (engine + discogs client + store) and your local
// config.json (the Discogs token). Unlike the cloud watcher's paced, warm-up-gated alerting,
// this is a deliberate "show me everything cheap right now" scan: it lists EVERY release whose
// cheapest copy currently sits >= minDiscount under its VG+ suggested price (or its own usual
// lowest). No email, no warm-up, no new-low dedupe. Cancellable; emits progress to the renderer.
let scrapeAbort = false;
let scrapeRunning = false;
const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_SCAN_FILE = () => path.join(app.getPath('userData'), 'last-scan.json');

function loadWatcher() {
  // Pure, dependency-light modules from the watcher project. Wrapped so a packaged build that
  // can't see ../ fails with a clear message instead of a cryptic require error.
  try {
    return {
      engine: require(path.join(WATCHER_DIR, 'engine.js')),
      makeClient: require(path.join(WATCHER_DIR, 'discogs.js')).makeClient,
      makeStore: require(path.join(WATCHER_DIR, 'store.js')).makeStore,
      loadConfig: require(path.join(WATCHER_DIR, 'watcher.js')).loadConfig,
    };
  } catch (e) {
    throw new Error('Local scan needs the watcher source next to the dashboard (run it from the project, not a packaged build). ' + e.message);
  }
}

const SOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sold-median changes slowly; cache a week
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISCOGS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const parseMoney = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };

// In-page extractor: pull the "Last Sold / Low / Median / High" sales-history block off the
// release page. Discogs renders it in plain text once Cloudflare clears (verified live).
const SOLD_EXTRACT = `(() => {
  const t = document.body ? document.body.innerText : '';
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    median: g(/Median:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    low: g(/Low:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    high: g(/High:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    lastSold: g(/Last Sold:\\s*([^\\n\\t]+)/i),
    challenged: /just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300)),
    len: t.length,
  };
})()`;

// Load a release page in a hidden (real Chromium, residential IP) window and read its REAL
// sales-history median. The Cloudflare JS challenge runs and clears in this window; the
// cf_clearance cookie persists across navigations so only the first load pays the wait.
async function fetchSoldMedian(cfWin, releaseId) {
  await cfWin.loadURL(`https://www.discogs.com/release/${releaseId}`, { userAgent: DISCOGS_UA }).catch(() => {});
  let r = null;
  for (let i = 0; i < 22; i++) {
    await sleep(1000);
    r = await cfWin.webContents.executeJavaScript(SOLD_EXTRACT).catch(() => null);
    if (r && !r.challenged && r.len > 1500) break;
  }
  if (!r || r.challenged) return null; // Cloudflare never cleared for this one
  return { median: parseMoney(r.median), low: parseMoney(r.low), high: parseMoney(r.high), lastSold: r.lastSold || null, ts: Date.now() };
}

async function runScrape(win) {
  if (scrapeRunning) throw new Error('A scan is already running.');
  scrapeRunning = true;
  scrapeAbort = false;
  const send = (m) => { try { win.webContents.send('scrape:progress', m); } catch { /* window gone */ } };
  let cfWin = null;
  try {
    const { engine, makeClient, makeStore, loadConfig } = loadWatcher();
    const config = loadConfig();
    if (!config.token) throw new Error('No Discogs token in config.json — add it to enable local scans.');
    if (!config.username) throw new Error('No Discogs username in config.json.');

    const store = makeStore(path.join(WATCHER_DIR, 'state'));
    const client = makeClient({ token: config.token, userAgent: config.userAgent });

    send({ phase: 'wantlist', checked: 0, total: 0, found: 0 });
    const wantlist = await client.getWantlist(config.username);
    const total = wantlist.length;

    // PHASE 1 (API, fast): find candidates that look cheap vs the VG+ suggestion. This bounds the
    // slow web phase to a shortlist instead of scraping all ~715 release pages.
    const candidates = [];
    let checked = 0;
    for (const rel of wantlist) {
      if (scrapeAbort) break;
      try {
        const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
        const prevObs = store.lastObservation(rel.releaseId);
        const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
        store.pushObservation(rel.releaseId, curObs);

        if (stats.numForSale > 0 && stats.lowestPrice != null) {
          let sug = store.getSuggestion(rel.releaseId);
          if (!sug || !sug.ladder || Date.now() - sug.ts > SUGGESTION_TTL_MS) {
            try {
              const raw = await client.getPriceSuggestions(rel.releaseId);
              if (raw) { sug = { ts: Date.now(), vgplus: raw['Very Good Plus (VG+)']?.value ?? null, vg: raw['Very Good (VG)']?.value ?? null, ladder: engine.extractLadder(raw) }; store.setSuggestion(rel.releaseId, sug); }
            } catch { /* no suggestion -> trailing-median fallback */ }
          }
          const prelim = engine.evaluateMarketSignal({
            lowest: stats.lowestPrice,
            suggestion: sug ? sug.vgplus : null, suggestionLow: sug ? sug.vg : null, ladder: sug ? sug.ladder : null,
            trailingMedian: store.trailingMedianLowest(rel.releaseId, config.trailingN),
            prevAlertedLowest: null,
          }, { minDiscount: 0.4 });
          if (prelim.meetsThreshold) candidates.push({ rel, stats, sug, freshListing: engine.isFreshListing(prevObs, curObs) });
        }
      } catch (e) { /* one release failing must not abort the scan */ }
      checked++;
      if (checked % 2 === 0 || checked === total) send({ phase: 'scan', checked, total, found: candidates.length });
    }

    // PHASE 2 (web, slower): for each candidate fetch the REAL sales-history median via a hidden
    // BrowserWindow (residential IP clears Cloudflare), then re-judge against that true market value.
    cfWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { images: false } });
    const deals = [];
    let priced = 0;
    for (const c of candidates) {
      if (scrapeAbort) break;
      let sold = store.getSoldMedian(c.rel.releaseId);
      if (!sold || Date.now() - sold.ts > SOLD_TTL_MS) {
        try { const f = await fetchSoldMedian(cfWin, c.rel.releaseId); if (f) { sold = f; store.setSoldMedian(c.rel.releaseId, f); } } catch { /* leave sold null -> falls back to suggestion */ }
        await sleep(800); // be gentle on Discogs/Cloudflare between page loads
      }
      const sig = engine.evaluateMarketSignal({
        lowest: c.stats.lowestPrice,
        soldMedian: sold ? sold.median : null,
        suggestion: c.sug ? c.sug.vgplus : null, suggestionLow: c.sug ? c.sug.vg : null, ladder: c.sug ? c.sug.ladder : null,
        trailingMedian: store.trailingMedianLowest(c.rel.releaseId, config.trailingN),
        prevAlertedLowest: null,
      }, { minDiscount: 0.4 });
      if (sig.meetsThreshold) {
        deals.push({
          id: `${c.rel.releaseId}-scan`,
          releaseId: c.rel.releaseId, title: c.rel.title, artist: c.rel.artist, year: c.rel.year, thumb: c.rel.thumb,
          lowest: c.stats.lowestPrice, currency: c.stats.currency || config.currency, numForSale: c.stats.numForSale,
          reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
          soldMedian: sold ? sold.median : null, soldLow: sold ? sold.low : null, soldHigh: sold ? sold.high : null, lastSold: sold ? sold.lastSold : null,
          impliedGrade: sig.impliedGrade, pricedAsWorn: sig.pricedAsWorn,
          ownDrop: sig.ownDrop, confidence: sig.confidence, suspicious: sig.suspicious,
          freshListing: c.freshListing,
          url: `${engine.releaseMarketUrl(c.rel.releaseId)}?sort=price%2Casc&limit=25&currency=${config.currency}`,
          releaseUrl: engine.releaseUrl(c.rel.releaseId), ts: Date.now(),
        });
      }
      priced++;
      send({ phase: 'prices', checked: priced, total: candidates.length, found: deals.length });
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals })); } catch { /* best effort */ }
    send({ phase: 'done', checked: total, total, found: deals.length, aborted: scrapeAbort });
    return { deals, checked: total, total, aborted: scrapeAbort };
  } finally {
    scrapeRunning = false;
    if (cfWin) { try { cfWin.destroy(); } catch { /* already gone */ } }
  }
}

function lastScan() {
  try { return JSON.parse(fs.readFileSync(LAST_SCAN_FILE(), 'utf8')); } catch { return null; }
}

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('deals:get', (_e, limit) => getDeals(limit));
ipcMain.handle('status:get', () => getStatus());
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('scrape:run', (e) => runScrape(BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('scrape:cancel', () => { scrapeAbort = true; return true; });
ipcMain.handle('scrape:last', () => lastScan());

function createWindow() {
  const win = new BrowserWindow({
    width: 1120, height: 800, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#0f1115',
    title: 'Discogs Deal Watcher',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile('index.html');
  // Show only once painted, to avoid the white flash (same pattern as BPM Tapper).
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
