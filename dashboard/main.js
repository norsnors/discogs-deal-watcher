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
const { execFile } = require('child_process');

// Where the watcher's pure modules (engine/discogs/store/watcher.js) live:
//   • dev run  — one level up, in the project checkout.
//   • packaged — bundled into the app's resources/ via electron-builder extraResources.
const WATCHER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'watcher')
  : path.join(__dirname, '..');

// Where the USER's own data lives — config.json (Discogs creds), the state/ cache, sold-medians:
//   • dev run  — the project folder (shared with the cloud watcher; the soldmedians git push works).
//   • packaged — the OS per-user app-data dir (Program Files is read-only). The first-run setup
//     wizard writes config.json there. Computed lazily because app.getPath needs the app ready.
function dataDir() { return app.isPackaged ? app.getPath('userData') : WATCHER_DIR; }
function configPath() { return path.join(dataDir(), 'config.json'); }
function stateDir() { return path.join(dataDir(), 'state'); }

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
// Defaults for a fresh, shareable install: no cloud is configured, so the LOCAL SCAN is the deal
// source out of the box (it works with just a Discogs token — no GitHub/server needed). Anyone
// running their own cloud watcher can point this at their repo/server in Settings.
const DEFAULT_SETTINGS = {
  sourceType: 'scan',        // 'scan' (local, default) | 'github' | 'server'
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  apiBase: '',
  token: '',
  autoPushMedians: true, // dev/owner only: after a scan, commit+push soldmedians.json for the cloud
  autoScanOnLaunchHours: 1, // re-scan while the app is open whenever the last scan is older than this many hours (also gates the launch scan). 0 = off
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

// Run a git command in the watcher repo. Rejects on non-zero exit or timeout. Terminal prompts are
// disabled so a missing credential fails fast instead of hanging the app waiting for input.
function git(args, ms = 45_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', WATCHER_DIR, ...args], { timeout: ms, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => { if (err) { err.stderr = stderr; reject(err); } else resolve((stdout || '').trim()); });
  });
}

// The last push outcome, PERSISTED — a failed push used to flash in the scan-status line for a few
// seconds and vanish, while the cloud silently kept judging deals against stale references for
// weeks. The topbar badge reads this file so a failure stays visible until a push succeeds.
const PUSH_STATUS_FILE = () => path.join(app.getPath('userData'), 'push-status.json');
function readPushStatus() { try { return JSON.parse(fs.readFileSync(PUSH_STATUS_FILE(), 'utf8')); } catch { return null; } }
function writePushStatus(st) { try { fs.writeFileSync(PUSH_STATUS_FILE(), JSON.stringify(st)); } catch { /* best effort */ } }

