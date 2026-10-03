// Client del worker di analisi (una richiesta alla volta per traccia, in coda).
import { BT_SAMPLE_RATE } from '../dsp/beat-this.js';

// modello Beat This! incluso nell'app (scaricato da npm run models)
export const BEAT_MODEL = 'segueo-analisi-battute.onnx';
// dopo questo tempo senza richieste il worker si chiude: la memoria WASM del modello torna libera
const IDLE_MS = 20000;

let seq = 0;
// refine: 'library' = rifinitura AI di tutta la libreria in background, 'deck' = solo quando il brano va su un deck
const config = { engine: 'classic', model: BEAT_MODEL, refine: 'library' };

/** Motore di analisi del tempo: 'ai' (Beat This!) o 'classic'. */
export function configureAnalysis(patch) {
  Object.assign(config, patch);
}

export function analysisEngine() {
  return config.engine;
}

/** La rifinitura AI si fa in background su tutta la libreria (o solo sui deck)? */
export function refineInBackground() {
  return config.engine === 'ai' && config.refine !== 'deck';
}

/**
 * Analisi ibrida: con il motore AI il classico dà subito i risultati e Beat This! rifinisce poi griglia,
 * battuta forte e struttura. Il brano aspetta la rifinitura? (Mai se la griglia è stata corretta a mano.)
 */
export function needsAiRefine(t) {
  return config.engine === 'ai' && Boolean(t && t.analyzed && t.bpm && !t.analysisFailed && !t.aiRefineFailed)
    && t.bpmEngine !== 'ai' && t.bpmEngine !== 'manual';
}

/** Rifinitura AI di un brano già analizzato: battute, battuta forte, struttura ed energia. */
export function refineWithAi(channels, sampleRate, encoded) {
  return analyze(channels, sampleRate, { engine: 'ai', waveform: false, key: false, bpm: true, encoded });
}

// Più worker in parallelo per l'analisi classica (un core ciascuno, uno lasciato all'interfaccia e all'audio);
// il primo tiene anche la sessione di Beat This!, che usa già più thread da sola.
export const POOL_SIZE = Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));
const pool = []; // { worker, pending, idle }

function spawn(slot) {
  const w = { worker: new Worker(new URL('../../workers/analyzer.js', import.meta.url), { type: 'module' }), pending: new Map(), idle: null };
  w.worker.onmessage = (e) => {
    const p = w.pending.get(e.data.id);
    if (!p) return;
    w.pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
    if (!w.pending.size) scheduleIdle(w, slot);
  };
  w.worker.onerror = (e) => {
    for (const p of w.pending.values()) p.reject(new Error(e.message || 'Errore del worker di analisi'));
    w.pending.clear();
    pool[slot] = null;
  };
  pool[slot] = w;
  return w;
}

/** Worker per una richiesta: Beat This! sempre sul primo, il resto su quello meno occupato. */
function getWorker(ai) {
  let slot = 0;
  if (!ai) {
    let best = Infinity;
    for (let i = 0; i < POOL_SIZE; i++) {
      const load = pool[i] ? pool[i].pending.size : 0;
      // a parità di carico si evita il primo, che può avere la rete neurale al lavoro
      if (load + (i === 0 ? 0.5 : 0) < best) {
        best = load + (i === 0 ? 0.5 : 0);
        slot = i;
      }
    }
  }
  const w = pool[slot] || spawn(slot);
  clearTimeout(w.idle);
  return w;
}

function scheduleIdle(w, slot) {
  clearTimeout(w.idle);
  w.idle = setTimeout(() => {
    if (pool[slot] === w && !w.pending.size) {
      w.worker.terminate();
      pool[slot] = null;
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
  const { encoded, mono22050: given, ...rest } = options;
  const opts = { engine: config.engine, model: config.model, ...rest };
  const ai = opts.engine === 'ai' && opts.bpm !== false;
  let mono22050 = given || null;
  if (ai && !mono22050 && encoded) {
    try {
      mono22050 = await decodeMono22050(encoded);
    } catch (err) {
      console.warn('Decodifica a 22050 Hz per l\'analisi AI non riuscita', err);
    }
  }
  const id = ++seq;
  const w = getWorker(ai);
  // i buffer dell'audio si spostano nel worker senza copiarli (lo stesso buffer può comparire due volte)
  const transfer = [...new Set([...(options.transfer ? channels.map((c) => c.buffer) : []), ...(mono22050 ? [mono22050.buffer] : [])])];
  const result = await new Promise((resolve, reject) => {
    w.pending.set(id, { resolve, reject });
    w.worker.postMessage({ id, channels, sampleRate, options: { ...opts, transfer: undefined }, mono22050 }, transfer);
  });
  if (result.aiError) console.warn(`Analisi AI non riuscita, uso quella classica: ${result.aiError}`);
  return result;
}

/**
 * Analisi di un file della libreria con una sola decodifica, mono a 22050 Hz: basta per BPM, tonalità,
 * energia e struttura (stessi risultati della decodifica a 44,1/48 kHz, ml/REPORT.md) ed è quella che usa
 * Beat This!. Senza forma d'onda: quella si calcola quando il brano va su un deck.
 * @returns {{ res: object, duration: number }}
 */
export async function analyzeBytes(bytes, options = {}) {
  const mono = await decodeMono22050(bytes);
  const duration = mono.length / BT_SAMPLE_RATE;
  const ai = (options.engine || config.engine) === 'ai' && options.bpm !== false;
  const res = await analyze([mono], BT_SAMPLE_RATE, { waveform: false, ...options, mono22050: ai ? mono : undefined, transfer: true });
  return { res, duration };
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
