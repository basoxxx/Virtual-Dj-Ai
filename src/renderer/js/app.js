// Avvio dell'applicazione e collegamento di motore audio, interfaccia, MIDI e tastiera.
import { api } from './api.js';
import { AudioEngine } from './audio/engine.js';
import { ChannelStrip } from './audio/mixer.js';
import { Deck } from './audio/deck.js';
import { Sampler } from './audio/sampler.js';
import { MicChannel } from './audio/mic.js';
import { MidiManager } from './midi.js';
import { AutoDJ } from './ai/autodj.js';
import { BatchAnalyzer } from './ai/batch-analyzer.js';
import { configureAnalysis } from './audio/analyzer-client.js';
import { StemManager } from './ai/stems.js';
import { MashupManager } from './ai/mashups.js';
import { SegueoChat } from './ai/segueochat.js';
import { ChatModel } from './ai/chat-model.js';
import { DeckUI } from './ui/deck-ui.js';
import { MixerUI } from './ui/mixer-ui.js';
import { LibraryUI } from './ui/library-ui.js';
import { SideUI, remaining } from './ui/side-ui.js';
import { ScrollingWaveform, HOTCUE_COLORS } from './ui/waveform.js';
import { openSettings } from './ui/settings-ui.js';
import { installKeyboard } from './keyboard.js';
import { el, button, toast } from './ui/controls.js';
import { formatTime } from './dsp/analysis.js';
import { knownActions } from './controllers/presets.js';
import { GamepadController } from './controllers/gamepad.js';
import { icon, withIcon } from './ui/icons.js';
import { UpdateUI } from './ui/update-ui.js';
import { AiView } from './ui/ai-view.js';
import { MashupUI } from './ui/mashup-ui.js';
import { ChatUI } from './ui/chat-ui.js';
import { RequestsUI, DEFAULT_REQUESTS } from './ui/requests-ui.js';

const ACCENTS = ['#2ea8ff', '#ff6a3d'];

const DEFAULT_SETTINGS = {
  audio: { mode: 'single', masterDevice: '', headphoneDevice: '', micDevice: 'default', latency: 'interactive' },
  mixer: {
    xfCurve: 'smooth', autoGain: true, limiter: true, pitchRange: 8, keylock: false, quantize: true,
    vinyl: true, lockPlaying: true, brakeTime: 0, startTime: 0, hotcuePlay: true,
  },
  midi: { mapping: {}, preset: 'auto', gamepad: true },
  sampler: [],
  ai: {
    autoAnalyze: true,
    analysisEngine: 'ai',
    options: {},
  },
  updates: { auto: true },
  // richieste dal pubblico: sito per "Cerca online" e cartella dei download da guardare ('' = quella di sistema)
  requests: DEFAULT_REQUESTS,
  // view: ultima vista usata, 'console' (classica) o 'ai' (dedicata all'AI DJ); startView: 'last', 'console' o 'ai'
  ui: { view: 'console', startView: 'last' },
};

function merge(defaults, saved) {
  const out = structuredClone(defaults);
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}

class App {
  constructor() {
    this.api = api;
    this.decks = [];
    this.strips = [];
    this.actions = new Map();
  }

