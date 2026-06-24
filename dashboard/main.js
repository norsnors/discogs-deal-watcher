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
  autoPushMedians: true, // after a scan, auto commit+push soldmedians.json so the cloud emails use it
  autoScanOnLaunchHours: 1, // keep a fresh scan while the app is open: re-scan whenever the last one is older than this many hours (also gates the launch scan). 0 = off
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
async function githubHealth(s) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const to = withTimeout(12_000);
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (s.githubToken) headers.authorization = 'Bearer ' + s.githubToken;
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=1`, { headers, signal: to.signal });
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
    const run = (j.workflow_runs || [])[0] || null;
    if (!run) return { mode: 'github', repo, ok: true, run: null };
    return {
      mode: 'github', repo, ok: true,
      run: {
        startedAt: Date.parse(run.run_started_at || run.created_at) || null,
        updatedAt: Date.parse(run.updated_at) || null,
        status: run.status,         // queued | in_progress | completed
        conclusion: run.conclusion, // success | failure | cancelled | null (while running)
        url: run.html_url,
        runNumber: run.run_number,
        event: run.event,
      },
    };
  } finally { to.done(); }
}

async function getServiceHealth() {
  const s = readSettings();
  if ((s.sourceType || 'github') === 'server') {
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
    throw new Error('Local scan needs the watcher source next to the dashboard (run it from the project, not a packaged build). ' + e.message);
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
  // Strategy 1: in-page fetch on the sell page we're already on.
  let lr = null;
  for (let i = 0; i < 5; i++) {
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
    const config = loadConfig();
    if (!config.token) throw new Error('No Discogs token in config.json — add it to enable local scans.');
    if (!config.username) throw new Error('No Discogs username in config.json.');

    const store = makeStore(path.join(WATCHER_DIR, 'state'));
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
      const soldFresh = !opts.fullMedians && !!(cachedSold && cachedSold.median != null && cachedSold.ts && (Date.now() - cachedSold.ts < SOLD_TTL_MS));

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
          await new Promise((r) => { wake = r; }); // sleep until a candidate is enqueued (or producer ends)
          continue;
        }
        const c = queue.shift();
        try { await confirmCandidate(c); } catch { /* one candidate failing must not stop the drain */ }
        priced++;
        progress();
      }
    })();

    for (const rel of work) {
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

    // --- Sold-median warm-up (coverage builder) -------------------------------------------------
    // The candidate pipeline only scrapes a sold-median for releases that LOOKED cheap. Releases
    // sitting at a normal price never get their true market value learned — so when one suddenly gets
    // a just-listed cheap copy (the prime diamond event), the cloud has no real median and must judge
    // it against the often-inflated VG+ suggestion (a missed diamond, or a false positive). To close
    // that gap, each FULL scan tops up a bounded budget of not-yet-covered releases — regardless of
    // current price — caching the real median (or a "never sold" sentinel so we don't re-try weekly).
    // Over a few scans the whole wantlist gets a real reference. Quick scans skip this (they're for
    // speed); the cf window + cf_clearance are already warm here, and it needs no API calls.
    let warmedReal = 0, warmedChecked = 0;
    // A deep "full + medians" scan lifts the per-scan warm-up cap and re-scrapes EVERY median
    // (ignoring the weekly freshness cache), so the whole wantlist's references are refreshed in one
    // run instead of 50 at a time. A normal full scan keeps the bounded top-up; quick skips it.
    const WARMUP_BUDGET = opts.quick ? 0 : (opts.fullMedians ? work.length : (() => { const v = Number(readSettings().soldMedianWarmup); return Number.isFinite(v) ? v : 50; })());
    if (WARMUP_BUDGET > 0 && !scrapeAbort) {
      const fresh = (id) => { const sm = store.getSoldMedian(id); return !!(sm && sm.ts && (Date.now() - sm.ts < SOLD_TTL_MS)); };
      const targets = work
        .filter((rel) => (opts.fullMedians ? !scrapedThisRun.has(rel.releaseId) : !fresh(rel.releaseId)))
        .sort((a, b) => { const sa = store.getSoldMedian(a.releaseId), sb = store.getSoldMedian(b.releaseId); return (sa ? sa.ts : 0) - (sb ? sb.ts : 0); }) // never-cached first, then oldest
        .slice(0, WARMUP_BUDGET);
      for (let i = 0; i < targets.length; i++) {
        if (scrapeAbort) break;
        send({ phase: 'warmup', checked: i, total: targets.length, found: deals.length });
        let d = { cleared: false, sold: null };
        try { d = await loadReleaseData(cfWin, targets[i].releaseId, config.currency, { soldOnly: true }); } catch { /* transient — retry next scan */ }
        if (d.sold && d.sold.median != null) { store.setSoldMedian(targets[i].releaseId, d.sold); warmedReal++; }
        else if (d.cleared && d.sold) { store.setSoldMedian(targets[i].releaseId, { median: null, low: null, high: null, lastSold: d.sold.lastSold || 'Never', ts: Date.now() }); }
        warmedChecked++;
        await sleep(300);
      }
      send({ phase: 'warmup', checked: targets.length, total: targets.length, found: deals.length });
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    // Near-misses: show the most USEFUL first — a confirmed VG+ copy that just missed the threshold
    // (a real almost-deal) before the worn / no-VG+ ones — then by how close it came. Cap so a huge
    // worn-copy tail can't bloat the result; the count is reported either way.
    const missRank = (m) => (m.reasonCode === 'vgplus-not-cheap' ? 0 : m.reasonCode === 'unconfirmed-not-cheap' ? 1 : 2);
    nearMisses.sort((a, b) => missRank(a) - missRank(b) || ((b.effectiveDiscount ?? b.discount ?? 0) - (a.effectiveDiscount ?? a.discount ?? 0)));
    const nearMissOut = nearMisses.slice(0, 250);
    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals, nearMisses: nearMissOut })); } catch { /* best effort */ }

    // Export the accumulated REAL sales-history medians to a committable root file so the cloud email
    // watcher can judge deals against true market value. The store keeps them in the gitignored
    // state/soldmedians.json (which can't reach GitHub); soldmedians.json at the repo root can —
    // commit + push it and watch-once.js seeds it on the next sweep. This is how a local scan makes
    // the EMAILS smarter (its main job), beyond just showing results in the dashboard.
    let soldMediansExported = 0;
    try {
      const src = path.join(WATCHER_DIR, 'state', 'soldmedians.json');
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
    let mediansPush = null;
    if (soldMediansExported && readSettings().autoPushMedians !== false) {
      send({ phase: 'pushing' });
      mediansPush = await autoPushSoldMedians();
    }

    send({ phase: 'done', checked: total, total, found: deals.length, confirmed, droppedNoVgPlus, unconfirmed, realShip, nearMisses: nearMissOut.length, warmedReal, warmedChecked, soldMediansExported, mediansPush, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal });
    return { deals, nearMisses: nearMissOut, checked: total, total, confirmed, droppedNoVgPlus, unconfirmed, realShip, warmedReal, warmedChecked, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal };
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
ipcMain.handle('health:get', () => getServiceHealth());
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('scrape:run', (e, opts) => runScrape(BrowserWindow.fromWebContents(e.sender), opts || {}));
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
