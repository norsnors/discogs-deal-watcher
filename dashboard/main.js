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

async function runScrape(win) {
  if (scrapeRunning) throw new Error('A scan is already running.');
  scrapeRunning = true;
  scrapeAbort = false;
  const send = (m) => { try { win.webContents.send('scrape:progress', m); } catch { /* window gone */ } };
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
    const deals = [];
    let checked = 0;

    for (const rel of wantlist) {
      if (scrapeAbort) break;
      try {
        const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
        const prevObs = store.lastObservation(rel.releaseId);
        const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
        store.pushObservation(rel.releaseId, curObs);

        if (stats.numForSale > 0 && stats.lowestPrice != null) {
          // Reference: cached/fresh VG+ suggestion, else this release's own trailing median.
          let sug = store.getSuggestion(rel.releaseId);
          if (!sug || Date.now() - sug.ts > SUGGESTION_TTL_MS) {
            try {
              const raw = await client.getPriceSuggestions(rel.releaseId);
              if (raw) { sug = { ts: Date.now(), vgplus: raw['Very Good Plus (VG+)']?.value ?? null, vg: raw['Very Good (VG)']?.value ?? null }; store.setSuggestion(rel.releaseId, sug); }
            } catch { /* no suggestion -> trailing-median fallback */ }
          }
          const sig = engine.evaluateMarketSignal({
            lowest: stats.lowestPrice,
            suggestion: sug ? sug.vgplus : null,
            suggestionLow: sug ? sug.vg : null,
            trailingMedian: store.trailingMedianLowest(rel.releaseId, config.trailingN),
            prevAlertedLowest: null, // manual scan: show every current bargain, no dedupe
          }, { minDiscount: config.minDiscount });

          if (sig.meetsThreshold) {
            deals.push({
              id: `${rel.releaseId}-scan`,
              releaseId: rel.releaseId, title: rel.title, artist: rel.artist, year: rel.year, thumb: rel.thumb,
              lowest: stats.lowestPrice, currency: stats.currency || config.currency, numForSale: stats.numForSale,
              reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
              ownDrop: sig.ownDrop, confidence: sig.confidence, suspicious: sig.suspicious,
              freshListing: engine.isFreshListing(prevObs, curObs),
              url: `${engine.releaseMarketUrl(rel.releaseId)}?sort=price%2Casc&limit=25&currency=${config.currency}`,
              releaseUrl: engine.releaseUrl(rel.releaseId), ts: Date.now(),
            });
          }
        }
      } catch (e) { /* one release failing must not abort the scan */ }
      checked++;
      if (checked % 2 === 0 || checked === total) send({ phase: 'scan', checked, total, found: deals.length });
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals })); } catch { /* best effort */ }
    send({ phase: 'done', checked, total, found: deals.length, aborted: scrapeAbort });
    return { deals, checked, total, aborted: scrapeAbort };
  } finally {
    scrapeRunning = false;
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
