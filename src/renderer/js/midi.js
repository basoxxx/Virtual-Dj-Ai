// Controller MIDI: riconoscimento automatico delle console, profili pronti, MIDI learn,
// procedura guidata, LED di ritorno e import/export delle mappature.
// Chiave messaggio: "note:<canale>:<nota>", "cc:<canale>:<numero>" oppure "pb:<canale>".
import { detectPreset, presetById, normalizeEntry, decodeRelative, WIZARD_STEPS } from './controllers/presets.js';

// fader a 14 bit: il byte basso arriva entro pochi millisecondi dal byte alto (di solito nello stesso pacchetto USB)
const LSB_WINDOW_MS = 40;
// una correzione fatta con Learn diventa a 14 bit solo con il byte basso subito dopo il byte alto, per qualche volta di fila
const LSB_TIGHT_MS = 5;
const LEARN_HIRES_PAIRS = 4;
const VALID_KEY = /^(note|cc):\d+:\d+$|^pb:\d+$/;
// porte MIDI virtuali del sistema (Linux, macOS, Windows): non sono console, niente avvisi
const VIRTUAL_PORT = /\bthrough\b|^iac\b|loopmidi|network session|rtpmidi/i;

const errText = (err) => (err && err.message ? err.message : String(err));

/** Divide le mappature dell'utente in valide e scartate (chiave non valida o azione che non esiste). */
export function cleanMapping(mapping, actions) {
  const clean = {};
  const dropped = {};
  for (const [k, v] of Object.entries(mapping && typeof mapping === 'object' ? mapping : {})) {
    const e = normalizeEntry(v);
    if (VALID_KEY.test(k) && e && actions.has(e.a)) clean[k] = v;
    else dropped[k] = v;
  }
  return { clean, dropped };
}

/** Modo dei profili valido: automatico, nessuno o un profilo che esiste ancora. */
export function validPresetMode(mode) {
  return mode === 'auto' || mode === 'none' || Boolean(presetById(mode));
}

/**
 * Prima volta con un profilo (o con una sua versione corretta): le correzioni fatte a mano servivano a tappare
 * gli errori della versione vecchia, quindi si mettono da parte, senza perdere quelle messe da parte prima
 * (per lo stesso controllo o la stessa azione vincono le più recenti). Non modifica gli argomenti:
 * restituisce null se non c'è niente da fare, altrimenti { presetRevs, backup, moved } (moved: le correzioni attuali vanno tolte).
 */
export function migrateMapping(settingsMidi, mapping, preset) {
  const revs = (settingsMidi && settingsMidi.presetRevs) || {};
  if ((revs[preset.id] || 0) >= preset.rev) return null;
  const presetRevs = { ...revs, [preset.id]: preset.rev };
  const prev = (settingsMidi && settingsMidi.backup) || null;
  const current = mapping || {};
  if (!(preset.rev > 1) || !Object.keys(current).length) return { presetRevs, backup: prev, moved: false };
  const actionOf = (v) => (normalizeEntry(v) || {}).a;
  const newer = new Set(Object.values(current).map(actionOf));
  const kept = Object.entries(prev || {}).filter(([k, v]) => !(k in current) && !newer.has(actionOf(v)));
  return { presetRevs, backup: { ...Object.fromEntries(kept), ...current }, moved: true };
}

