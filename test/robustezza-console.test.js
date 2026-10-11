// Console DJ e gamepad: i problemi (porta che non si apre, console senza profilo, comandi che danno errore,
// mappature non valide) devono arrivare all'utente invece di sparire in silenzio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { knownActions, actionKind } from '../src/renderer/js/controllers/presets.js';
import { MidiManager, migrateMapping } from '../src/renderer/js/midi.js';
import { GamepadController } from '../src/renderer/js/controllers/gamepad.js';

const actions = (log = []) => new Map(knownActions().map((id) => [id, { label: id, kind: actionKind(id), run: (...a) => log.push([id, a[0]]) }]));

/** Raccoglie gli eventi di un tipo. */
function collect(target, type) {
  const got = [];
  target.addEventListener(type, (e) => got.push(e.detail));
  return got;
}

const flush = () => new Promise((r) => setImmediate(r));

test('mappature salvate con un comando che non esiste più: messe da parte, il profilo torna attivo su quel controllo', async () => {
  const log = [];
  const m = new MidiManager(actions(log));
  await m.init({ 'note:0:11': 'X.inesistente', 'note:0:12': 'B.cue', 'chiave sbagliata': 'A.play' }, 'auto');
  assert.deepEqual(m.mapping, { 'note:0:12': 'B.cue' });
  assert.deepEqual(m.discarded, { 'note:0:11': 'X.inesistente', 'chiave sbagliata': 'A.play' });
  const dev = { name: 'DDJ-400' };
  m.onMessage([0x90, 0x0b, 127], dev);
  assert.deepEqual(log.at(-1), ['A.play', true]);
  // anche una voce orfana arrivata in un altro modo non oscura il profilo
  m.mapping['note:1:11'] = 'boh';
  m.onMessage([0x91, 0x0b, 127], dev);
  assert.deepEqual(log.at(-1), ['B.play', true]);
});

test('profilo scelto a mano che non esiste più: all\'avvio torna il riconoscimento automatico e lo si dice', async () => {
  const m = new MidiManager(actions());
  await m.init({}, 'denon-sc6000-sc5000-prime-4-modalit-pc');
  assert.equal(m.presetMode, 'auto');
  assert.equal(m.presetMissing, 'denon-sc6000-sc5000-prime-4-modalit-pc');
  const ok = new MidiManager(actions());
  await ok.init({}, 'pioneer-ddj-ddj-400');
  assert.equal(ok.presetMode, 'pioneer-ddj-ddj-400');
  assert.equal(ok.presetMissing, '');
  await ok.init({}, 'none');
  assert.equal(ok.presetMode, 'none');
});

test('MIDI negato dal sistema: init restituisce false e conserva il motivo', async () => {
  const had = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  navigator.requestMIDIAccess = async () => {
    throw new Error('Permesso negato');
  };
  try {
    const m = new MidiManager(actions());
    assert.equal(m.supported, true);
    assert.equal(await m.init(), false);
    assert.match(m.error, /Permesso negato/);
  } finally {
    if (had) Object.defineProperty(navigator, 'requestMIDIAccess', had);
    else delete navigator.requestMIDIAccess;
  }
});

test('porta della console che non si apre (in uso da un altro programma DJ): un errore chiaro, una volta, di nuovo dopo averla ricollegata', async () => {
  const m = new MidiManager(actions());
  const errors = collect(m, 'error');
  const input = { id: 'i', name: 'DDJ-400', state: 'connected', connection: 'closed', open: () => Promise.reject(new Error('Port is not available')) };
  m.access = { inputs: new Map([['i', input]]), outputs: new Map() };
  m.bindInputs();
  m.bindInputs();
  await flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DDJ-400/);
  assert.match(errors[0], /rekordbox|Serato|VirtualDJ/);
  assert.equal(typeof input.onmidimessage, 'function');
  input.state = 'disconnected';
  m.onStateChange({ port: input });
  await flush();
  assert.equal(errors.length, 1);
  input.state = 'connected';
  m.onStateChange({ port: input });
  await flush();
  assert.equal(errors.length, 2, 'ricollegata: si riprova e lo si dice di nuovo');
  // porta già aperta: niente da fare
  const open = { id: 'o', name: 'DDJ-FLX4', connection: 'open', open: () => assert.fail('già aperta') };
  m.access.inputs = new Map([['o', open]]);
  m.bindInputs();
});

