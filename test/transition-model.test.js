import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deckBlock, perBeatWave, gridBeats, transitionInput, curvesAt, TM_MAX_BEATS, TM_INPUTS, TM_DECK,
} from '../src/renderer/js/ai/transition-model.js';
import { TRANSITION_MODEL } from '../src/renderer/js/ai/transition-planner.js';

// riferimenti prodotti da ml/transitions/export_onnx.py
const FIX = fileURLToPath(new URL('./fixtures/transition-model/reference.json', import.meta.url));
const MODELS = fileURLToPath(new URL('../src/renderer/models/', import.meta.url));
const ref = JSON.parse(readFileSync(FIX, 'utf8'));

test('modello C: ingressi per battuta uguali a deck_block in Python', () => {
  const f = ref.deckBlock;
  const out = deckBlock(f.t, f.wave, f.pos, f.bar, f.duration, f.present);
  assert.equal(out.length, f.expected.length);
  let maxErr = 0;
  for (let i = 0; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - f.expected[i]));
  assert.ok(maxErr < 1e-5, `errore massimo ${maxErr}`);
});

test('modello C: forma d\'onda media per battuta', () => {
  const n = 300;
  const wf = { binsPerSecond: 100, length: n, peak: new Float32Array(n), low: new Float32Array(n), mid: new Float32Array(n), high: new Float32Array(n) };
  for (let i = 0; i < n; i++) wf.low[i] = i < 150 ? 1 : 0;
  const w = perBeatWave(wf, [0, 1, 2.5, 5], 0.5);
  assert.deepEqual([w[1], w[5], w[9], w[13]], [1, 1, 0, 0]);
});

test('modello C: griglia del deck, posizione nella battuta e battute fuori dal brano', () => {
  const deck = { bpm: 120, gridOffset: 1, duration: 10 };
  const g = gridBeats(deck, 0.98, 20);
  assert.equal(g.t[0], 1);
  assert.deepEqual([...g.pos.slice(0, 6)], [0, 1, 2, 3, 0, 1]);
  assert.deepEqual([...g.bar.slice(0, 6)], [0, 0, 0, 0, 1, 1]);
  assert.equal(g.present[17], true);
  assert.equal(g.present[18], false);
  const before = gridBeats(deck, 0, 3);
  assert.deepEqual([...before.pos], [2, 3, 0]);
  assert.deepEqual([...before.bar], [-1, -1, 0]);
});

test('modello C: tensore d\'ingresso, maschera e caratteristiche globali', () => {
  const wf = { binsPerSecond: 150, length: 3000, peak: new Float32Array(3000).fill(0.5), low: new Float32Array(3000), mid: new Float32Array(3000), high: new Float32Array(3000) };
  const from = { waveform: wf, bpm: 128, gridOffset: 0.2, duration: 20 };
  const to = { waveform: wf, bpm: 126, gridOffset: 0.1, duration: 20 };
  const { x, mask, length } = transitionInput(from, 10, to, 0.1, 64);
  assert.equal(length, 64);
  assert.equal(x.length, TM_MAX_BEATS * TM_INPUTS);
  assert.equal(mask.reduce((a, b) => a + b, 0), 64);
  const g = 2 * TM_DECK;
  assert.equal(x[10 * TM_INPUTS + g], 10 / 64);
  assert.equal(x[10 * TM_INPUTS + g + 1], 0.5);
  assert.ok(Math.abs(x[g + 2] - Math.log2(126 / 128)) < 1e-6);
  assert.equal(x[0], 0.5); // peak del deck uscente
  // battute oltre la fine del brano uscente (20 s) a zero
  assert.equal(x[40 * TM_INPUTS + 15], 0);
  assert.equal(x[64 * TM_INPUTS + g], 0);
  assert.equal(transitionInput(from, 10, to, 0, 400).length, TM_MAX_BEATS);
  // finestra da 256 (v5): l'ingresso lunghezza resta L / 128
  const long = transitionInput(from, 10, to, 0.1, 200, 256);
  assert.equal(long.length, 200);
  assert.equal(long.x.length, 256 * TM_INPUTS);
  assert.equal(long.x[5 * TM_INPUTS + g + 1], 200 / 128);
});

