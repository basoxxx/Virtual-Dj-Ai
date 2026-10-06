// Controller MIDI: riconoscimento automatico delle console, profili pronti, MIDI learn,
// procedura guidata, LED di ritorno e import/export delle mappature.
// Chiave messaggio: "note:<canale>:<nota>", "cc:<canale>:<numero>" oppure "pb:<canale>".
import { detectPreset, presetById, normalizeEntry, decodeRelative, WIZARD_STEPS } from './controllers/presets.js';

export class MidiManager extends EventTarget {
  constructor(actions) {
    super();
    this.actions = actions; // Map id -> { label, kind: 'button'|'knob'|'jog', run(value), led?() }
    this.access = null;
    this.mapping = {}; // mappature dell'utente (hanno la precedenza sui profili)
    this.presetMode = 'auto'; // 'auto' | 'none' | id del profilo
    this.learning = null;
    this.wizard = null;
    this.ledCache = new Map();
    this.initialized = new Set(); // porte di uscita a cui è già stato mandato l'avvio del profilo
    this.keepAliveAt = new Map(); // porta di uscita -> ultimo keep-alive mandato
    this.sysex = false;
    this.lastCc = new Map(); // "canale:numero" -> istante dell'ultimo CC (per riconoscere i fader a 14 bit)
    this.learnHold = 0; // durante la procedura guidata: ignora i messaggi fino a questo istante
    this.learnedKey = '';
    this.vuSource = null; // (deckId) => livello 0..1 per i VU della console
    this.guideSource = null; // (deckId) => { tempo, phase } per le spie della guida al beatmatch
    this.msb = new Map(); // fader a 14 bit: ultimo byte alto ricevuto per chiave
    this.absPrev = new Map(); // piatti a posizione assoluta: ultima posizione per chiave
    this.takeover = new Map(); // soft takeover: chiave -> { applied, hw }
    this.now = () => performance.now();
    this.supported = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async init(mapping = {}, presetMode = 'auto') {
    this.mapping = { ...mapping };
    this.presetMode = presetMode || 'auto';
    if (!this.supported) return false;
    // SysEx serve ad alcune console (es. Pioneer DDJ-400/FLX4: posizione dei controlli e keep-alive);
    // se il sistema lo nega si va avanti senza
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        console.warn('MIDI non disponibile', err);
        return false;
      }
    }
    this.bindInputs();
    this.access.onstatechange = () => {
      this.bindInputs();
      this.ledCache.clear();
      this.initialized.clear();
      this.dispatchEvent(new CustomEvent('devices'));
    };
    return true;
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  get outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  bindInputs() {
    for (const input of this.inputs) input.onmidimessage = (e) => this.onMessage(e.data, input);
  }

  /** Profilo applicato a una periferica. */
  presetFor(device) {
    if (this.presetMode === 'none') return null;
    // un profilo scelto a mano che non esiste più (es. diviso in più modelli) torna al riconoscimento automatico
    if (this.presetMode && this.presetMode !== 'auto' && presetById(this.presetMode)) return presetById(this.presetMode);
    return detectPreset(device && device.name);
  }

  setPresetMode(mode) {
    this.presetMode = mode;
    this.ledCache.clear();
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
    this.dispatchEvent(new CustomEvent('devices'));
  }

  /** Elenco delle periferiche collegate con il profilo riconosciuto. */
  devices() {
    return this.inputs.map((i) => ({ id: i.id, name: i.name, manufacturer: i.manufacturer, preset: this.presetFor(i) }));
  }

  static parse(data) {
    const [status, d1, d2 = 0] = data;
    const type = status & 0xf0;
    const ch = status & 0x0f;
    if (type === 0x90 || type === 0x80) {
      return { key: `note:${ch}:${d1}`, value: type === 0x90 && d2 > 0 ? d2 / 127 : 0, raw: d2, isNote: true };
    }
    if (type === 0xb0) return { key: `cc:${ch}:${d1}`, value: d2 / 127, raw: d2, isNote: false };
    if (type === 0xe0) return { key: `pb:${ch}`, value: ((d2 << 7) | d1) / 16383, raw: d2, isNote: false };
    return null;
  }

  /** Voce di mappatura per un messaggio: prima l'utente, poi il profilo della console. */
  resolve(key, device) {
    if (this.mapping[key]) return { ...normalizeEntry(this.mapping[key]), source: 'user' };
    const preset = this.presetFor(device);
    if (preset && preset.mapping[key]) return { ...normalizeEntry(preset.mapping[key]), source: 'preset' };
    return null;
  }

