import test from 'node:test';
import assert from 'node:assert/strict';
import { RAPID, dropTime, phraseEnergy, rapidTiming } from '../src/renderer/js/ai/rapid.js';
import { planTransition, transitionState } from '../src/renderer/js/ai/selector.js';

// forma d'onda sintetica: 120 BPM (frase da 8 misure = 16 s), intro debole per 2 frasi, poi il drop
function waveform(duration, dropAt, bps = 100) {
  const n = Math.round(duration * bps);
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) peak[i] = i / bps >= dropAt ? 0.9 : 0.3;
  return { binsPerSecond: bps, length: n, peak, low: peak, mid: peak, high: peak };
}

test('tagli a raffica: energia per frase e drop dopo l\'intro', () => {
  const wf = waveform(240, 32);
  const ph = phraseEnergy(wf, 120, 0, 240);
  assert.equal(ph.length, 15);
  assert.ok(ph[1].energy < 0.35 && ph[2].energy > 0.85);
  assert.equal(dropTime(wf, 120, 0, 240), 32);
  // senza salto di energia (tutto uguale) non c'è un drop
  assert.equal(dropTime(waveform(240, 0), 120, 0, 240), null);
  assert.equal(dropTime(null, 120, 0, 240), null);
});

test('tagli a raffica: 16 o 24 misure dal punto di entrata, taglio sulla griglia, successivo sul drop', () => {
  const deck = { beatLength: 0.5, gridOffset: 0.2, duration: 240, position: 5, bpm: 120 };
  const next = { beatLength: 0.5, gridOffset: 0, duration: 240, bpm: 120, waveform: waveform(240, 32) };
  const bar = 2;
  // random: prima scelta delle misure (< 0.5 -> 16), poi entrata sul drop (< 1/3)
  const seq = (...v) => () => v.shift();
  const a = rapidTiming(deck, next, { entry: 4.2, defaultMixIn: 0, random: seq(0.1, 0.1) });
  assert.equal(a.playBars, 16);
  assert.ok(Math.abs(a.startAt + bar - (4.2 + 16 * bar)) < 1e-9); // il taglio cade 16 misure dopo l'entrata
  assert.ok(Math.abs(((a.startAt - 0.2) / bar) - Math.round((a.startAt - 0.2) / bar)) < 1e-9); // sulla griglia
  assert.equal(a.fromDrop, true);
  assert.equal(a.mixIn, 32 - bar); // parte una misura prima del drop: al taglio è sul drop
  const b = rapidTiming(deck, next, { entry: 4.2, defaultMixIn: 10, random: seq(0.9, 0.9) });
  assert.equal(b.playBars, 24);
  assert.equal(b.fromDrop, false);
  assert.equal(b.mixIn, 10); // entrata dal punto di mix normale
  // se il brano è già oltre, il taglio va alla prima misura utile
  const late = rapidTiming({ ...deck, position: 120 }, next, { entry: 0, random: seq(0.1, 0.9) });
  assert.ok(late.startAt >= 120 && late.startAt - 120 <= 2 * bar);
  assert.deepEqual(RAPID.playBars, [16, 24]);
});

test('tagli a raffica: filtro e bassi sull\'uscente, taglio netto alla fine della misura', () => {
  assert.equal(planTransition({ bpm: 120 }, { bpm: 121 }, { style: 'rapid', bars: 16 }).bars, 1);
  const mid = transitionState('rapid', 0.6);
  assert.equal(mid.xf, 0);
  assert.equal(mid.outLow, -1);
  assert.ok(mid.outFilter > 0.3);
  assert.equal(transitionState('rapid', 0.2).outLow, 0);
  assert.equal(transitionState('rapid', 0.99).xf, 1);
});

test('tagli a raffica: il piano dell\'AI DJ usa i tempi di LUM!X', async () => {
  const { AutoDJ } = await import('../src/renderer/js/ai/autodj.js');
  const dj = new AutoDJ({ engine: {}, decks: [], getControls: () => ({}), getPool: () => [], llm: null, random: () => 0.1 });
  dj.options.style = 'rapid';
  const cur = { track: { bpm: 120, key: 'Am', energy: 5 }, beatLength: 0.5, duration: 240, position: 1, gridOffset: 0, tempo: 1, _aiEntry: 0 };
  const next = { track: { bpm: 120, key: 'Am', energy: 6, mixIn: 0 }, beatLength: 0.5, duration: 240, gridOffset: 0, bpm: 120, waveform: waveform(240, 48) };
  const plan = dj.makePlan(cur, next);
  assert.equal(plan.type, 'rapid');
  assert.equal(plan.bars, 1);
  assert.equal(plan.startAt, 30); // 16 misure da 2 s, meno la misura del cambio
  assert.equal(plan.mixIn, 46); // drop a 48 s meno una misura
  assert.match(plan.why, /LUM!X: 16 misure, entrata sul drop/);
});
