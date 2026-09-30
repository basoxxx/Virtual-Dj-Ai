// Libreria musicale: scansione cartelle locali, metadati, playlist, cronologia, mashup preparati.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./store');

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
    if (meta.format && meta.format.duration) track.duration = meta.format.duration;
  } catch {
    // file non leggibile dai metadati: resta con i dati del nome file
  }
  return track;
}

async function walk(dir, out, depth = 0) {
  if (depth > 24) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out, depth + 1);
    else if (entry.isFile() && isAudioFile(entry.name)) out.push(full);
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
  constructor(userDataDir) {
    this.store = new JsonStore(path.join(userDataDir, 'library.json'), {
      version: 1,
      folders: [],
      tracks: {},
      playlists: [],
      history: [],
      mashups: [],
    }, { delay: SAVE_DELAY });
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
        const track = await readMetadata(file);
        this.data.tracks[id] = track;
        added.push(track);
      }
      done++;
      if (onProgress && (done % 10 === 0 || done === audio.length)) onProgress(done, audio.length);
    });
    this.store.save();
    return added;
  }

  async addFolder(folder, onProgress) {
    const resolved = path.resolve(folder);
    if (!this.data.folders.includes(resolved)) this.data.folders.push(resolved);
    const files = [];
    await walk(resolved, files);
    await this.addFiles(files, onProgress);
    this.store.save();
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

  async rescan(onProgress) {
    // rimuove i file spariti e aggiunge quelli nuovi
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (!fs.existsSync(t.path)) delete this.data.tracks[id];
    }
    const files = [];
    for (const folder of this.data.folders) await walk(folder, files);
    await this.addFiles(files, onProgress);
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