  onMessage(data, device = null) {
    const msg = MidiManager.parse(data);
    if (!msg) return;
    const now = this.now();
    let msbKey = '';
    if (!msg.isNote && msg.key.startsWith('cc:')) {
      const [, ch, n] = msg.key.split(':').map(Number);
      // fader a 14 bit (es. Hercules Inpulse, Pioneer DDJ): il CC n+32 subito dopo il CC n è la parte fine dello stesso fader
      if (n >= 32 && n < 64 && now - (this.lastCc.get(`${ch}:${n - 32}`) ?? -1e9) < 40) msbKey = `cc:${ch}:${n - 32}`;
      msg.burst = now - (this.lastCc.get(`${ch}:${n}`) ?? -1e9) < 250;
      this.lastCc.set(`${ch}:${n}`, now);
    }
    // byte basso dichiarato dal profilo su un CC qualsiasi (es. Denon MC7000: pitch su CC 9 + CC 119)
    const preset = this.presetFor(device);
    if (!msbKey && preset && preset.lsbOf && preset.lsbOf[msg.key]) msbKey = preset.lsbOf[msg.key];
    this.dispatchEvent(new CustomEvent('message', { detail: { ...msg, device: device && device.name } }));
    if (this.learning) {
      if (!msbKey && this.accepts(this.learning, msg, now)) this.assign(this.learning, msg);
      return;
    }
    if (msbKey && this.onLsb(msbKey, msg, device)) return;
    const entry = this.resolve(msg.key, device);
    const action = entry && this.actions.get(entry.a);
    if (!action) return;
    if (action.kind === 'button') {
      action.run(msg.value > 0, msg.value, entry);
    } else if (action.kind === 'jog') {
      const delta = entry.enc === 'abs7' ? this.absDelta(msg.key, msg.raw) : decodeRelative(msg.raw, entry.enc);
      if (delta) action.run(entry.invert ? -delta : delta, entry);
    } else {
      this.msb.set(msg.key, msg.raw);
      this.runKnob(msg.key, entry, action, msg.value);
    }
  }

  /**
   * Byte basso di un fader a 14 bit: valore fine (16384 passi) invece dei 128 del solo byte alto.
   * Vale per le voci marcate `hires` e per le correzioni fatte con Learn (che diventano a 14 bit da sole).
   * Restituisce false se il messaggio non è il byte basso di un fader mappato.
   */
  onLsb(msbKey, msg, device) {
    const entry = this.resolve(msbKey, device);
    const action = entry && this.actions.get(entry.a);
    if (!action || action.kind === 'button' || action.kind === 'jog') return false;
    if (!entry.hires && !entry.lsb && entry.source !== 'user') return false;
    if (!entry.hires && !entry.lsb) {
      this.mapping[msbKey] = { ...normalizeEntry(this.mapping[msbKey]), hires: true };
      this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
    }
    const msb = this.msb.get(msbKey);
    if (msb != null) this.runKnob(msbKey, entry, action, ((msb << 7) | msg.raw) / 16383);
    return true;
  }

  /**
   * Manopole e fader con "soft takeover": se il controllo nel programma è stato spostato da altro
   * (mouse, AI DJ, sync), la console lo riprende solo quando ci passa sopra, senza salti di volume o di tempo.
   */
  runKnob(key, entry, action, value) {
    const v = entry.invert ? 1 - value : value;
    if (!action.get) {
      action.run(v, entry);
      return;
    }
    const st = this.takeover.get(key);
    const cur = action.get();
    if (st && Math.abs(cur - st.applied) > 0.03) {
      const crossed = (st.hw - cur) * (v - cur) <= 0;
      if (Math.abs(v - cur) > 0.04 && !crossed) {
        st.hw = v;
        return;
      }
    }
    action.run(v, entry);
    this.takeover.set(key, { applied: action.get(), hw: v });
  }

  /**
   * Piatti che mandano una posizione assoluta a 7 bit che si riavvolge (es. Hercules Inpulse T7):
   * il movimento è la differenza con la lettura precedente.
   */
  absDelta(key, raw) {
    const prev = this.absPrev.get(key);
    this.absPrev.set(key, raw);
    if (prev == null) return 0;
    let d = (raw - prev) & 127;
    if (d === 64) return 0; // verso sconosciuto
    if (d > 64) d -= 128;
    return d;
  }

  /** Durante Learn/procedura guidata: il messaggio è adatto al controllo richiesto? */
  accepts(actionId, msg, now) {
    if (msg.isNote && msg.value === 0) return false;
    const action = this.actions.get(actionId);
    const kind = action ? action.kind : 'button';
    // una manopola, un fader o un jog non si mappano su un tasto (es. il touch del jog)
    if (kind !== 'button' && msg.isNote) return false;
    // un tasto mandato come CC vale 127 alla pressione; i messaggi a raffica sono jog o fader in movimento
    if (kind === 'button' && !msg.isNote && (msg.raw < 64 || msg.burst)) return false;
    if (this.wizard) {
      // il controllo appena appreso continua a mandare messaggi (fader, jog): non deve finire sul passo dopo
      if (now < this.learnHold || msg.key === this.learnedKey) return false;
    }
    return true;
  }

