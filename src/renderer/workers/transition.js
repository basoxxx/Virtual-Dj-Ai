// Worker del pianificatore delle transizioni (modello C, ONNX, solo CPU): riceve gli ingressi
// per battuta dei due deck e restituisce le curve di crossfader, EQ e filtri.
import { loadOrt, fetchModel } from '../js/dsp/ort-loader.js';
import { TM_MAX_BEATS, TM_INPUTS } from '../js/ai/transition-model.js';

let current = null; // { model, promise }

function session(model) {
  if (!current || current.model !== model) {
    const promise = (async () => {
      const ort = await loadOrt();
      const s = await ort.InferenceSession.create(await fetchModel(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { ort, s };
    })();
    const entry = { model, promise };
    promise.catch(() => {
      if (current === entry) current = null;
    });
    current = entry;
  }
  return current.promise;
}

self.onmessage = async (e) => {
  const { id, model, beats = TM_MAX_BEATS, x, mask } = e.data;
  try {
    const { ort, s } = await session(model);
    const res = await s.run({
      x: new ort.Tensor('float32', x, [1, beats, TM_INPUTS]),
      mask: new ort.Tensor('float32', mask, [1, beats]),
    });
    const curves = new Float32Array(res.controls.data);
    self.postMessage({ id, curves }, [curves.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
