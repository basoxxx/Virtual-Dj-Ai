import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  stftChannel, istftChannel, chunkWeights, paddedChunk, DEMUCS_CHUNK,
} from '../src/renderer/js/dsp/demucs.js';

// riferimento prodotto da ml/mashup/make_fixture.py (spec di ml/mashup/export_demucs.py = HTDemucs._spec)
const ref = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/demucs/stft.json', import.meta.url)), 'utf8'));

function signal() {
  const x = [new Float32Array(ref.n), new Float32Array(ref.n)];
  for (let i = 0; i < ref.n; i++) {
    const t = i / 44100;
    x[0][i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 1234.5 * t);
    x[1][i] = 0.2 * Math.sin(2 * Math.PI * 330 * t) + 0.1 * Math.sin(2 * Math.PI * 3210 * t);
  }
  return x;
}

test('Demucs: STFT uguale a HTDemucs._spec (reale e immaginario per canale)', () => {
  const x = signal();
  const T = ref.T;
  const spec = new Float32Array(4 * 2048 * T);
  for (let c = 0; c < 2; c++) stftChannel(x[c], spec, c, T);
  const bins = 2048 / ref.step;
  let maxErr = 0;
  let maxVal = 0;
  for (let k = 0; k < 4; k++) {
    for (let b = 0; b < bins; b++) {
      for (let t = 0; t < T; t++) {
        const e = ref.spec[(k * bins + b) * T + t];
        const v = spec[k * 2048 * T + b * ref.step * T + t];
        maxErr = Math.max(maxErr, Math.abs(v - e));
        maxVal = Math.max(maxVal, Math.abs(e));
      }
    }
  }
  assert.ok(maxErr < 1e-4 * maxVal, `errore massimo ${maxErr} su valori fino a ${maxVal}`);
});

test('Demucs: ISTFT uguale a HTDemucs._ispec (esatta al centro, come Demucs ai bordi)', () => {
  const x = signal();
  const T = ref.T;
  const spec = new Float32Array(4 * 2048 * T);
  stftChannel(x[0], spec, 0, T);
  const y = istftChannel(spec.subarray(0, 2048 * T), spec.subarray(2048 * T, 2 * 2048 * T), ref.n, T);
  let mid = 0;
  for (let i = 3072; i < ref.n - 3072; i++) mid = Math.max(mid, Math.abs(y[i] - x[0][i]));
  assert.ok(mid < 1e-5, `centro: errore massimo ${mid}`);
  // _spec scarta i primi due frame e _ispec li rimette a zero: ai bordi Demucs non ricostruisce x
  let edge = 0;
  ref.istftHead.forEach((v, k) => (edge = Math.max(edge, Math.abs(y[k * 4] - v))));
  ref.istftTail.forEach((v, k) => (edge = Math.max(edge, Math.abs(y[ref.n - 3072 + k * 4] - v))));
  assert.ok(edge < 1e-5, `bordi: differenza da Demucs ${edge}`);
});

test('Demucs: pesi triangolari e blocchi come apply_model', () => {
  const w = chunkWeights(10);
  assert.deepEqual([...w].map((v) => Math.round(v * 5)), [1, 2, 3, 4, 5, 5, 4, 3, 2, 1]);
  assert.equal(chunkWeights().length, DEMUCS_CHUNK);
  const ch = [Float32Array.from({ length: 20 }, (_, i) => i + 1)];
  // blocco di 4 campioni da 10, completato a 8 con l'audio vicino (2 prima, 2 dopo)
  const { chunk, trim } = paddedChunk(ch, 10, 4, 8);
  assert.deepEqual([...chunk[0]], [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(trim, 2);
  // all'inizio del brano gli zeri prendono il posto dell'audio mancante
  assert.deepEqual([...paddedChunk(ch, 0, 4, 8).chunk[0]], [0, 0, 1, 2, 3, 4, 5, 6]);
});
