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

module.exports = { makeStore, HISTORY_CAP, DEALS_CAP };

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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('store selftest: all assertions passed');
}
