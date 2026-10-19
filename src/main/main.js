// Processo principale Electron: finestra, protocollo app://, libreria, file system, registrazione.
const { app, BrowserWindow, ipcMain, dialog, protocol, net, session, shell, Menu, systemPreferences, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Library, isAudioFile, AUDIO_EXTENSIONS } = require('./library');
const { JsonStore } = require('./store');
const updater = require('./updater');
const aiAssets = require('./ai-assets');
const migrate = require('./migrate');
const recorder = require('./recorder');
const { Notices } = require('./notices');
const { fsErrorText } = require('./errors');
const { DownloadWatcher, searchUrl, searchTemplateProblem } = require('./downloads');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isDev = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
let library = null;
let settings = null;
let recording = null;
let quitWithRecording = false; // l'utente ha scelto di uscire anche se si registra

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --- avvisi all'utente e registro degli errori ----------------------------------------
// Gli avvisi nati prima che l'interfaccia sia pronta (avvio, migrazione, file illeggibili) aspettano che li chieda.
const notices = new Notices((n) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('app:notice', n);
  return true;
});

function notice(message, type = 'error', ms = 9000, onDelivered = null) {
  notices.add(message, type, ms, onDelivered);
}

function logFile() {
  return path.join(app.getPath('userData'), 'logs', 'main.log');
}

