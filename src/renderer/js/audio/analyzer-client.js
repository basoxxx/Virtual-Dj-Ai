// Client del worker di analisi (una richiesta alla volta per traccia, in coda).
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../../workers/analyzer.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Errore del worker di analisi'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

export function analyze(channels, sampleRate, options = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, channels, sampleRate, options });
  });
}

/** Converte il risultato dell'analisi nei campi salvati in libreria. */
export function analysisPatch(res, duration) {
  const patch = { analyzed: true };
  if (duration) patch.duration = duration;
  if (res.beat && res.beat.bpm) {
    patch.bpm = res.beat.bpm;
    patch.gridOffset = res.beat.offset;
  }
  if (res.key) patch.key = res.key.key;
  if (res.loudness) patch.gain = res.loudness.gainDb;
  if (res.energy) patch.energy = res.energy;
  if (res.structure) {
    patch.mixIn = res.structure.mixIn;
    patch.mixOut = res.structure.mixOut;
    patch.introEnd = res.structure.introEnd;
    patch.outroStart = res.structure.outroStart;
    patch.barEnergy = res.structure.barEnergy;
  }
  return patch;
}

/** La traccia ha già tutti i dati che servono all'AI DJ? */
export function isFullyAnalyzed(t) {
  return Boolean(t.analysisFailed || (t.analyzed && t.bpm && t.key && t.energy && t.mixOut));
}
