// Catena dell'app in Node (beat-this.js + onnxruntime-web WASM, 4 thread) su audio mono a 22050 Hz già decodificato.
// Uso: node ml/beat_this/js_check.mjs --model <file.onnx> --list <elenco.json> --out <risultati.json>
//      elenco: [{ "id": ..., "audio": "file.f32" }]; uscita: { id: { beats, downbeats, grid, ms } }
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as ort from 'onnxruntime-web';
import { createBeatThisSession, trackBeats } from '../../src/renderer/js/dsp/beat-this.js';

const { values: a } = parseArgs({ options: { model: { type: 'string' }, list: { type: 'string' }, out: { type: 'string' } } });
ort.env.wasm.numThreads = 4;
const { run, release } = await createBeatThisSession(ort, new Uint8Array(readFileSync(a.model)));
const out = {};
for (const { id, audio } of JSON.parse(readFileSync(a.list, 'utf8'))) {
  const buf = readFileSync(audio);
  const mono = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const t0 = performance.now();
  const { beats, downbeats, grid } = await trackBeats(run, mono);
  out[id] = { beats, downbeats, grid, ms: Math.round(performance.now() - t0), seconds: mono.length / 22050 };
}
await release();
writeFileSync(a.out, JSON.stringify(out));
