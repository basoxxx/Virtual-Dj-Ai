const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bench', {
  start: () => ipcRenderer.invoke('bench:start'),
  resetPeak: () => ipcRenderer.invoke('bench:resetPeak'),
  track: (r) => ipcRenderer.invoke('bench:track', r),
  done: (info) => ipcRenderer.invoke('bench:done', info),
});