test('LED e keep-alive: un messaggio rifiutato dalla porta si dice una volta, la porta chiusa no', () => {
  const m = new MidiManager(actions());
  const errors = collect(m, 'error');
  let fail = new TypeError('Invalid MIDI message');
  const out = { id: 'o', name: 'DJControl Inpulse 300', send: () => { throw fail; } };
  m.access = { inputs: new Map([['i', { id: 'i', name: 'DJControl Inpulse 300' }]]), outputs: new Map([['o', out]]) };
  m.updateLeds();
  m.ledCache.clear();
  m.updateLeds();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Inpulse 300.*luci/);
  fail = Object.assign(new Error('closed'), { name: 'InvalidStateError' });
  m.reported.clear();
  m.ledCache.clear();
  m.updateLeds();
  assert.equal(errors.length, 1, 'porta chiusa in quel momento: si riprova senza avvisi');
});

test('console con profilo ma senza porta di uscita, o senza permesso SysEx per il keep-alive: lo si dice una volta', () => {
  const m = new MidiManager(actions());
  const errors = collect(m, 'error');
  let t = 0;
  m.now = () => t;
  m.access = { inputs: new Map([['i', { id: 'i', name: 'DDJ-400' }]]), outputs: new Map() };
  m.updateLeds();
  assert.equal(errors.length, 0, 'le porte compaiono una alla volta: si aspetta un attimo');
  t += 3000;
  m.updateLeds();
  m.updateLeds();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DDJ-400/);

  const flx = new MidiManager(actions());
  const errs = collect(flx, 'error');
  flx.access = {
    inputs: new Map([['i', { id: 'i', name: 'DDJ-FLX4' }]]),
    outputs: new Map([['o', { id: 'o', name: 'DDJ-FLX4', send: () => {} }]]),
  };
  flx.updateLeds();
  flx.updateLeds();
  assert.equal(errs.length, 1);
  assert.match(errs[0], /SysEx/);
});

test('monitor: Program Change e Aftertouch compaiono come "non supportato"; Learn spiega perché non prende un controllo', () => {
  const m = new MidiManager(actions());
  const msgs = collect(m, 'message');
  const rejected = collect(m, 'rejected');
  m.onMessage(new Uint8Array([0xc0, 0x05]), { name: 'Pad' });
  assert.deepEqual(msgs.at(-1), { key: 'non supportato', raw: 'C0 05', device: 'Pad' });
  m.onMessage([0xf8]); // clock MIDI: nessun controllo dietro, non copre il monitor
  assert.equal(msgs.length, 1);

  m.learn('A.volume');
  m.onMessage([0x90, 0x10, 127]);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /pulsante.*«A\.volume».*fader o una manopola/);
  assert.equal(rejected[0].id, 'A.volume');
  m.onMessage([0x80, 0x10, 0]); // rilascio del tasto: silenzio
  m.onMessage([0xa0, 0x10, 30]);
  assert.equal(rejected.length, 2);
  assert.match(rejected[1].reason, /non usa/);
  m.onMessage([0xb0, 0x07, 90]);
  assert.equal(m.keyFor('A.volume'), 'cc:0:7');

  let t = 0;
  m.now = () => t;
  m.learn('A.play');
  m.onMessage([0xb0, 0x08, 0]); // tasto mandato come CC, rilascio: silenzio
  assert.equal(rejected.length, 2);
  m.onMessage([0xb0, 0x09, 20]); // manopola in basso
  t += 10;
  m.onMessage([0xb0, 0x09, 80]); // e poi in movimento
  assert.equal(rejected.length, 4);
  assert.match(rejected[3].reason, /fader o una manopola.*«A\.play».*premi un pulsante/);
  assert.equal(m.learning, 'A.play');
});

test('un comando della console che dà errore: avviso una volta, la console continua a funzionare', async () => {
  const log = [];
  const acts = actions(log);
  acts.get('A.play').run = () => {
    throw new Error('deck rotto');
  };
  acts.get('A.load').run = (on) => on && Promise.reject(new Error('file sparito'));
  const m = new MidiManager(acts);
  const errors = collect(m, 'error');
  const dev = { name: 'DDJ-400' };
  m.onMessage([0x90, 0x0b, 127], dev);
  m.onMessage([0x90, 0x0b, 127], dev);
  m.onMessage([0x91, 0x0c, 127], dev); // cue B: funziona ancora
  assert.deepEqual(log.at(-1), ['B.cue', true]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Comando «A\.play» dalla console non riuscito: deck rotto/);
  m.onMessage([0x96, 0x46, 127], dev); // carica su A
  await flush();
  assert.equal(errors.length, 2);
  assert.match(errors[1], /file sparito/);
});

