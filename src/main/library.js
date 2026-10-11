// Libreria musicale: scansione cartelle locali, metadati, playlist, cronologia, mashup preparati.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./store');
const { fsErrorText } = require('./errors');

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.wave', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.mp4', '.aif', '.aiff', '.webm', '.wma',
]);

function isAudioFile(file) {
  return AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

let mmPromise = null;
function musicMetadata() {
  if (!mmPromise) mmPromise = Promise.resolve().then(() => require('music-metadata'));
  return mmPromise;
}

function trackId(file) {
  return crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 16);
}

function baseTrack(file) {
  const name = path.basename(file, path.extname(file));
  // "Artista - Titolo.mp3" è la convenzione più diffusa
  const dash = name.indexOf(' - ');
  return {
    id: trackId(file),
    path: path.resolve(file),
    title: dash > 0 ? name.slice(dash + 3) : name,
    artist: dash > 0 ? name.slice(0, dash) : '',
    album: '',
    genre: '',
    year: '',
    duration: 0,
    bpm: 0,
    key: '',
    gain: 0,
    rating: 0,
    playCount: 0,
    lastPlayed: 0,
    added: Date.now(),
    hotcues: [],
    analyzed: false,
  };
}

async function readMetadata(file) {
  const track = baseTrack(file);
  try {
    const mm = await musicMetadata();
    const meta = await mm.parseFile(file, { skipCovers: true, duration: false });
    const c = meta.common || {};
    if (c.title) track.title = c.title;
    if (c.artist) track.artist = c.artist;
    if (c.album) track.album = c.album;
    if (c.genre && c.genre.length) track.genre = c.genre.join(', ');
    if (c.year) track.year = String(c.year);
    if (c.bpm) track.bpm = Number(c.bpm) || 0;
    if (c.key) track.key = c.key;
    const f = meta.format || {};
    // es. una pagina HTML d'errore salvata come .mp3: si legge senza errori ma non c'è nessun formato audio
    if (!f.container && !f.codec && !f.sampleRate) track.metadataError = 'formato audio non riconosciuto';
    if (f.duration) track.duration = f.duration;
  } catch (err) {
    // metadati illeggibili: il brano resta con i dati del nome file, ma il motivo si ricorda (file non audio, permessi)
    track.metadataError = fsErrorText(err);
  }
  return track;
}

/** Cartella non leggibile, in parole (su macOS spesso è la privacy di Musica, Download, Scrivania e dischi esterni). */
function folderError(dir, err) {
  if (err.code === 'ENOENT') return new Error(`Cartella non trovata: ${dir}`);
  if (err.code === 'ENOTDIR') return new Error(`Non è una cartella: ${dir}`);
  if (err.code === 'EPERM' || err.code === 'EACCES') {
    const mac = process.platform === 'darwin'
      ? '. Su macOS consenti l\'accesso a Segueo in Impostazioni di Sistema → Privacy e sicurezza → File e cartelle (o Accesso completo al disco), poi riprova'
      : '';
    return new Error(`Non ho il permesso di leggere la cartella ${dir}${mac}`);
  }
  return new Error(`Cartella non leggibile: ${dir} (${fsErrorText(err)})`);
}

/**
 * File audio della cartella e delle sottocartelle. Se non si legge la cartella di partenza è un errore (non una
 * cartella vuota); le sottocartelle che non si leggono finiscono in skipped.
 */
async function walk(dir, out, skipped = [], depth = 0) {
  if (depth > 24) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (depth === 0) throw folderError(dir, err);
    skipped.push(dir);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out, skipped, depth + 1);
    else if (entry.isFile() && isAudioFile(entry.name)) out.push(full);
  }
}

function inside(file, folder) {
  return file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);
}

/** La cartella si raggiunge? Vuota ma con brani registrati = quasi sempre un punto di mount senza il disco (NAS, Linux). */
async function folderReachable(folder, hasTracks) {
  try {
    const d = await fs.promises.opendir(folder);
    const first = await d.read();
    await d.close();
    return Boolean(first) || !hasTracks;
  } catch {
    return false;
  }
}

