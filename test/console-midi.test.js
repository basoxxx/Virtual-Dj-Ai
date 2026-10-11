// Console MIDI: mappe verificate collegate ai profili, profili tolti dal catalogo e fader a 14 bit
// (byte alto sul CC n, byte basso sul CC n+32) senza confonderli con altri controlli mossi insieme.
import test from 'node:test';
import assert from 'node:assert/strict';
import { presetById, knownActions, actionKind, normalizeEntry } from '../src/renderer/js/controllers/presets.js';
import { VERIFIED } from '../src/renderer/js/controllers/verified-maps.js';
import { MidiManager } from '../src/renderer/js/midi.js';

// azioni finte con lo stesso tipo dell'app: il log tiene [azione, valore]
const logActions = (log) => new Map(knownActions().map((id) => [id, { label: id, kind: actionKind(id), run: (v) => log.push([id, v]) }]));

/** MidiManager con orologio finto: tick(ms) fa passare il tempo. */
function clocked(log) {
  const m = new MidiManager(logActions(log));
  let t = 0;
  m.now = () => t;
  return { m, tick: (ms) => { t += ms; } };
}

test('mappe verificate: ognuna è collegata al suo profilo, con la sua mappa e rev 2', () => {
  for (const [id, v] of Object.entries(VERIFIED)) {
    if (!Object.keys(v.mapping).length) continue; // mappa vuota: resta il profilo della famiglia
    const p = presetById(id);
    assert.ok(p, `mappa verificata senza profilo: ${id}`);
    assert.equal(p.mapping, v.mapping, id);
    assert.equal(p.rev, 2, id);
  }
});

test('profilo scelto a mano e poi tolto dal catalogo (#29): torna il riconoscimento automatico', () => {
  const m = new MidiManager(new Map());
  for (const removed of ['denon-sc6000-sc5000-prime-4-modalit-pc', 'grid-behringer-cmd-novation-launch-control']) {
    m.presetMode = removed;
    assert.equal(m.presetFor({ name: 'DDJ-400' }).id, 'pioneer-ddj-ddj-400', removed);
  }
});

test('14 bit: un byte basso arrivato dopo 40 ms non si accoppia al byte alto (Inpulse 500)', () => {
  const log = [];
  const { m, tick } = clocked(log);
  const dev = { name: 'DJControl Inpulse 500' };
  m.onMessage([0xb1, 0x08, 64], dev);
  tick(100);
  m.onMessage([0xb1, 0x28, 0], dev);
  assert.equal(log.length, 1);
});

test('14 bit: un CC n+32 che nel profilo è un altro controllo non viene inghiottito (CMD MM-1)', () => {
  const log = [];
  const { m, tick } = clocked(log);
  const dev = { name: 'CMD MM-1' };
  m.onMessage([0xb4, 16, 64], dev); // EQ basse B
  tick(5);
  m.onMessage([0xb4, 48, 100], dev); // volume A, mosso insieme
  assert.deepEqual(log.map((l) => l[0]), ['B.eq.low', 'A.volume']);
});

test('14 bit: con l\'EQ ri-appreso a mano, il volume A (CC n+32) mosso insieme non si perde e l\'EQ non diventa a 14 bit', () => {
  const log = [];
  const { m, tick } = clocked(log);
  const dev = { name: 'CMD MM-1' };
  m.mapping = { 'cc:4:16': 'B.eq.low' };
  m.onMessage([0xb4, 16, 64], dev);
  tick(1);
  m.onMessage([0xb4, 48, 100], dev);
  assert.deepEqual(log.map((l) => l[0]), ['B.eq.low', 'A.volume']);
  assert.equal(normalizeEntry(m.mapping['cc:4:16']).hires, undefined);
  // anche un controllo appreso con Learn sul CC n+32 ha la precedenza sul byte basso
  m.mapping['cc:4:50'] = 'B.filter';
  tick(100);
  m.onMessage([0xb4, 18, 10], dev); // filtro A del profilo
  tick(1);
  m.onMessage([0xb4, 50, 30], dev);
  assert.deepEqual(log.slice(-2).map((l) => l[0]), ['A.filter', 'B.filter']);
});

test('14 bit: una correzione con Learn non diventa a 14 bit per una coincidenza con un CC n+32 libero', () => {
  const log = [];
  const { m, tick } = clocked(log);
  m.mapping = { 'cc:5:16': 'B.volume' };
  // fader e controllo libero mossi insieme: il CC 48 arriva a volte subito dopo il CC 16, a volte no
  for (let i = 0; i < 20; i++) {
    m.onMessage([0xb5, 16, 60 + i]);
    tick(i % 3 ? 20 : 2);
    m.onMessage([0xb5, 48, i]);
    tick(20);
  }
  assert.equal(normalizeEntry(m.mapping['cc:5:16']).hires, undefined);
  assert.ok(log.every((l) => l[0] === 'B.volume' && Math.abs(l[1] * 127 - Math.round(l[1] * 127)) < 1e-9), 'solo valori a 7 bit');
  // un byte basso che arriva dopo qualche millisecondo non è lo stesso fader
  for (let i = 0; i < 10; i++) {
    m.onMessage([0xb5, 16, 100]);
    tick(8);
    m.onMessage([0xb5, 48, 64]);
    tick(20);
  }
  assert.equal(normalizeEntry(m.mapping['cc:5:16']).hires, undefined);
});

test('14 bit: un fader appreso con Learn diventa a 14 bit dopo qualche coppia byte alto + byte basso di fila', () => {
  const log = [];
  const { m, tick } = clocked(log);
  m.learn('B.volume');
  m.onMessage([0xb5, 0x10, 100]);
  tick(1);
  m.onMessage([0xb5, 0x30, 0]);
  assert.equal(m.keyFor('B.volume'), 'cc:5:16');
  for (let i = 1; i <= 10; i++) {
    tick(15);
    m.onMessage([0xb5, 0x10, 100 + i]);
    tick(1);
    m.onMessage([0xb5, 0x30, 127]);
  }
  assert.equal(normalizeEntry(m.mapping['cc:5:16']).hires, true);
  assert.ok(Math.abs(log.at(-1)[1] - ((110 << 7) | 127) / 16383) < 1e-9, `14 bit: ${log.at(-1)[1]}`);
});

test('14 bit dichiarato dal profilo (Denon MC7000, pitch su CC 9 + CC 119): anche dopo Learn arrivano i valori fini', () => {
  const log = [];
  const { m, tick } = clocked(log);
  const dev = { name: 'Denon DJ MC7000' };
  m.learn('A.pitch');
  m.onMessage([0xb0, 0x09, 90], dev);
  assert.equal(m.keyFor('A.pitch'), 'cc:0:9');
  tick(100);
  m.onMessage([0xb0, 0x09, 100], dev);
  tick(1);
  m.onMessage([0xb0, 0x77, 64], dev); // byte basso sul CC 119, dichiarato dal profilo
  assert.ok(Math.abs(log.at(-1)[1] - ((100 << 7) | 64) / 16383) < 1e-9, `pitch ${log.at(-1)[1]}`);
});
