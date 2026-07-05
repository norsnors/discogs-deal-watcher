'use strict';
/*
 * server.js — tiny read-only HTTP API the desktop dashboard polls.
 *
 * Runs in the same process as the watcher loop (one container). Endpoints:
 *   GET /api/deals?limit=N   -> [deal, ...] newest-first
 *   GET /api/gems?limit=N    -> { ts, gems: [...], zeroWatch: [...] }  rare-gem alerts + the
 *                               zero-stock watch list (releases with 0 copies for sale)
 *   GET /api/status          -> { wantlistSize, lastSweepAt, sweepCount, rateRemaining, ... }
 *   GET /healthz             -> "ok"  (no auth; for host health checks)
 *
 * Protected by a bearer token (config.dashboardToken). CORS open so the Electron
 * renderer can fetch it directly.
 */

const http = require('http');

function makeServer({ store, getStatus, token, getZeroWatch }) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }

    // Auth on everything else.
    if (token) {
      const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (provided !== token) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    }

    const json = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/api/deals') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
      return json(store.getDeals(limit));
    }
    if (url.pathname === '/api/gems') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
      return json({ ts: Date.now(), gems: store.getGems(limit), zeroWatch: getZeroWatch ? getZeroWatch() : [] });
    }
    if (url.pathname === '/api/status') return json(getStatus());

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  return server;
}

module.exports = { makeServer };
