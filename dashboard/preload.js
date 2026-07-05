'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:set', s),
  // Discogs account config (first-run wizard / Settings). getConfig never returns the token itself.
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:set', c),
  testConfig: (c) => ipcRenderer.invoke('config:test', c),
  getDeals: (limit) => ipcRenderer.invoke('deals:get', limit),
  // 💎 rare gems + zero-stock watch list -> { ts, gems: [...], zeroWatch: [...] }
  getGems: () => ipcRenderer.invoke('gems:get'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getHealth: () => ipcRenderer.invoke('health:get'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // Local scan: full sweep, or a prioritized quick scan ({ quick: true }).
  scrapeRun: (opts) => ipcRenderer.invoke('scrape:run', opts),
  scrapeCancel: () => ipcRenderer.invoke('scrape:cancel'),
  scrapeLast: () => ipcRenderer.invoke('scrape:last'),
  onScrapeProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scrape:progress', h);
    return () => ipcRenderer.removeListener('scrape:progress', h);
  },
});
