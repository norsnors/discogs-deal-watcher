'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:set', s),
  getDeals: (limit) => ipcRenderer.invoke('deals:get', limit),
  getStatus: () => ipcRenderer.invoke('status:get'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // Local "Scan now" full sweep.
  scrapeRun: () => ipcRenderer.invoke('scrape:run'),
  scrapeCancel: () => ipcRenderer.invoke('scrape:cancel'),
  scrapeLast: () => ipcRenderer.invoke('scrape:last'),
  onScrapeProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scrape:progress', h);
    return () => ipcRenderer.removeListener('scrape:progress', h);
  },
});