// Auto-commit + push the refreshed soldmedians.json so the cloud email watcher picks it up with NO
// manual git step (the whole point: "Scan now" is the only action). soldmedians.json is local-only and
// the cloud bot's deals.json is remote-only, so the rebase pull that integrates the bot's commits never
// conflicts. Fully best-effort: any failure is reported back, never thrown into the scan.
async function autoPushSoldMedians() {
  try {
    await git(['add', 'soldmedians.json']);
    // `diff --cached --quiet` exits 0 when nothing is staged (file unchanged) -> nothing to push.
    try { await git(['diff', '--cached', '--quiet', '--', 'soldmedians.json']); return { ok: true, pushed: false, reason: 'unchanged' }; }
    catch { /* non-zero exit = there IS a staged change -> continue committing */ }
    await git(['commit', '-m', 'Auto: refresh sold-medians from dashboard scan']);
    // Integrate the cloud bot's deals.json commits first, or the push is rejected (non-fast-forward).
    await git(['pull', '--rebase', '--autostash', 'origin', 'main'], 90_000);
    await git(['push', 'origin', 'main'], 60_000);
    return { ok: true, pushed: true };
  } catch (e) {
    const msg = (e && (e.stderr || e.message)) ? String(e.stderr || e.message) : String(e);
    const firstLine = msg.split('\n').map((l) => l.trim()).find(Boolean) || 'git failed';
    return { ok: false, pushed: false, reason: firstLine.slice(0, 200) };
  }
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

// GitHub mode (watch-once.js via Actions): read a committed JSON file (deals.json / gems.json).
//  - public repo (no token): raw CDN — no auth, no 60-req/hour API limit.
//  - private repo (token):   authenticated Contents API.
// Returns null when the file isn't committed yet (nothing found so far).
async function githubFile(s, name) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const branch = (s.githubBranch || 'main').trim();
  const to = withTimeout(12_000);
  try {
    let res;
    if (s.githubToken) {
      res = await fetch(`https://api.github.com/repos/${repo}/contents/${name}?ref=${branch}`, {
        headers: { Accept: 'application/vnd.github.raw', authorization: 'Bearer ' + s.githubToken },
        signal: to.signal,
      });
    } else {
      res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${name}?t=${Date.now()}`, {
        cache: 'no-store', signal: to.signal,
      });
    }
    if (res.status === 404) return null; // not committed yet
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check the access token in Settings.');
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    return await res.json();
  } finally { to.done(); }
}
const githubDeals = async (s) => (await githubFile(s, 'deals.json')) || [];

async function getDeals(limit) {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') return serverGet(s, '/api/deals?limit=' + (limit || 200));
  if (src === 'github') return githubDeals(s);
  // 'scan' (default for a fresh install): no cloud — show whatever the last local scan found.
  const last = lastScan();
  return (last && Array.isArray(last.deals)) ? last.deals : [];
}
async function getStatus() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') return serverGet(s, '/api/status');
  if (src === 'github') return { sourceType: 'github', repo: s.githubRepo };
  const last = lastScan();
  return { sourceType: 'scan', wantlistSize: (last && last.wantlistTotal != null) ? last.wantlistTotal : '—' };
}

// 💎 Rare gems (0-for-sale -> first copy) + the zero-stock watch list, for the dashboard's Rare tab.
// Shape everywhere: { ts, gems: [...], zeroWatch: [...] }.
//   • github — the committed gems.json (written by watch-once.js next to deals.json).
//   • server — the live /api/gems endpoint.
//   • scan   — the LOCAL store's accumulated gems (state/gems.json, appended by runScrape) + the
//              zero-stock watch list saved with the last scan.
async function getGems() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') return serverGet(s, '/api/gems?limit=100');
  if (src === 'github') {
    const g = await githubFile(s, 'gems.json');
    return g && typeof g === 'object' ? { ts: g.ts || null, gems: g.gems || [], zeroWatch: g.zeroWatch || [] } : { ts: null, gems: [], zeroWatch: [] };
  }
  let gems = [];
  try { gems = JSON.parse(fs.readFileSync(path.join(stateDir(), 'gems.json'), 'utf8')).slice(0, 100); } catch { /* no gems yet */ }
  const last = lastScan();
  return { ts: last ? last.ts : null, gems, zeroWatch: (last && last.zeroWatch) || [] };
}

// ---------------------------------------------------------------------------
// Service health — "is the cloud watcher actually RUNNING right now?"
// ---------------------------------------------------------------------------
// getStatus()/getDeals() only confirm the SOURCE is reachable (the raw CDN can hand back a
// deals.json that's days stale and look perfectly "connected"). This is the real heartbeat:
//   • GitHub mode — query the Actions runs API for the last scheduled sweep: when it fired and
//     whether it succeeded. A 'failure' conclusion is meaningful — watch-once.js exits non-zero
//     precisely when the deal EMAIL fails to send (the product), so a red badge = "you've stopped
//     getting deal mails". Works unauthenticated on the public repo (deals.json comes from the raw
//     CDN, a different host, so this is the only api.github.com traffic — polled slowly to stay
//     under the 60-req/hr unauthenticated limit).
//   • Server mode — read the live /api/status sweep timestamp.
const CRON_WORKFLOW = 'watch.yml'; // the sweep workflow file — health/cron info reads THIS workflow's runs only

// Which GitHub repo hosts the cloud cron? Settings (github mode) first; failing that, a dev/owner
// run can derive it from the local checkout's origin remote (the dashboard lives inside the watcher
// repo) — that's what lets the cron pill work in the default local-scan mode with zero setup.
let repoFromGit; // undefined = not probed yet; null = probed, none found
async function cronRepo(s) {
  const set = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (set) return set;
  if (repoFromGit !== undefined) return repoFromGit;
  if (app.isPackaged) { repoFromGit = null; return null; } // packaged installs have no checkout/remote
  try {
    const url = await git(['remote', 'get-url', 'origin'], 10_000);
    const m = String(url).match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    repoFromGit = m ? m[1] : null;
  } catch { repoFromGit = null; }
  return repoFromGit;
}

async function githubHealth(s) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const to = withTimeout(12_000);
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (s.githubToken) headers.authorization = 'Bearer ' + s.githubToken;
    // Scoped to the sweep workflow's runs (a build-mac run can't shadow the heartbeat), and a few of
    // them: the extra runs feed the cron pill's fire history + real-cadence estimate at no extra
    // request cost (still ONE api.github.com call per poll).
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${CRON_WORKFLOW}/runs?per_page=6`, { headers, signal: to.signal });
    // 403/429 with no remaining budget = the unauthenticated rate limit, NOT a real outage — say so
    // so the UI keeps the last-known state instead of falsely flipping to "down".
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || !s.githubToken) return { mode: 'github', repo, ok: false, rateLimited: true };
    }
    if (res.status === 404) return { mode: 'github', repo, ok: false, notFound: true };
    if (res.status === 401) throw new Error('GitHub auth failed — check the access token in Settings.');
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    const j = await res.json();
    const mapRun = (run) => ({
      startedAt: Date.parse(run.run_started_at || run.created_at) || null,
      updatedAt: Date.parse(run.updated_at) || null,
      status: run.status,         // queued | in_progress | completed
      conclusion: run.conclusion, // success | failure | cancelled | null (while running)
      url: run.html_url,
      runNumber: run.run_number,
      event: run.event,           // schedule | workflow_dispatch | ...
    });
    const runs = (j.workflow_runs || []).map(mapRun);
    return { mode: 'github', repo, ok: true, run: runs[0] || null, recent: runs };
  } finally { to.done(); }
}

async function getServiceHealth() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'scan') {
    // Local-scan mode: the "service" is your own ⚡ Scan now — but the OWNER's cloud cron still
    // exists next door, so when a repo is derivable (settings, or the checkout's git remote) the
    // cron heartbeat rides along for the topbar's cron pill. Best-effort: no repo / no network →
    // plain local health, exactly as before.
    const last = lastScan();
    const out = { mode: 'local', ok: true, lastScanAt: (last && last.ts) ? last.ts : null };
    try {
      const repo = await cronRepo(s);
      if (repo) out.cron = await githubHealth({ ...s, githubRepo: repo });
    } catch { /* cron info is a bonus, never a failure */ }
    return out;
  }
  if (src === 'server') {
    try { return { mode: 'server', ok: true, apiBase: s.apiBase, status: await serverGet(s, '/api/status') }; }
    catch (e) { return { mode: 'server', ok: false, apiBase: s.apiBase, error: e.message }; }
  }
  try { return await githubHealth(s); }
  catch (e) { return { mode: 'github', ok: false, repo: s.githubRepo, error: e.message }; }
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
const RARE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // per-release cooldown between rare-gem alerts (mirrors the cloud watcher)
const QUICK_SCAN_SIZE = 250; // a quick scan checks only the top-N highest-priority releases (by watch-score)
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
    // Packaged builds bundle these into resources/watcher (see electron-builder extraResources); a
    // dev run reads them from the project one level up. Either way, a failure here is a broken install.
    throw new Error('Could not load the watcher engine (' + WATCHER_DIR + '). Reinstall the app. ' + e.message);
  }
}

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

