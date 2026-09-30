// Worker del modello Segueo Chat (ONNX, solo CPU): riceve le caratteristiche del messaggio e delle sue parti e
// restituisce i punteggi di tutte le teste.
import { loadOrt, fetchModel } from '../js/dsp/ort-loader.js';

let session = null;

function getSession(model) {
  if (!session) {
    session = (async () => {
      const ort = await loadOrt();
      const s = await ort.InferenceSession.create(await fetchModel(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { ort, s };
    })();
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

self.onmessage = async (e) => {
  const { id, model, inputs } = e.data;
  try {
    const { ort, s } = await getSession(model);
    const logits = [];
    for (const ids of inputs) {
      const res = await s.run({ ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]) });
      logits.push(Array.from(res.logits.data));
    }
    self.postMessage({ id, logits });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