test('gamepad: un comando che dà errore non ferma il polling e si dice una volta', () => {
  const log = [];
  const acts = actions(log);
  acts.get('A.play').run = () => {
    throw new Error('deck rotto');
  };
  const g = new GamepadController(acts);
  const errors = collect(g, 'error');
  g.run('A.play', true);
  g.run('A.play', true);
  g.run('B.play', true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /«A\.play».*deck rotto/);
  assert.deepEqual(log.at(-1), ['B.play', true]);
});

test('import della mappatura: JSON illeggibile, nessun controllo valido o profilo sconosciuto non cancellano quella attuale', () => {
  const m = new MidiManager(actions());
  m.mapping = { 'note:0:5': 'A.play' };
  assert.throws(() => m.importMapping('{non è json'), /JSON|leggibile/);
  const file = (mapping, presetMode) => JSON.stringify({ format: 'virtual-dj-ai-midi', version: 1, mapping, presetMode });
  assert.throws(() => m.importMapping(file({ 'note:0:1': 'X.boh', nota: 'A.cue' })), /Nessun controllo valido/);
  assert.throws(() => m.importMapping(file({})), /nessun controllo|Nessun controllo/i);
  assert.deepEqual(m.mapping, { 'note:0:5': 'A.play' });
  m.presetMode = 'pioneer-ddj-ddj-400';
  const res = m.importMapping(file({ 'note:0:1': 'A.cue', 'note:0:2': 'X.boh' }, 'profilo-che-non-esiste'));
  assert.deepEqual(res, { count: 1, dropped: 1, presetIgnored: true });
  assert.deepEqual(m.mapping, { 'note:0:1': 'A.cue' });
  assert.equal(m.presetMode, 'pioneer-ddj-ddj-400');
  assert.deepEqual(m.importMapping(file({ 'note:0:3': 'B.cue' }, 'none')), { count: 1, dropped: 0, presetIgnored: false });
  assert.equal(m.presetMode, 'none');
});

test('avvisi sulle console: riconosciuta, senza profilo, profilo a mano diverso, scollegata e ricollegata (una volta per nome)', () => {
  const m = new MidiManager(actions());
  const inputs = new Map();
  m.access = { inputs, outputs: new Map() };
  const texts = () => m.deviceNotices().map((n) => `${n.type}: ${n.text}`);
  inputs.set('a', { id: 'a', name: 'DDJ-400' });
  inputs.set('b', { id: 'b', name: 'Controller misterioso' });
  inputs.set('c', { id: 'c', name: 'Midi Through Port-0' });
  const first = texts();
  assert.equal(first.length, 2);
  assert.match(first[0], /^ok: Console riconosciuta: .*DDJ-400/);
  assert.match(first[1], /^warn: "Controller misterioso" è collegata ma non ha un profilo: configurala con la procedura guidata/);
  assert.deepEqual(texts(), [], 'una volta sola');
  // porta rimasta nell'elenco ma scollegata
  inputs.set('a', { id: 'a', name: 'DDJ-400', state: 'disconnected' });
  assert.deepEqual(texts(), ['warn: Console "DDJ-400" scollegata']);
  inputs.set('a', { id: 'a', name: 'DDJ-400', state: 'connected' });
  assert.deepEqual(texts(), ['ok: Console "DDJ-400" ricollegata']);
  inputs.delete('b');
  assert.deepEqual(texts(), ['warn: Console "Controller misterioso" scollegata']);

  // profilo scelto a mano: niente "riconosciuta", e un avviso se la console sembra un'altra
  const manual = new MidiManager(actions());
  manual.presetMode = 'hercules-djcontrol-inpulse-500';
  manual.access = { inputs: new Map([['a', { id: 'a', name: 'DDJ-FLX4' }], ['b', { id: 'b', name: 'USB MIDI' }]]), outputs: new Map() };
  const notes = manual.deviceNotices();
  assert.equal(notes[0].type, 'warn');
  assert.match(notes[0].text, /"DDJ-FLX4".*scelto a mano.*Inpulse 500.*DDJ-FLX4/);
  assert.equal(notes[1].type, 'info');
  assert.match(notes[1].text, /"USB MIDI".*scelto a mano.*Inpulse 500/);
  // senza profilo ma con mappature personali (procedura guidata già fatta): nessun avviso
  const mapped = new MidiManager(actions());
  mapped.mapping = { 'note:0:1': 'A.play' };
  mapped.access = { inputs: new Map([['b', { id: 'b', name: 'Controller misterioso' }]]), outputs: new Map() };
  assert.deepEqual(mapped.deviceNotices(), []);
});

