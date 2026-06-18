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
  autoScanOnLaunchHours: 24, // auto-run a local scan on launch if the last one is older than this (0 = off)
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
    const items = (j.items || []).map((it) => ({
      itemId: it.itemId || null,
      media: it.mediaCondition || null,
      sleeve: it.sleeveCondition || null,
      price: it.price ? it.price.amount : null,
      currency: it.price ? it.price.currencyCode : null,
      shipping: (it.shipping && it.shipping.shippingPrice != null) ? it.shipping.shippingPrice : null,
      shipsFrom: it.seller ? it.seller.shipsFrom : null,
      sellerRating: it.seller ? it.seller.rating : null,
      allowsOffers: !!it.allowsOffers,
    }));
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
    const items = (j.items || []).map((it) => ({
      itemId: it.itemId || null,
      media: it.mediaCondition || null,
      sleeve: it.sleeveCondition || null,
      price: it.price ? it.price.amount : null,
      currency: it.price ? it.price.currencyCode : null,
      shipping: (it.shipping && it.shipping.shippingPrice != null) ? it.shipping.shippingPrice : null,
      shipsFrom: it.seller ? it.seller.shipsFrom : null,
    }));
    return { items: items, totalCount: (j.totalCount != null ? j.totalCount : items.length) };
  } catch (e) { return { error: 'parse_' + String((e && e.message) || e) }; }
})()`;

// Load a release page in a hidden (real Chromium, residential IP) window, then read BOTH:
//   (1) its REAL sales-history median (Last Sold / Low / Median / High, off the page text), and
//   (2) its REAL per-copy marketplace listings (via the same-origin sell_item JSON fetch above).
// The Cloudflare JS challenge runs and clears in this window; the cf_clearance cookie persists
// across navigations so only the first load pays the wait.
async function loadReleaseData(cfWin, releaseId, currency) {
  await cfWin.loadURL(`https://www.discogs.com/release/${releaseId}`, { userAgent: DISCOGS_UA }).catch(() => {});
  let sold = null;
  let cleared = false;
  for (let i = 0; i < 22; i++) {
    await sleep(1000);
    const r = await cfWin.webContents.executeJavaScript(SOLD_EXTRACT).catch(() => null);
    if (r && !r.challenged && r.len > 1500) {
      cleared = true;
      sold = { median: parseMoney(r.median), low: parseMoney(r.low), high: parseMoney(r.high), lastSold: r.lastSold || null, ts: Date.now() };
      break;
    }
  }
  if (!cleared) return { cleared: false, sold: null, listings: null, listingsError: 'cloudflare' };
  // CF cleared -> the public marketplace JSON API is now reachable from this origin.
  // Strategy 1: in-page fetch (no extra navigation; returns structured data directly).
  let lr = null;
  for (let i = 0; i < 5; i++) {
    lr = await cfWin.webContents.executeJavaScript(LISTINGS_FETCH(releaseId, currency)).catch((e) => ({ error: String((e && e.message) || e) }));
    if (lr && Array.isArray(lr.items)) break;
    await sleep(800);
  }
  // Strategy 2 (fallback): navigate straight to the JSON URL and read the body (the scraper's flow).
  if (!(lr && Array.isArray(lr.items))) {
    await cfWin.loadURL(SELL_ITEM_URL(releaseId, currency), { userAgent: DISCOGS_UA, extraHeaders: 'Accept: application/json' }).catch(() => {});
    for (let i = 0; i < 8; i++) {
      await sleep(800);
      const r = await cfWin.webContents.executeJavaScript(PARSE_BODY).catch(() => null);
      if (r && Array.isArray(r.items)) { lr = r; break; }
      if (r && r.error && r.error !== 'cloudflare') { lr = r; break; } // genuine parse error, stop retrying
    }
  }
  return {
    cleared: true,
    sold,
    listings: lr && Array.isArray(lr.items) ? lr.items : null,
    listingsError: lr && lr.error ? lr.error : (lr && Array.isArray(lr.items) ? null : 'no_result'),
    totalCount: lr ? lr.totalCount : null,
  };
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

    // PHASE 2 (web, slower): for each candidate open a hidden BrowserWindow (residential IP clears
    // Cloudflare) and read the REAL data the official API hides — the sales-history median AND every
    // copy's actual media condition + price + shipping. We then pick the CHEAPEST copy that is
    // VG+ or better and judge the discount against THAT copy. A release whose only cheap copies are
    // worn (sub-VG+) is dropped — so a scan deal is a copy we've CONFIRMED is VG+, not a price guess.
    cfWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { images: false } });
    const deals = [];
    let priced = 0;
    let confirmed = 0;
    let droppedNoVgPlus = 0;
    let unconfirmed = 0;
    const marketUrl = (id) => `${engine.releaseMarketUrl(id)}?sort=price%2Casc&limit=25&currency=${config.currency}`;
    for (const c of candidates) {
      if (scrapeAbort) break;
      const cachedSold = store.getSoldMedian(c.rel.releaseId);

      // One navigation gives us both the sold-median and the live per-copy listings.
      let data = { cleared: false, sold: null, listings: null };
      try { data = await loadReleaseData(cfWin, c.rel.releaseId, config.currency); } catch { /* leave defaults */ }
      await sleep(600); // be gentle on Discogs/Cloudflare between releases

      // Sold-median: prefer a fresh scrape, else the weekly cache. Refresh the cache when fresh.
      let sold = cachedSold;
      if (data.sold && data.sold.median != null) { sold = data.sold; store.setSoldMedian(c.rel.releaseId, data.sold); }

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
        if (!pick.best) { droppedNoVgPlus++; priced++; send({ phase: 'prices', checked: priced, total: candidates.length, found: deals.length }); continue; }
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
            shipping: best.shipping, shipsFrom: best.shipsFrom,
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
        }
      }
      priced++;
      send({ phase: 'prices', checked: priced, total: candidates.length, found: deals.length, confirmed, droppedNoVgPlus, unconfirmed });
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals })); } catch { /* best effort */ }

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
        soldMediansExported = sm && typeof sm === 'object' ? Object.keys(sm).length : 0;
        if (soldMediansExported) fs.writeFileSync(path.join(WATCHER_DIR, 'soldmedians.json'), JSON.stringify(sm));
      }
    } catch { /* non-fatal: the export is a convenience for committing, not the scan result */ }

    // Auto-commit + push the refreshed medians so the cloud emails use them with no manual git step.
    let mediansPush = null;
    if (soldMediansExported && readSettings().autoPushMedians !== false) {
      send({ phase: 'pushing' });
      mediansPush = await autoPushSoldMedians();
    }

    send({ phase: 'done', checked: total, total, found: deals.length, confirmed, droppedNoVgPlus, unconfirmed, soldMediansExported, mediansPush, aborted: scrapeAbort });
    return { deals, checked: total, total, confirmed, droppedNoVgPlus, unconfirmed, aborted: scrapeAbort };
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
