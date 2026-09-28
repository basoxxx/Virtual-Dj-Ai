// Client del worker del pianificatore delle transizioni (modello C, sperimentale).
import { transitionInput } from './transition-model.js';

// Modelli delle transizioni per stile (pannello AI DJ → Transizioni); beats = finestra del modello in battute
// (128 per v1-v4, 256 dalla v5: fino a 64 misure).
// - dance: imparato dai mix di Gabry Ponte e LUM!X (cambi corti e a tempo, v8)
// - techno: imparato dai DJ set techno/minimal di Mixotic e dal crossfader di Gand (dissolvenze lunghe, v6)
export const TRANSITION_STYLES = {
  model: { file: 'segueo-transizioni-dance-v8.onnx', beats: 256, name: 'dance' },
  'model-techno': { file: 'segueo-transizioni-techno-v6.onnx', beats: 256, name: 'techno' },
};
export const TRANSITION_MODEL = TRANSITION_STYLES.model.file; // stile predefinito
export const TRANSITION_MODEL_BEATS = TRANSITION_STYLES.model.beats;

/** Lo stile di transizione scelto usa un modello AI? */
export function isModelStyle(style) {
  return Object.prototype.hasOwnProperty.call(TRANSITION_STYLES, style);
}

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
 * al successivo `to` (da toStart s). from/to: { waveform, bpm, gridOffset, duration }; style: chiave di
 * TRANSITION_STYLES.
 */
export async function planCurves(from, fromStart, to, toStart, bars, { style = 'model', timeoutMs = 5000 } = {}) {
  if (!from.waveform || !to.waveform || !(from.bpm > 0) || !(to.bpm > 0)) throw new Error('analisi dei brani incompleta');
  const m = TRANSITION_STYLES[style] || TRANSITION_STYLES.model;
  const { x, mask, length } = transitionInput(from, fromStart, to, toStart, bars * 4, m.beats);
  const id = ++seq;
  const curves = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, model: m.file, beats: m.beats, x, mask }, [x.buffer, mask.buffer]);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('il modello non ha risposto in tempo'));
    }, timeoutMs);
  });
  return { curves, length };
}