test('modello C: lettura delle curve tra una battuta e l\'altra', () => {
  const curves = new Float32Array(3 * 9);
  curves[0] = 0;
  curves[9] = 0.5;
  curves[18] = 1;
  curves[9 + 1] = -1;
  assert.equal(curvesAt(curves, 3, 0.5).xf, 0.25);
  assert.equal(curvesAt(curves, 3, 1).eqA[0], -1);
  assert.equal(curvesAt(curves, 3, 9).xf, 1);
  assert.equal(curvesAt(curves, 3, -2).xf, 0);
});

test('modello C: il piano dell\'AI DJ chiede le curve al modello solo con il sync', async () => {
  const { AutoDJ } = await import('../src/renderer/js/ai/autodj.js');
  const dj = new AutoDJ({ engine: {}, decks: [], getControls: () => ({}), getPool: () => [] });
  dj.options.style = 'model';
  const deck = (bpm, key) => ({ track: { bpm, key, energy: 5, mixOut: 100 }, beatLength: 60 / bpm, duration: 200, position: 0, gridOffset: 0.1, tempo: 1 });
  const next = { ...deck(127, 'Am'), track: { bpm: 127, key: 'Am', energy: 6, mixIn: 0.1 } };
  assert.equal(dj.makePlan(deck(128, 'Am'), next).wantModel, true);
  const far = { ...deck(90, 'Am'), track: { bpm: 90, key: 'Am', energy: 6 } };
  assert.equal(dj.makePlan(deck(128, 'Am'), far).wantModel, false);
  assert.equal(dj.makePlan(deck(128, 'Am'), next).modelStyle, 'model');
  // stile techno: stesso piano, modello diverso
  dj.options.style = 'model-techno';
  const techno = dj.makePlan(deck(128, 'Am'), next);
  assert.equal(techno.wantModel, true);
  assert.equal(techno.modelStyle, 'model-techno');
  dj.options.style = 'bassswap';
  assert.equal(dj.makePlan(deck(128, 'Am'), next).wantModel, false);
});

test('modello C: ogni stile di transizione del pannello ha il suo modello e la sua finestra', async () => {
  const { TRANSITIONS } = await import('../src/renderer/js/ai/selector.js');
  const { TRANSITION_STYLES, isModelStyle } = await import('../src/renderer/js/ai/transition-planner.js');
  const modelStyles = Object.keys(TRANSITIONS).filter(isModelStyle);
  assert.deepEqual(modelStyles.sort(), Object.keys(TRANSITION_STYLES).sort());
  const files = Object.values(TRANSITION_STYLES).map((m) => m.file);
  assert.equal(new Set(files).size, files.length);
  for (const m of Object.values(TRANSITION_STYLES)) {
    assert.match(m.file, /^segueo-transizioni-[a-z]+-v\d+\.onnx$/);
    assert.ok([128, 256].includes(m.beats));
  }
});

// parità di ogni stile con onnxruntime Python: riferimenti da ml/transitions/export_onnx.py
// (reference.json per lo stile predefinito, reference-techno.json per la v6 dello stile techno)
const PARITY = [
  [TRANSITION_MODEL, ref],
  ['segueo-transizioni-techno-v6.onnx', JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/transition-model/reference-techno.json', import.meta.url)), 'utf8'))],
];
for (const [file, r] of PARITY) {
  const path = MODELS + file;
  test(`modello C int8 con onnxruntime-web (${file}): curve come onnxruntime Python`, { skip: !existsSync(path) && 'modello non scaricato' }, async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(path)), { executionProviders: ['wasm'] });
    try {
      const res = await s.run({
        x: new ort.Tensor('float32', Float32Array.from(r.model.x), [1, r.model.mask.length, TM_INPUTS]),
        mask: new ort.Tensor('float32', Float32Array.from(r.model.mask), [1, r.model.mask.length]),
      });
      let maxErr = 0;
      for (let i = 0; i < res.controls.data.length; i++) {
        if (!r.model.mask[Math.floor(i / 9)]) continue;
        maxErr = Math.max(maxErr, Math.abs(res.controls.data[i] - r.model.int8[i]));
      }
      // i kernel int8 di WASM arrotondano diversamente da quelli nativi (vedi Beat This!)
      assert.ok(maxErr < 0.05, `errore massimo ${maxErr}`);
    } finally {
      await s.release();
    }
  });
}