  async start() {
    this.settings = merge(DEFAULT_SETTINGS, await api.getSettings());
    configureAnalysis({ engine: this.settings.ai.analysisEngine, refine: this.settings.ai.refine || 'library' });
    this.engine = new AudioEngine();
    await this.engine.init({ latency: this.settings.audio.latency });
    this.engine.addEventListener('error', (e) => toast(e.detail, 'error'));

    for (const id of ['A', 'B']) {
      const strip = new ChannelStrip(this.engine, id);
      this.engine.addChannel(strip);
      this.strips.push(strip);
      this.decks.push(new Deck(this.engine, strip, id));
    }
    this.mic = new MicChannel(this.engine);
    this.mic.deviceId = this.settings.audio.micDevice;
    this.mic.addEventListener('error', (e) => toast(e.detail, 'error'));
    this.sampler = new Sampler(this.engine);
    await this.sampler.init(this.settings.sampler);
    // il modello linguistico locale (Ollama, LM Studio) non c'è più: via le sue impostazioni e opzioni salvate
    for (const k of ['llm', 'provider', 'endpoint', 'model', 'apiKey']) delete this.settings.ai[k];
    if (this.settings.ai.options) {
      delete this.settings.ai.options.useLLM;
      delete this.settings.ai.options.notes;
    }
    this.analyzer = new BatchAnalyzer(this.engine.ctx, {
      priority: () => this.analysisPriority(),
      // la separazione (circa 3 GB) non va mai insieme all'analisi: l'analisi si ferma tra un brano e l'altro
      shouldYield: () => Boolean(this.stems.running || this.stems.queue.length),
    });
    // la separazione aspetta solo il brano in analisi in quel momento, non tutta la libreria
    this.stems = new StemManager({ isBusy: () => this.analyzer.stepping });
    this.mashups = new MashupManager({ stems: this.stems, getTrack: (id) => this.library.track(id) });
    this.automix = new AutoDJ({
      stems: this.stems,
      getMashups: () => this.mashups.list,
      engine: this.engine,
      decks: this.decks,
      getControls: () => this.mixerUI.controls,
      getPool: (source) => (source && source !== 'library' ? this.library.playlistTracks(source) : this.library.lib.tracks),
    });
    this.automix.setOptions(this.settings.ai.options || {});
    // opzioni cambiate dal pannello, da SegueoChat o finite le impostazioni temporanee: si salvano
    this.automix.addEventListener('options', () => {
      this.settings.ai.options = this.automix.savedOptions();
      this.saveSettings();
    });
    this.chat = new SegueoChat({
      automix: this.automix,
      mashups: this.mashups,
      model: new ChatModel(),
      getTracks: () => this.library.lib.tracks,
      getPlaylists: () => this.library.lib.playlists,
      setOptions: (patch) => this.automix.setOptions(patch),
      setView: (v) => this.setView(v),
    });

    this.buildLayout();
    this.applyMixerSettings();
    try {
      await this.engine.applyRouting(this.settings.audio);
    } catch (err) {
      toast(`Uscita audio: ${err.message}`, 'error');
    }

    this.registerActions();
    this.midi = new MidiManager(this.actions);
    // la console MIDI non deve bloccare l'avvio: se il sistema non risponde entro 3 s si va avanti
    // (libreria, interfaccia) e la console si collega appena arriva la risposta
    const midiReady = this.midi.init(this.settings.midi.mapping, this.settings.midi.preset).then(() => this.updateMidiBadge());
    await Promise.race([midiReady, new Promise((r) => setTimeout(r, 3000))]);
    this.gamepad = new GamepadController(this.actions);
    this.gamepad.enabled = this.settings.midi.gamepad !== false;
    this.gamepad.addEventListener('connected', (e) => {
      toast(`Gamepad collegato: ${e.detail}`);
      this.updateMidiBadge();
    });
    this.gamepad.addEventListener('disconnected', () => this.updateMidiBadge());
    // VU dei canali sulla console (in dB: −42 dB spento, 0 dB tutto acceso)
    this.midi.vuSource = (id) => {
      const strip = this.strips.find((st) => st.name === id);
      if (!strip) return 0;
      // nella vista AI il mixer non legge i meter: li legge la console
      const levels = this.view === 'ai' ? strip.meter.read().levels : strip.meter.levels;
      const peak = Math.max(levels[0], levels[1]);
      return peak > 0 ? (20 * Math.log10(peak) + 42) / 42 : 0;
    };
    // guida al beatmatch sulla console: tempo +1 troppo veloce / −1 troppo lento / 0 ok; fase +1 avanti / −1 indietro / 0 a tempo
    this.midi.guideSource = (id) => {
      const d = this.decks.find((x) => x.id === id);
      const o = this.decks.find((x) => x.id !== id);
      if (!d || !o || !d.loaded || !o.loaded || !d.bpm || !o.bpm) return {};
      let td = d.effectiveBpm;
      let to = o.effectiveBpm;
      // metà/doppio tempo
      if (td / to > 1.5) td /= 2;
      else if (to / td > 1.5) to /= 2;
      const diff = td - to;
      if (Math.abs(diff) > 0.25) return { tempo: diff > 0 ? 1 : -1 };
      if (!d.playing || !o.playing) return { tempo: 0 };
      let ph = d.beatPhase() - o.beatPhase();
      if (ph > 0.5) ph -= 1;
      if (ph < -0.5) ph += 1;
      return { tempo: 0, phase: Math.abs(ph) < 0.02 ? 0 : ph > 0 ? 1 : -1 };
    };
    setInterval(() => this.midi.updateLeds(), 50);
    this.midi.addEventListener('mapping', (e) => {
      this.settings.midi.mapping = e.detail;
      this.saveSettings();
    });
    this.midi.addEventListener('devices', () => this.updateMidiBadge());
    this.updateMidiBadge();

    installKeyboard(this);
    api.on('menu', (cmd) => this.onMenu(cmd));
    api.on('library:progress', (p) => this.showProgress(p));
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => this.refreshInputs());
    this.refreshInputs();

