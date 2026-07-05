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
  // Sold-medians git push: last persisted outcome (null = badge hidden) + a manual retry.
  getPushStatus: () => ipcRenderer.invoke('medians:pushStatus'),
  retryPush: () => ipcRenderer.invoke('medians:retryPush'),
  // ☁ Cloud setup: fork the watcher repo + configure the 24/7 email watcher on the user's own
  // GitHub account. Tokens are used transiently; progress streams via cloud:progress.
  cloudSetup: (opts) => ipcRenderer.invoke('cloud:setup', opts),
  onCloudProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('cloud:progress', h);
    return () => ipcRenderer.removeListener('cloud:progress', h);
  },
  onScrapeProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scrape:progress', h);
    return () => ipcRenderer.removeListener('scrape:progress', h);
  },
});
