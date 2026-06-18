'use strict';
/*
 * store.js — tiny JSON-file store (no native deps; mirrors the soulseek-batch state/ pattern).
 *
 * Files under <dir>:
 *   history.json      { [releaseId]: [ { ts, lowest, numForSale } ... capped ] }
 *   alerted.json      { [releaseId]: { lowest, ts } }   last price we emailed an alert for
 *   suggestions.json  { [releaseId]: { ts, vgplus, vg } }   cached price suggestions
 *   deals.json        [ deal, ... ]  newest-first, capped (what the dashboard reads)
 *
 * Writes are atomic (write tmp + rename). Safe to delete the whole dir; it rebuilds.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_CAP = 60;
const DEALS_CAP = 1000;
// How many synthetic observations a re-seeded release gets. Must exceed the warm-up threshold
// (warmupMin=4) so a release recovered from the committed seed counts as already warmed; capped so
// the exported digest is stable run-to-run (it stops changing once a release passes this) -> tiny git churn.
const SEED_WARM = 8;
const round2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

function makeStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, n);

  function read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  }
  function write(name, data) {
    const tmp = file(name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file(name));
  }

  const history = read('history.json', {});
  const alerted = read('alerted.json', {});
  const suggestions = read('suggestions.json', {});
  const soldMedians = read('soldmedians.json', {}); // real sales-history medians (scraped locally)
  let deals = read('deals.json', []);

  return {
    // --- price history ---
    pushObservation(releaseId, obs) {
      const arr = history[releaseId] || (history[releaseId] = []);
      arr.push(obs);
      if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
      write('history.json', history);
    },
    historyCount(releaseId) { return (history[releaseId] || []).length; },
    getHistory(releaseId) { return history[releaseId] || []; },
    lastObservation(releaseId) { const a = history[releaseId]; return a && a.length ? a[a.length - 1] : null; },
    trailingMedianLowest(releaseId, n = 30) {
      const arr = (history[releaseId] || []).slice(-n).map((o) => o.lowest).filter((x) => typeof x === 'number' && x > 0);
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => a - b);
      const m = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    },

    // --- alert dedupe memory ---
    getAlerted(releaseId) { return alerted[releaseId] || null; },
    setAlerted(releaseId, v) { alerted[releaseId] = v; write('alerted.json', alerted); },

    // --- cached price suggestions ---
    getSuggestion(releaseId) { return suggestions[releaseId] || null; },
    setSuggestion(releaseId, v) { suggestions[releaseId] = v; write('suggestions.json', suggestions); },

    // --- cached real sales-history medians (from the local residential scrape) ---
    getSoldMedian(releaseId) { return soldMedians[releaseId] || null; },
    setSoldMedian(releaseId, v) { soldMedians[releaseId] = v; write('soldmedians.json', soldMedians); },
    // Merge sold-medians into memory WITHOUT writing to disk. Used by the cloud watcher to seed the
    // real sales-history medians that the local scan committed to the repo (the gitignored state/
    // dir can't carry them to GitHub) so the emailed deals are judged against true market value.
    primeSoldMedians(map) { if (map && typeof map === 'object') Object.assign(soldMedians, map); },

    // --- durable warm-up + dedupe seed (survives Actions-cache eviction) ---
    // The cloud's warm-up counts (history) and alert dedupe (alerted) normally live only in the
    // Actions cache, which GitHub evicts after 7 days unused / under its 10 GB LRU cap. Losing it
    // resets every release to "cold" (~4 sweeps of no alerts) AND wipes dedupe (a one-time re-flood).
    // exportSeed() produces a TINY digest committed to the repo (like soldmedians.json); primeSeed()
    // restores it on a cold start. Mirrors primeSoldMedians: in-memory only, no disk write here.
    exportSeed() {
      const seed = {};
      const ids = new Set([...Object.keys(history), ...Object.keys(alerted)]);
      for (const id of ids) {
        const arr = history[id] || [];
        const n = Math.min(arr.length, SEED_WARM);
        const tmArr = arr.slice(-30).map((o) => o.lowest).filter((x) => typeof x === 'number' && x > 0).sort((a, b) => a - b);
        const tm = tmArr.length ? round2(tmArr.length % 2 ? tmArr[(tmArr.length - 1) / 2] : (tmArr[tmArr.length / 2 - 1] + tmArr[tmArr.length / 2]) / 2) : null;
        const al = alerted[id] ? round2(alerted[id].lowest) : null;
        if (!n && al == null) continue;
        const e = {};
        if (n) e.n = n;
        if (tm != null) e.tm = tm;
        if (al != null) e.al = al;
        seed[id] = e;
      }
      return seed;
    },
    // Restore warm-up + dedupe for releases the (possibly empty) cache doesn't already know. Fills
    // `n` synthetic observations at the trailing median so historyCount + trailingMedianLowest both
    // recover; never overwrites a release the cache already has (the cache is always the fresher copy).
    primeSeed(map) {
      if (!map || typeof map !== 'object') return 0;
      let restored = 0;
      for (const [id, e] of Object.entries(map)) {
        if (!e) continue;
        if (!history[id] || !history[id].length) {
          const n = Math.max(0, Math.min(SEED_WARM, e.n || 0));
          const v = typeof e.tm === 'number' ? e.tm : null;
          if (n && v != null) { history[id] = Array.from({ length: n }, () => ({ ts: 0, lowest: v, numForSale: null })); restored++; }
        }
        if (e.al != null && !alerted[id]) alerted[id] = { lowest: e.al, ts: 0 };
      }
      return restored;
    },

    // --- deals (dashboard feed) ---
    addDeal(deal) {
      deals.unshift(deal);
      if (deals.length > DEALS_CAP) deals = deals.slice(0, DEALS_CAP);
      write('deals.json', deals);
    },
    getDeals(limit = 200) { return deals.slice(0, limit); },
    countDeals() { return deals.length; },
  };
}

module.exports = { makeStore, HISTORY_CAP, DEALS_CAP, SEED_WARM };

// --- tiny self-test (node store.js --selftest) -----------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-store-'));
  let s = makeStore(tmp);

  s.pushObservation(100, { ts: 1, lowest: 30, numForSale: 5 });
  s.pushObservation(100, { ts: 2, lowest: 28, numForSale: 4 });
  s.pushObservation(100, { ts: 3, lowest: 32, numForSale: 6 });
  assert.strictEqual(s.trailingMedianLowest(100), 30, 'median of [30,28,32] = 30');
  assert.strictEqual(s.historyCount(100), 3, 'three observations recorded');
  assert.strictEqual(s.lastObservation(100).lowest, 32, 'lastObservation returns the newest obs');
  assert.strictEqual(s.getHistory(100).length, 3, 'getHistory returns the full series');
  assert.strictEqual(s.lastObservation(999), null, 'lastObservation is null for an unseen release');

  s.setAlerted(100, { lowest: 12, ts: 99 });
  s.setSuggestion(100, { ts: 5, vgplus: 30, vg: 18 });
  s.addDeal({ id: 'd1', releaseId: 100, lowest: 12 });

  // Reopen from disk -> state persisted.
  s = makeStore(tmp);
  assert.strictEqual(s.getAlerted(100).lowest, 12, 'alerted persisted');
  assert.strictEqual(s.getSuggestion(100).vgplus, 30, 'suggestion persisted');
  assert.strictEqual(s.getDeals()[0].id, 'd1', 'deal persisted');
  assert.strictEqual(s.trailingMedianLowest(100), 30, 'history persisted');

  // primeSoldMedians seeds in-memory medians without writing to disk (cloud reads committed medians).
  s.primeSoldMedians({ 200: { median: 42, low: 30, high: 60 } });
  assert.strictEqual(s.getSoldMedian(200).median, 42, 'primed sold-median is readable');
  assert.ok(!fs.existsSync(path.join(tmp, 'soldmedians.json')), 'priming does NOT write soldmedians.json to disk');

  // --- durable warm-up + dedupe seed (exportSeed / primeSeed) ---
  // A WARMED release (400: 6 obs at 20) plus release 100 (3 obs [30,28,32], median 30, alerted at 12).
  for (let i = 0; i < 6; i++) s.pushObservation(400, { ts: i, lowest: 20, numForSale: 3 });
  const seed = s.exportSeed();
  assert.strictEqual(seed[100].n, 3, 'exported warm-up count = historyCount (not yet warmed)');
  assert.strictEqual(seed[100].tm, 30, 'exported trailing median');
  assert.strictEqual(seed[100].al, 12, 'exported last-alerted lowest');
  assert.strictEqual(seed[400].n, 6, 'exported warm-up count for the warmed release');

  // A FRESH store (simulating a wiped Actions cache) recovers warm-up + dedupe from the digest.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-seed-'));
  let s2 = makeStore(tmp2);
  assert.strictEqual(s2.historyCount(400), 0, 'cold store starts empty');
  const restored = s2.primeSeed(seed);
  assert.ok(restored >= 2, 'primeSeed restored both releases with history');
  assert.ok(s2.historyCount(400) >= 4, 'a warmed release recovers above the warm-up threshold (>=4)');
  assert.strictEqual(s2.trailingMedianLowest(400), 20, 'recovered trailing median matches');
  assert.strictEqual(s2.historyCount(100), 3, 'partial warm-up progress is preserved exactly (3 obs)');
  assert.strictEqual(s2.getAlerted(100).lowest, 12, 'recovered alert-dedupe memory even without full history');

  // primeSeed never clobbers a release the cache already has (cache is the fresher copy).
  s2.pushObservation(400, { ts: 9, lowest: 99, numForSale: 1 });
  s2.primeSeed({ 400: { n: 8, tm: 5, al: 1 } });
  assert.strictEqual(s2.lastObservation(400).lowest, 99, 'existing history is not overwritten by a re-seed');

  // export count caps at SEED_WARM so the digest stops changing once warmed (low git churn).
  for (let i = 0; i < 20; i++) s.pushObservation(300, { ts: i, lowest: 10, numForSale: 2 });
  assert.strictEqual(s.exportSeed()[300].n, SEED_WARM, 'exported warm-up count is capped at SEED_WARM');

  fs.rmSync(tmp2, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('store selftest: all assertions passed');
}