    await this.library.reload();
    document.addEventListener('pointerdown', () => this.engine.resume(), { once: true });
    document.body.classList.add('ready');
    this.installAutoFit();
    this.updateUI.schedule();
    this.loop();
  }

  buildLayout() {
    const root = document.getElementById('app');
    root.innerHTML = '';

    // barra superiore
    this.recBtn = button(withIcon('record', 'REC'), { className: 'rec-btn toggle', title: 'Registra il mix in WAV (Ctrl+R)', onClick: () => this.toggleRecording() });
    this.recTime = el('span', { class: 'rec-time' }, '');
    this.automixBtn = button(withIcon('sparkles', 'AI DJ'), { className: 'toggle', title: 'AI DJ: mixa in automatico (Ctrl+M)', onClick: () => this.automix.setEnabled(!this.automix.enabled) });
    this.automix.addEventListener('change', () => this.automixBtn.setOn(this.automix.enabled));
    this.automix.addEventListener('log', (e) => {
      if (/^(Prossimo|In onda)/.test(e.detail.text)) this.library.renderRows();
    });
    this.midiBadge = el('span', { class: 'badge', title: 'Console DJ' }, 'MIDI');
    this.midiBadge.addEventListener('click', () => this.openSettings('midi'));
    this.clock = el('span', { class: 'clock' });
    this.updateUI = new UpdateUI(this);
    this.progress = el('span', { class: 'progress' });
    this.engine.addEventListener('recording', (e) => {
      this.recBtn.setOn(e.detail);
      if (!e.detail) this.recTime.textContent = '';
    });
    this.viewBtns = {
      console: button('Console', { className: 'seg', title: 'Console classica: deck, mixer ed effetti a mano', onClick: () => this.setView('console') }),
      ai: button(withIcon('sparkles', 'AI', 13), { className: 'seg', title: 'Vista AI: mix automatico e mashup (Ctrl+Shift+A)', onClick: () => this.setView('ai') }),
    };
    const top = el('header', { class: 'topbar' },
      el('div', { class: 'logo' }, el('img', { class: 'logo-img', src: 'img/icon.png', alt: '' }), 'Segueo'),
      el('div', { class: 'view-switch', role: 'group', 'aria-label': 'Vista' }, this.viewBtns.console, this.viewBtns.ai),
      this.progress,
      el('div', { class: 'spacer' }),
      this.updateUI.badge, this.recBtn, this.recTime, this.automixBtn, this.midiBadge,
      button(icon('gear'), { className: 'icon-btn', title: 'Impostazioni (Ctrl+,)', onClick: () => this.openSettings() }),
      button(icon('help'), { className: 'icon-btn', title: 'Scorciatoie (F1)', onClick: () => this.openSettings('keys') }),
      this.clock);

    // forme d'onda scorrevoli
    const waves = el('section', { class: 'waves' });
    this.scrollers = this.decks.map((d, i) => {
      const canvas = el('canvas', { class: 'wave' });
      const zoom = el('div', { class: 'wave-zoom' },
        button('−', { className: 'tiny', title: 'Zoom out', onClick: () => sw.zoom(1.3) }),
        button('+', { className: 'tiny', title: 'Zoom in', onClick: () => sw.zoom(1 / 1.3) }));
      const sw = new ScrollingWaveform(canvas, d, ACCENTS[i]);
      const wrap = el('div', { class: 'wave-wrap' }, el('span', { class: 'wave-label', style: { color: ACCENTS[i] } }, d.id), canvas, zoom);
      wrap.addEventListener('dragover', (e) => e.preventDefault());
      wrap.addEventListener('drop', (e) => {
        e.preventDefault();
        this.onDeckDrop(d, e);
      });
      waves.append(wrap);
      return sw;
    });

    // deck e mixer
    const deckA = el('section', {});
    const mixer = el('section', {});
    const deckB = el('section', {});
    const middle = el('div', { class: 'console' }, deckA, mixer, deckB);
    this.consoleEl = middle;
    this.wavesEl = waves;
    this.deckUIs = this.decks.map((d, i) => new DeckUI(i === 0 ? deckA : deckB, d, {
      accent: ACCENTS[i],
      side: i === 0 ? 'left' : 'right',
      getOther: () => this.decks[1 - i],
      onRequestLoad: (e) => this.onDeckDrop(d, e),
      stems: this.stems,
    }));
    this.mixerUI = new MixerUI(mixer, { engine: this.engine, strips: this.strips, decks: this.decks, mic: this.mic, sampler: this.sampler, accents: ACCENTS });

    // libreria e pannello laterale
    const libHost = el('section', {});
    const sideHost = el('aside', {});
    this.library = new LibraryUI(libHost, {
      onLoad: (t, deckId) => this.loadTrack(t, deckId),
      onQueue: (tracks) => {
        this.automix.enqueue(tracks);
        this.sideUI.show('automix');
        toast(`${tracks.length} brani in coda AI DJ`);
      },
      getMasterDeck: () => this.masterDeck(),
      onMashup: (track, role) => {
        this.mashupUI.useTrack(track, role);
        this.sideUI.show('mashup');
      },
    });
    this.mashupUI = new MashupUI({ app: this });
    this.requests = new RequestsUI(this);
    this.chatUI = new ChatUI({ app: this, chat: this.chat });
    this.sideUI = new SideUI(sideHost, {
      tabs: [{ id: 'chat', label: 'CHAT', pane: this.chatUI.root }, { id: 'mashup', label: 'MASHUP', pane: this.mashupUI.root }],
      stems: this.stems,
      sampler: this.sampler,
      automix: this.automix,
      onSamplerChange: () => {
        this.settings.sampler = this.sampler.serialize();
        this.saveSettings();
      },
      getTrack: (id) => this.library.track(id),
      analyzer: this.analyzer,
      getPlaylists: () => this.library.lib.playlists,
      getAllTracks: () => this.library.lib.tracks,
      onAiOptions: () => {
        this.settings.ai.options = this.automix.savedOptions();
        this.saveSettings();
      },
      planSet: (description) => this.chat.planSet(description),
      openChat: () => this.openChat(),
    });
    this.library.addEventListener('playlists', () => this.sideUI.refreshSources());
    this.library.addEventListener('changed', () => {
      this.sideUI.refreshSources();
      this.mashups.setList(this.library.lib.mashups);
      // l'analisi cede il passo alla separazione di voce e base: si può avviare anche mentre separa
      if (this.settings.ai.autoAnalyze && !this.analyzer.running) {
        clearTimeout(this.analyzeTimer);
        this.analyzeTimer = setTimeout(() => this.analyzer.run(this.library.lib.tracks), 3000);
      }
    });
    this.analyzer.addEventListener('progress', (e) => {
      const p = e.detail;
      if (p.running) this.showProgress({ label: 'Analisi AI', done: p.done, total: p.total, extra: remaining(p.eta) });
      else this.library.renderRows();
    });
    const bottom = el('div', { class: 'bottom' }, libHost, sideHost);
    this.aiView = new AiView(el('section', {}), { app: this, accents: ACCENTS });
    root.append(top, waves, middle, this.aiView.root, bottom);
    const start = this.settings.ui.startView;
    this.setView(start === 'console' || start === 'ai' ? start : this.settings.ui.view, { save: false });

    let libTimer = null;
    for (const d of this.decks) {
      // badge "A"/"B" in libreria sul brano caricato nel deck
      let marked = null;
      d.addEventListener('loaded', () => {
        if (marked && marked._deck === d.id) delete marked._deck;
        marked = d.track;
        if (marked) marked._deck = d.id;
      });
      const rerender = () => {
        clearTimeout(libTimer);
        libTimer = setTimeout(() => this.library.renderRows(), 300);
      };
      d.addEventListener('loaded', rerender);
      d.addEventListener('analyzed', rerender);
      d.addEventListener('pitch', rerender);
      d.addEventListener('state', rerender);
    }
  }

  /**
   * Ordine dell'analisi della libreria: prima i brani sui deck, in coda all'AI DJ e dei mashup che si stanno
   * creando o preparando (0), poi quelli della playlist dell'AI DJ e dei mashup salvati (1), poi tutti gli altri (2).
   */
  analysisPriority() {
    const now = new Set(this.automix.queue.map((t) => t.id));
    if (this.requests) for (const id of this.requests.priorityIds) now.add(id);
    for (const d of this.decks) if (d.track) now.add(d.track.id);
    const draft = this.mashupUI ? this.mashupUI.draft : {};
    for (const t of [draft.base, draft.vocal]) if (t) now.add(t.id);
    for (const id of this.mashups.preparing) {
      const m = this.mashups.get(id);
      if (m) now.add(m.baseId).add(m.vocalId);
    }
    const soon = new Set();
    const src = this.automix.options.source;
    const playlist = src && src !== 'library' && this.library.lib.playlists.find((p) => p.id === src);
    if (playlist) playlist.tracks.forEach((id) => soon.add(id));
    for (const m of this.mashups.list) {
      soon.add(m.baseId);
      soon.add(m.vocalId);
    }
    return (t) => (now.has(t.id) ? 0 : soon.has(t.id) ? 1 : 2);
  }

  /** Apre SegueoChat nel pannello laterale, pronta per scrivere. */
  openChat() {
    this.sideUI.show('chat');
    this.chatUI.focus();
  }

  /** Vista classica ('console') o dedicata all'AI ('ai'): l'AI DJ continua a mixare in entrambe. */
  setView(view, { save = true } = {}) {
    const v = view === 'ai' ? 'ai' : 'console';
    this.view = v;
    document.body.classList.toggle('view-ai', v === 'ai');
    for (const [k, b] of Object.entries(this.viewBtns)) b.setOn(k === v);
    if (save && this.settings.ui.view !== v) {
      this.settings.ui.view = v;
      this.saveSettings();
    }
    if (this.consoleEl) this.fitLayout();
  }

  masterDeck() {
    const [a, b] = this.decks;
    const playing = this.decks.filter((d) => d.playing);
    if (playing.length === 1) return playing[0];
    if (playing.length === 2) {
      const { a: ga, b: gb } = AudioEngine.crossfaderGains(this.engine.crossfader, this.engine.xfCurve);
      const va = ga * a.strip.volume;
      const vb = gb * b.strip.volume;
      return va >= vb ? a : b;
    }
    return a.loaded ? a : b.loaded ? b : null;
  }

  async loadTrack(track, deckId) {
    if (!track) return;
    let deck = deckId ? this.decks.find((d) => d.id === deckId) : null;
    if (!deck) {
      deck = this.decks.find((d) => !d.loaded && !d.playing) || this.decks.find((d) => !d.playing);
    }
    if (!deck) {
      toast('Entrambi i deck sono in riproduzione', 'warn');
      return;
    }
    if (deck.playing && this.settings.mixer.lockPlaying) {
      toast(`Il deck ${deck.id} è in riproduzione: fermalo prima di caricare`, 'warn');
      return;
    }
    await deck.load(track);
  }

  async onDeckDrop(deck, e) {
    const id = e.dataTransfer.getData('text/x-track-id');
    if (id) {
      this.loadTrack(this.library.track(id), deck.id);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const res = await api.addFiles(paths);
    this.library.setLibrary(res.snapshot);
    const t = this.library.lib.tracks.find((x) => x.path === paths[0] || x.path.endsWith(paths[0]));
    if (t) this.loadTrack(t, deck.id);
    else toast('Formato file non supportato', 'error');
  }

  applyMixerSettings() {
    const m = this.settings.mixer;
    this.engine.setCrossfaderCurve(m.xfCurve);
    if (this.mixerUI) this.mixerUI.curveSel.value = m.xfCurve;
    this.engine.autoGain = m.autoGain;
    this.engine.setLimiter(m.limiter);
    for (const d of this.decks) {
      if (!this.mixerApplied) {
        d.setPitchRange(m.pitchRange);
        d.setKeylock(m.keylock);
      }
      d.quantize = m.quantize;
      d.vinyl = m.vinyl;
      d.brakeTime = m.brakeTime;
      d.startTime = m.startTime;
      d.hotcuePlays = m.hotcuePlay !== false;
      d.strip.setAutoGain(m.autoGain && d.track ? d.track.gain || 0 : 0);
      d.emit('state');
    }
    this.mixerApplied = true;
  }

  saveSettings() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api.setSettings({
        audio: this.settings.audio,
        mixer: this.settings.mixer,
        midi: {
          mapping: this.midi ? this.midi.mapping : this.settings.midi.mapping,
          preset: this.midi ? this.midi.presetMode : this.settings.midi.preset,
          gamepad: this.gamepad ? this.gamepad.enabled : this.settings.midi.gamepad,
          presetRevs: this.settings.midi.presetRevs || {},
          backup: this.settings.midi.backup || null,
        },
        sampler: this.sampler.serialize(),
        ai: this.settings.ai,
        updates: this.settings.updates,
        ui: this.settings.ui,
      });
    }, 300);
  }

  openSettings(tab) {
    openSettings(this, tab);
  }

  async refreshInputs() {
    const { inputs } = await AudioEngine.devices();
    for (const ui of this.deckUIs) ui.updateInputs(inputs.filter((i) => i.deviceId !== 'default' && i.deviceId !== 'communications'));
  }

  updateMidiBadge() {
    const devices = this.midi.devices();
    const pads = this.gamepad ? this.gamepad.pads : [];
    const n = devices.length + pads.length;
    const known = devices.find((d) => d.preset);
    this.midiBadge.textContent = known ? known.preset.name.split(' /')[0] : pads.length && !devices.length ? 'Gamepad' : 'MIDI';
    this.midiBadge.classList.toggle('on', n > 0);
    this.midiBadge.title = n
      ? [...devices.map((d) => `${d.name}${d.preset ? ` → profilo ${d.preset.brand} ${d.preset.name}` : ' (nessun profilo: usa Learn o la procedura guidata)'}`), ...pads.map((p) => `Gamepad: ${p.id}`)].join('\n')
      : 'Nessuna console collegata';
    if (known && !this.announced?.has(known.id)) {
      this.announced = this.announced || new Set();
      this.announced.add(known.id);
      toast(`Console riconosciuta: ${known.preset.brand} ${known.preset.name}`, 'ok');
    }
    for (const d of devices) if (d.preset) this.setupConsole(d.preset);
  }

  /**
   * Prima volta con un profilo (o con una sua versione corretta): le correzioni fatte a mano sulla versione
   * vecchia servivano a tappare i suoi errori, quindi si mettono da parte (si possono ripristinare);
   * con una console che ha la scheda audio a 4 uscite si prepara anche l'audio.
   */
  setupConsole(preset) {
    const m = this.settings.midi;
    m.presetRevs = m.presetRevs || {};
    const seen = m.presetRevs[preset.id] || 0;
    if (seen >= preset.rev) return;
    m.presetRevs[preset.id] = preset.rev;
    if (preset.rev > 1 && Object.keys(this.midi.mapping).length) {
      m.backup = { ...this.midi.mapping };
      this.midi.clearAll();
      toast(`Profilo ${preset.brand} ${preset.name} aggiornato: le tue vecchie correzioni sono state messe da parte (Impostazioni → Console DJ → Ripristina correzioni)`, 'ok', 9000);
    }
    this.saveSettings();
    if (preset.audio && preset.audio.quad) this.setupConsoleAudio(preset);
  }

  /** Scheda audio della console: casse sulle uscite 1-2, cuffia sulle 3-4 (se l'audio non è già impostato a mano). */
  async setupConsoleAudio(preset, attempt = 0) {
    const a = this.settings.audio;
    if (a.mode !== 'single' || a.headphoneDevice) return;
    const { outputs } = await AudioEngine.devices();
    const names = preset.match.map((x) => x.toLowerCase());
    const found = outputs.filter((o) => o.deviceId !== 'default' && o.deviceId !== 'communications' && names.some((n) => (o.label || '').toLowerCase().includes(n)));
    if (!found.length) {
      // la scheda audio USB può comparire qualche secondo dopo la porta MIDI
      if (attempt < 3) setTimeout(() => this.setupConsoleAudio(preset, attempt + 1), 2000);
      return;
    }
    if (a.masterDevice && !found.some((o) => o.deviceId === a.masterDevice)) return; // casse su un'altra scheda, scelta a mano
    const before = { ...a };
    Object.assign(a, { mode: 'quad', masterDevice: found[0].deviceId });
    const res = await this.engine.applyRouting(a);
    if (res && res.quad) {
      toast(`Audio sulla ${preset.name}: casse sulle uscite 1-2, cuffia sulle uscite 3-4`, 'ok', 6000);
    } else if (found.length > 1) {
      // alcuni driver mostrano la scheda come due uscite stereo: una per le casse e una per la cuffia
      const hp = found.find((o) => /3.?4|head|phone|cuffi|casque|kopfh/i.test(o.label)) || found[1];
      Object.assign(a, { mode: 'single', masterDevice: found.find((o) => o !== hp).deviceId, headphoneDevice: hp.deviceId });
      await this.engine.applyRouting(a);
      toast(`Audio sulla ${preset.name}: casse su "${found.find((o) => o !== hp).label}", cuffia su "${hp.label}"`, 'ok', 6000);
    } else {
      Object.assign(a, before);
      await this.engine.applyRouting(a);
      return;
    }
    this.saveSettings();
  }

  async toggleRecording() {
    try {
      if (this.engine.recording) {
        const path = await this.engine.stopRecording();
        if (path) toast(`Registrazione salvata: ${path}`, 'ok', 6000);
      } else {
        await this.engine.startRecording(api);
        toast('Registrazione avviata');
      }
    } catch (err) {
      toast(`Registrazione: ${err.message}`, 'error');
    }
  }

  onMenu(cmd) {
    if (cmd === 'add-folder') this.library.addFolder();
    else if (cmd === 'add-files') this.library.addFiles();
    else if (cmd === 'settings') this.openSettings();
    else if (cmd === 'help') this.openSettings('keys');
    else if (cmd === 'record') this.toggleRecording();
    else if (cmd === 'automix') this.automix.setEnabled(!this.automix.enabled);
    else if (cmd === 'view') this.setView(this.view === 'ai' ? 'console' : 'ai');
    else if (cmd === 'chat') this.openChat();
  }

  showProgress(p) {
    clearTimeout(this.progressTimer);
    this.progress.textContent = `${p.label}: ${p.done}/${p.total}${p.extra || ''}`;
    this.progress.classList.add('show');
    this.progressTimer = setTimeout(() => this.progress.classList.remove('show'), 1500);
  }

  registerActions() {
    // get(): valore attuale 0..1 delle manopole, per il soft takeover della console
    const add = (id, label, kind, run, led, get) => this.actions.set(id, { label, kind, run, led, get });
    const mix = this.mixerUI.controls;
    const scale = (ctl, min, max) => (v) => ctl.set(min + v * (max - min));
    const knob = (id, label, ctl, min, max) => add(id, label, 'knob', scale(ctl, min, max), null, () => (ctl.getValue() - min) / (max - min));
    this.decks.forEach((d, i) => {
      const other = () => this.decks[1 - i];
      const X = d.id;
      const ui = this.deckUIs[i];
      const blinkPaused = () => d.playing || (d.loaded && Math.floor(performance.now() / 500) % 2 === 0);
      add(`${X}.play`, `Deck ${X}: Play/Pausa`, 'button', (on) => on && d.togglePlay(), blinkPaused);
      add(`${X}.cue`, `Deck ${X}: Cue`, 'button', (on) => (on ? d.cueDown() : d.cueUp()), () => d.loaded && !d.playing && Math.abs(d.position - d.cuePoint) < 0.02);
      add(`${X}.sync`, `Deck ${X}: Sync`, 'button', (on) => on && d.sync(other()), () => {
        const o = other();
        return Boolean(o.bpm && d.bpm && Math.abs(o.effectiveBpm - d.effectiveBpm) < 0.05);
      });
      add(`${X}.stutter`, `Deck ${X}: Riparti dal cue`, 'button', (on) => on && d.cuePlay());
      add(`${X}.rewind`, `Deck ${X}: Torna all'inizio`, 'button', (on) => on && d.rewind());
      add(`${X}.eject`, `Deck ${X}: Espelli il brano`, 'button', (on) => on && d.eject());
      add(`${X}.keySync`, `Deck ${X}: Allinea la tonalità all'altro deck`, 'button', (on) => on && d.keySync(other()), () => d.keyShift !== 0);
      // entry.arg = semitoni: keyShift li aggiunge (0 = tonalità originale), keySet li imposta, tonePlay riparte dall'hot cue
      add(`${X}.keyShift`, `Deck ${X}: Tonalità ± (semitoni)`, 'button', (on, _v, e) => {
        if (!on) return;
        const st = e && e.arg != null ? e.arg : 0;
        d.setKeyShift(st ? d.keyShift + st : 0);
      });
      add(`${X}.keySet`, `Deck ${X}: Imposta la tonalità (semitoni)`, 'button', (on, _v, e) => on && d.setKeyShift((e && e.arg) || 0),
        (e) => d.keyShift === ((e && e.arg) || 0) && d.keyShift !== 0);
      add(`${X}.tonePlay`, `Deck ${X}: TonePlay (pad)`, 'button', (on, _v, e) => on && d.tonePlay((e && e.arg) || 0),
        (e) => d.loaded && d.keyShift === ((e && e.arg) || 0));
      add(`${X}.keylock`, `Deck ${X}: Keylock`, 'button', (on) => on && d.setKeylock(!d.keylock), () => d.keylock);
      add(`${X}.slip`, `Deck ${X}: Slip`, 'button', (on) => on && d.setSlip(!d.slip), () => d.slip);
      add(`${X}.quantize`, `Deck ${X}: Quantize`, 'button', (on) => {
        if (!on) return;
        d.quantize = !d.quantize;
        d.emit('state');
      }, () => d.quantize);
      add(`${X}.vinyl`, `Deck ${X}: Modalità vinile (scratch)`, 'button', (on) => {
        if (!on) return;
        d.vinyl = !d.vinyl;
        d.emit('state');
      }, () => d.vinyl);
      add(`${X}.censor`, `Deck ${X}: Censor (tieni premuto)`, 'button', (on) => d.censor(on), () => d.reverse);
      // LED dell'hot cue: il suo colore (i pad RGB lo mostrano), spento se vuoto
      for (let h = 0; h < 8; h++) add(`${X}.hotcue${h + 1}`, `Deck ${X}: Hot cue ${h + 1}`, 'button', (on) => on && d.hotcue(h), () => (d.hotcues[h] != null ? HOTCUE_COLORS[h] : false));
      // pad con SHIFT: entry.arg = numero dell'hot cue da cancellare
      add(`${X}.hotcueClear`, `Deck ${X}: Cancella hot cue`, 'button', (on, _v, e) => on && d.deleteHotcue(((e && e.arg) || 1) - 1));
      add(`${X}.loop4`, `Deck ${X}: Loop 4 battute`, 'button', (on) => on && d.autoLoop(4), () => d.loop.active);
      add(`${X}.autoLoop`, `Deck ${X}: Loop on/off (dimensione dall'encoder)`, 'button', (on) => on && d.toggleAutoLoop(), () => d.loop.active);
      add(`${X}.loopSize`, `Deck ${X}: Dimensione loop (encoder)`, 'jog', (delta) => d.loopSizeStep(delta));
      add(`${X}.reloop`, `Deck ${X}: Reloop/Esci`, 'button', (on) => on && d.reloop(), () => d.loop.active);
      add(`${X}.loopHalf`, `Deck ${X}: Loop ÷2`, 'button', (on) => on && d.loopScale(0.5));
      add(`${X}.loopDouble`, `Deck ${X}: Loop ×2`, 'button', (on) => on && d.loopScale(2));
      // IN: punto di inizio; tenuto premuto avvia un loop di 4 battute da lì
      add(`${X}.loopIn`, `Deck ${X}: Loop in (tieni: loop 4 battute)`, 'button', (on) => {
        clearTimeout(d._loopInHold);
        if (!on) return;
        d.loopIn();
        d._loopInHold = setTimeout(() => d.loopFromIn(4), 600);
      });
      add(`${X}.loopOut`, `Deck ${X}: Loop out`, 'button', (on) => on && d.loopOut(), () => d.loop.active);
      // pad: entry.arg = battute (loop, roll), fetta 1–8 (slicer), salto in battute con segno (beat jump)
      add(`${X}.beatloop`, `Deck ${X}: Loop automatico (pad)`, 'button', (on, _v, e) => on && d.autoLoop((e && e.arg) || 4),
        (e) => d.loop.active && !d.rolling && d.loop.beats === ((e && e.arg) || 4));
      add(`${X}.roll`, `Deck ${X}: Loop roll (tieni premuto)`, 'button', (on, _v, e) => d.roll((e && e.arg) || 1, on),
        (e) => d.rolling === ((e && e.arg) || 1));
      add(`${X}.slice`, `Deck ${X}: Slicer (tieni premuto)`, 'button', (on, _v, e) => d.slice((e && e.arg) || 1, on),
        (e) => d.slicing === ((e && e.arg) || 1));
      add(`${X}.beatjump`, `Deck ${X}: Beat jump (pad)`, 'button', (on, _v, e) => on && d.beatJump((e && e.arg) || 4));
      add(`${X}.jumpBack`, `Deck ${X}: Beat jump indietro`, 'button', (on) => on && d.beatJump(-4));
      add(`${X}.jumpFwd`, `Deck ${X}: Beat jump avanti`, 'button', (on) => on && d.beatJump(4));
      add(`${X}.nudgeDown`, `Deck ${X}: Nudge −`, 'button', (on) => d.bend(on ? -4 : 0));
      add(`${X}.nudgeUp`, `Deck ${X}: Nudge +`, 'button', (on) => d.bend(on ? 4 : 0));
      add(`${X}.tempoReset`, `Deck ${X}: Azzera pitch`, 'button', (on) => on && ui.pitchFader.set(0));
      add(`${X}.pitch`, `Deck ${X}: Pitch fader`, 'knob', (v) => ui.pitchFader.set(v * 2 - 1), null, () => (ui.pitchFader.getValue() + 1) / 2);
      // entry.res = tick per giro dei jog "a impulsi" (Hercules): la velocità segue la mano
      add(`${X}.jog`, `Deck ${X}: Jog (bordo / bend)`, 'jog', (delta, e) => (e && e.res ? d.jogTicks(delta, e.res, false) : d.jogTurn(delta / 64)));
      add(`${X}.jogTouch`, `Deck ${X}: Jog touch (scratch)`, 'button', (on) => d.jogTouch(on));
      add(`${X}.jogSearch`, `Deck ${X}: Jog con SHIFT (ricerca veloce)`, 'jog', (delta, e) => d.jogSearch(delta, e && e.res));
      add(`${X}.jogScratch`, `Deck ${X}: Jog piatto (scratch)`, 'jog', (delta, e) => {
        if (e && e.res) {
          d.jogTicks(delta, e.res, true);
          return;
        }
        if (!d.scratching) {
          d.jogTurn(delta / 64);
          return;
        }
        d.jogScratch(delta * 0.8);
        clearTimeout(d._midiScratch);
        d._midiScratch = setTimeout(() => d.jogScratch(0), 40);
      });
      knob(`${X}.volume`, `Canale ${X}: Volume`, mix[X].vol, 0, 1);
      knob(`${X}.gain`, `Canale ${X}: Gain`, mix[X].gain, -12, 12);
      for (const band of ['high', 'mid', 'low']) knob(`${X}.eq.${band}`, `Canale ${X}: EQ ${band}`, mix[X].eq[band], -1, 1);
      knob(`${X}.filter`, `Canale ${X}: Filtro`, mix[X].filter, -1, 1);
      add(`${X}.pfl`, `Canale ${X}: Cuffia (PFL)`, 'button', (on) => on && mix[X].cue.click(), () => d.strip.cue);
      ui.fxBoxes.forEach((box, f) => {
        const c = box.fxControls;
        add(`${X}.fx${f + 1}.on`, `Deck ${X}: FX${f + 1} on/off`, 'button', (on) => on && c.onBtn.click(), () => c.slot.on);
        knob(`${X}.fx${f + 1}.mix`, `Deck ${X}: FX${f + 1} dry/wet`, c.wet, 0, 1);
        knob(`${X}.fx${f + 1}.param`, `Deck ${X}: FX${f + 1} parametro`, c.param, 0, 1);
      });
      add(`${X}.load`, `Deck ${X}: Carica brano selezionato`, 'button', (on) => on && this.loadTrack(this.library.selectedTracks()[0], X));
    });
    // interruttore del crossfader sulla console (es. Inpulse 500): escluso = crossfader al centro e fermo
    add('xfader', 'Crossfader', 'knob', (v) => !this.xfDisabled && this.engine.setCrossfader(v * 2 - 1), null, () => (this.engine.crossfader + 1) / 2);
    add('xfEnable', 'Crossfader abilitato (interruttore)', 'button', (on) => {
      this.xfDisabled = !on;
      if (!on) this.engine.setCrossfader(0);
    }, () => !this.xfDisabled);
    // selettore della curva sulla console: MIX / (lineare) / SCRATCH
    add('xfCurve', 'Curva crossfader (selettore)', 'knob', (v) => {
      const curve = v < 0.34 ? 'smooth' : v < 0.67 ? 'linear' : 'cut';
      this.settings.mixer.xfCurve = curve;
      this.engine.setCrossfaderCurve(curve);
      this.mixerUI.curveSel.value = curve;
      this.saveSettings();
    });
    knob('master', 'Volume master', this.mixerUI.masterKnob, 0, 1);
    knob('hpVolume', 'Volume cuffia', this.mixerUI.hpVolKnob, 0, 1);
    knob('cueMix', 'Cuffia: cue/master', this.mixerUI.cueMixKnob, 0, 1);
    add('vinylAll', 'Modalità vinile (entrambi i deck)', 'button', (on) => {
      if (!on) return;
      const v = !this.decks[0].vinyl;
      for (const d of this.decks) {
        d.vinyl = v;
        d.emit('state');
      }
    }, () => this.decks[0].vinyl);
    add('loadAuto', 'Libreria: carica sul deck libero', 'button', (on) => on && this.loadTrack(this.library.selectedTracks()[0]));
    add('mic', 'Microfono on air', 'button', (on) => on && this.mic.setOnAir(!this.mic.onAir), () => this.mic.onAir);
    add('automix', 'AI DJ on/off', 'button', (on) => on && this.automix.setEnabled(!this.automix.enabled), () => this.automix.enabled);
    add('view', 'Vista Console/AI', 'button', (on) => on && this.setView(this.view === 'ai' ? 'console' : 'ai'), () => this.view === 'ai');
    add('aiMixNow', 'AI DJ: mixa ora', 'button', (on) => on && this.automix.mixNow(), () => Boolean(this.automix.transition));
    add('aiSkip', 'AI DJ: cambia prossimo brano', 'button', (on) => on && this.automix.skipNext());
    add('record', 'Registrazione', 'button', (on) => on && this.toggleRecording(), () => this.engine.recording);
    for (let p = 0; p < 8; p++) add(`sampler${p + 1}`, `Sampler pad ${p + 1}`, 'button', (on) => on && this.sampler.trigger(p), () => Boolean(this.sampler.pads[p].source));
    add('samplerStop', 'Sampler: ferma il pad', 'button', (on, _v, e) => {
      if (!on) return;
      if (e && e.arg) this.sampler.stop(e.arg - 1);
      else this.sampler.stopAll();
    });
    const browse = (step) => (delta) => {
      const lib = this.library;
      const i = Math.max(0, Math.min(lib.rows.length - 1, lib.lastClicked + Math.sign(delta) * step));
      if (!lib.rows[i]) return;
      lib.selected = new Set([lib.rows[i].id]);
      lib.lastClicked = i;
      lib.viewport.scrollTop = Math.max(0, i * 26 - lib.viewport.clientHeight / 2);
      lib.renderRows();
    };
    add('browse', 'Libreria: scorri (encoder)', 'jog', browse(1));
    add('browseFast', 'Libreria: scorri veloce (10 righe)', 'jog', browse(10));
    const missing = knownActions().filter((id) => !this.actions.has(id));
    if (missing.length) console.warn('Azioni MIDI non registrate:', missing);
  }

  /**
   * Adatta la console allo spazio disponibile: su schermi bassi (es. MacBook 13") la riduce
   * in proporzione invece di farla sovrapporre alla libreria, che tiene sempre uno spazio minimo.
   */
  fitLayout() {
    const c = this.consoleEl;
    if (!c) return;
    c.style.zoom = '';
    if (this.view === 'ai') {
      document.body.classList.remove('compact');
      return;
    }
    const natural = c.scrollHeight;
    const topbar = 44;
    const minBottom = Math.max(210, window.innerHeight * 0.27);
    const available = window.innerHeight - topbar - this.wavesEl.offsetHeight - minBottom;
    const zoom = Math.max(0.68, Math.min(1, available / natural));
    if (zoom < 0.995) c.style.zoom = zoom.toFixed(3);
    document.body.classList.toggle('compact', zoom < 0.995);
  }

  installAutoFit() {
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        this.fitLayout();
      });
    };
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    schedule();
  }

  loop() {
    const frame = () => {
      if (this.gamepad) this.gamepad.poll();
      for (const s of this.scrollers) s.draw();
      if (this.view === 'ai') {
        this.aiView.frame();
      } else {
        for (const ui of this.deckUIs) ui.frame();
        this.mixerUI.frame();
      }
      if (this.engine.recording) this.recTime.textContent = formatTime((performance.now() - this.engine.recordStart) / 1000, false);
      const now = new Date();
      this.clock.textContent = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

const app = new App();
window.dj = app;
app.start().catch((err) => {
  console.error(err);
  document.getElementById('app').innerHTML = `<div class="fatal"><h1>Errore di avvio</h1><pre>${String(err && err.stack ? err.stack : err).replace(/</g, '&lt;')}</pre></div>`;
});
