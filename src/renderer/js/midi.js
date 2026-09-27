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
    this.supported = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async init(mapping = {}, presetMode = 'auto') {
    this.mapping = { ...mapping };
    this.presetMode = presetMode || 'auto';
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      console.warn('MIDI non disponibile', err);
      return false;
    }
    this.bindInputs();
    this.access.onstatechange = () => {
      this.bindInputs();
      this.ledCache.clear();
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
    if (this.presetMode && this.presetMode !== 'auto') return presetById(this.presetMode);
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
    this.dispatchEvent(new CustomEvent('message', { detail: { ...msg, device: device && device.name } }));
    if (this.learning) {
      if (msg.isNote && msg.value === 0) return;
      this.assign(this.learning, msg);
      return;
    }
    const entry = this.resolve(msg.key, device);
    const action = entry && this.actions.get(entry.a);
    if (!action) return;
    if (action.kind === 'button') {
      action.run(msg.value > 0, msg.value);
    } else if (action.kind === 'jog') {
      const delta = decodeRelative(msg.raw, entry.enc);
      if (delta) action.run(entry.invert ? -delta : delta);
    } else {
      action.run(entry.invert ? 1 - msg.value : msg.value);
    }
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
      const entries = [];
      if (preset && preset.leds) for (const [k, v] of Object.entries(preset.mapping)) entries.push([k, normalizeEntry(v).a]);
      for (const [k, v] of Object.entries(this.mapping)) entries.push([k, normalizeEntry(v).a]);
      for (const [key, actionId] of entries) {
        if (!key.startsWith('note:')) continue;
        const action = this.actions.get(actionId);
        if (!action || !action.led) continue;
        const on = Boolean(action.led());
        const cacheKey = `${out.id}|${key}`;
        if (this.ledCache.get(cacheKey) === on) continue;
        this.ledCache.set(cacheKey, on);
        const [, ch, n] = key.split(':').map(Number);
        try {
          out.send([0x90 | ch, n, on ? 0x7f : 0x00]);
        } catch {
          // porta chiusa
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
