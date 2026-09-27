// Worker di separazione (Demucs v4 in ONNX, solo CPU): riceve un brano stereo a 44,1 kHz e restituisce
// voce e base come file WAV. Si usa un worker per brano e poi si chiude: la memoria WASM del modello
// (circa 3 GB durante la separazione) torna libera.
import { loadOrt, fetchModel } from '../js/dsp/ort-loader.js';
import { separate, DEMUCS_CHUNK, DEMUCS_FRAMES, DEMUCS_SR } from '../js/dsp/demucs.js';
import { encodeWav } from '../js/dsp/wav.js';

self.onmessage = async (e) => {
  const { id, model, left, right } = e.data;
  try {
    const ort = await loadOrt();
    const session = await ort.InferenceSession.create(await fetchModel(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const run = async (mix, spec) => {
      const r = await session.run({
        mix: new ort.Tensor('float32', mix, [1, 2, DEMUCS_CHUNK]),
        spec: new ort.Tensor('float32', spec, [1, 4, 2048, DEMUCS_FRAMES]),
      });
      return { freq: r.freq.data, time: r.time.data };
    };
    const out = await separate([left, right || left], run, { onProgress: (p) => self.postMessage({ id, progress: p }) });
    await session.release();
    const vocals = encodeWav(out.vocals, DEMUCS_SR);
    const instrumental = encodeWav(out.instrumental, DEMUCS_SR);
    self.postMessage({ id, vocals, instrumental }, [vocals.buffer, instrumental.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