// Map one raw sell_item JSON copy to our trimmed shape. Defined ONCE and embedded into both the
// in-page fetch and the fallback body-parse extractors below, so the two can never drift apart.
//
// Shipping from the JSON: a copy carries `shipping.shippingPrice` (seller base rate) and
// `shipping.buyerShippingPrice` (what WE pay to ship to our location). We prefer the buyer price,
// fall back to the base rate, and honour a single-item free-shipping threshold. **BUT, verified
// live (June 2026): for an ANONYMOUS request the entire `shipping` object — and the buyer* price
// fields — come back null** (Discogs only computes buyer shipping for a known/logged-in
// destination). That's why every scanned copy used to show the €5 estimate. The REAL shipping is
// instead joined on by itemId from the rendered marketplace page (see SHIP_EXTRACT below), which
// DOES show IP-geolocated shipping to us anonymously. This mapping is kept (correct + free when a
// session ever IS logged in), but in practice `shippingSource` here is null and the page provides
// the number. `shippingSource`: 'buyer'|'base'|null (the page join later sets 'page').
const MAP_SELL_ITEM = `(it) => {
  const sh = it.shipping || {};
  const p = it.price || {};
  const amount = (p.amount != null) ? p.amount : null;
  let shipping = (sh.buyerShippingPrice != null) ? sh.buyerShippingPrice
    : ((sh.shippingPrice != null) ? sh.shippingPrice : null);
  const shippingSource = (sh.buyerShippingPrice != null) ? 'buyer'
    : ((sh.shippingPrice != null) ? 'base' : null);
  if (shipping != null && sh.freeShippingMin != null && amount != null && amount >= sh.freeShippingMin) shipping = 0;
  return {
    itemId: it.itemId || null,
    media: it.mediaCondition || null,
    sleeve: it.sleeveCondition || null,
    price: amount,
    currency: p.currencyCode || null,
    shipping: shipping,
    shippingSource: shippingSource,
    shipsFrom: it.seller ? it.seller.shipsFrom : null,
    sellerRating: it.seller ? it.seller.rating : null,
    allowsOffers: !!it.allowsOffers,
  };
}`;

// In-page fetch of the REAL per-copy marketplace listings. The modern Discogs marketplace is
// backed by a clean JSON endpoint (/api/shop-page-api/sell_item) that returns each copy's exact
// media + sleeve condition, price and shipping — the data the official API hides. We run this
// fetch INSIDE the Cloudflare-cleared window (same-origin + cf_clearance cookie), so it succeeds
// where a plain cloud/datacenter fetch would 403. Far more robust than scraping listing HTML.
const LISTINGS_FETCH = (releaseId, currency) => `(async () => {
  try {
    const u = 'https://www.discogs.com/api/shop-page-api/sell_item?release=' + ${Number(releaseId)}
      + '&sort=price&sortOrder=ascending&count=100&offset=0&currency=' + ${JSON.stringify(String(currency || 'EUR'))};
    const res = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) return { error: 'http_' + res.status };
    const ct = res.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { error: 'not_json' }; // Cloudflare HTML challenge, not the API
    const j = await res.json();
    const items = (j.items || []).map(${MAP_SELL_ITEM});
    return { items: items, totalCount: (j.totalCount != null ? j.totalCount : items.length) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;

// The same listings endpoint as a plain URL — for the FALLBACK strategy: navigate the window
// straight to it and read the JSON body (the exact flow proven by the public Discogs scraper —
// a direct GET of this URL returns JSON once cf_clearance is set). Robust if the in-page fetch is
// ever blocked (e.g. a stricter CSP/referer check) while a top-level navigation still works.
const SELL_ITEM_URL = (releaseId, currency) =>
  `https://www.discogs.com/api/shop-page-api/sell_item?release=${Number(releaseId)}&sort=price&sortOrder=ascending&count=100&offset=0&currency=${encodeURIComponent(String(currency || 'EUR'))}`;

// Read + parse the JSON body of the sell_item endpoint after navigating to it directly.
const PARSE_BODY = `(() => {
  try {
    const t = document.body ? document.body.innerText : '';
    if (/just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300))) return { error: 'cloudflare' };
    const j = JSON.parse(t);
    const items = (j.items || []).map(${MAP_SELL_ITEM});
    return { items: items, totalCount: (j.totalCount != null ? j.totalCount : items.length) };
  } catch (e) { return { error: 'parse_' + String((e && e.message) || e) }; }
})()`;

// The classic marketplace page (/sell/release/{id}) for the REAL per-copy shipping. The sell_item
// JSON returns a null shipping object for anonymous requests, but this rendered page DOES show
// shipping — geolocated to our (NL residential) IP — in every listing row (verified live: rows
// like "+€20.00 shipping"). Each row links to /sell/item/{itemId}, so we scrape { itemId: shipping }
// and join it onto the JSON copies by itemId. Selectors used (`tr.shortcut_navigable`, `.item_shipping`,
// `a[href*="/sell/item/"]`) are the long-stable classic-marketplace markup. Returns 0 for free
// shipping and omits rows with no parseable number (those keep null → estimate fallback, honestly).
const SELL_PAGE_URL = (releaseId, currency) =>
  `https://www.discogs.com/sell/release/${Number(releaseId)}?currency=${encodeURIComponent(String(currency || 'EUR'))}&sort=price%2Casc&limit=100`;
const SHIP_EXTRACT = `(() => {
  const rows = [...document.querySelectorAll('tr.shortcut_navigable')];
  const map = {};
  for (const tr of rows) {
    const link = tr.querySelector('a[href*="/sell/item/"]');
    const idm = link ? (link.getAttribute('href').match(/\\/sell\\/item\\/(\\d+)/) || [])[1] : null;
    if (!idm) continue;
    const shipEl = tr.querySelector('.item_shipping');
    let ship = null;
    if (shipEl) {
      const t = shipEl.textContent.trim();
      if (/free/i.test(t)) ship = 0;
      else { const m = t.replace(/,/g, '.').match(/(\\d+(?:\\.\\d+)?)/); if (m) ship = parseFloat(m[1]); }
    }
    if (ship != null && isFinite(ship)) map[idm] = ship;
  }
  // The ready flag lets the poller stop as soon as the sell page has rendered (Cloudflare cleared),
  // even for a release with zero current listings (rowCount 0) -- otherwise it would spin the
  // full retry budget waiting for rows that will never appear.
  const t = document.body ? document.body.innerText : '';
  const challenged = /just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300));
  return { map: map, rowCount: rows.length, ready: !challenged && t.length > 1200 };
})()`;

// Poll an in-page check, FAST-FIRST then backing off, instead of paying a fixed leading sleep.
// Returns the first result for which ok(result) is true, or null after the retry budget. Once
// cf_clearance is warm a page is ready almost immediately, so the first (zero-delay) check usually
// wins — that's where the per-candidate seconds come from vs the old `sleep(1000); check` loops.
// All waiting is local DOM polling (executeJavaScript), so it adds no network load on Discogs.
async function waitFor(cfWin, script, ok, { tries = 20, step = 400, max = 1500 } = {}) {
  let delay = 0;
  for (let i = 0; i < tries; i++) {
    if (scrapeAbort) return null;
    if (delay) await sleep(delay);
    const r = await cfWin.webContents.executeJavaScript(script).catch(() => null);
    if (ok(r)) return r;
    delay = Math.min(max, delay + step); // 0, 400, 800, 1200, 1500, 1500, ...
  }
  return null;
}