/** Il file è stato cancellato davvero (non solo illeggibile per permessi o disco). */
function fileMissing(file) {
  try {
    fs.statSync(file);
    return false;
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR';
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// Con migliaia di brani library.json pesa decine di MB: durante l'analisi (un aggiornamento per brano) si scrive al
// massimo ogni 2 s invece che a ogni brano. All'uscita si scrive comunque subito (flush).
const SAVE_DELAY = 2000;

class Library {
  /** onSaveError(err): salvataggio in background non riuscito (disco pieno, permessi). */
  constructor(userDataDir, { onSaveError = null } = {}) {
    this.store = new JsonStore(path.join(userDataDir, 'library.json'), {
      version: 1,
      folders: [],
      tracks: {},
      playlists: [],
      history: [],
      mashups: [],
    }, { delay: SAVE_DELAY, label: 'Libreria', onError: onSaveError });
  }

  get data() {
    return this.store.data;
  }

  /**
   * Libreria per l'interfaccia. Senza barEnergy (energia per battuta, circa 3/4 dei byte): serve solo al brano
   * sul deck e si chiede con track(id); così ogni ricarica passa 4 volte meno dati tra i processi.
   */
  snapshot() {
    const d = this.data;
    return {
      folders: d.folders,
      tracks: Object.values(d.tracks).map(({ barEnergy, ...t }) => t),
      playlists: d.playlists,
      history: d.history.slice(-500),
      mashups: d.mashups,
    };
  }

  /** Un brano con tutti i dati, compresa l'energia per battuta. */
  track(id) {
    return this.data.tracks[id] || null;
  }

  hasPath(file) {
    return Boolean(this.data.tracks[trackId(file)]);
  }

  async addFiles(files, onProgress) {
    const audio = files.filter(isAudioFile);
    let done = 0;
    const added = [];
    await mapLimit(audio, 6, async (file) => {
      const id = trackId(file);
      const existing = this.data.tracks[id];
      if (!existing) {
        // il motivo dei metadati illeggibili serve solo a chi importa (es. le richieste), non si salva in libreria
        const { metadataError, ...track } = await readMetadata(file);
        this.data.tracks[id] = track;
        added.push(metadataError ? { ...track, metadataError } : track);
      }
      done++;
      if (onProgress && (done % 10 === 0 || done === audio.length)) onProgress(done, audio.length);
    });
    this.store.save();
    return added;
  }

  /**
   * Una cartella non leggibile è un errore e non entra in libreria. Restituisce i brani aggiunti, quanti file audio
   * ha trovato (anche già in libreria) e le sottocartelle che non ha potuto leggere.
   */
  async addFolder(folder, onProgress) {
    const resolved = path.resolve(folder);
    const files = [];
    const skipped = [];
    await walk(resolved, files, skipped);
    if (!this.data.folders.includes(resolved)) this.data.folders.push(resolved);
    const added = await this.addFiles(files, onProgress);
    return { added, found: files.length, skipped };
  }

  removeFolder(folder) {
    const resolved = path.resolve(folder);
    this.data.folders = this.data.folders.filter((f) => f !== resolved);
    const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (t.path.startsWith(prefix)) delete this.data.tracks[id];
    }
    this.store.save();
  }

  /**
   * Toglie i brani spariti e aggiunge quelli nuovi. Un brano si toglie solo se è stato cancellato davvero: se la sua
   * cartella della libreria non si raggiunge (disco esterno o di rete scollegato) cue, griglie, voti e analisi restano.
   * Per i brani aggiunti uno per uno vale la loro cartella: se manca anche quella, il disco è scollegato.
   */
  async rescan(onProgress) {
    const tracks = Object.entries(this.data.tracks);
    const offline = [];
    for (const folder of this.data.folders) {
      if (!(await folderReachable(folder, tracks.some(([, t]) => inside(t.path, folder))))) offline.push(folder);
    }
    let removed = 0;
    for (const [id, t] of tracks) {
      const root = this.data.folders.find((f) => inside(t.path, f));
      if (root ? offline.includes(root) : !dirExists(path.dirname(t.path))) continue;
      if (fileMissing(t.path)) {
        delete this.data.tracks[id];
        removed++;
      }
    }
    const files = [];
    const skipped = [];
    for (const folder of this.data.folders) {
      if (offline.includes(folder)) continue;
      try {
        await walk(folder, files, skipped);
      } catch {
        offline.push(folder); // sparita proprio adesso
      }
    }
    const added = await this.addFiles(files, onProgress);
    return { removed, added: added.length, offline, skipped };
  }

  removeTrack(id) {
    delete this.data.tracks[id];
    for (const p of this.data.playlists) p.tracks = p.tracks.filter((t) => t !== id);
    this.data.mashups = this.data.mashups.filter((m) => m.baseId !== id && m.vocalId !== id);
    this.store.save();
  }

  updateTrack(id, patch) {
    const t = this.data.tracks[id];
    if (!t) return null;
    // bpmEngine dice chi ha fatto la griglia (classic, ai, manual): senza, a ogni avvio Beat This! rianalizzava
    // tutta la libreria e sovrascriveva le griglie corrette a mano
    const allowed = ['bpm', 'key', 'gain', 'duration', 'rating', 'hotcues', 'analyzed', 'title', 'artist', 'genre', 'gridOffset', 'comment',
      'energy', 'mixIn', 'mixOut', 'introEnd', 'outroStart', 'barEnergy', 'bpmEngine', 'bpmConfidence'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
    this.store.save();
    return t;
  }

  markPlayed(id) {
    const t = this.data.tracks[id];
    if (!t) return;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    this.data.history.push({ id, at: t.lastPlayed });
    if (this.data.history.length > 2000) this.data.history.splice(0, this.data.history.length - 2000);
    this.store.save();
  }

  createPlaylist(name) {
    const playlist = { id: crypto.randomUUID(), name: name || 'Nuova playlist', tracks: [] };
    this.data.playlists.push(playlist);
    this.store.save();
    return playlist;
  }

  renamePlaylist(id, name) {
    const p = this.data.playlists.find((x) => x.id === id);
    if (p) p.name = name;
    this.store.save();
  }

  deletePlaylist(id) {
    this.data.playlists = this.data.playlists.filter((x) => x.id !== id);
    this.store.save();
  }

  addToPlaylist(id, trackIds) {
    const p = this.data.playlists.find((x) => x.id === id);
    if (!p) return;
    for (const t of trackIds) if (this.data.tracks[t]) p.tracks.push(t);
    this.store.save();
  }

  removeFromPlaylist(id, index) {
    const p = this.data.playlists.find((x) => x.id === id);
    if (!p) return;
    p.tracks.splice(index, 1);
    this.store.save();
  }

  movePlaylistItem(id, from, to) {
    const p = this.data.playlists.find((x) => x.id === id);
    if (!p) return;
    const [item] = p.tracks.splice(from, 1);
    p.tracks.splice(to, 0, item);
    this.store.save();
  }

  /**
   * Mashup preparato prima del set: base di un brano e voce di un altro. Crea o aggiorna (stesso id);
   * baseStart e vocalStart sono secondi nei due brani, null = scelti in automatico.
   */
  saveMashup(m) {
    if (!m || m.baseId === m.vocalId || !this.data.tracks[m.baseId] || !this.data.tracks[m.vocalId]) throw new Error('Mashup non valido');
    const sec = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const mashup = {
      id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
      baseId: m.baseId,
      vocalId: m.vocalId,
      bars: Number.isInteger(m.bars) && m.bars >= 4 && m.bars <= 64 ? m.bars : 16,
      baseStart: sec(m.baseStart),
      vocalStart: sec(m.vocalStart),
      created: Number(m.created) || Date.now(),
    };
    const i = this.data.mashups.findIndex((x) => x.id === mashup.id);
    if (i >= 0) this.data.mashups[i] = mashup;
    else this.data.mashups.push(mashup);
    this.store.save();
    return mashup;
  }

  deleteMashup(id) {
    this.data.mashups = this.data.mashups.filter((m) => m.id !== id);
    this.store.save();
  }

  flush() {
    this.store.flush();
  }
}

module.exports = { Library, isAudioFile, trackId, readMetadata, AUDIO_EXTENSIONS };
