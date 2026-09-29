// Accesso al processo principale. In un normale browser (sviluppo/test) usa
// un'implementazione in memoria, così l'interfaccia resta completamente usabile.

function pickFiles(accept = 'audio/*', multiple = true, directory = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (directory) input.webkitdirectory = true;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

function createBrowserApi() {
  const files = new Map();
  const lib = { folders: [], tracks: [], playlists: [], history: [], mashups: [] };
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem('vdjai-settings') || '{}');
  } catch {
    settings = {};
  }
  let rec = null;
  const stems = new Map();
  const snapshot = () => structuredClone(lib);

  const registerFile = (file) => {
    const path = `browser://${file.name}#${file.size}`;
    files.set(path, file);
    if (!lib.tracks.find((t) => t.path === path)) {
      const name = file.name.replace(/\.[^.]+$/, '');
      const dash = name.indexOf(' - ');
      lib.tracks.push({
        id: path,
        path,
        title: dash > 0 ? name.slice(dash + 3) : name,
        artist: dash > 0 ? name.slice(0, dash) : '',
        album: '', genre: '', year: '', duration: 0, bpm: 0, key: '', gain: 0,
        rating: 0, playCount: 0, lastPlayed: 0, added: Date.now(), hotcues: [], analyzed: false,
      });
    }
    return lib.tracks.find((t) => t.path === path);
  };

  return {
    isElectron: false,
    appInfo: async () => ({ version: 'web', platform: 'browser', arch: '', electron: '-', chrome: navigator.userAgent }),
    getSettings: async () => settings,
    setSettings: async (patch) => {
      Object.assign(settings, patch);
      try {
        localStorage.setItem('vdjai-settings', JSON.stringify(settings));
      } catch {
        // archiviazione non disponibile
      }
      return settings;
    },
    getLibrary: async () => snapshot(),
    addFolder: async () => {
      const list = await pickFiles('audio/*', true, true);
      list.filter((f) => /\.(mp3|wav|flac|ogg|m4a|aac|opus|aiff?|webm)$/i.test(f.name)).forEach(registerFile);
      return snapshot();
    },
    addFiles: async (paths) => {
      if (paths && paths.length) return { snapshot: snapshot(), added: [] };
      const list = await pickFiles();
      const added = list.map(registerFile);
      return { snapshot: snapshot(), added };
    },
    registerFile,
    removeFolder: async () => snapshot(),
    rescan: async () => snapshot(),
    removeTrack: async (id) => {
      lib.tracks = lib.tracks.filter((t) => t.id !== id);
      lib.mashups = lib.mashups.filter((m) => m.baseId !== id && m.vocalId !== id);
      return snapshot();
    },
    updateTrack: async (id, patch) => {
      const t = lib.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t;
    },
    markPlayed: async (id) => {
      const t = lib.tracks.find((x) => x.id === id);
      if (t) {
        t.playCount++;
        t.lastPlayed = Date.now();
        lib.history.push({ id, at: t.lastPlayed });
      }
    },
    createPlaylist: async (name) => {
      const p = { id: crypto.randomUUID(), name, tracks: [] };
      lib.playlists.push(p);
      return p;
    },
    renamePlaylist: async (id, name) => {
      const p = lib.playlists.find((x) => x.id === id);
      if (p) p.name = name;
    },
    deletePlaylist: async (id) => {
      lib.playlists = lib.playlists.filter((x) => x.id !== id);
    },
    addToPlaylist: async (id, ids) => {
      const p = lib.playlists.find((x) => x.id === id);
      if (p) p.tracks.push(...ids);
    },
    removeFromPlaylist: async (id, index) => {
      const p = lib.playlists.find((x) => x.id === id);
      if (p) p.tracks.splice(index, 1);
    },
    movePlaylistItem: async (id, from, to) => {
      const p = lib.playlists.find((x) => x.id === id);
      if (!p) return;
      const [item] = p.tracks.splice(from, 1);
      p.tracks.splice(to, 0, item);
    },
    saveMashup: async (m) => {
      const mashup = { bars: 16, baseStart: null, vocalStart: null, created: Date.now(), ...m, id: m.id || crypto.randomUUID() };
      const i = lib.mashups.findIndex((x) => x.id === mashup.id);
      if (i >= 0) lib.mashups[i] = mashup;
      else lib.mashups.push(mashup);
      return structuredClone(mashup);
    },
    deleteMashup: async (id) => {
      lib.mashups = lib.mashups.filter((m) => m.id !== id);
    },
    readFile: async (path) => {
      const file = files.get(path);
      if (file) return new Uint8Array(await file.arrayBuffer());
      const res = await fetch(path);
      return new Uint8Array(await res.arrayBuffer());
    },
    getCover: async () => null,
    pickAudioFile: async () => {
      const [file] = await pickFiles('audio/*', false);
      return file ? registerFile(file).path : null;
    },
    revealFile: async () => {},
    pathForFile: (file) => registerFile(file).path,
    recordStart: async ({ sampleRate, channels }) => {
      rec = { sampleRate, channels, chunks: [] };
      return 'memory';
    },
    recordChunk: (chunk) => rec && rec.chunks.push(chunk),
    recordStop: async () => {
      if (!rec) return null;
      const { encodeWavFromInt16 } = await import('./dsp/wav.js');
      const blob = new Blob([encodeWavFromInt16(rec.chunks, rec.sampleRate, rec.channels)], { type: 'audio/wav' });
      rec = null;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Mix-${Date.now()}.wav`;
      a.click();
      return a.download;
    },
    requestMic: async () => true,
    // mashup: nel browser niente download di modelli; le parti separate restano in memoria
    modelStatus: async (name) => ({ name, installed: false, bytes: 0 }),
    downloadModel: async () => {
      throw new Error('Disponibile solo nell\'app installata');
    },
    stemsStatus: async (trackId) => ({ vocals: stems.has(`${trackId}:vocals`), instrumental: stems.has(`${trackId}:instrumental`) }),
    saveStem: async (trackId, kind, bytes) => Boolean(stems.set(`${trackId}:${kind}`, bytes)),
    readStem: async (trackId, kind) => stems.get(`${trackId}:${kind}`),
    systemMemory: async () => ({ totalMB: (navigator.deviceMemory || 4) * 1024, freeMB: 0 }),
    aiModels: async ({ provider, endpoint }) => {
      const b = endpoint.replace(/\/+$/, '');
      if (provider === 'ollama') return ((await (await fetch(`${b}/api/tags`)).json()).models || []).map((m) => m.name);
      const v1 = /\/v1$/.test(b) ? b : `${b}/v1`;
      return ((await (await fetch(`${v1}/models`)).json()).data || []).map((m) => m.id);
    },
    aiChat: async ({ provider, endpoint, model, messages, temperature }) => {
      const b = endpoint.replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'ollama') {
        const r = await fetch(`${b}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ model, messages, stream: false, format: 'json', options: { temperature } }) });
        return (await r.json()).message.content;
      }
      const v1 = /\/v1$/.test(b) ? b : `${b}/v1`;
      const r = await fetch(`${v1}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages, temperature }) });
      return (await r.json()).choices[0].message.content;
    },
    on: () => () => {},
  };
}

export const api = window.api || createBrowserApi();