  assign(actionId, msg) {
    for (const [k, v] of Object.entries(this.mapping)) if (normalizeEntry(v).a === actionId) delete this.mapping[k];
    const action = this.actions.get(actionId);
    let entry = actionId;
    if (action && action.kind === 'jog' && !msg.isNote) {
      // gli encoder "rel64" mandano valori intorno a 64, gli altri intorno a 0/127
      entry = { a: actionId, enc: msg.raw > 48 && msg.raw < 80 ? 'rel64' : 'twos' };
    }
    this.mapping[msg.key] = entry;
    this.learning = null;
    this.learnedKey = msg.key;
    this.learnHold = this.now() + 600;
    this.dispatchEvent(new CustomEvent('learned', { detail: { id: actionId, key: msg.key } }));
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
    if (this.wizard) this.wizardNext();
  }

  learn(actionId) {
    this.learning = actionId;
    this.dispatchEvent(new CustomEvent('learning', { detail: actionId }));
  }

  cancelLearn() {
    this.learning = null;
    if (this.wizard) this.stopWizard();
    this.dispatchEvent(new CustomEvent('learning', { detail: null }));
  }

  clear(actionId) {
    for (const [k, v] of Object.entries(this.mapping)) if (normalizeEntry(v).a === actionId) delete this.mapping[k];
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
  }

  clearAll() {
    this.mapping = {};
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
  }

  /** Inverte il verso di un controllo appreso (manopole, fader, jog). */
  toggleInvert(actionId) {
    for (const [k, v] of Object.entries(this.mapping)) {
      const e = normalizeEntry(v);
      if (e.a === actionId) this.mapping[k] = { ...e, invert: !e.invert };
    }
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
  }

  userEntry(actionId) {
    for (const [k, v] of Object.entries(this.mapping)) {
      const e = normalizeEntry(v);
      if (e.a === actionId) return { key: k, ...e };
    }
    return null;
  }

  keyFor(actionId) {
    const u = this.userEntry(actionId);
    return u ? u.key : '';
  }

  /** Controllo del profilo attivo associato a un'azione (per mostrarlo nelle impostazioni). */
  presetKeyFor(actionId) {
    for (const input of this.inputs) {
      const p = this.presetFor(input);
      if (!p) continue;
      for (const [k, v] of Object.entries(p.mapping)) if (normalizeEntry(v).a === actionId) return k;
    }
    return '';
  }

  // --- procedura guidata -------------------------------------------------------------

  startWizard(steps = WIZARD_STEPS) {
    this.learnHold = 0;
    this.learnedKey = '';
    this.wizard = { steps: steps.filter((s) => this.actions.has(s)), index: -1 };
    this.wizardNext();
  }

  wizardNext() {
    const w = this.wizard;
    if (!w) return;
    w.index++;
    if (w.index >= w.steps.length) {
      this.stopWizard(true);
      return;
    }
    this.learning = w.steps[w.index];
    this.dispatchEvent(new CustomEvent('wizard', { detail: { index: w.index, total: w.steps.length, id: this.learning } }));
    this.dispatchEvent(new CustomEvent('learning', { detail: this.learning }));
  }

  skipWizardStep() {
    this.learnHold = 0;
    if (this.wizard) this.wizardNext();
  }

  stopWizard(done = false) {
    this.wizard = null;
    this.learning = null;
    this.dispatchEvent(new CustomEvent('wizard', { detail: { done, stopped: !done } }));
    this.dispatchEvent(new CustomEvent('learning', { detail: null }));
  }

  // --- LED di ritorno -------------------------------------------------------------------

  outputFor(input) {
    const outs = this.outputs;
    const exact = outs.find((o) => o.name === input.name);
    if (exact) return exact;
    const p = detectPreset(input.name);
    if (p) return outs.find((o) => detectPreset(o.name) === p) || null;
    const base = input.name.replace(/\s*(in|input|midi\s*\d*)\s*$/i, '').trim();
    return outs.find((o) => o.name.startsWith(base)) || null;
  }

