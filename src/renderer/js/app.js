// Avvio dell'applicazione e collegamento di motore audio, interfaccia, MIDI e tastiera.
import { api } from './api.js';
import { AudioEngine } from './audio/engine.js';
import { ChannelStrip } from './audio/mixer.js';
import { Deck } from './audio/deck.js';
import { Sampler } from './audio/sampler.js';
import { MicChannel } from './audio/mic.js';
import { MidiManager } from './midi.js';
import { AutoDJ } from './ai/autodj.js';
import { LocalLLM } from './ai/llm.js';
import { BatchAnalyzer } from './ai/batch-analyzer.js';
import { DeckUI } from './ui/deck-ui.js';
import { MixerUI } from './ui/mixer-ui.js';
import { LibraryUI } from './ui/library-ui.js';
import { SideUI } from './ui/side-ui.js';
import { ScrollingWaveform } from './ui/waveform.js';
import { openSettings } from './ui/settings-ui.js';
import { installKeyboard } from './keyboard.js';
import { el, button, toast } from './ui/controls.js';
import { formatTime } from './dsp/analysis.js';
import { knownActions } from './controllers/presets.js';
import { GamepadController } from './controllers/gamepad.js';
import { icon, withIcon } from './ui/icons.js';

const ACCENTS = ['#2ea8ff', '#ff6a3d'];

