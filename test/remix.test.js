import test from 'node:test';
import assert from 'node:assert/strict';
import { planRemix, barEnergyAt, REMIX_ACTIONS } from '../src/renderer/js/ai/remix.js';

// brano a 120 BPM (battuta 2 s, frase di 8 battute 16 s), griglia da 0,5 s, 5 minuti
const track = (energy) => ({ bpm: 120, gridOffset: 0.5, duration: 300, barEnergy: energy || new Array(150).fill(0.5) });
const seq = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};

test('remix: il gesto cade sul prossimo confine di frase, con anticipo', () => {
  const p = planRemix(track(), 20, { rng: seq(0, 0) });
  assert.equal(p.boundary, 32.5); // 0,5 + 2 frasi da 16 s
  assert.ok(Object.keys(REMIX_ACTIONS).includes(p.action));
  assert.ok(p.at < p.boundary && p.at >= p.boundary - 4, `inizio ${p.at}`);
  assert.equal(p.until, p.boundary);
  // a meno di 2 battute dal confine si passa alla frase dopo
  assert.equal(planRemix(track(), 30, { rng: seq(0, 0) }).boundary, 48.5);
});

test('remix: niente gesti vicino alla fine o a una transizione pianificata', () => {
  assert.equal(planRemix(track(), 280, { rng: seq(0, 0) }), null);
  assert.equal(planRemix(track(), 20, { rng: seq(0, 0), nextMixAt: 60 }), null);
  assert.notEqual(planRemix(track(), 20, { rng: seq(0, 0), nextMixAt: 80 }), null);
  assert.equal(planRemix({ bpm: 0 }, 10), null);
});

test('remix: a volte salta la frase, e non ripete due volte lo stesso gesto', () => {
  assert.deepEqual(planRemix(track(), 20, { rng: seq(0.9), rate: 0.45 }), { action: 'none', boundary: 32.5 });
  for (let i = 0; i < 20; i++) {
    const p = planRemix(track(), 20, { rng: seq(0, i / 20), last: 'roll' });
    assert.notEqual(p.action, 'roll');
  }
});

test('remix: dopo una frase molto energica che cala, può ripeterla (beat jump indietro di 8 battute)', () => {
  const e = new Array(150).fill(0.4);
  for (let b = 8; b < 16; b++) e[b] = 0.95; // frase 2 (battute 8-15) energica, poi cala
  const got = new Set();
  for (let i = 0; i < 40; i++) got.add(planRemix(track(e), 20, { rng: seq(0, i / 40) }).action);
  assert.ok(got.has('repeat'), [...got].join(','));
  const r = [...Array(40)].map((_, i) => planRemix(track(e), 20, { rng: seq(0, i / 40) })).find((p) => p.action === 'repeat');
  assert.equal(r.jumpBeats, -32);
  assert.equal(r.at, r.boundary);
});

test('remix: energia per battuta anche con barEnergy ridotta a 256 punti', () => {
  const long = { bpm: 120, gridOffset: 0, duration: 1200, barEnergy: new Array(200).fill(0).map((_, i) => i / 200) };
  // 600 battute ridotte con passo 3: la battuta 300 è il punto 100
  assert.equal(barEnergyAt(long, 300), 0.5);
  assert.equal(barEnergyAt(long, 9999), null);
});

test('mashup: si prepara solo con tonalità compatibili, sync e modello installato', async () => {
  const { AutoDJ } = await import('../src/renderer/js/ai/autodj.js');
  const log = [];
  const stems = { checkModel: async () => false, ensure: async () => true };
  const dj = new AutoDJ({ engine: {}, decks: [], getControls: () => ({}), getPool: () => [], llm: null, stems });
  dj.say = (t) => log.push(t);
  const plan = (fromKey, toKey, sync = true) => ({ sync, fromTrack: { title: 'A', key: fromKey }, toTrack: { title: 'B', key: toKey } });
  const far = plan('Am', 'F#');
  await dj.prepareMashup(far);
  assert.equal(far.mashup, undefined); // tonalità lontane: niente mashup
  const noSync = plan('Am', 'Am', false);
  await dj.prepareMashup(noSync);
  assert.equal(noSync.mashup, undefined);
  const ok = plan('Am', 'C'); // relativa maggiore: compatibile
  await dj.prepareMashup(ok);
  assert.equal(ok.mashup.status, 'failed'); // modello non scaricato
  assert.match(log.at(-1), /scarica prima il modello/);
});
