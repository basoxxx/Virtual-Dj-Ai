// Separazione in JavaScript (src/renderer/js/dsp/demucs.js + onnxruntime-web) contro PyTorch: SDR, tempo, RAM.
// Uso: node ml/mashup/bench_separate.mjs --model ml/data/onnx/htdemucs.onnx [--threads 4]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { separate, DEMUCS_CHUNK, DEMUCS_FRAMES } from '../../src/renderer/js/dsp/demucs.js';

const { values: a } = parseArgs({ options: { model: { type: 'string' }, threads: { type: 'string', default: '4' }, lowmem: { type: 'boolean', default: false } } });
const D = new URL('../data/stems/', import.meta.url).pathname;
const f32 = (name) => { const b = readFileSync(D + name); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const mix = f32('ref-mix.f32');
const n = mix.length / 2;
const channels = [mix.subarray(0, n), mix.subarray(n)];
const ort = await import('onnxruntime-web');
ort.env.wasm.numThreads = Number(a.threads);
const t0 = performance.now();
const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(a.model)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...(a.lowmem ? { enableCpuMemArena: false, enableMemPattern: false } : {}) });
const t1 = performance.now();
let chunks = 0;
const runCore = async (m, spec) => {
  chunks++;
  const r = await s.run({ mix: new ort.Tensor('float32', m, [1, 2, DEMUCS_CHUNK]), spec: new ort.Tensor('float32', spec, [1, 4, 2048, DEMUCS_FRAMES]) });
  return { freq: r.freq.data, time: r.time.data };
};
const out = await separate(channels, runCore);
const t2 = performance.now();
const sdr = (est, refName) => {
  const r = f32(refName);
  let num = 0; let den = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const e = r[c * n + i]; const d = est[c][i] - e; num += e * e; den += d * d; }
  return Math.round(10 * Math.log10(num / den) * 10) / 10;
};
console.log(JSON.stringify({
  model: a.model.split('/').pop(), threads: Number(a.threads), lowmem: a.lowmem, secondiAudio: n / 44100, blocchi: chunks,
  caricamentoS: Math.round(t1 - t0) / 1000, separazioneS: Math.round(t2 - t1) / 1000, tempoReale: Math.round(((t2 - t1) / 1000 / (n / 44100)) * 100) / 100,
  sdrVoceDb: sdr(out.vocals, 'ref-vocals.f32'), sdrBaseDb: sdr(out.instrumental, 'ref-instrumental.f32'),
  piccoRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
}));
