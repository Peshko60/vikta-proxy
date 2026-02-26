'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vikta', {
  getSettings:    ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:   (data)   => ipcRenderer.invoke('save-settings', data),
  toggleServer:   ()       => ipcRenderer.invoke('toggle-server'),
  onStatusChange: (cb)     => ipcRenderer.on('status-change', (_, d) => cb(d)),
});
