'use strict';
/*
 * main.js — Electron main process for the Discogs Deal dashboard.
 *
 * All HTTP to the cloud watcher happens HERE (Node fetch), so the dashboard token
 * never lives in the renderer and there are no CORS concerns. The renderer asks via
 * IPC (see preload.js). Settings (cloud API base URL + token) live in userData.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); }
  catch { return { sourceType: 'server', apiBase: 'http://localhost:8787', token: '', githubRepo: '', githubToken: '' }; }
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
  if ((s.sourceType || 'server') === 'github') return githubDeals(s);
  return serverGet(s, '/api/deals?limit=' + (limit || 200));
}
async function getStatus() {
  const s = readSettings();
  if ((s.sourceType || 'server') === 'github') return { sourceType: 'github', repo: s.githubRepo };
  return serverGet(s, '/api/status');
}

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('deals:get', (_e, limit) => getDeals(limit));
ipcMain.handle('status:get', () => getStatus());
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

function createWindow() {
  const win = new BrowserWindow({
    width: 1120, height: 800, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#0f1115',
    title: 'Discogs Deal Watcher',
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
