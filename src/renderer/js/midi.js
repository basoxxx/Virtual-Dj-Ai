// Controller MIDI: rilevamento dispositivi, MIDI learn e mappature salvate.
// Chiave messaggio: "note:<canale>:<nota>" oppure "cc:<canale>:<numero>".

export class MidiManager extends EventTarget {
  constructor(actions) {
    super();
    this.actions = actions; // Map id -> { label, kind: 'button'|'knob'|'jog', run(value) }
    this.access = null;
    this.mapping = {};
    this.learning = null;
    this.supported = typeof navigator.requestMIDIAccess === 'function';
  }

  async init(mapping = {}) {
    this.mapping = { ...mapping };
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
      this.dispatchEvent(new CustomEvent('devices'));
    };
    return true;
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  bindInputs() {
    for (const input of this.inputs) input.onmidimessage = (e) => this.onMessage(e.data);
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

  onMessage(data) {
    const msg = MidiManager.parse(data);
    if (!msg) return;
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    if (this.learning) {
      if (msg.isNote && msg.value === 0) return;
      for (const [k, v] of Object.entries(this.mapping)) if (v === this.learning) delete this.mapping[k];
      this.mapping[msg.key] = this.learning;
      const id = this.learning;
      this.learning = null;
      this.dispatchEvent(new CustomEvent('learned', { detail: { id, key: msg.key } }));
      this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
      return;
    }
    const actionId = this.mapping[msg.key];
    const action = actionId && this.actions.get(actionId);
    if (!action) return;
    if (action.kind === 'button') {
      action.run(msg.value > 0, msg.value);
    } else if (action.kind === 'jog') {
      // encoder relativo: 1..63 avanti, 65..127 indietro
      const delta = msg.raw < 64 ? msg.raw : msg.raw - 128;
      action.run(delta);
    } else {
      action.run(msg.value);
    }
  }

  learn(actionId) {
    this.learning = actionId;
    this.dispatchEvent(new CustomEvent('learning', { detail: actionId }));
  }

  cancelLearn() {
    this.learning = null;
    this.dispatchEvent(new CustomEvent('learning', { detail: null }));
  }

  clear(actionId) {
    for (const [k, v] of Object.entries(this.mapping)) if (v === actionId) delete this.mapping[k];
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
  }

  keyFor(actionId) {
    return Object.keys(this.mapping).find((k) => this.mapping[k] === actionId) || '';
  }
}