/** Errore nel registro userData/logs/main.log (oltre 1 MB il precedente passa in main.log.1). */
function logError(where, err) {
  console.error(`${where}:`, err);
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 1048576) fs.renameSync(file, `${file}.1`);
    } catch {
      // registro ancora vuoto
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${where}: ${(err && err.stack) || err}\n`);
  } catch {
    // il registro non si scrive (es. disco pieno): resta la console
  }
}

function openExternal(url) {
  shell.openExternal(url).catch((err) => notice(`Non riesco ad aprire il browser (${err.message})`, 'error'));
}

// --- registrazione: mai persa in silenzio ------------------------------------------------
function recoveryDir() {
  return path.join(app.getPath('userData'), recorder.RECOVERY_DIR);
}

/** Chiude la registrazione senza chiedere dove salvarla: resta nella cartella di recupero e all'avvio si avvisa. */
function abandonRecording() {
  if (!recording) return null;
  const rec = recording;
  recording = null;
  try {
    recorder.finalizeRecording(rec);
  } catch (err) {
    logError('Chiusura della registrazione', err); // all'avvio si rifà l'intestazione dalla dimensione del file
  }
  return rec.file;
}

/** Chiudere o uscire mentre si registra: si chiede. true = si può chiudere. */
function confirmQuitWhileRecording() {
  if (!recording || quitWithRecording) return true;
  const options = {
    type: 'warning',
    buttons: ['Ferma e salva…', 'Esci comunque', 'Annulla'],
    defaultId: 0,
    cancelId: 2,
    message: 'La registrazione del mix è in corso',
    detail: `Se esci adesso la registrazione si chiude e resta in ${recoveryDir()}.`,
  };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
  if (choice === 0) send('menu', 'record'); // l'interfaccia la ferma e chiede dove salvarla
  if (choice === 1) quitWithRecording = true;
  return choice === 1;
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    // i modelli scaricati su richiesta stanno nella cartella dati dell'utente
    if (rel.startsWith('models/') && !fs.existsSync(file)) {
      const extra = aiAssets.downloadedModel(app.getPath('userData'), rel.slice(7));
      if (!extra) return new Response('Not found', { status: 404 });
      file = extra;
    }
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      // isolamento cross-origin: SharedArrayBuffer per i thread WASM dell'analisi AI
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
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
    title: 'Segueo',
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
  // la finestra nasce nascosta e si mostra al primo disegno; se non arriva (driver video, antivirus che rallenta il
  // primo avvio, pagina che non si carica) si mostra lo stesso: un processo invisibile terrebbe il lock dell'istanza
  // unica e ogni nuovo avvio si chiuderebbe in silenzio
  const win = mainWindow;
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(showTimer);
    win.show();
    if (settings.data.maximized) win.maximize();
  };
  const showTimer = setTimeout(() => {
    if (!shown) logError('Avvio', 'ready-to-show non arrivato entro 8 s: finestra mostrata comunque');
    reveal();
  }, 8000);
  win.once('ready-to-show', reveal);
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    logError('Caricamento dell\'interfaccia', `${description} (${code}) ${url}`);
    reveal();
  });
  mainWindow.on('close', (e) => {
    if (!confirmQuitWhileRecording()) {
      e.preventDefault();
      return;
    }
    settings.data.maximized = mainWindow.isMaximized();
    try {
      settings.flush();
    } catch (err) {
      logError('Salvataggio delle impostazioni alla chiusura', err);
    }
  });
  // macOS: chiusa la finestra l'app resta aperta, ma l'interfaccia che registrava non c'è più
  mainWindow.on('closed', () => abandonRecording());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.on('did-start-loading', () => notices.reset()); // gli avvisi aspettano la nuova interfaccia
  // interfaccia bloccata o terminata: la registrazione si chiude con quanto registrato, si avvisa e si riparte
  let lastGone = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    logError('Interfaccia terminata', details.reason);
    notices.reset();
    const file = abandonRecording();
    const saved = file ? ` La registrazione in corso è salvata in ${file}` : '';
    if (Date.now() - lastGone < 15000) {
      // si blocca di nuovo subito: niente ripartenze all'infinito; gli avvisi in attesa (es. dov'è la registrazione)
      // si mostrano qui, così all'avvio dopo non si ripetono
      const pending = notices.drain().map((n) => n.message);
      if (file) recorder.clearMarker({ file });
      dialog.showErrorBox('Segueo', [`L'interfaccia continua a bloccarsi (${details.reason}): chiudi e riapri Segueo. Dettagli in ${logFile()}.${saved}`, ...pending].join('\n\n'));
      return;
    }
    // il marcatore della registrazione resta finché l'avviso non arriva: se non arriva, si avvisa all'avvio dopo
    notice(`L'interfaccia si è bloccata (${details.reason}) ed è ripartita.${saved}`, 'error', 20000, file ? () => recorder.clearMarker({ file }) : null);
    lastGone = Date.now();
    mainWindow.reload();
  });
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
        { label: 'AI DJ (mix automatico)', accelerator: 'CmdOrCtrl+M', click: () => send('menu', 'automix') },
        { label: 'Vista AI / console classica', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu', 'view') },
        { label: 'SegueoChat', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'chat') },
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
        { label: 'Pagina del progetto', click: () => openExternal('https://github.com/basoxxx/Virtual-Dj-Ai') },
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

  // l'interfaccia è pronta: riceve gli avvisi nati prima (avvio, migrazione, file illeggibili), poi arrivano in diretta
  ipcMain.handle('app:notices', () => notices.take());

  ipcMain.handle('settings:get', () => settings.data);
  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(settings.data, patch);
    settings.save();
    return settings.data;
  });

  ipcMain.handle('library:get', () => library.snapshot());
  // cartelle che non si leggono (permessi, disco): non entrano in libreria e il motivo arriva all'interfaccia
  async function addFolders(folders) {
    const res = { tracks: [], found: 0, skipped: [], errors: [] };
    for (const folder of folders) {
      try {
        const r = await library.addFolder(folder, progress('Scansione'));
        res.tracks.push(...r.added);
        res.found += r.found;
        res.skipped.push(...r.skipped);
      } catch (err) {
        res.errors.push(err.message);
      }
    }
    return res;
  }
  ipcMain.handle('library:addFolder', async (_e, folder) => {
    let folders = folder ? [folder] : null;
    if (!folders) {
      const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
      if (res.canceled) return { snapshot: library.snapshot(), canceled: true, added: 0, found: 0, skipped: [], errors: [] };
      folders = res.filePaths;
    }
    const r = await addFolders(folders);
    if (r.errors.length && r.errors.length === folders.length) throw new Error(r.errors.join(' · ')); // non è entrata nessuna
    return { snapshot: library.snapshot(), added: r.tracks.length, found: r.found, skipped: r.skipped, errors: r.errors };
  });
  ipcMain.handle('library:addFiles', async (_e, files) => {
    let list = files;
    if (!list || !list.length) {
      const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: audioFilters() });
      if (res.canceled) return { snapshot: library.snapshot(), added: [], canceled: true };
      list = res.filePaths;
    }
    list = list.filter((f) => typeof f === 'string');
    // cartelle trascinate: si aggiungono come cartelle della libreria
    const folders = list.filter((f) => {
      try {
        return fs.statSync(f).isDirectory();
      } catch {
        return false;
      }
    });
    const plain = list.filter((f) => !folders.includes(f));
    const fromFolders = await addFolders(folders);
    const added = await library.addFiles(plain, progress('Importazione'));
    const audio = plain.filter(isAudioFile).length;
    return {
      snapshot: library.snapshot(),
      added: [...fromFolders.tracks, ...added],
      found: fromFolders.found + audio, // file audio trovati, anche già in libreria
      folders: folders.length - fromFolders.errors.length,
      skipped: fromFolders.skipped,
      errors: fromFolders.errors,
      ignored: plain.length - audio,
    };
  });
  ipcMain.handle('library:removeFolder', (_e, folder) => {
    library.removeFolder(folder);
    return library.snapshot();
  });
  // removed/added: brani tolti e aggiunti; offline: cartelle non raggiungibili (i loro brani restano)
  ipcMain.handle('library:rescan', async () => {
    const r = await library.rescan(progress('Aggiornamento'));
    return { snapshot: library.snapshot(), ...r };
  });
  // uno o più brani; l'interfaccia ricarica la libreria una volta sola alla fine
  ipcMain.handle('library:removeTrack', (_e, ids) => {
    for (const id of [].concat(ids)) library.removeTrack(id);
    return true;
  });
  ipcMain.handle('library:track', (_e, id) => library.track(id));
  ipcMain.handle('library:updateTrack', (_e, id, patch) => library.updateTrack(id, patch));
  ipcMain.handle('library:markPlayed', (_e, id) => library.markPlayed(id));
  ipcMain.handle('playlist:create', (_e, name) => library.createPlaylist(name));
  ipcMain.handle('playlist:rename', (_e, id, name) => library.renamePlaylist(id, name));
  ipcMain.handle('playlist:delete', (_e, id) => library.deletePlaylist(id));
  ipcMain.handle('playlist:add', (_e, id, trackIds) => library.addToPlaylist(id, trackIds));
  ipcMain.handle('playlist:remove', (_e, id, index) => library.removeFromPlaylist(id, index));
  ipcMain.handle('playlist:move', (_e, id, from, to) => library.movePlaylistItem(id, from, to));
  ipcMain.handle('playlist:list', () => library.data.playlists);
  ipcMain.handle('mashup:save', (_e, m) => library.saveMashup(m));
  ipcMain.handle('mashup:delete', (_e, id) => library.deleteMashup(id));

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

  // Scalette (DJ set già decisi, es. scritti con Claude): file di testo JSON e appunti
  const setlistFilters = [{ name: 'Scaletta Segueo', extensions: ['json', 'txt', 'segueo'] }];
  ipcMain.handle('setlist:open', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Apri scaletta', properties: ['openFile'], filters: setlistFilters });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('File troppo grande per essere una scaletta');
    return { name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
  });
  ipcMain.handle('setlist:save', async (_e, { text, name }) => {
    const safe = String(name || 'Scaletta').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Scaletta';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Salva scaletta',
      defaultPath: path.join(app.getPath('documents'), `${safe}.json`),
      filters: setlistFilters,
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, String(text), 'utf8');
    return res.filePath;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // Richieste dal pubblico: "Cerca online" apre il browser e si importa ogni file audio che arriva nei download
  const requests = new DownloadWatcher({
    accept: isAudioFile,
    onFile: async (file) => {
      try {
        const [added] = await library.addFiles([file]);
        // estensione audio ma non è audio (es. pagina d'errore salvata come .mp3) o non si legge: non si importa
        if (added && added.metadataError && !added.duration) {
          library.removeTrack(added.id);
          send('requests:arrived', { error: `File non audio o danneggiato: ${path.basename(file)} (${added.metadataError})`, file });
          return;
        }
        const track = library.snapshot().tracks.find((t) => t.path === file) || null;
        send('requests:arrived', { snapshot: library.snapshot(), track, file });
      } catch (err) {
        send('requests:arrived', { error: err.message, file });
      }
    },
    onIgnored: (file) => send('requests:ignored', { file, name: path.basename(file) }),
    // da sola (30 minuti senza file, cartella non più leggibile): con il motivo
    onStop: (info) => send('requests:stopped', info),
  });
  ipcMain.handle('requests:start', async (_e, { query = '', template = '', folder = '' } = {}) => {
    const dir = folder || app.getPath('downloads');
    const url = template === 'none' ? null : searchUrl(template, query); // un indirizzo non valido si segnala prima di iniziare
    requests.start(dir);
    if (url) {
      try {
        await shell.openExternal(url);
      } catch (err) {
        requests.stop(false); // niente attesa di download che non arriveranno
        throw new Error(`Non riesco ad aprire il browser (${err.message})`);
      }
    }
    return dir;
  });
  ipcMain.handle('requests:stop', () => requests.stop(false));
  ipcMain.handle('requests:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Cartella dei download', properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('requests:defaultFolder', () => app.getPath('downloads'));
  ipcMain.handle('requests:checkSite', (_e, template) => searchTemplateProblem(template));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

  // Registrazione del mix (recorder.js): si scrive a blocchi nella cartella di recupero, da cui si sposta solo salvando
  ipcMain.handle('record:start', (_e, { sampleRate, channels }) => {
    if (recording) throw new Error('Registrazione già in corso');
    recording = recorder.startRecording(recoveryDir(), { sampleRate, channels });
    quitWithRecording = false;
    return recording.file;
  });
  ipcMain.on('record:chunk', (_e, chunk) => {
    if (!recording) return;
    // disco pieno o scollegato: una volta sola all'interfaccia, che ferma la registrazione
    const problem = recorder.writeChunk(recording, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (problem) {
      logError('Scrittura della registrazione', recording.error);
      send('record:error', { message: problem });
    }
  });
  // { file } salvata; { canceled, kept } non salvata, resta nella cartella di recupero (mai cancellata)
  ipcMain.handle('record:stop', async () => {
    if (!recording) return null;
    const rec = recording;
    recording = null;
    try {
      recorder.finalizeRecording(rec);
    } catch (err) {
      logError('Chiusura della registrazione', err);
      throw new Error(`Chiusura della registrazione non riuscita (${fsErrorText(err)}): il file è in ${rec.file}, al prossimo avvio provo a sistemarlo`);
    }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Salva registrazione del mix',
      defaultPath: path.join(app.getPath('music'), path.basename(rec.file)),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    recorder.clearMarker(rec); // da qui l'interfaccia dice dov'è la registrazione
    if (res.canceled || !res.filePath) return { canceled: true, kept: rec.file };
    return { file: recorder.saveRecording(rec.file, res.filePath) };
  });

  // --- aggiornamenti automatici ---------------------------------------------------
  let updateInfo = null;
  let downloadedInstaller = null;
  // net.fetch usa la rete di Chromium: rispetta proxy e certificati di sistema
  const fetchImpl = (url, opts) => net.fetch(url, opts);
  ipcMain.handle('update:check', async () => {
    updateInfo = await updater.checkForUpdates(app.getVersion(), { fetchImpl });
    return { ...updateInfo, packaged: app.isPackaged };
  });
  ipcMain.handle('update:download', async () => {
    if (!updateInfo || !updateInfo.available) throw new Error('Nessun aggiornamento disponibile');
    downloadedInstaller = await updater.download(updateInfo.asset, {
      fetchImpl,
      onProgress: (done, total) => send('update:progress', { done, total }),
    });
    return { file: downloadedInstaller, verified: Boolean(updateInfo.asset.sha256) };
  });
  ipcMain.handle('update:install', async () => {
    if (!downloadedInstaller) throw new Error('Scarica prima l\'aggiornamento');
    if (recording) throw new Error('Ferma la registrazione prima di aggiornare');
    // dal codice sorgente non si sostituisce mai l'eseguibile: si apre solo l'installer
    const result = app.isPackaged
      ? await updater.install(downloadedInstaller, { shell, version: app.getVersion(), latest: updateInfo && updateInfo.latest })
      : 'manual';
    if (result === 'manual' && !app.isPackaged) shell.showItemInFolder(downloadedInstaller);
    // libreria e impostazioni si salvano all'uscita (before-quit), ognuna per conto suo
    if (result === 'restart') setTimeout(() => app.quit(), 300);
    return result;
  });

  // --- modelli su richiesta e parti separate (mashup) --------------------------------
  const userData = () => app.getPath('userData');
  ipcMain.handle('models:status', (_e, name) => aiAssets.modelStatus(userData(), name, path.join(RENDERER_DIR, 'models')));
  ipcMain.handle('models:download', (_e, name) => aiAssets.downloadModel(userData(), name, {
    fetchImpl,
    onProgress: (done, total) => send('models:progress', { name, done, total }),
  }));
  ipcMain.handle('stems:status', (_e, trackId) => aiAssets.stemsStatus(userData(), trackId));
  ipcMain.handle('stems:save', (_e, trackId, kind, bytes) => aiAssets.saveStem(userData(), trackId, kind, bytes));
  ipcMain.handle('stems:read', (_e, trackId, kind) => aiAssets.readStem(userData(), trackId, kind));
  ipcMain.handle('system:memory', () => ({ totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) }));


  ipcMain.handle('media:requestMic', async () => {
    if (process.platform !== 'darwin') return true;
    try {
      return await systemPreferences.askForMediaAccess('microphone');
    } catch (err) {
      logError('Richiesta di accesso al microfono', err);
      return false;
    }
  });
}

// Passaggio dal vecchio nome, macOS: l'app si sposta prima di tutto (e si riapre col nome nuovo).
function renameLegacyBundle() {
  if (app.isPackaged && process.platform === 'darwin') {
    const move = migrate.macBundleRename(process.execPath, app.getName());
    if (move) {
      try {
        fs.renameSync(move.from, move.to);
        app.relaunch({ execPath: move.execPath });
        app.exit(0);
        return true;
      } catch (err) {
        logError('Rinomina dell\'app', err);
      }
    }
  }
  return false;
}

// I dati del vecchio nome si copiano solo con il lock dell'istanza unica (un secondo avvio non deve spostare file da
// sotto l'app già aperta) e prima che Chromium apra la cartella.
function migrateLegacyData() {
  const oldDir = path.join(app.getPath('appData'), migrate.LEGACY_NAME);
  try {
    const res = migrate.migrateUserData(oldDir, app.getPath('userData'));
    if (res && res.aside) {
      notice(`Dati di '${migrate.LEGACY_NAME}' portati in Segueo. Quello che avevi fatto dopo il tentativo non riuscito è in ${res.aside}`, 'warn', 30000);
    }
  } catch (err) {
    logError('Migrazione dei dati', err);
    notice(`Non sono riuscito a portare i dati da '${migrate.LEGACY_NAME}' (${fsErrorText(err)}): sono ancora in ${oldDir}. Riprovo al prossimo avvio`, 'error', 30000);
  }
}

// Errori non gestiti: nel registro e all'utente in italiano, senza la finestra di Electron con lo stack in inglese
process.on('uncaughtException', (err) => {
  logError('Eccezione non gestita', err);
  notice(`Errore interno di Segueo: ${(err && err.message) || err}. Dettagli in ${logFile()}`, 'error', 12000);
});
process.on('unhandledRejection', (reason) => {
  logError('Promessa rifiutata non gestita', reason);
  notice(`Errore interno di Segueo: ${(reason && reason.message) || reason}. Dettagli in ${logFile()}`, 'error', 12000);
});

/** All'avvio: registrazioni interrotte, esito dell'ultimo aggiornamento, libreria o impostazioni illeggibili. */
function startupChecks() {
  for (const store of [library.store, settings]) {
    if (!store.loadError) continue;
    logError('Caricamento', store.loadError);
    notice(store.loadError, 'error', 30000);
  }
  try {
    for (const file of recorder.recoverInterrupted(recoveryDir())) {
      notice(`Registrazione non salvata (Segueo si è chiuso mentre registravi): la trovi in ${file}`, 'warn', 30000);
    }
  } catch (err) {
    logError('Recupero delle registrazioni', err);
  }
  try {
    const update = updater.checkInstallResult(updater.UPDATE_DIR, app.getVersion());
    if (update && !update.ok) {
      notice(`Aggiornamento a ${update.to} non riuscito${update.code ? ` (codice ${update.code})` : ''}: installa a mano da ${update.installer}`, 'error', 30000);
    } else if (update) {
      notice(`Segueo aggiornato alla versione ${app.getVersion()}`, 'ok', 6000);
    }
  } catch (err) {
    logError('Esito dell\'aggiornamento', err);
  }
}

const relaunching = renameLegacyBundle();
// il lock crea solo SingletonLock/Cookie/Socket (Windows: lockfile): esclusi dalla migrazione, non contano come dati
const gotLock = !relaunching && app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  migrateLegacyData();
  // un secondo avvio (doppio clic, riavvio dopo l'aggiornamento) porta davanti la finestra, anche se era nascosta
  app.on('second-instance', () => {
    if (!app.isReady() || !settings) return; // la finestra arriva comunque dall'avvio in corso
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const saveError = (what) => (err) => notice(`Impossibile salvare ${what} (${fsErrorText(err)}): le ultime modifiche non sono su disco`, 'error', 15000);
    library = new Library(userData, { onSaveError: saveError('la libreria') });
    settings = new JsonStore(path.join(userData, 'settings.json'), {}, { label: 'Impostazioni', onError: saveError('le impostazioni') });
    startupChecks();
    registerAppProtocol();
    configurePermissions();
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    logError('Avvio', err);
    dialog.showErrorBox('Segueo non si è avviato', `${err.message}\n\nDettagli in ${logFile()}`);
    app.quit();
  });

  // GPU che si blocca (driver video vecchi, desktop remoto, macchine virtuali): nel registro, Chromium ripiega da solo
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU' && details.reason !== 'clean-exit') logError('Processo GPU terminato', `${details.reason} (${details.exitCode})`);
  });

  app.on('before-quit', (e) => {
    if (!confirmQuitWhileRecording()) {
      e.preventDefault();
      return;
    }
    // ognuno per conto suo: se un salvataggio non riesce gli altri si fanno lo stesso
    const failed = [];
    for (const [what, store] of [['la libreria', library], ['le impostazioni', settings]]) {
      if (!store) continue;
      try {
        store.flush();
      } catch (err) {
        logError(`Salvataggio all'uscita (${what})`, err);
        failed.push(`${what} (${fsErrorText(err)})`);
      }
    }
    abandonRecording();
    if (failed.length) dialog.showErrorBox('Segueo', `Non sono riuscito a salvare ${failed.join(' e ')}: le ultime modifiche non sono su disco.`);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