test('profilo aggiornato: le correzioni vanno da parte senza perdere quelle messe da parte prima', () => {
  const ddj = { id: 'pioneer-ddj-ddj-400', rev: 2 };
  const inpulse = { id: 'hercules-djcontrol-inpulse-500', rev: 2 };
  const first = migrateMapping({}, { 'note:0:1': 'A.play', 'cc:0:7': 'A.volume' }, ddj);
  assert.deepEqual(first.presetRevs, { 'pioneer-ddj-ddj-400': 2 });
  assert.equal(first.moved, true);
  assert.deepEqual(first.backup, { 'note:0:1': 'A.play', 'cc:0:7': 'A.volume' });
  assert.equal(migrateMapping({ presetRevs: first.presetRevs }, {}, ddj), null, 'stessa versione: niente da fare');
  // nuove correzioni, poi una console nuova: il backup di prima resta
  const settings = { presetRevs: first.presetRevs, backup: first.backup };
  const second = migrateMapping(settings, { 'note:0:9': 'B.play', 'cc:0:8': 'A.volume' }, inpulse);
  assert.deepEqual(second.backup, { 'note:0:1': 'A.play', 'note:0:9': 'B.play', 'cc:0:8': 'A.volume' });
  assert.deepEqual(second.presetRevs, { 'pioneer-ddj-ddj-400': 2, 'hercules-djcontrol-inpulse-500': 2 });
  assert.deepEqual(settings.backup, first.backup, 'non modifica le impostazioni');
  // nessuna correzione: si segna solo la versione
  const empty = migrateMapping({ backup: first.backup }, {}, inpulse);
  assert.equal(empty.moved, false);
  assert.deepEqual(empty.backup, first.backup);
});

// L'app registra le azioni dentro App (non importabile nei test): si leggono dal sorgente di registerActions, così
// un'azione dei profili che l'app non registra più (o registra con un altro tipo) fa fallire i test invece di finire
// solo in un console.warn all'avvio.
test('ogni azione dei profili è registrata dall\'app, con lo stesso tipo', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/renderer/js/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('  registerActions() {');
  const body = src.slice(start, src.indexOf('Azioni MIDI non registrate', start));
  assert.ok(start > 0 && body.length > 1000, 'registerActions non trovato in app.js');
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const VALUES = { X: ['A', 'B'], 'h + 1': range(8), 'p + 1': range(8), 'f + 1': range(2), band: ['high', 'mid', 'low'] };
  const expand = (tpl) => {
    const m = tpl.match(/\$\{([^}]+)\}/);
    if (!m) return [tpl];
    assert.ok(VALUES[m[1]], `variabile sconosciuta in ${tpl}: aggiungila a VALUES`);
    return VALUES[m[1]].flatMap((v) => expand(tpl.replace(m[0], v)));
  };
  const registered = new Map();
  for (const [, fn, id, kind] of body.matchAll(/\b(add|knob)\((`[^`]*`|'[^']*'),\s*(?:`[^`]*`|'[^']*'),\s*(?:'(\w+)')?/g)) {
    for (const x of expand(id.slice(1, -1))) registered.set(x, fn === 'knob' ? 'knob' : kind);
  }
  const known = knownActions();
  assert.deepEqual(known.filter((id) => !registered.has(id)), [], 'azioni dei profili che l\'app non registra');
  assert.deepEqual([...registered.keys()].filter((id) => !known.includes(id)), [], 'azioni registrate che i profili non conoscono');
  assert.deepEqual(known.filter((id) => registered.get(id) && registered.get(id) !== actionKind(id)), [], 'tipo diverso tra app e presets');
});