// Read a release's REAL data from a hidden (real Chromium, residential IP) window:
//   (1) its sales-history median (Last Sold / Low / Median / High) — ONLY when we need it, and
//   (2) its per-copy marketplace listings (condition/price via the same-origin sell_item JSON)
//       joined with REAL per-copy shipping (scraped from the rendered sell page).
// The Cloudflare JS challenge clears in this window; the cf_clearance cookie persists across
// navigations (and across candidates in one scan), so only the first load pays the wait.
//
// opts.needSold === false skips the release-page navigation entirely. The sold-median moves slowly
// (it's sales HISTORY) and is cached weekly, so on a repeat scan we already have it — skipping that
// whole navigation is the single biggest per-candidate saving (and one fewer hit on Discogs). The
// sell page is same-origin for the JSON fetch AND carries the shipping rows, so condition + price +
// shipping all come from ONE navigation; the release page is loaded only on a sold-median cache miss.
async function loadReleaseData(cfWin, releaseId, currency, opts = {}) {
  const needSold = opts.needSold !== false;
  let sold = null;
  let cleared = false;

  if (needSold) {
    await cfWin.loadURL(`https://www.discogs.com/release/${releaseId}`, { userAgent: DISCOGS_UA }).catch(() => {});
    const r = await waitFor(cfWin, SOLD_EXTRACT, (x) => x && !x.challenged && x.len > 1500);
    if (r) {
      cleared = true;
      sold = { median: parseMoney(r.median), low: parseMoney(r.low), high: parseMoney(r.high), lastSold: r.lastSold || null, ts: Date.now() };
    }
  }

  // Warm-up path: the caller only wants the sold-median (coverage builder). Skip the sell page +
  // listings entirely — that's the bulk of the per-release work and it's irrelevant here.
  if (opts.soldOnly) return { cleared, sold, listings: null, listingsError: null, totalCount: null, shippingJoined: 0 };

  // Sell page: real per-copy shipping (DOM rows) AND, same-origin, the structured listings JSON.
  await cfWin.loadURL(SELL_PAGE_URL(releaseId, currency), { userAgent: DISCOGS_UA }).catch(() => {});
  const shipRes = await waitFor(cfWin, SHIP_EXTRACT, (x) => x && (x.rowCount > 0 || x.ready));
  if (shipRes) cleared = true; // the sell page cleared CF even if the release page wasn't loaded/cleared
  const shipMap = shipRes ? (shipRes.map || {}) : null;

  // Per-copy condition + price via the same-origin JSON fetch (robust structured data, no selectors).
  // Strategy 1: in-page fetch on the sell page we're already on. Two tries only — when the in-page
  // fetch fails it's structural (CSP/challenge), not transient, so extra retries just delayed the
  // fallback by ~1.5s per candidate.
  let lr = null;
  for (let i = 0; i < 2; i++) {
    if (scrapeAbort) break;
    lr = await cfWin.webContents.executeJavaScript(LISTINGS_FETCH(releaseId, currency)).catch((e) => ({ error: String((e && e.message) || e) }));
    if (lr && Array.isArray(lr.items)) break;
    await sleep(500);
  }
  // Strategy 2 (fallback): navigate straight to the JSON URL and read the body (the scraper's flow).
  if (!(lr && Array.isArray(lr.items))) {
    await cfWin.loadURL(SELL_ITEM_URL(releaseId, currency), { userAgent: DISCOGS_UA, extraHeaders: 'Accept: application/json' }).catch(() => {});
    const r = await waitFor(cfWin, PARSE_BODY, (x) => x && (Array.isArray(x.items) || (x.error && x.error !== 'cloudflare')), { tries: 8, step: 500 });
    if (r) lr = r;
  }

  // Join the REAL per-copy shipping onto the JSON copies by itemId. The JSON's shipping is null
  // anonymously; the rendered sell page shows IP-geolocated shipping to us. Best-effort: any miss
  // leaves shipping null → the dashboard's estimate fallback kicks in.
  let shippingJoined = 0;
  if (lr && Array.isArray(lr.items) && lr.items.length && shipMap) {
    for (const it of lr.items) {
      const k = it.itemId != null ? String(it.itemId) : null;
      if (it.shipping == null && k && shipMap[k] != null) { it.shipping = shipMap[k]; it.shippingSource = 'page'; shippingJoined++; }
    }
  }

  return {
    cleared,
    sold,
    listings: lr && Array.isArray(lr.items) ? lr.items : null,
    listingsError: lr && lr.error ? lr.error : (lr && Array.isArray(lr.items) ? null : 'no_result'),
    totalCount: lr ? lr.totalCount : null,
    shippingJoined,
  };
}