  /** Accende/spegne le luci dei pulsanti della console in base allo stato del programma. */
  updateLeds() {
    for (const input of this.inputs) {
      const out = this.outputFor(input);
      if (!out) continue;
      const preset = this.presetFor(input);
      const send = (data) => {
        try {
          out.send(data);
        } catch {
          // porta chiusa
        }
      };
      if (preset && !this.initialized.has(out.id)) {
        this.initialized.add(out.id);
        for (const data of preset.init || []) if (data[0] !== 0xf0 || this.sysex) send(data);
      }
      // alcune console vogliono un messaggio periodico dal software, altrimenti passano in modalità demo
      if (preset && preset.keepAlive && this.sysex) {
        const now = this.now();
        const last = this.keepAliveAt.get(out.id) || 0;
        if (now - last >= preset.keepAlive.ms) {
          this.keepAliveAt.set(out.id, now);
          send(preset.keepAlive.msg);
        }
      }
      const ledOn = preset && preset.ledOn != null ? preset.ledOn : 0x7f;
      const ledOff = preset && preset.ledOff != null ? preset.ledOff : 0x00;
      const noLed = new Set(preset ? preset.noLed || [] : []);
      const entries = new Map();
      if (preset && preset.leds) {
        for (const [k, v] of Object.entries(preset.mapping)) if (!noLed.has(k)) entries.set(k, normalizeEntry(v));
        for (const o of preset.ledOut || []) if (o.key) entries.set(o.key, normalizeEntry(o));
        // LED con messaggi propri (es. Denon MC6000MK2: CC con il numero del LED nel terzo byte)
        (preset.ledOut || []).forEach((o, i) => {
          if (!o.on) return;
          const action = this.actions.get(o.a);
          if (!action || !action.led) return;
          const on = Boolean(action.led(normalizeEntry(o)));
          const cacheKey = `${out.id}|raw${i}`;
          if (this.ledCache.get(cacheKey) === on) return;
          this.ledCache.set(cacheKey, on);
          send(on ? o.on : o.off);
        });
      }
      for (const [k, v] of Object.entries(this.mapping)) entries.set(k, normalizeEntry(v));
      const sendNote = (key, value) => {
        const cacheKey = `${out.id}|${key}`;
        if (this.ledCache.get(cacheKey) === value) return;
        this.ledCache.set(cacheKey, value);
        const [, ch, n] = key.split(':').map(Number);
        send([0x90 | ch, n, value]);
      };
      for (const [key, entry] of entries) {
        if (!key.startsWith('note:')) continue;
        const action = this.actions.get(entry.a);
        if (!action || !action.led) continue;
        // led() può restituire un colore ("#rrggbb", es. hot cue) per le console con pad RGB
        const state = action.led(entry);
        const value = typeof state === 'string' ? (preset && preset.padColor ? preset.padColor(state) : ledOn) : state ? ledOn : ledOff;
        sendNote(key, value);
      }
      // guida al beatmatch: frecce di tempo e fase sui deck
      if (preset && preset.guide && this.guideSource) {
        for (const deckId of ['A', 'B']) {
          const g = preset.guide[deckId];
          if (!g) continue;
          const { tempo, phase } = this.guideSource(deckId) || {};
          sendNote(g.tooFast, tempo === 1 ? 0x7f : 0);
          sendNote(g.tooSlow, tempo === -1 ? 0x7f : 0);
          sendNote(g.tempoOk, tempo === 0 ? 0x7f : 0);
          sendNote(g.ahead, phase === 1 ? 0x7f : 0);
          sendNote(g.behind, phase === -1 ? 0x7f : 0);
          sendNote(g.phaseOk, phase === 0 ? 0x7f : 0);
        }
      }
      // VU dei canali sulla console
      if (preset && preset.vu && this.vuSource) {
        for (const deckId of ['A', 'B']) {
          const key = preset.vu[deckId];
          if (!key) continue;
          const value = Math.round(Math.max(0, Math.min(1, this.vuSource(deckId))) * preset.vu.max);
          const cacheKey = `${out.id}|${key}`;
          if (this.ledCache.get(cacheKey) === value) continue;
          this.ledCache.set(cacheKey, value);
          const [, ch, n] = key.split(':').map(Number);
          send([0xb0 | ch, n, value]);
        }
      }
    }
  }

  // --- import / export ------------------------------------------------------------------

  exportMapping(name = 'Mappatura personale') {
    return JSON.stringify({ format: 'virtual-dj-ai-midi', version: 1, name, presetMode: this.presetMode, mapping: this.mapping }, null, 2);
  }

  importMapping(text) {
    const data = JSON.parse(text);
    if (!data || data.format !== 'virtual-dj-ai-midi' || typeof data.mapping !== 'object') {
      throw new Error('File di mappatura non valido');
    }
    const clean = {};
    for (const [k, v] of Object.entries(data.mapping)) {
      const e = normalizeEntry(v);
      if (/^(note|cc):\d+:\d+$|^pb:\d+$/.test(k) && e && this.actions.has(e.a)) clean[k] = v;
    }
    this.mapping = clean;
    if (data.presetMode) this.presetMode = data.presetMode;
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
    return Object.keys(clean).length;
  }
}
