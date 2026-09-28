// Client del worker del pianificatore delle transizioni (modello C, sperimentale).
import { transitionInput } from './transition-model.js';

export const TRANSITION_MODEL = 'transition-planner-v6-int8.onnx';
// finestra del modello in battute: 128 per v1-v4, 256 dalla v5 (fino a 64 misure)
export const TRANSITION_MODEL_BEATS = 256;

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../../workers/transition.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.curves);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Errore del pianificatore'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/**
 * Curve della transizione (L battute × 9 controlli) dal brano in onda `from` (da fromStart s)
 * al successivo `to` (da toStart s). from/to: { waveform, bpm, gridOffset, duration }.
 */
export async function planCurves(from, fromStart, to, toStart, bars, { timeoutMs = 5000 } = {}) {
  if (!from.waveform || !to.waveform || !(from.bpm > 0) || !(to.bpm > 0)) throw new Error('analisi dei brani incompleta');
  const { x, mask, length } = transitionInput(from, fromStart, to, toStart, bars * 4, TRANSITION_MODEL_BEATS);
  const id = ++seq;
  const curves = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, model: TRANSITION_MODEL, beats: TRANSITION_MODEL_BEATS, x, mask }, [x.buffer, mask.buffer]);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('il modello non ha risposto in tempo'));
    }, timeoutMs);
  });
  return { curves, length };
}