async function runScrape(win, opts = {}) {
  if (scrapeRunning) throw new Error('A scan is already running.');
  scrapeRunning = true;
  scrapeAbort = false;
  const send = (m) => { try { win.webContents.send('scrape:progress', m); } catch { /* window gone */ } };
  let cfWin = null;
  try {
    const { engine, makeClient, makeStore, loadConfig } = loadWatcher();
    const config = loadConfig(configPath());
    if (!config.token) throw new Error('No Discogs token configured — open Settings → Discogs account.');
    if (!config.username) throw new Error('No Discogs username configured — open Settings → Discogs account.');

    const store = makeStore(stateDir());
    // Slightly tighter pacing than the cloud default (1100ms) for this interactive scan: 1050ms is
    // ~57 req/min — under Discogs' 60/min cap AND clear of the client's near-empty-window guard (which
    // would 60s-stall if `remaining` hit 1), so it shaves ~30-40s off a full sweep without risking a
    // rate-limit stall. The cloud watcher keeps the conservative 1100ms default — its email
    // reliability matters more there than a few seconds.
    const client = makeClient({ token: config.token, userAgent: config.userAgent, minIntervalMs: 1050 });
    const SOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sold-median changes slowly; reuse the weekly cache

    send({ phase: 'wantlist', checked: 0, total: 0, found: 0 });
    const wantlist = await client.getWantlist(config.username);
    const wantlistTotal = wantlist.length;

    // Quick scan: check only the highest-PRIORITY releases — ranked by engine.releaseWatchScore
    // (staleness + recent activity + rarity), the same signal the cloud sweep uses — instead of the
    // whole wantlist. This is the only way under the ~13-min API rate-limit floor: it trades coverage
    // (quiet/low-priority releases are skipped THIS run and roll into the next) for a ~4-5 min scan.
    // A full scan (opts.quick falsy) still checks every release.
    const now = Date.now();
    const work = opts.quick
      ? wantlist
        .map((rel) => ({ rel, score: engine.releaseWatchScore(store.getHistory(rel.releaseId), now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, QUICK_SCAN_SIZE)
        .map((x) => x.rel)
      : wantlist;
    const total = work.length;

    // Create the hidden Cloudflare-clearing window NOW and pre-warm it in the background, so the
    // cf_clearance cookie is already set by the time the first candidate needs it (the wait overlaps
    // the early API calls instead of stalling the first confirmation).
    cfWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { images: false } });
    cfWin.loadURL('https://www.discogs.com/', { userAgent: DISCOGS_UA }).catch(() => {});

    const deals = [];
    // Near-misses: candidates that LOOKED cheap (passed the Phase-1 prelim) but were rejected in
    // confirmation — no VG+ copy, or a VG+ copy that isn't cheap enough. Surfaced (opt-in) in the
    // dashboard with the reason, so "why isn't release X showing?" is answerable without a script.
    const nearMisses = [];
    const scrapedThisRun = new Set(); // releases whose median we (re)scraped this run — lets a full-median refresh skip them in the warm-up (no double scrape)
    let priced = 0;          // candidates run through the browser (Phase 2)
    let candidateCount = 0;  // candidates discovered so far (Phase 1)
    let confirmed = 0;
    let droppedNoVgPlus = 0;
    let unconfirmed = 0;
    let realShip = 0; // confirmed deals carrying REAL per-copy shipping (joined from the page, not estimated)
    let cfFailed = 0; // candidates where Cloudflare never cleared — surfaced in the done line, retried next scan
    const marketUrl = (id) => `${engine.releaseMarketUrl(id)}?sort=price%2Casc&limit=25&currency=${config.currency}`;

    // Confirm ONE candidate through the browser: read the REAL data the official API hides — the
    // sales-history median (only when not cached) AND every copy's actual media condition + price +
    // shipping — then pick the CHEAPEST copy that is VG+ or better and judge the discount against
    // THAT copy. A release whose only cheap copies are worn (sub-VG+) is dropped, so a scan deal is a
    // copy we've CONFIRMED is VG+, not a price guess.
    async function confirmCandidate(c) {
      const cachedSold = store.getSoldMedian(c.rel.releaseId);
      // A deep "full + medians" scan re-scrapes every median (ignoring the weekly cache) so all
      // references are guaranteed current; a normal scan reuses a fresh cached median to save time.
      // Either way, a release the interleaved warm-up ALREADY scraped this run is fresh by
      // definition — don't pay the release-page navigation twice in one scan.
      const soldFresh = scrapedThisRun.has(c.rel.releaseId)
        ? !!cachedSold
        : (!opts.fullMedians && !!(cachedSold && cachedSold.median != null && cachedSold.ts && (Date.now() - cachedSold.ts < SOLD_TTL_MS)));

      let data = { cleared: false, sold: null, listings: null };
      try { data = await loadReleaseData(cfWin, c.rel.releaseId, config.currency, { needSold: !soldFresh }); } catch { /* leave defaults */ }
      await sleep(300); // be gentle on Discogs/Cloudflare between releases

      // Sold-median: prefer a fresh scrape, else the weekly cache. Refresh the cache when fresh.
      // If the page cleared but the release has simply never sold, cache a null-median sentinel so the
      // warm-up below doesn't keep re-scraping it every run (only when we don't already have a real one).
      let sold = cachedSold;
      if (data.sold && data.sold.median != null) { sold = data.sold; store.setSoldMedian(c.rel.releaseId, data.sold); }
      else if (data.cleared && data.sold && (!cachedSold || cachedSold.median == null)) { store.setSoldMedian(c.rel.releaseId, { median: null, low: null, high: null, lastSold: data.sold.lastSold || 'Never', ts: Date.now() }); }
      if (data.sold) scrapedThisRun.add(c.rel.releaseId); // got a release-page read this run -> warm-up needn't redo it

      const common = {
        id: `${c.rel.releaseId}-scan`,
        releaseId: c.rel.releaseId, title: c.rel.title, artist: c.rel.artist, year: c.rel.year, thumb: c.rel.thumb,
        numForSale: c.stats.numForSale,
        soldMedian: sold ? sold.median : null, soldLow: sold ? sold.low : null, soldHigh: sold ? sold.high : null, lastSold: sold ? sold.lastSold : null,
        freshListing: c.freshListing,
        // Recent lowest-price trail (oldest -> newest) for the dashboard sparkline.
        spark: store.getHistory(c.rel.releaseId).slice(-12).map((o) => o.lowest).filter((x) => typeof x === 'number' && x > 0),
        releaseUrl: engine.releaseUrl(c.rel.releaseId), ts: Date.now(),
      };

      if (Array.isArray(data.listings)) {
        // We have the real listings -> pick the cheapest copy that is actually VG+ or better.
        const pick = engine.selectByCondition(data.listings, { minCondition: 'Very Good Plus (VG+)' });
        if (!pick.best) {
          droppedNoVgPlus++;
          const ca = pick.cheapestAny;
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'no-vgplus',
            currency: (ca && ca.currency) || c.stats.currency || config.currency,
            cheapestPrice: ca ? (ca.price ?? null) : null, cheapestGrade: ca ? ca.media : null,
            copiesSeen: pick.totalCount, vgPlusCount: pick.acceptableCount,
            url: marketUrl(c.rel.releaseId),
          });
          return;
        }
        const best = pick.best;
        const sig = engine.evaluateMarketSignal({
          lowest: best.price,
          soldMedian: sold ? sold.median : null,
          suggestion: c.sug ? c.sug.vgplus : null, suggestionLow: c.sug ? c.sug.vg : null, ladder: c.sug ? c.sug.ladder : null,
          trailingMedian: store.trailingMedianLowest(c.rel.releaseId, config.trailingN),
          prevAlertedLowest: null,
        }, { minDiscount: 0.4, shippingEstimate: best.shipping != null ? best.shipping : config.shippingEstimate });
        if (sig.meetsThreshold) {
          const cur = best.currency || c.stats.currency || config.currency;
          const cheaperWorn = pick.cheapestAny && pick.cheapestAny.itemId !== best.itemId
            && (pick.cheapestAny.total ?? pick.cheapestAny.price) < (best.total ?? best.price);
          // A: how many VG+ copies are ALL cheap vs the reference (a cluster = real price drop, not a fluke).
          const cluster = engine.cheapCluster(pick.acceptable, sig.reference, 0.4);
          // B: a slightly-dearer-but-better-grade copy to offer as an alternative.
          const alt = pick.betterAlt;
          deals.push({
            ...common,
            lowest: best.price, currency: cur,
            shipping: best.shipping, shippingSource: best.shippingSource, shipsFrom: best.shipsFrom,
            reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
            conditionConfirmed: true, mediaCondition: best.media, sleeveCondition: best.sleeve,
            vgPlusCount: pick.acceptableCount, copiesSeen: pick.totalCount,
            cheapVgPlusCount: cluster.count, cheapVgPlusLow: cluster.low, cheapVgPlusHigh: cluster.high,
            altGrade: alt ? alt.media : null, altPrice: alt ? (alt.total ?? alt.price) : null, altUrl: alt ? alt.url : null,
            cheaperWornPrice: cheaperWorn ? pick.cheapestAny.price : null,
            cheaperWornCondition: cheaperWorn ? pick.cheapestAny.media : null,
            ownDrop: sig.ownDrop, impliedGrade: sig.impliedGrade, pricedAsWorn: sig.pricedAsWorn, suspicious: sig.suspicious,
            listingUrl: best.url, url: best.url || marketUrl(c.rel.releaseId),
          });
          confirmed++;
          if (best.shipping != null) realShip++;
        } else {
          // There IS a VG+ copy, it's just not cheap enough vs the reference (the JJ-Foster case).
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'vgplus-not-cheap',
            currency: best.currency || c.stats.currency || config.currency,
            bestPrice: best.price, bestGrade: best.media, shipping: best.shipping,
            discount: sig.discount, effectiveDiscount: sig.effectiveDiscount,
            reference: sig.reference, referenceSource: sig.referenceSource,
            url: best.url || marketUrl(c.rel.releaseId),
          });
        }
      } else {
        // Listings unreachable (Cloudflare didn't clear / API shape changed) -> fall back to the
        // API-only estimate so the feature degrades gracefully. Marked unconfirmed; the dashboard's
        // "VG+ only" filter hides it unless it at least looks VG+ by price.
        if (!data.cleared) cfFailed++; // count the "never got past Cloudflare" case for the done line
        const sig = engine.evaluateMarketSignal({
          lowest: c.stats.lowestPrice,
          soldMedian: sold ? sold.median : null,
          suggestion: c.sug ? c.sug.vgplus : null, suggestionLow: c.sug ? c.sug.vg : null, ladder: c.sug ? c.sug.ladder : null,
          trailingMedian: store.trailingMedianLowest(c.rel.releaseId, config.trailingN),
          prevAlertedLowest: null,
        }, { minDiscount: 0.4 });
        if (sig.meetsThreshold) {
          deals.push({
            ...common,
            lowest: c.stats.lowestPrice, currency: c.stats.currency || config.currency,
            shipping: null,
            reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
            conditionConfirmed: false, conditionError: data.listingsError || 'unavailable',
            ownDrop: sig.ownDrop, impliedGrade: sig.impliedGrade, pricedAsWorn: sig.pricedAsWorn, suspicious: sig.suspicious,
            url: marketUrl(c.rel.releaseId),
          });
          unconfirmed++;
        } else {
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'unconfirmed-not-cheap',
            currency: c.stats.currency || config.currency,
            lowest: c.stats.lowestPrice, discount: sig.discount, effectiveDiscount: sig.effectiveDiscount,
            reference: sig.reference, referenceSource: sig.referenceSource, impliedGrade: sig.impliedGrade,
            url: marketUrl(c.rel.releaseId),
          });
        }
      }
    }

    // --- Sold-median warm-up (coverage builder) — INTERLEAVED, not a serial post-pass -----------
    // The candidate pipeline only scrapes a sold-median for releases that LOOKED cheap. Releases
    // sitting at a normal price never get their true market value learned — so when one suddenly
    // gets a just-listed cheap copy (the prime diamond event), the cloud has no real median and must
    // judge it against the often-inflated VG+ suggestion. Each FULL scan therefore tops up a bounded
    // budget of not-yet-covered releases, caching the real median (or a "never sold" sentinel).
    // The probes run in the CONSUMER'S IDLE TIME: while the API pacing hasn't produced a candidate
    // yet, the browser does a warm-up probe instead of sleeping — the old serial post-pass added
    // 1.5-2 min AFTER the progress bar hit 100%; now most (often all) of it hides inside the sweep.
    // Whatever budget is left when the pipeline ends drains in a short post-pass. Quick scans skip
    // it; "Full + medians" lifts the budget to the whole wantlist and ignores the weekly TTL.
    const WARMUP_BUDGET = opts.quick ? 0 : (opts.fullMedians ? work.length : (() => { const v = Number(readSettings().soldMedianWarmup); return Number.isFinite(v) ? v : 50; })());
    const soldFreshNow = (id) => { const sm = store.getSoldMedian(id); return !!(sm && sm.ts && (Date.now() - sm.ts < SOLD_TTL_MS)); };
    const warmupQueue = WARMUP_BUDGET > 0
      ? work
        .filter((rel) => (opts.fullMedians ? true : !soldFreshNow(rel.releaseId)))
        .sort((a, b) => { const sa = store.getSoldMedian(a.releaseId), sb = store.getSoldMedian(b.releaseId); return (sa ? sa.ts : 0) - (sb ? sb.ts : 0); }) // never-cached first, then oldest
      : [];
    let warmupIdx = 0, warmedReal = 0, warmedChecked = 0;
    const warmupTotal = Math.min(WARMUP_BUDGET, warmupQueue.length); // display estimate (skips can shrink the real count)
    // Probe ONE warm-up target (release page only, no API calls). Returns false when the queue or
    // budget is exhausted. Targets that were scraped by the pipeline mid-run — or became fresh —
    // are skipped for free.
    async function warmupNext() {
      while (warmupIdx < warmupQueue.length && warmedChecked < WARMUP_BUDGET) {
        if (scrapeAbort) return false;
        const rel = warmupQueue[warmupIdx++];
        if (scrapedThisRun.has(rel.releaseId)) continue;              // pipeline already read this release page
        if (!opts.fullMedians && soldFreshNow(rel.releaseId)) continue; // became fresh mid-run
        let d = { cleared: false, sold: null };
        try { d = await loadReleaseData(cfWin, rel.releaseId, config.currency, { soldOnly: true }); } catch { /* transient — retry next scan */ }
        if (d.sold) scrapedThisRun.add(rel.releaseId); // a later candidate for this release needn't re-scrape
        if (d.sold && d.sold.median != null) { store.setSoldMedian(rel.releaseId, d.sold); warmedReal++; }
        else if (d.cleared && d.sold) { store.setSoldMedian(rel.releaseId, { median: null, low: null, high: null, lastSold: d.sold.lastSold || 'Never', ts: Date.now() }); }
        warmedChecked++;
        await sleep(300);
        return true;
      }
      return false;
    }

    // PIPELINE: the API sweep (Phase 1, hits api.discogs.com) and the browser confirmation (Phase 2,
    // hits www.discogs.com) use independent rate limits, so run them CONCURRENTLY instead of one after
    // the other — the browser work fills the time the API pacing would otherwise spend idle. A single
    // producer enqueues candidates as it finds them; a single consumer drains them through the one
    // Cloudflare-cleared window. Total wall-clock collapses to ≈ the API sweep alone.
    const queue = [];
    let producerDone = false;
    let wake = null; // resolver to wake the consumer when a candidate arrives or the producer finishes
    let scanned = 0; // releases stats-checked (Phase 1 progress)
    const progress = () => send({ phase: 'scan', checked: scanned, total, found: deals.length, candidates: candidateCount, processed: priced, queued: queue.length });

    const consumer = (async () => {
      for (;;) {
        if (scrapeAbort) break;
        if (!queue.length) {
          if (producerDone) break;
          // Idle: no candidate ready yet. Spend the wait on a sold-median warm-up probe (same
          // window, zero API calls) instead of sleeping — candidates still take priority the
          // moment one lands in the queue (re-checked every iteration).
          if (await warmupNext()) continue;
          await new Promise((r) => { wake = r; }); // sleep until a candidate is enqueued (or producer ends)
          continue;
        }
        const c = queue.shift();
        try { await confirmCandidate(c); } catch { /* one candidate failing must not stop the drain */ }
        priced++;
        progress();
      }
    })();

    const gemsFound = []; // 💎 rare appearances (0 -> first copy) detected during THIS scan
    for (const rel of work) {
      if (scrapeAbort) break;
      try {
        const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
        const prevObs = store.lastObservation(rel.releaseId);
        const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
        store.pushObservation(rel.releaseId, curObs);

        // 💎 Rare gem: this release had ZERO copies for sale and just got its first — recorded
        // regardless of price (availability is the signal). Same cooldown dedupe as the cloud
        // watcher, but against the LOCAL state (the two keep independent histories, so the cloud
        // still emails the same event on its own next sweep).
        if (engine.isRareAppearance(prevObs, curObs)) {
          const ra = store.getRareAlerted(rel.releaseId);
          if (!ra || Date.now() - ra.ts > RARE_COOLDOWN_MS) {
            const sm = store.getSoldMedian(rel.releaseId);
            const sug0 = store.getSuggestion(rel.releaseId);
            const refSource = sm && sm.median != null ? 'sold-median' : (sug0 && sug0.vgplus != null ? 'suggestion' : null);
            const gem = {
              id: `${rel.releaseId}-gem-${Date.now()}`,
              type: 'gem',
              releaseId: rel.releaseId, title: rel.title, artist: rel.artist, year: rel.year, thumb: rel.thumb,
              lowest: stats.lowestPrice, currency: stats.currency || config.currency,
              numForSale: stats.numForSale,
              reference: refSource === 'sold-median' ? sm.median : (refSource === 'suggestion' ? sug0.vgplus : null),
              referenceSource: refSource,
              url: marketUrl(rel.releaseId),
              releaseUrl: engine.releaseUrl(rel.releaseId),
              ts: Date.now(),
            };
            store.addGem(gem);
            store.setRareAlerted(rel.releaseId, { ts: Date.now(), numForSale: stats.numForSale });
            gemsFound.push(gem);
          }
        }

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
          if (prelim.meetsThreshold) {
            queue.push({ rel, stats, sug, freshListing: engine.isFreshListing(prevObs, curObs) });
            candidateCount++;
            if (wake) { wake(); wake = null; } // wake the consumer if it was idle
          }
        }
      } catch (e) { /* one release failing must not abort the scan */ }
      scanned++;
      if (scanned % 2 === 0 || scanned === total) progress();
    }
    producerDone = true;
    if (wake) { wake(); wake = null; } // let the consumer finish draining the queue
    await consumer;

    // Drain whatever warm-up budget the interleaved probes didn't get through during the pipeline
    // (on a candidate-heavy scan the consumer had little idle time). Often this is already empty.
    if (!scrapeAbort && warmedChecked < WARMUP_BUDGET && warmupIdx < warmupQueue.length) {
      send({ phase: 'warmup', checked: warmedChecked, total: warmupTotal, found: deals.length });
      while (!scrapeAbort && await warmupNext()) {
        send({ phase: 'warmup', checked: warmedChecked, total: warmupTotal, found: deals.length });
      }
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    // Near-misses: show the most USEFUL first — a confirmed VG+ copy that just missed the threshold
    // (a real almost-deal) before the worn / no-VG+ ones — then by how close it came. Cap so a huge
    // worn-copy tail can't bloat the result; the count is reported either way.
    const missRank = (m) => (m.reasonCode === 'vgplus-not-cheap' ? 0 : m.reasonCode === 'unconfirmed-not-cheap' ? 1 : 2);
    nearMisses.sort((a, b) => missRank(a) - missRank(b) || ((b.effectiveDiscount ?? b.discount ?? 0) - (a.effectiveDiscount ?? a.discount ?? 0)));
    const nearMissOut = nearMisses.slice(0, 250);

    // 💎 zero-stock watch list: wantlist releases whose LATEST observation counted ZERO copies for
    // sale — the rarities the 💎 tab shows as "being watched". Computed against the FULL wantlist
    // (the store keeps knowledge from earlier scans, so a quick scan doesn't shrink the list).
    const zeroIds = new Set(store.listZeroStock());
    const zeroWatchOut = wantlist
      .filter((r) => zeroIds.has(String(r.releaseId)))
      .map((r) => ({ releaseId: r.releaseId, title: r.title, artist: r.artist, year: r.year, thumb: r.thumb }));

    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals, nearMisses: nearMissOut, gems: gemsFound, zeroWatch: zeroWatchOut })); } catch { /* best effort */ }

    // Export the accumulated REAL sales-history medians to a committable root file so the cloud email
    // watcher can judge deals against true market value. The store keeps them in the gitignored
    // state/soldmedians.json (which can't reach GitHub); soldmedians.json at the repo root can —
    // commit + push it and watch-once.js seeds it on the next sweep. This is how a local scan makes
    // the EMAILS smarter (its main job), beyond just showing results in the dashboard.
    // Exporting medians to a committable root file + git-pushing them only makes sense for the OWNER
    // running from the project checkout (there's a git repo and a cloud watcher to feed). A packaged,
    // shared install has no repo — its medians just live in the local state/ cache, which is all the
    // dashboard needs. So this whole step is dev-only.
    let soldMediansExported = 0;
    let mediansPush = null;
    if (!app.isPackaged) {
      try {
        const src = path.join(stateDir(), 'soldmedians.json');
        if (fs.existsSync(src)) {
          const sm = JSON.parse(fs.readFileSync(src, 'utf8'));
          // Commit only REAL medians — drop the "never sold" sentinels (median null) the warm-up keeps
          // locally to avoid re-scraping; the cloud only wants true market references.
          const real = {};
          if (sm && typeof sm === 'object') for (const [id, v] of Object.entries(sm)) if (v && v.median != null) real[id] = v;
          soldMediansExported = Object.keys(real).length;
          if (soldMediansExported) fs.writeFileSync(path.join(WATCHER_DIR, 'soldmedians.json'), JSON.stringify(real));
        }
      } catch { /* non-fatal: the export is a convenience for committing, not the scan result */ }

      // Auto-commit + push the refreshed medians so the cloud emails use them with no manual git step.
      if (soldMediansExported && readSettings().autoPushMedians !== false) {
        send({ phase: 'pushing' });
        mediansPush = await autoPushSoldMedians();
        writePushStatus({ ts: Date.now(), ...mediansPush }); // feeds the persistent topbar badge
      }
    }

    send({ phase: 'done', checked: total, total, found: deals.length, gems: gemsFound.length, zeroWatch: zeroWatchOut.length, confirmed, droppedNoVgPlus, unconfirmed, cfFailed, realShip, nearMisses: nearMissOut.length, warmedReal, warmedChecked, soldMediansExported, mediansPush, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal });
    return { deals, nearMisses: nearMissOut, gems: gemsFound, zeroWatch: zeroWatchOut, checked: total, total, confirmed, droppedNoVgPlus, unconfirmed, cfFailed, realShip, warmedReal, warmedChecked, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal };
  } finally {
    scrapeRunning = false;
    if (cfWin) { try { cfWin.destroy(); } catch { /* already gone */ } }
  }
}

