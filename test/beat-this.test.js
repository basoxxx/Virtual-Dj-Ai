import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  logMelSpectrogram, chunkStarts, predictLogits, minimalPostprocess, beatGrid, createBeatThisSession, trackBeats,
  BT_CHUNK, BT_MELS,
} from '../src/renderer/js/dsp/beat-this.js';
import { musicClip, toInt16Precision } from './helpers/music.js';

// riferimenti prodotti da ml/beat_this/export_onnx.py (torchaudio + onnxruntime Python)
const FIX = fileURLToPath(new URL('./fixtures/beat-this/', import.meta.url));
const MODELS = fileURLToPath(new URL('../src/renderer/models/', import.meta.url));
const ref = JSON.parse(readFileSync(FIX + 'reference.json', 'utf8'));
const f32 = (name) => {
  const b = readFileSync(FIX + name);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const clip = () => toInt16Precision(musicClip(ref.sampleRate, ref.clipSeconds));

// errore misurato sul brano di prova: massimo 1,04e-4, medio 3,6e-6 su valori fino a 8,06
// (JavaScript calcola in float64, torchaudio in float32)
const MEL_TOLERANCE = 2e-4;

test('Beat This!: spettrogramma log-mel uguale a torchaudio', () => {
  const { data, frames } = logMelSpectrogram(clip());
  const expected = f32('clip-mel.f32');
  assert.equal(frames, ref.frames);
  assert.equal(data.length, expected.length);
  let maxErr = 0;
  for (let i = 0; i < data.length; i++) maxErr = Math.max(maxErr, Math.abs(data[i] - expected[i]));
  assert.ok(maxErr < MEL_TOLERANCE, `errore massimo ${maxErr}`);
});

test('Beat This!: blocchi come split_piece di beat_this', () => {
  assert.deepEqual(chunkStarts(300), [-6]);
  // valori calcolati con beat_this.inference.split_piece
  assert.deepEqual(chunkStarts(1488), [-6]);
  assert.deepEqual(chunkStarts(1489), [-6, -5]);
  assert.deepEqual(chunkStarts(1494), [-6, 0]);
  assert.deepEqual(chunkStarts(3000), [-6, 1482, 1506]);
  assert.deepEqual(chunkStarts(4464), [-6, 1482, 2970]);
});

test('Beat This!: ricomposizione dei blocchi (vale il blocco precedente)', async () => {
  const frames = 3000;
  const spect = new Float32Array(frames * BT_MELS);
  for (let t = 0; t < frames; t++) spect[t * BT_MELS] = t;
  // il modello finto restituisce il frame d'origine (dal primo valore della riga) e l'indice del blocco
  let calls = 0;
  const run = async (input) => {
    const id = ++calls;
    const beat = new Float32Array(BT_CHUNK);
    const downbeat = new Float32Array(BT_CHUNK).fill(id);
    for (let i = 0; i < BT_CHUNK; i++) beat[i] = input[i * BT_MELS];
    return { beat, downbeat };
  };
  const out = await predictLogits(spect, frames, run);
  for (let t = 1; t < frames; t++) assert.equal(out.beat[t], t, `frame ${t}`);
  // blocchi in ordine inverso: 1 = ultimo, 3 = primo; nelle sovrapposizioni vince il primo
  assert.equal(out.downbeat[0], 3);
  assert.equal(out.downbeat[1487], 3);
  assert.equal(out.downbeat[1488], 2);
  assert.equal(out.downbeat[1511], 2);
  assert.equal(out.downbeat[2975], 2);
  assert.equal(out.downbeat[2976], 1);
});

test('Beat This!: post-processing uguale a postprocessor.py', () => {
  for (const [name, m] of Object.entries(ref.models)) {
    for (const v of ['fp32', 'int8']) {
      const l = f32(`clip-logits-${name}-${v}.f32`);
      const { beats, downbeats } = minimalPostprocess(l.subarray(0, ref.frames), l.subarray(ref.frames));
      assert.deepEqual(beats.map((b) => Math.round(b * 1000) / 1000), m[`${v}ClipBeats`], `${name} ${v}`);
      assert.deepEqual(downbeats.map((b) => Math.round(b * 1000) / 1000), m[`${v}ClipDownbeats`], `${name} ${v}`);
    }
  }
});

test('Beat This!: post-processing su picchi larghi e senza battute', () => {
  const beat = new Float32Array(100).fill(-5);
  beat[10] = 2;
  beat[11] = 2; // picco su due frame: media
  beat[40] = 1;
  beat[42] = 3; // massimo locale solo a 42
  const down = new Float32Array(100).fill(-5);
  down[41] = 4; // si sposta sulla battuta più vicina
  const r = minimalPostprocess(beat, down);
  assert.deepEqual(r.beats, [10.5 / 50, 42 / 50]);
  assert.deepEqual(r.downbeats, [42 / 50]);
  assert.deepEqual(minimalPostprocess(new Float32Array(10).fill(-1), new Float32Array(10).fill(-1)), { beats: [], downbeats: [] });
});

function gridBeats(bpm, offset, seconds, { jitter = 0.01, seed = 7 } = {}) {
  const beats = [];
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  for (let t = offset; t < seconds; t += 60 / bpm) beats.push(Math.round((t + rnd() * 2 * jitter) * 50) / 50);
  return beats;
}

test('beatGrid: BPM intero, fase della battuta forte e confidenza', () => {
  const beats = gridBeats(124, 0.37, 300);
  const period = 60 / 124;
  // battute forti sul terzo tempo della griglia (la prima battuta forte è a 0,37 + 2 battute)
  const downbeats = beats.filter((_, i) => i % 4 === 2);
  const g = beatGrid(beats, downbeats);
  assert.equal(g.bpm, 124);
  assert.ok(Math.abs(g.offset - (0.37 + 2 * period)) < 0.01, `offset ${g.offset}`);
  assert.ok(g.confidence > 0.9, `confidenza ${g.confidence}`);
});

test('beatGrid: tollera battute mancanti e in più, tiene i BPM decimali', () => {
  const beats = gridBeats(127.5, 0.1, 240).filter((_, i) => i % 17 !== 5);
  beats.push(33.333, 90.01);
  beats.sort((a, b) => a - b);
  const g = beatGrid(beats, []);
  assert.ok(Math.abs(g.bpm - 127.5) < 0.03, `bpm ${g.bpm}`);
  const period = 60 / 127.5;
  let d = Math.abs(g.offset - 0.1) % period;
  d = Math.min(d, period - d);
  assert.ok(d < 0.01, `offset ${g.offset}`);
});

test('beatGrid: un tratto a livello metrico diverso non sposta la griglia (regressione 12/8)', () => {
  // 80 BPM, poi 40 s a 120 BPM (il modello segue un altro livello metrico), poi di nuovo 80
  const a = gridBeats(80, 0.03, 60);
  const b = gridBeats(120, 60, 100).filter((t) => t > a[a.length - 1] + 0.3);
  const c = gridBeats(80, 0.03 + 134 * 0.75, 200).filter((t) => t > b[b.length - 1] + 0.3); // in fase col primo tratto
  const g = beatGrid([...a, ...b, ...c], []);
  assert.equal(g.bpm, 80);
  assert.ok(g.confidence > 0.4, `confidenza ${g.confidence}`);
  assert.ok(Math.abs(g.offset % 0.75 - 0.03) < 0.01, `offset ${g.offset}`);
});

test('beatGrid: metà/doppio tempo dentro 70–180 BPM e casi degeneri', () => {
  assert.equal(beatGrid(gridBeats(200, 0.2, 120, { jitter: 0 }), []).bpm, 100);
  assert.equal(beatGrid(gridBeats(60, 0.2, 120, { jitter: 0 }), []).bpm, 120);
  assert.deepEqual(beatGrid([1, 2, 3], []), { bpm: 0, offset: 0, confidence: 0 });
});

// Con il modello scaricato (npm run models) si verifica l'intera catena JavaScript + onnxruntime-web.
// Scarto misurato sui logit rispetto a onnxruntime Python: fp32 4e-5; int8 fino a 0,35 anche a parità
// di spettrogramma (i kernel int8 di WASM arrotondano diversamente da quelli nativi), battute identiche.
const E2E = [
  ['small0', 'int8', 0.5], ['small0', 'fp32', 1e-3], ['final0', 'int8', 0.5], ['final0', 'fp32', 1e-3],
];
for (const [name, variant, tolerance] of E2E) {
  const path = `${MODELS}beat_this-${name}${variant === 'fp32' ? '' : '-' + variant}.onnx`;
  test(`Beat This! ${name} ${variant} con onnxruntime-web: logit e battute come Python`, { skip: !existsSync(path) && 'modello non scaricato' }, async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const { run, release } = await createBeatThisSession(ort, new Uint8Array(readFileSync(path)));
    try {
      const { data, frames } = logMelSpectrogram(clip());
      const logits = await predictLogits(data, frames, run);
      const expected = f32(`clip-logits-${name}-${variant}.f32`);
      let maxErr = 0;
      for (let t = 0; t < frames; t++) {
        maxErr = Math.max(maxErr, Math.abs(logits.beat[t] - expected[t]), Math.abs(logits.downbeat[t] - expected[frames + t]));
      }
      assert.ok(maxErr < tolerance, `errore massimo ${maxErr}`);
      const res = await trackBeats(run, clip());
      assert.deepEqual(res.beats.map((b) => Math.round(b * 1000) / 1000), ref.models[name][`${variant}ClipBeats`]);
      assert.deepEqual(res.downbeats.map((b) => Math.round(b * 1000) / 1000), ref.models[name][`${variant}ClipDownbeats`]);
      assert.equal(res.grid.bpm, 124);
    } finally {
      await release();
    }
  });
}

const BUNDLED = `${MODELS}beat_this-small0-int8.onnx`;
test('Beat This! small0 int8: BPM e prima battuta forte su brani a tempo noto', { skip: !existsSync(BUNDLED) && 'modello non scaricato' }, async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const { run, release } = await createBeatThisSession(ort, new Uint8Array(readFileSync(BUNDLED)));
  try {
    for (const bpm of [95, 122, 128, 140, 174]) {
      const offset = 0.3;
      const res = await trackBeats(run, toInt16Precision(musicClip(22050, 40, { bpm, offset })));
      assert.ok(Math.abs(res.grid.bpm - bpm) < 0.1, `atteso ${bpm}, ottenuto ${res.grid.bpm}`);
      // nel brano sintetico la battuta forte (cassa accentata, cambio d'accordo) cade a offset + k battute
      const bar = 240 / bpm;
      let d = Math.abs(res.grid.offset - offset) % bar;
      d = Math.min(d, bar - d);
      assert.ok(d < 0.03, `${bpm} BPM: offset ${res.grid.offset}`);
    }
  } finally {
    await release();
  }
});
