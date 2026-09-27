// Client del worker di analisi (una richiesta alla volta per traccia, in coda).
import { BT_SAMPLE_RATE } from '../dsp/beat-this.js';

// modello Beat This! incluso nell'app (scaricato da npm run models)
export const BEAT_MODEL = 'beat_this-small0-int8.onnx';
// dopo questo tempo senza richieste il worker si chiude: la memoria WASM del modello torna libera
const IDLE_MS = 20000;

let worker = null;
let seq = 0;
let idleTimer = null;
const pending = new Map();
const config = { engine: 'classic', model: BEAT_MODEL };

/** Motore di analisi del tempo: 'ai' (Beat This!) o 'classic'. */
export function configureAnalysis(patch) {
  Object.assign(config, patch);
}

function getWorker() {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(new URL('../../workers/analyzer.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
      if (!pending.size) scheduleIdle();
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Errore del worker di analisi'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (worker && !pending.size) {
      worker.terminate();
      worker = null;
    }
  }, IDLE_MS);
}

/**
 * Audio mono a 22050 Hz per Beat This!: il file viene decodificato una seconda volta da un
 * OfflineAudioContext a 22050 Hz, che ricampiona con un filtro sinc. Un AudioBufferSourceNode
 * userebbe l'interpolazione lineare senza anti-aliasing: sui brani di prova (ml/REPORT.md)
 * la F-measure delle battute scendeva fino a 0,77 contro 0,99 del ricampionamento sinc.
 */
export async function decodeMono22050(bytes) {
  const ctx = new OfflineAudioContext(1, 1, BT_SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const n = audio.numberOfChannels;
  if (n === 1) return audio.getChannelData(0).slice();
  // da stereo a mono come beat_this: media dei canali
  const out = new Float32Array(audio.length);
  for (let c = 0; c < n; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

/**
 * Analizza un brano. Con il motore "ai" serve anche `encoded` (i byte del file) per
 * l'audio a 22050 Hz; senza, o in caso di errore, il BPM viene dall'analisi classica.
 */
export async function analyze(channels, sampleRate, options = {}) {
  const { encoded, ...rest } = options;
  const opts = { engine: config.engine, model: config.model, ...rest };
  let mono22050 = null;
  if (opts.engine === 'ai' && opts.bpm !== false && encoded) {
    try {
      mono22050 = await decodeMono22050(encoded);
    } catch (err) {
      console.warn('Decodifica a 22050 Hz per l\'analisi AI non riuscita', err);
    }
  }
  const id = ++seq;
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, channels, sampleRate, options: opts, mono22050 }, mono22050 ? [mono22050.buffer] : []);
  });
  if (result.aiError) console.warn(`Analisi AI non riuscita, uso quella classica: ${result.aiError}`);
  return result;
}

/** Converte il risultato dell'analisi nei campi salvati in libreria. */
export function analysisPatch(res, duration) {
  const patch = { analyzed: true };
  if (duration) patch.duration = duration;
  if (res.beat && res.beat.bpm) {
    patch.bpm = res.beat.bpm;
    patch.gridOffset = res.beat.offset;
    patch.bpmEngine = res.beat.engine || 'classic';
    if (res.beat.confidence != null) patch.bpmConfidence = Math.round(res.beat.confidence * 100) / 100;
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
