import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, TIERS, knownActions, detectPreset, decodeRelative, normalizeEntry, WIZARD_STEPS } from '../src/renderer/js/controllers/presets.js';
import { MidiManager } from '../src/renderer/js/midi.js';
import { GamepadController } from '../src/renderer/js/controllers/gamepad.js';

const KNOWN = new Set(knownActions());

test('catalogo: ogni fascia ha console e ogni profilo usa azioni esistenti', () => {
  for (const tier of Object.keys(TIERS)) assert.ok(PRESETS.filter((p) => p.tier === tier).length >= 5, tier);
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), `id duplicato ${p.id}`);
    ids.add(p.id);
    assert.ok(Object.keys(p.mapping).length >= 8, p.id);
    for (const [key, v] of Object.entries(p.mapping)) {
      assert.match(key, /^(note|cc):\d{1,2}:\d{1,3}$/, `${p.id} ${key}`);
      const [, ch, n] = key.split(':').map(Number);
      assert.ok(ch <= 15 && n <= 127, `${p.id} ${key}`);
      assert.ok(KNOWN.has(normalizeEntry(v).a), `${p.id}: azione sconosciuta ${normalizeEntry(v).a}`);
    }
  }
  for (const s of WIZARD_STEPS) assert.ok(KNOWN.has(s), s);
});

test('riconoscimento automatico dal nome della periferica', () => {
  assert.equal(detectPreset('DDJ-FLX4 MIDI 1').name, 'DDJ-FLX4');
  assert.equal(detectPreset('PIONEER DDJ-400').name, 'DDJ-400');
  assert.equal(detectPreset('DDJ-FLX10').name, 'DDJ-FLX10');
  assert.equal(detectPreset('DJControl Inpulse 300 MIDI').brand, 'Hercules');
  assert.equal(detectPreset('Numark Party Mix Live').brand, 'Numark');
  assert.equal(detectPreset('Denon DJ MC7000').tier, 'pro');
  assert.equal(detectPreset('Rane ONE MIDI').brand, 'Rane');
  assert.equal(detectPreset('Tastiera USB generica'), null);
  assert.equal(detectPreset(''), null);
});

test('decodifica degli encoder relativi', () => {
  assert.equal(decodeRelative(1, 'twos'), 1);
  assert.equal(decodeRelative(127, 'twos'), -1);
  assert.equal(decodeRelative(65, 'rel64'), 1);
  assert.equal(decodeRelative(60, 'rel64'), -4);
  assert.equal(decodeRelative(0x42, 'signmag'), -2);
  assert.equal(decodeRelative(0x03, 'signmag'), 3);
});

function fakeActions(log) {
  const actions = new Map();
  for (const id of knownActions()) {
    const kind = /pitch|volume|gain|eq|filter|xfader|master|hpVolume|cueMix|mix$|param$/.test(id) ? 'knob' : /jog$|jogScratch|browse/.test(id) ? 'jog' : 'button';
    actions.set(id, { label: id, kind, run: (...a) => log.push([id, ...a]), led: () => id === 'A.play' });
  }
  return actions;
}

test('profilo Pioneer DDJ: i messaggi comandano deck, mixer e jog', () => {
  const log = [];
  const m = new MidiManager(fakeActions(log));
  const dev = { name: 'DDJ-FLX4' };
  m.onMessage([0x90, 0x0b, 127], dev); // play deck 1
  m.onMessage([0x91, 0x0c, 127], dev); // cue deck 2
  m.onMessage([0xb0, 0x13, 127], dev); // volume deck 1
  m.onMessage([0xb0, 0x21, 66], dev); // jog deck 1 (rel64)
  m.onMessage([0xb6, 0x1f, 0], dev); // crossfader
  m.onMessage([0x97, 0x02, 127], dev); // pad hot cue 3 deck 1
  m.onMessage([0xb0, 0x00, 0], dev); // pitch invertito
  assert.deepEqual(log, [
    ['A.play', true, 1], ['B.cue', true, 1], ['A.volume', 1], ['A.jog', 2], ['xfader', 0], ['A.hotcue3', true, 1], ['A.pitch', 1],
  ]);
});

test('le mappature personali hanno la precedenza sul profilo e si possono invertire', () => {
  const log = [];
  const m = new MidiManager(fakeActions(log));
  const dev = { name: 'DDJ-400' };
  m.learn('B.play');
  m.onMessage([0x90, 0x0b, 127], dev);
  m.onMessage([0x90, 0x0b, 127], dev);
  assert.deepEqual(log.at(-1), ['B.play', true, 1]);
  m.learn('A.volume');
  m.onMessage([0xb3, 0x05, 10], dev);
  m.toggleInvert('A.volume');
  m.onMessage([0xb3, 0x05, 127], dev);
  assert.deepEqual(log.at(-1), ['A.volume', 0]);
  m.setPresetMode('none');
  log.length = 0;
  m.onMessage([0xb0, 0x13, 127], dev);
  assert.equal(log.length, 0);
});

test('procedura guidata: un controllo alla volta, con salto', () => {
  const log = [];
  const m = new MidiManager(fakeActions(log));
  m.startWizard(['A.play', 'A.cue', 'xfader']);
  m.onMessage([0x92, 1, 127]);
  m.skipWizardStep();
  m.onMessage([0xb2, 7, 64]);
  assert.equal(m.wizard, null);
  assert.equal(m.keyFor('A.play'), 'note:2:1');
  assert.equal(m.keyFor('A.cue'), '');
  assert.equal(m.keyFor('xfader'), 'cc:2:7');
});

test('LED: invia lo stato dei pulsanti alla porta di uscita della console', () => {
  const sent = [];
  const m = new MidiManager(fakeActions([]));
  m.access = {
    inputs: new Map([['i', { id: 'i', name: 'DDJ-400' }]]),
    outputs: new Map([['o', { id: 'o', name: 'DDJ-400', send: (d) => sent.push(d) }]]),
  };
  m.updateLeds();
  assert.ok(sent.some((d) => d[0] === 0x90 && d[1] === 0x0b && d[2] === 0x7f), 'LED play acceso');
  const n = sent.length;
  m.updateLeds();
  assert.equal(sent.length, n, 'nessun reinvio se lo stato non cambia');
});

test('export/import delle mappature', () => {
  const m = new MidiManager(fakeActions([]));
  m.learn('A.play');
  m.onMessage([0x90, 5, 127]);
  const json = m.exportMapping();
  const m2 = new MidiManager(fakeActions([]));
  assert.equal(m2.importMapping(json), 1);
  assert.equal(m2.keyFor('A.play'), 'note:0:5');
  assert.throws(() => m2.importMapping('{"foo":1}'));
});

test('gamepad: pulsanti, grilletti e croce', () => {
  const log = [];
  const g = new GamepadController(fakeActions(log));
  const btn = (pressed, value = pressed ? 1 : 0) => ({ pressed, value });
  const pad = { index: 0, id: 'Xbox', axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => btn(false)) };
  g.supported = true;
  Object.defineProperty(g, 'pads', { get: () => [pad] });
  pad.buttons[0] = btn(true); // A
  pad.buttons[7] = btn(true, 1); // RT tutto
  g.poll();
  g.poll(); // tenuto premuto: nessun doppio play
  pad.buttons[15] = btn(true); // croce destra: carica su B
  g.poll();
  assert.deepEqual(log.filter((l) => l[0] === 'A.play').length, 1);
  assert.ok(log.some((l) => l[0] === 'xfader' && l[1] === 1));
  assert.ok(log.some((l) => l[0] === 'B.load'));
});