function lastScan() {
  try { return JSON.parse(fs.readFileSync(LAST_SCAN_FILE(), 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Discogs account config — written by the first-run setup wizard.
// ---------------------------------------------------------------------------
// Lives in config.json (dataDir): the same shape watcher.js loadConfig() reads, so a packaged
// app and the dev/owner project share one format. We never send the token back to the renderer
// (only `hasToken`); the wizard collects a fresh one if the user wants to change it.
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfigFile(patch) {
  const next = { ...readConfigFile(), ...(patch || {}) };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return true;
}

// Validate Discogs credentials live: the personal token via /oauth/identity (401 if bad), and the
// username by counting its wantlist. Returns a friendly {ok, username, wantlist} / {ok:false, error}.
async function testConfig({ username, token } = {}) {
  let makeClient;
  try { ({ makeClient } = loadWatcher()); }
  catch (e) { return { ok: false, error: e.message }; }
  const client = makeClient({ token: (token || '').trim(), userAgent: 'DiscogsDealWatcher/1.0 (desktop setup test)' });
  let who;
  try {
    const id = await client.req('/oauth/identity');
    who = id && id.data ? id.data.username : null;
    if (!who) return { ok: false, error: 'Token werd niet geaccepteerd — controleer je persoonlijke token.' };
  } catch (e) {
    if (e && e.status === 401) return { ok: false, error: 'Token ongeldig (401) — controleer je persoonlijke token.' };
    return { ok: false, error: 'Kon Discogs niet bereiken: ' + (e && e.message ? e.message : String(e)) };
  }
  const uname = (username || '').trim();
  if (!uname) return { ok: true, username: who, wantlist: null };
  try {
    const wl = await client.getWantlist(uname);
    return { ok: true, username: who, wantlist: wl.length };
  } catch (e) {
    return { ok: false, error: `Token werkt (ingelogd als ${who}), maar wantlist van "${uname}" ophalen mislukte: ${e && e.message ? e.message : e}` };
  }
}

ipcMain.handle('config:get', () => {
  const c = readConfigFile();
  return {
    username: c.username || '',
    currency: c.currency || 'EUR',
    hasToken: !!c.token,
    minDiscount: c.minDiscount,
    minReference: c.minReference,
    shippingEstimate: c.shippingEstimate,
  };
});
ipcMain.handle('config:set', (_e, patch) => writeConfigFile(patch));
ipcMain.handle('config:test', (_e, creds) => testConfig(creds || {}));

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('deals:get', (_e, limit) => getDeals(limit));
ipcMain.handle('gems:get', () => getGems());
ipcMain.handle('status:get', () => getStatus());
ipcMain.handle('health:get', () => getServiceHealth());
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('scrape:run', (e, opts) => runScrape(BrowserWindow.fromWebContents(e.sender), opts || {}));
ipcMain.handle('scrape:cancel', () => { scrapeAbort = true; return true; });
ipcMain.handle('scrape:last', () => lastScan());
// Medians push status — null hides the badge (packaged installs never push: there's no repo; and
// with autoPushMedians off there's nothing to report). Retry lets the user fix a red badge in place.
ipcMain.handle('medians:pushStatus', () => {
  if (app.isPackaged || readSettings().autoPushMedians === false) return null;
  return readPushStatus();
});
ipcMain.handle('medians:retryPush', async () => {
  if (app.isPackaged) return { ok: false, pushed: false, reason: 'not available in a packaged install' };
  const res = await autoPushSoldMedians();
  const st = { ts: Date.now(), ...res };
  writePushStatus(st);
  return st;
});

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
