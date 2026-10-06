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
    const kind = /pitch|volume|gain|eq|filter|xfader|xfCurve|master|hpVolume|cueMix|mix$|param$/.test(id) ? 'knob' : /jog$|jogScratch|jogSearch|loopSize|browse/.test(id) ? 'jog' : 'button';
    // l'ultimo argomento è la voce della mappa: nel log si tiene solo il suo parametro (arg/res), se c'è
    const run = (...a) => {
      const e = a.at(-1);
      if (e && typeof e === 'object') a = [...a.slice(0, -1), ...(e.arg != null ? [{ arg: e.arg }] : e.res ? [{ res: e.res }] : [])];
      log.push([id, ...a]);
    };
    actions.set(id, { label: id, kind, run, led: () => id === 'A.play' });
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

test('profilo Hercules Inpulse 500: EQ, loop, SHIFT e pad come sulla console', () => {
  const log = [];
  const m = new MidiManager(fakeActions(log));
  const dev = { name: 'DJControl Inpulse 500' };
  assert.equal(detectPreset(dev.name).name, 'DJControl Inpulse 500');
  m.onMessage([0x91, 0x07, 127], dev); // play A
  m.onMessage([0x92, 0x06, 127], dev); // cue B
  m.onMessage([0xb1, 0x02, 127], dev); // manopola LOW deck A
  m.onMessage([0xb1, 0x04, 0], dev); // manopola HIGH deck A
  m.onMessage([0x91, 0x09, 127], dev); // LOOP IN
  m.onMessage([0x94, 0x09, 127], dev); // SHIFT + IN = ÷2
  m.onMessage([0xb1, 0x0e, 0x7f], dev); // encoder loop indietro
  m.onMessage([0x96, 0x02, 127], dev); // pad 3 in HOT CUE
  m.onMessage([0x96, 0x0a, 127], dev); // SHIFT + pad 3 = cancella hot cue 3
  m.onMessage([0x97, 0x75, 127], dev); // deck B, BEAT JUMP pad 6 = +4
  m.onMessage([0x96, 0x30, 127], dev); // pad 1 in SAMPLER
  m.onMessage([0x94, 0x06, 127], dev); // SHIFT + CUE = inizio brano
  m.onMessage([0xb1, 0x0a, 0x01], dev); // jog (piatto), un tick
  m.onMessage([0xb0, 0x00, 0], dev); // crossfader
  assert.deepEqual(log, [
    ['A.play', true, 1], ['B.cue', true, 1], ['A.eq.low', 1], ['A.eq.high', 0], ['A.loopIn', true, 1], ['A.loopHalf', true, 1],
    ['A.loopSize', -1], ['A.hotcue3', true, 1], ['A.hotcueClear', true, 1, { arg: 3 }], ['B.beatjump', true, 1, { arg: 4 }],
    ['sampler1', true, 1], ['A.rewind', true, 1], ['A.jogScratch', 1, { res: 720 }], ['xfader', 0],
  ]);
});

test('profili Hercules: EQ basse sul CC 2 e alte sul CC 4 per tutta la gamma', () => {
  for (const p of PRESETS.filter((x) => x.family === 'hercules')) {
    assert.equal(normalizeEntry(p.mapping['cc:1:2']).a, 'A.eq.low', p.name);
    assert.equal(normalizeEntry(p.mapping['cc:2:4']).a, 'B.eq.high', p.name);
    assert.equal(p.rev, 2, p.name);
  }
});

test('procedura guidata: i fader a 14 bit e i controlli che continuano a muoversi non sfasano i passi', () => {
  const log = [];
  const m = new MidiManager(fakeActions(log));
  let t = 1000;
  m.now = () => t;
  m.startWizard(['A.volume', 'A.eq.high', 'A.jogTouch', 'A.jogScratch', 'A.play']);
  m.onMessage([0xb1, 0x00, 70]); // fader: byte alto…
  m.onMessage([0xb1, 0x20, 12]); // …e byte basso subito dopo: non va sull'EQ
  t += 30;
  m.onMessage([0xb1, 0x00, 71]); // il fader continua a muoversi
  t += 800;
  m.onMessage([0x91, 0x08, 127]); // toccare il jog non è una manopola: ignorato
  m.onMessage([0xb1, 0x04, 40]); // EQ HIGH
  t += 800;
  m.onMessage([0x91, 0x08, 127]); // touch del jog
  t += 800;
  m.onMessage([0x91, 0x08, 127]); // il touch di nuovo non è il jog che gira
  m.onMessage([0xb1, 0x0a, 1]); // jog
  t += 50;
  m.onMessage([0xb1, 0x0a, 127]); // il jog che gira ancora non diventa "play"
  t += 800;
  m.onMessage([0x91, 0x07, 127]); // play
  assert.equal(m.wizard, null);
  assert.equal(m.keyFor('A.volume'), 'cc:1:0');
  assert.equal(m.keyFor('A.eq.high'), 'cc:1:4');
  assert.equal(m.keyFor('A.jogTouch'), 'note:1:8');
  assert.equal(m.keyFor('A.jogScratch'), 'cc:1:10');
  assert.equal(m.keyFor('A.play'), 'note:1:7');
});

test('Hercules: all\'avvio chiede la posizione dei controlli e accende i VU dei canali', () => {
  const sent = [];
  const m = new MidiManager(fakeActions([]));
  m.access = {
    inputs: new Map([['i', { id: 'i', name: 'DJControl Inpulse 500' }]]),
    outputs: new Map([['o', { id: 'o', name: 'DJControl Inpulse 500', send: (d) => sent.push(d) }]]),
  };
  m.vuSource = (id) => (id === 'A' ? 1 : 0);
  m.updateLeds();
  assert.deepEqual(sent[0], [0xb0, 0x7f, 0x7f]);
  assert.ok(sent.some((d) => d[0] === 0xb1 && d[1] === 0x40 && d[2] === 125), 'VU deck A pieno');
  assert.ok(sent.some((d) => d[0] === 0xb2 && d[1] === 0x40 && d[2] === 0), 'VU deck B spento');
  const n = sent.length;
  m.updateLeds();
  assert.equal(sent.length, n, 'avvio e VU non si ripetono se non cambia nulla');
});
