// Processo principale Electron: finestra, protocollo app://, libreria, file system, registrazione.
const { app, BrowserWindow, ipcMain, dialog, protocol, net, session, shell, Menu, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Library, isAudioFile, AUDIO_EXTENSIONS } = require('./library');
const { JsonStore } = require('./store');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isDev = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
let library = null;
let settings = null;
let recording = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function configurePermissions() {
  const allowed = new Set(['media', 'midi', 'midiSysex', 'speaker-selection', 'audioCapture', 'fullscreen']);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0d0f14',
    title: 'Virtual DJ AI',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (settings.data.maximized) mainWindow.maximize();
  });
  mainWindow.on('close', () => {
    settings.data.maximized = mainWindow.isMaximized();
    settings.flush();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadURL('app://dj/index.html');
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Aggiungi cartella musicale…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'add-folder') },
        { label: 'Aggiungi file…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu', 'add-files') },
        { type: 'separator' },
        { label: 'Impostazioni…', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Esci' },
      ],
    },
    {
      label: 'Mix',
      submenu: [
        { label: 'Avvia/Ferma registrazione', accelerator: 'CmdOrCtrl+R', click: () => send('menu', 'record') },
        { label: 'Automix', accelerator: 'CmdOrCtrl+M', click: () => send('menu', 'automix') },
      ],
    },
    {
      label: 'Visualizza',
      submenu: [
        { role: 'togglefullscreen', label: 'Schermo intero' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Strumenti sviluppatore' },
      ],
    },
    {
      label: 'Aiuto',
      submenu: [
        { label: 'Scorciatoie da tastiera', accelerator: 'F1', click: () => send('menu', 'help') },
        { label: 'Pagina del progetto', click: () => shell.openExternal('https://github.com/basoxxx/Virtual-Dj-Ai') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function audioFilters() {
  return [
    { name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((e) => e.slice(1)) },
    { name: 'Tutti i file', extensions: ['*'] },
  ];
}

function progress(label) {
  return (done, total) => send('library:progress', { label, done, total });
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }));

  ipcMain.handle('settings:get', () => settings.data);
  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(settings.data, patch);
    settings.save();
    return settings.data;
  });

  ipcMain.handle('library:get', () => library.snapshot());
  ipcMain.handle('library:addFolder', async (_e, folder) => {
    let target = folder;
    if (!target) {
      const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
      if (res.canceled) return library.snapshot();
      for (const f of res.filePaths) await library.addFolder(f, progress('Scansione'));
      return library.snapshot();
    }
    await library.addFolder(target, progress('Scansione'));
    return library.snapshot();
  });
  ipcMain.handle('library:addFiles', async (_e, files) => {
    let list = files;
    if (!list || !list.length) {
      const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: audioFilters() });
      if (res.canceled) return { snapshot: library.snapshot(), added: [] };
      list = res.filePaths;
    }
    const added = await library.addFiles(list.filter((f) => typeof f === 'string'), progress('Importazione'));
    return { snapshot: library.snapshot(), added };
  });
  ipcMain.handle('library:removeFolder', (_e, folder) => {
    library.removeFolder(folder);
    return library.snapshot();
  });
  ipcMain.handle('library:rescan', async () => {
    await library.rescan(progress('Aggiornamento'));
    return library.snapshot();
  });
  ipcMain.handle('library:removeTrack', (_e, id) => {
    library.removeTrack(id);
    return library.snapshot();
  });
  ipcMain.handle('library:updateTrack', (_e, id, patch) => library.updateTrack(id, patch));
  ipcMain.handle('library:markPlayed', (_e, id) => library.markPlayed(id));
  ipcMain.handle('playlist:create', (_e, name) => library.createPlaylist(name));
  ipcMain.handle('playlist:rename', (_e, id, name) => library.renamePlaylist(id, name));
  ipcMain.handle('playlist:delete', (_e, id) => library.deletePlaylist(id));
  ipcMain.handle('playlist:add', (_e, id, trackIds) => library.addToPlaylist(id, trackIds));
  ipcMain.handle('playlist:remove', (_e, id, index) => library.removeFromPlaylist(id, index));
  ipcMain.handle('playlist:move', (_e, id, from, to) => library.movePlaylistItem(id, from, to));

  ipcMain.handle('file:read', async (_e, file) => {
    if (typeof file !== 'string' || !isAudioFile(file)) throw new Error('Formato non supportato');
    const buf = await fs.promises.readFile(file);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  ipcMain.handle('file:cover', async (_e, file) => {
    try {
      if (!isAudioFile(file)) return null;
      const mm = require('music-metadata');
      const meta = await mm.parseFile(file, { duration: false });
      const pic = meta.common.picture && meta.common.picture[0];
      if (!pic) return null;
      return `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle('file:pickAudio', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: audioFilters() });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('file:reveal', (_e, file) => shell.showItemInFolder(file));

  // Registrazione del mix: i campioni PCM arrivano a blocchi e vengono scritti
  // subito su disco, così anche set di ore non riempiono la memoria.
  ipcMain.handle('record:start', (_e, { sampleRate, channels }) => {
    if (recording) throw new Error('Registrazione già in corso');
    const tmp = path.join(os.tmpdir(), `vdjai-rec-${Date.now()}.wav`);
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, Buffer.alloc(44));
    recording = { tmp, fd, sampleRate, channels, bytes: 0 };
    return tmp;
  });
  ipcMain.on('record:chunk', (_e, chunk) => {
    if (!recording) return;
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    fs.writeSync(recording.fd, buf);
    recording.bytes += buf.byteLength;
  });
  ipcMain.handle('record:stop', async () => {
    if (!recording) return null;
    const rec = recording;
    recording = null;
    const header = wavHeader(rec.bytes, rec.sampleRate, rec.channels);
    fs.writeSync(rec.fd, header, 0, 44, 0);
    fs.closeSync(rec.fd);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Salva registrazione del mix',
      defaultPath: path.join(app.getPath('music'), `Mix-${stamp}.wav`),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (res.canceled || !res.filePath) {
      fs.rmSync(rec.tmp, { force: true });
      return null;
    }
    try {
      fs.renameSync(rec.tmp, res.filePath);
    } catch {
      fs.copyFileSync(rec.tmp, res.filePath);
      fs.rmSync(rec.tmp, { force: true });
    }
    return res.filePath;
  });

  ipcMain.handle('media:requestMic', async () => {
    if (process.platform !== 'darwin') return true;
    try {
      return await systemPreferences.askForMediaAccess('microphone');
    } catch {
      return false;
    }
  });
}

function wavHeader(dataBytes, sampleRate, channels) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40);
  return b;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    library = new Library(userData);
    settings = new JsonStore(path.join(userData, 'settings.json'), {});
    registerAppProtocol();
    configurePermissions();
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (library) library.flush();
    if (settings) settings.flush();
    if (recording) {
      try {
        fs.closeSync(recording.fd);
      } catch {
        // già chiuso
      }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { wavHeader };