const DEFAULT_SETTINGS = {
  audio: { mode: 'single', masterDevice: '', headphoneDevice: '', micDevice: 'default', latency: 'interactive' },
  mixer: {
    xfCurve: 'smooth', autoGain: true, limiter: true, pitchRange: 8, keylock: false, quantize: true,
    vinyl: true, lockPlaying: true, brakeTime: 0, startTime: 0,
  },
  midi: { mapping: {}, preset: 'auto', gamepad: true },
  sampler: [],
  ai: {
    llm: false, provider: 'ollama', endpoint: 'http://localhost:11434', model: '', apiKey: '',
    autoAnalyze: true,
    options: {},
  },
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
    this.llm = new LocalLLM(() => this.settings.ai);
    this.analyzer = new BatchAnalyzer(this.engine.ctx);
    this.automix = new AutoDJ({
      engine: this.engine,
      decks: this.decks,
      getControls: () => this.mixerUI.controls,
      getPool: (source) => (source && source !== 'library' ? this.library.playlistTracks(source) : this.library.lib.tracks),
      llm: this.llm,
    });
    this.automix.setOptions(this.settings.ai.options || {});

    this.buildLayout();
    this.applyMixerSettings();
    try {
      await this.engine.applyRouting(this.settings.audio);
    } catch (err) {
      toast(`Uscita audio: ${err.message}`, 'error');
    }

    this.registerActions();
    this.midi = new MidiManager(this.actions);
    await this.midi.init(this.settings.midi.mapping, this.settings.midi.preset);
    this.gamepad = new GamepadController(this.actions);
    this.gamepad.enabled = this.settings.midi.gamepad !== false;
    this.gamepad.addEventListener('connected', (e) => {
      toast(`Gamepad collegato: ${e.detail}`);
      this.updateMidiBadge();
    });
    this.gamepad.addEventListener('disconnected', () => this.updateMidiBadge());
    setInterval(() => this.midi.updateLeds(), 100);
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
    this.progress = el('span', { class: 'progress' });
    this.engine.addEventListener('recording', (e) => {
      this.recBtn.setOn(e.detail);
      if (!e.detail) this.recTime.textContent = '';
    });
    const top = el('header', { class: 'topbar' },
      el('div', { class: 'logo' }, el('img', { class: 'logo-img', src: 'img/icon.png', alt: '' }), 'Virtual DJ ', el('b', {}, 'AI')),
      this.progress,
      el('div', { class: 'spacer' }),
      this.recBtn, this.recTime, this.automixBtn, this.midiBadge,
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
    this.deckUIs = this.decks.map((d, i) => new DeckUI(i === 0 ? deckA : deckB, d, {
      accent: ACCENTS[i],
      side: i === 0 ? 'left' : 'right',
      getOther: () => this.decks[1 - i],
      onRequestLoad: (e) => this.onDeckDrop(d, e),
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
    });
    this.sideUI = new SideUI(sideHost, {
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
      llm: this.llm,
      onAiOptions: (options) => {
        this.settings.ai.options = { ...options };
        this.saveSettings();
      },
      openAiSettings: () => this.openSettings('ai'),
    });
    this.library.addEventListener('changed', () => {
      this.sideUI.refreshSources();
      if (this.settings.ai.autoAnalyze && !this.analyzer.running) {
        clearTimeout(this.analyzeTimer);
        this.analyzeTimer = setTimeout(() => this.analyzer.run(this.library.lib.tracks), 3000);
      }
    });
    this.analyzer.addEventListener('progress', (e) => {
      const p = e.detail;
      if (p.running) this.showProgress({ label: 'Analisi AI', done: p.done, total: p.total });
      else this.library.renderRows();
    });
    const bottom = el('div', { class: 'bottom' }, libHost, sideHost);
    root.append(top, waves, middle, bottom);

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
        },
        sampler: this.sampler.serialize(),
        ai: this.settings.ai,
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
  }

  showProgress(p) {
    clearTimeout(this.progressTimer);
    this.progress.textContent = `${p.label}: ${p.done}/${p.total}`;
    this.progress.classList.add('show');
    this.progressTimer = setTimeout(() => this.progress.classList.remove('show'), 1500);
  }

  registerActions() {
    const add = (id, label, kind, run, led) => this.actions.set(id, { label, kind, run, led });
    const mix = this.mixerUI.controls;
    const scale = (ctl, min, max) => (v) => ctl.set(min + v * (max - min));
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
      add(`${X}.keylock`, `Deck ${X}: Keylock`, 'button', (on) => on && d.setKeylock(!d.keylock), () => d.keylock);
      add(`${X}.slip`, `Deck ${X}: Slip`, 'button', (on) => on && d.setSlip(!d.slip), () => d.slip);
      add(`${X}.censor`, `Deck ${X}: Censor (tieni premuto)`, 'button', (on) => d.censor(on), () => d.reverse);
      for (let h = 0; h < 8; h++) add(`${X}.hotcue${h + 1}`, `Deck ${X}: Hot cue ${h + 1}`, 'button', (on) => on && d.hotcue(h), () => d.hotcues[h] != null);
      add(`${X}.loop4`, `Deck ${X}: Loop 4 battute`, 'button', (on) => on && d.autoLoop(4), () => d.loop.active);
      add(`${X}.reloop`, `Deck ${X}: Reloop/Esci`, 'button', (on) => on && d.reloop(), () => d.loop.active);
      add(`${X}.loopHalf`, `Deck ${X}: Loop ÷2`, 'button', (on) => on && d.loopScale(0.5));
      add(`${X}.loopDouble`, `Deck ${X}: Loop ×2`, 'button', (on) => on && d.loopScale(2));
      add(`${X}.loopIn`, `Deck ${X}: Loop in`, 'button', (on) => on && d.loopIn());
      add(`${X}.loopOut`, `Deck ${X}: Loop out`, 'button', (on) => on && d.loopOut());
      add(`${X}.jumpBack`, `Deck ${X}: Beat jump indietro`, 'button', (on) => on && d.beatJump(-4));
      add(`${X}.jumpFwd`, `Deck ${X}: Beat jump avanti`, 'button', (on) => on && d.beatJump(4));
      add(`${X}.nudgeDown`, `Deck ${X}: Nudge −`, 'button', (on) => d.bend(on ? -4 : 0));
      add(`${X}.nudgeUp`, `Deck ${X}: Nudge +`, 'button', (on) => d.bend(on ? 4 : 0));
      add(`${X}.tempoReset`, `Deck ${X}: Azzera pitch`, 'button', (on) => on && ui.pitchFader.set(0));
      add(`${X}.pitch`, `Deck ${X}: Pitch fader`, 'knob', (v) => ui.pitchFader.set(v * 2 - 1));
      add(`${X}.jog`, `Deck ${X}: Jog (bordo / bend)`, 'jog', (delta) => d.jogTurn(delta / 64));
      add(`${X}.jogTouch`, `Deck ${X}: Jog touch (scratch)`, 'button', (on) => d.jogTouch(on));
      add(`${X}.jogScratch`, `Deck ${X}: Jog piatto (scratch)`, 'jog', (delta) => {
        if (!d.scratching) {
          d.jogTurn(delta / 64);
          return;
        }
        d.jogScratch(delta * 0.8);
        clearTimeout(d._midiScratch);
        d._midiScratch = setTimeout(() => d.jogScratch(0), 40);
      });
      add(`${X}.volume`, `Canale ${X}: Volume`, 'knob', scale(mix[X].vol, 0, 1));
      add(`${X}.gain`, `Canale ${X}: Gain`, 'knob', scale(mix[X].gain, -12, 12));
      for (const band of ['high', 'mid', 'low']) add(`${X}.eq.${band}`, `Canale ${X}: EQ ${band}`, 'knob', scale(mix[X].eq[band], -1, 1));
      add(`${X}.filter`, `Canale ${X}: Filtro`, 'knob', scale(mix[X].filter, -1, 1));
      add(`${X}.pfl`, `Canale ${X}: Cuffia (PFL)`, 'button', (on) => on && mix[X].cue.click(), () => d.strip.cue);
      ui.fxBoxes.forEach((box, f) => {
        const c = box.fxControls;
        add(`${X}.fx${f + 1}.on`, `Deck ${X}: FX${f + 1} on/off`, 'button', (on) => on && c.onBtn.click(), () => c.slot.on);
        add(`${X}.fx${f + 1}.mix`, `Deck ${X}: FX${f + 1} dry/wet`, 'knob', scale(c.wet, 0, 1));
        add(`${X}.fx${f + 1}.param`, `Deck ${X}: FX${f + 1} parametro`, 'knob', scale(c.param, 0, 1));
      });
      add(`${X}.load`, `Deck ${X}: Carica brano selezionato`, 'button', (on) => on && this.loadTrack(this.library.selectedTracks()[0], X));
    });
    add('xfader', 'Crossfader', 'knob', (v) => this.engine.setCrossfader(v * 2 - 1));
    add('master', 'Volume master', 'knob', scale(this.mixerUI.masterKnob, 0, 1));
    add('hpVolume', 'Volume cuffia', 'knob', scale(this.mixerUI.hpVolKnob, 0, 1));
    add('cueMix', 'Cuffia: cue/master', 'knob', scale(this.mixerUI.cueMixKnob, 0, 1));
    add('mic', 'Microfono on air', 'button', (on) => on && this.mic.setOnAir(!this.mic.onAir), () => this.mic.onAir);
    add('automix', 'AI DJ on/off', 'button', (on) => on && this.automix.setEnabled(!this.automix.enabled), () => this.automix.enabled);
    add('aiMixNow', 'AI DJ: mixa ora', 'button', (on) => on && this.automix.mixNow(), () => Boolean(this.automix.transition));
    add('aiSkip', 'AI DJ: cambia prossimo brano', 'button', (on) => on && this.automix.skipNext());
    add('record', 'Registrazione', 'button', (on) => on && this.toggleRecording(), () => this.engine.recording);
    for (let p = 0; p < 8; p++) add(`sampler${p + 1}`, `Sampler pad ${p + 1}`, 'button', (on) => on && this.sampler.trigger(p), () => Boolean(this.sampler.pads[p].source));
    add('browse', 'Libreria: scorri (encoder)', 'jog', (delta) => {
      const lib = this.library;
      const i = Math.max(0, Math.min(lib.rows.length - 1, lib.lastClicked + Math.sign(delta)));
      if (!lib.rows[i]) return;
      lib.selected = new Set([lib.rows[i].id]);
      lib.lastClicked = i;
      lib.viewport.scrollTop = Math.max(0, i * 26 - lib.viewport.clientHeight / 2);
      lib.renderRows();
    });
    const missing = knownActions().filter((id) => !this.actions.has(id));
    if (missing.length) console.warn('Azioni MIDI non registrate:', missing);
  }

  loop() {
    const frame = () => {
      if (this.gamepad) this.gamepad.poll();
      for (const s of this.scrollers) s.draw();
      for (const ui of this.deckUIs) ui.frame();
      this.mixerUI.frame();
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