/** Esegue action.run(...args): un errore, anche di una promessa, va a onError invece di perdersi. */
export function runAction(action, args, onError) {
  try {
    const res = action.run(...args);
    if (res && typeof res.then === 'function') res.then(null, onError);
  } catch (err) {
    onError(err);
  }
}

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
    this.pairs = new Map(); // byte alto -> { open, streak }: coppie byte alto + byte basso di fila (correzioni con Learn)
    this.absPrev = new Map(); // piatti a posizione assoluta: ultima posizione per chiave
    this.takeover = new Map(); // soft takeover: chiave -> { applied, hw }
    this.error = ''; // perché il MIDI non è disponibile (permesso negato, sistema senza MIDI)
    this.discarded = {}; // mappature salvate scartate all'avvio (azione sconosciuta o chiave non valida)
    this.presetMissing = ''; // profilo scelto a mano che non esiste più (all'avvio si torna all'automatico)
    this.reported = new Set(); // problemi già segnalati all'utente (evento 'error')
    this.opening = new Set(); // porte di ingresso già aperte o in apertura
    this.noOutputSince = new Map(); // console con profilo senza porta di uscita -> da quando
    this.present = new Set(); // nomi delle console collegate (per gli avvisi)
    this.lost = new Set(); // console scollegate durante la sessione
    this.now = () => performance.now();
    this.supported = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async init(mapping = {}, presetMode = 'auto') {
    // voci con un'azione che non esiste più non devono oscurare il profilo: l'app le mette da parte
    const { clean, dropped } = cleanMapping(mapping, this.actions);
    this.mapping = clean;
    this.discarded = dropped;
    // un profilo scelto a mano che non esiste più (es. diviso in più modelli) torna al riconoscimento automatico
    const mode = presetMode || 'auto';
    this.presetMissing = validPresetMode(mode) ? '' : mode;
    this.presetMode = this.presetMissing ? 'auto' : mode;
    if (!this.supported) {
      this.error = 'questo sistema non supporta il MIDI';
      return false;
    }
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
        this.error = errText(err);
        return false;
      }
    }
    this.error = '';
    this.bindInputs();
    this.access.onstatechange = (e) => this.onStateChange(e);
    return true;
  }

  onStateChange(e) {
    const port = e && e.port;
    // scollegata: quando torna si riapre la porta e un eventuale errore si dice di nuovo
    if (port && port.state === 'disconnected') {
      this.opening.delete(port.id);
      this.reported.delete(`open|${port.id}`);
    }
    this.bindInputs();
    this.ledCache.clear();
    this.initialized.clear();
    this.dispatchEvent(new CustomEvent('devices'));
  }

  // alcune versioni di Chrome lasciano nell'elenco le porte scollegate
  get inputs() {
    return this.access ? [...this.access.inputs.values()].filter((p) => p.state !== 'disconnected') : [];
  }

  get outputs() {
    return this.access ? [...this.access.outputs.values()].filter((p) => p.state !== 'disconnected') : [];
  }

  bindInputs() {
    for (const input of this.inputs) {
      input.onmidimessage = (e) => this.onMessage(e.data, input);
      // onmidimessage apre la porta da solo ma senza dire se non ci riesce (su Windows un altro programma DJ
      // aperto, anche in background, tiene la console in esclusiva): la si apre qui per saperlo
      if (input.connection === 'open' || typeof input.open !== 'function' || this.opening.has(input.id)) continue;
      this.opening.add(input.id);
      input.open().catch((err) => {
        this.report(`open|${input.id}`, `La console "${input.name}" non si apre (${errText(err)}): se è aperto un altro programma DJ (DJUCED, rekordbox, Serato, VirtualDJ…) chiudilo, anche dall'area di notifica, poi scollega e ricollega la console`, err);
      });
    }
  }

  /** Problema da mostrare all'utente (evento 'error'), una volta sola per chiave: non deve ripetersi a ogni messaggio. */
  report(key, text, err) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    console.warn(text, err || '');
    this.dispatchEvent(new CustomEvent('error', { detail: text }));
  }

  /** Esegue il comando di un controllo: se dà errore (anche dopo, in una promessa) lo si dice una volta e la console continua. */
  exec(id, action, ...args) {
    runAction(action, args, (err) => this.report(`run|${id}`, `Comando «${action.label || id}» dalla console non riuscito: ${errText(err)}`, err));
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

  /** Elenco delle periferiche collegate con il profilo riconosciuto (virtual = porta MIDI del sistema, non una console). */
  devices() {
    return this.inputs.map((i) => ({ id: i.id, name: i.name, manufacturer: i.manufacturer, preset: this.presetFor(i), virtual: VIRTUAL_PORT.test(i.name || '') }));
  }

  /**
   * Avvisi da mostrare quando cambiano le periferiche: console riconosciuta, collegata ma senza profilo
   * (non farebbe niente), profilo scelto a mano diverso da quello riconosciuto, scollegata e ricollegata.
   * Ogni console si annuncia una volta per nome; restituisce [{ type: 'ok'|'info'|'warn', text }].
   */
  deviceNotices() {
    const notes = [];
    const names = new Set();
    for (const input of this.inputs) {
      const name = input.name || 'Periferica MIDI';
      if (VIRTUAL_PORT.test(name)) continue;
      names.add(name);
      if (this.present.has(name)) continue;
      this.present.add(name);
      if (this.lost.delete(name)) {
        notes.push({ type: 'ok', text: `Console "${name}" ricollegata` });
        continue;
      }
      const preset = this.presetFor(input);
      const detected = detectPreset(name);
      if (preset && this.presetMode === 'auto') {
        notes.push({ type: 'ok', text: `Console riconosciuta: ${preset.brand} ${preset.name}` });
      } else if (preset && detected && detected !== preset) {
        notes.push({ type: 'warn', text: `"${name}" usa il profilo scelto a mano ${preset.brand} ${preset.name}, ma sembra una ${detected.brand} ${detected.name}: se i comandi non rispondono scegli "Automatico" (Impostazioni → Console DJ)` });
      } else if (preset) {
        notes.push({ type: 'info', text: `Console "${name}": profilo scelto a mano ${preset.brand} ${preset.name}` });
      } else if (this.presetMode === 'auto' && !Object.keys(this.mapping).length) {
        notes.push({ type: 'warn', text: `"${name}" è collegata ma non ha un profilo: configurala con la procedura guidata (Impostazioni → Console DJ)` });
      }
    }
    for (const name of this.present) {
      if (names.has(name)) continue;
      this.present.delete(name);
      this.lost.add(name);
      notes.push({ type: 'warn', text: `Console "${name}" scollegata` });
    }
    return notes;
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

  /** Voce di mappatura per un messaggio: prima l'utente (se l'azione esiste), poi il profilo della console. */
  resolve(key, device) {
    const user = normalizeEntry(this.mapping[key]);
    if (user && this.actions.has(user.a)) return { ...user, source: 'user' };
    const preset = this.presetFor(device);
    if (preset && preset.mapping[key]) return { ...normalizeEntry(preset.mapping[key]), source: 'preset' };
    return null;
  }

  onMessage(data, device = null) {
    const msg = MidiManager.parse(data);
    if (!msg) {
      this.onUnsupported(data, device);
      return;
    }
    const now = this.now();
    let msbKey = '';
    let lsbGap = Infinity;
    if (!msg.isNote && msg.key.startsWith('cc:')) {
      const [, ch, n] = msg.key.split(':').map(Number);
      // fader a 14 bit (es. Hercules Inpulse, Pioneer DDJ): il CC n+32 subito dopo il CC n è la parte fine dello stesso fader
      if (n >= 32 && n < 64) {
        lsbGap = now - (this.lastCc.get(`${ch}:${n - 32}`) ?? -1e9);
        if (lsbGap < LSB_WINDOW_MS) msbKey = `cc:${ch}:${n - 32}`;
      } else if (n < 32) {
        // byte alto arrivato senza byte basso dopo il precedente: la serie di coppie riparte da zero
        const p = this.pairs.get(msg.key) || { open: false, streak: 0 };
        if (p.open) p.streak = 0;
        p.open = true;
        this.pairs.set(msg.key, p);
      }
      msg.burst = now - (this.lastCc.get(`${ch}:${n}`) ?? -1e9) < 250;
      this.lastCc.set(`${ch}:${n}`, now);
    }
    // byte basso dichiarato dal profilo su un CC qualsiasi (es. Denon MC7000: pitch su CC 9 + CC 119)
    const preset = this.presetFor(device);
    let declared = false; // coppia dichiarata dal profilo: vale anche per le correzioni fatte con Learn su quel fader
    if (!msbKey && preset && preset.lsbOf && preset.lsbOf[msg.key]) {
      msbKey = preset.lsbOf[msg.key];
      declared = true;
    }
    // un CC che comanda già un'altra azione (dell'utente o del profilo) non è mai il byte basso di un fader
    // (es. Behringer CMD MM-1: EQ basse sul CC 16 e volume sul CC 48, mossi insieme)
    if (msbKey) {
      const own = this.resolve(msg.key, device);
      if (own && this.actions.has(own.a)) msbKey = '';
    }
    this.dispatchEvent(new CustomEvent('message', { detail: { ...msg, device: device && device.name } }));
    if (this.learning) {
      if (msbKey) return; // byte basso del fader appena mosso
      const ok = this.accepts(this.learning, msg, now);
      if (ok === true) this.assign(this.learning, msg);
      else if (ok) this.dispatchEvent(new CustomEvent('rejected', { detail: { id: this.learning, key: msg.key, reason: ok } }));
      return;
    }
    if (msbKey && this.onLsb(msbKey, msg, device, lsbGap, declared)) return;
    const entry = this.resolve(msg.key, device);
    const action = entry && this.actions.get(entry.a);
    if (!action) return;
    try {
      if (action.kind === 'button') {
        this.exec(entry.a, action, msg.value > 0, msg.value, entry);
      } else if (action.kind === 'jog') {
        const delta = entry.enc === 'abs7' ? this.absDelta(msg.key, msg.raw) : decodeRelative(msg.raw, entry.enc);
        if (delta) this.exec(entry.a, action, entry.invert ? -delta : delta, entry);
      } else {
        this.msb.set(msg.key, msg.raw);
        this.runKnob(msg.key, entry, action, msg.value);
      }
    } catch (err) {
      // es. action.get() del soft takeover
      this.report(`run|${entry.a}`, `Comando «${action.label || entry.a}» dalla console non riuscito: ${errText(err)}`, err);
    }
  }

  /**
   * Program Change, Aftertouch e Channel Pressure non comandano niente: il monitor li mostra comunque
   * e durante Learn si dice perché il controllo non viene preso. SysEx e messaggi di sistema (clock,
   * risposte al keep-alive) no: arrivano di continuo e coprirebbero i messaggi dei controlli.
   */
  onUnsupported(data, device) {
    const status = data[0];
    if (!(status >= 0x80 && status < 0xf0)) return;
    const raw = Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    this.dispatchEvent(new CustomEvent('message', { detail: { key: 'non supportato', raw, device: device && device.name } }));
    if (this.learning) {
      const reason = 'questo controllo manda un messaggio che Segueo non usa (Program Change o Aftertouch): provane un altro o cambia la sua modalità dal software della console';
      this.dispatchEvent(new CustomEvent('rejected', { detail: { id: this.learning, key: 'non supportato', reason } }));
    }
  }

  /**
   * Byte basso di un fader a 14 bit: valore fine (16384 passi) invece dei 128 del solo byte alto.
   * Vale per le voci marcate `hires`, per i byte bassi dichiarati dal profilo (`declared`, es. CC 119 del pitch
   * del Denon MC7000, anche se la voce è stata ri-appresa con Learn) e per le correzioni fatte con Learn
   * (che diventano a 14 bit da sole). Restituisce false se il messaggio non è il byte basso di un fader mappato.
   */
  onLsb(msbKey, msg, device, gap = Infinity, declared = false) {
    const entry = this.resolve(msbKey, device);
    const action = entry && this.actions.get(entry.a);
    if (!action || action.kind === 'button' || action.kind === 'jog') return false;
    if (!entry.hires && !entry.lsb && !declared) {
      // correzione fatta con Learn: diventa a 14 bit solo se il byte basso arriva subito dopo il byte alto
      // per qualche volta di fila, non per un altro controllo mosso per caso nello stesso momento
      if (entry.source !== 'user' || !(gap < LSB_TIGHT_MS)) return false;
      const p = this.pairs.get(msbKey);
      if (!p || !p.open) return false;
      p.open = false;
      if (++p.streak < LEARN_HIRES_PAIRS) return false;
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
      this.exec(entry.a, action, v, entry);
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
    this.exec(entry.a, action, v, entry);
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

  /**
   * Durante Learn/procedura guidata: il messaggio è adatto al controllo richiesto?
   * true = sì; false = no, in silenzio (rilascio di un tasto, controllo appena appreso che si muove ancora);
   * una frase = no, e la frase dice all'utente cosa muovere invece.
   */
  accepts(actionId, msg, now) {
    if (msg.isNote && msg.value === 0) return false;
    if (this.wizard) {
      // il controllo appena appreso continua a mandare messaggi (fader, jog): non deve finire sul passo dopo
      if (now < this.learnHold || msg.key === this.learnedKey) return false;
    }
    const action = this.actions.get(actionId);
    const kind = action ? action.kind : 'button';
    const label = (action && action.label) || actionId;
    // una manopola, un fader o un jog non si mappano su un tasto (es. il touch del jog)
    if (kind !== 'button' && msg.isNote) return `hai premuto un pulsante: per «${label}» ${kind === 'jog' ? 'gira il jog o l\'encoder' : 'muovi un fader o una manopola'}`;
    // un tasto mandato come CC vale 127 alla pressione (0 al rilascio); i messaggi a raffica sono jog o fader in movimento
    if (kind === 'button' && !msg.isNote && (msg.raw < 64 || msg.burst)) {
      return msg.raw === 0 && !msg.burst ? false : `hai mosso un fader o una manopola: per «${label}» premi un pulsante`;
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
      const preset = this.presetFor(input);
      const unreachable = (why) => this.report(`out|${input.name}`, `La console "${input.name}" non riceve i messaggi di Segueo (${why}): luci e modalità demo potrebbero non funzionare`);
      if (!out) {
        // le porte di ingresso e di uscita compaiono una alla volta: si avvisa solo se manca ancora dopo un attimo
        if (preset && (preset.leds || preset.init.length || preset.keepAlive || preset.vu)) {
          const since = this.noOutputSince.get(input.id) ?? this.now();
          this.noOutputSince.set(input.id, since);
          if (this.now() - since > 2000) unreachable('nessuna porta di uscita MIDI con un nome simile');
        }
        continue;
      }
      this.noOutputSince.delete(input.id);
      if (preset && !this.sysex && (preset.keepAlive || preset.init.some((d) => d[0] === 0xf0))) {
        unreachable('il sistema non ha concesso i messaggi SysEx: avvio e keep-alive non partono');
      }
      const send = (data) => {
        try {
          out.send(data);
        } catch (err) {
          // porta appena chiusa o console scollegata in quel momento: si riprova al giro dopo
          if (err && err.name === 'InvalidStateError') return;
          // messaggio non valido nel profilo, SysEx non permesso…: una volta per porta e tipo di errore
          this.report(`send|${out.id}|${err && err.name}`, `La console "${input.name}" non accetta un messaggio di Segueo (${errText(err)}): luci e modalità demo potrebbero non funzionare`, err);
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

  /**
   * Importa una mappatura esportata: la sostituisce a quella attuale solo se contiene almeno un controllo valido.
   * Restituisce { count, dropped, presetIgnored } (controlli importati, scartati, profilo del file sconosciuto).
   */
  importMapping(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Il file non è una mappatura di Segueo: il JSON non è leggibile');
    }
    if (!data || data.format !== 'virtual-dj-ai-midi' || !data.mapping || typeof data.mapping !== 'object') {
      throw new Error('File di mappatura non valido');
    }
    const { clean, dropped } = cleanMapping(data.mapping, this.actions);
    const count = Object.keys(clean).length;
    const nDropped = Object.keys(dropped).length;
    if (!count) {
      throw new Error(nDropped
        ? `Nessun controllo valido nel file (${nDropped} con comandi sconosciuti o messaggi non validi): la mappatura attuale resta com'è`
        : 'Nessun controllo nel file: la mappatura attuale resta com\'è');
    }
    this.mapping = clean;
    const presetIgnored = data.presetMode != null && !validPresetMode(data.presetMode);
    if (data.presetMode != null && !presetIgnored) this.presetMode = data.presetMode;
    this.dispatchEvent(new CustomEvent('mapping', { detail: this.mapping }));
    return { count, dropped: nDropped, presetIgnored };
  }
}
