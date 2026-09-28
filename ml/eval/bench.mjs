// Tempo e RAM di picco dell'analisi Beat This! su un brano mono a 22050 Hz (Float32 grezzo).
// Un processo per misura, così il picco di RSS riguarda solo quella configurazione.
// Uso: node ml/eval/bench.mjs --engine web|node --model <file.onnx> [--threads N] [--audio file.f32]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { logMelSpectrogram, predictLogits, minimalPostprocess, beatGrid, BT_CHUNK, BT_MELS } from '../../src/renderer/js/dsp/beat-this.js';

const { values: a } = parseArgs({
  options: {
    engine: { type: 'string', default: 'web' },
    model: { type: 'string' },
    threads: { type: 'string', default: '1' },
    audio: { type: 'string', default: new URL('../data/bench/track300.f32', import.meta.url).pathname },
  },
});
const mb = (b) => Math.round(b / 1048576);
const rss0 = process.memoryUsage().rss;
const buf = readFileSync(a.audio);
const mono = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const threads = Number(a.threads);

let ort;
let opts;
if (a.engine === 'node') {
  ort = (await import('onnxruntime-node')).default;
  opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 };
} else {
  ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = threads;
  opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
}
const t0 = performance.now();
const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(a.model)), opts);
const t1 = performance.now();
const { data, frames } = logMelSpectrogram(mono);
const t2 = performance.now();
const run = async (input) => {
  const r = await session.run({ spect: new ort.Tensor('float32', input, [1, BT_CHUNK, BT_MELS]) });
  return { beat: r.beat.data, downbeat: r.downbeat.data };
};
const logits = await predictLogits(data, frames, run);
const t3 = performance.now();
const { beats, downbeats } = minimalPostprocess(logits.beat, logits.downbeat);
const grid = beatGrid(beats, downbeats);
const t4 = performance.now();
await session.release();
const peak = process.resourceUsage().maxRSS * 1024;
console.log(JSON.stringify({
  engine: a.engine, model: a.model.split('/').pop(), threads, seconds: mono.length / 22050,
  loadMs: Math.round(t1 - t0), melMs: Math.round(t2 - t1), inferMs: Math.round(t3 - t2), postMs: Math.round(t4 - t3),
  totalMs: Math.round(t4 - t1 + (t1 - t0)), rssStartMB: mb(rss0), peakRssMB: mb(peak), bpm: grid.bpm, confidence: Math.round(grid.confidence * 100) / 100,
}));
