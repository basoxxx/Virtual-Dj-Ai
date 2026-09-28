// Worker del pianificatore delle transizioni (modello C, ONNX, solo CPU): riceve gli ingressi
// per battuta dei due deck e restituisce le curve di crossfader, EQ e filtri.
import { loadOrt, fetchModel } from '../js/dsp/ort-loader.js';
import { TM_MAX_BEATS, TM_INPUTS } from '../js/ai/transition-model.js';

// una sessione per modello (stili dance e techno): cambiare stile non ricarica il modello già usato
const sessions = new Map(); // model -> promise di { ort, s }

function session(model) {
  if (!sessions.has(model)) {
    const promise = (async () => {
      const ort = await loadOrt();
      const s = await ort.InferenceSession.create(await fetchModel(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { ort, s };
    })();
    promise.catch(() => sessions.delete(model));
    sessions.set(model, promise);
  }
  return sessions.get(model);
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
