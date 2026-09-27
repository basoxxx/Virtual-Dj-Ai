// Ponte sicuro tra renderer e processo principale.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  appInfo: invoke('app:info'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),

  getLibrary: invoke('library:get'),
  addFolder: invoke('library:addFolder'),
  addFiles: invoke('library:addFiles'),
  removeFolder: invoke('library:removeFolder'),
  rescan: invoke('library:rescan'),
  removeTrack: invoke('library:removeTrack'),
  updateTrack: invoke('library:updateTrack'),
  markPlayed: invoke('library:markPlayed'),
  createPlaylist: invoke('playlist:create'),
  renamePlaylist: invoke('playlist:rename'),
  deletePlaylist: invoke('playlist:delete'),
  addToPlaylist: invoke('playlist:add'),
  removeFromPlaylist: invoke('playlist:remove'),
  movePlaylistItem: invoke('playlist:move'),

  readFile: invoke('file:read'),
  getCover: invoke('file:cover'),
  pickAudioFile: invoke('file:pickAudio'),
  revealFile: invoke('file:reveal'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  recordStart: invoke('record:start'),
  recordChunk: (chunk) => ipcRenderer.send('record:chunk', chunk),
  recordStop: invoke('record:stop'),
  requestMic: invoke('media:requestMic'),
  aiModels: invoke('ai:models'),
  aiChat: invoke('ai:chat'),

  on: (channel, handler) => {
    const allowed = ['menu', 'library:progress'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
