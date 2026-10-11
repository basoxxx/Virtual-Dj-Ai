// Worker di analisi: BPM, beatgrid, tonalità, forma d'onda e loudness fuori dal thread UI.
// Con il motore "ai" battute e battute forti vengono da Beat This! (onnxruntime-web, solo CPU);
// se il modello manca o dà errore si usa l'analisi classica.
import { analyzeTrack } from '../js/dsp/analysis.js';
import { createBeatThisSession, trackBeats } from '../js/dsp/beat-this.js';
import { loadOrt, fetchModel } from '../js/dsp/ort-loader.js';

let beatThis = null; // { model, promise } della sessione, riusata tra un brano e l'altro

function loadBeatThis(model) {
  if (!beatThis || beatThis.model !== model) {
    if (beatThis) beatThis.promise.then((s) => s.release()).catch(() => {});
    const promise = (async () => createBeatThisSession(await loadOrt(), await fetchModel(model)))();
    const entry = { model, promise };
    promise.catch(() => {
      if (beatThis === entry) beatThis = null;
    });
    beatThis = entry;
  }
  return beatThis.promise;
}

async function aiBeat(mono22050, model) {
  let run;
  try {
    ({ run } = await loadBeatThis(model));
  } catch (err) {
    // modello mancante o rovinato, onnxruntime o WASM che non partono: non dipende dal brano
    throw Object.assign(new Error(String((err && err.message) || err)), { systemic: true });
  }
  const { beats, grid } = await trackBeats(run, mono22050);
  if (!grid.bpm) throw new Error('nessuna battuta riconosciuta');
  return { bpm: grid.bpm, offset: grid.offset, confidence: grid.confidence, engine: 'ai', beats: beats.length };
}

async function handle({ id, channels, sampleRate, options = {}, mono22050 }) {
  try {
    // il client fa partire da qui il tempo massimo della richiesta (le precedenti in coda sono finite)
    self.postMessage({ id, started: true });
    let beat = null;
    let aiError = null;
    let aiSystemic = false;
    if (options.bpm !== false && options.engine === 'ai') {
      try {
        if (!mono22050) throw new Error('audio a 22050 Hz non disponibile');
        beat = await aiBeat(mono22050, options.model);
      } catch (err) {
        aiError = String((err && err.message) || err);
        aiSystemic = Boolean(err && err.systemic);
      }
    }
    const opts = beat ? { ...options, bpm: false, knownBpm: beat.bpm, knownOffset: beat.offset } : options;
    const result = analyzeTrack(channels, sampleRate, opts);
    if (beat) result.beat = beat;
    else if (result.beat) result.beat.engine = 'classic';
    if (aiError) result.aiError = aiError;
    if (aiSystemic) result.aiSystemic = true;
    const wf = result.waveform;
    self.postMessage({ id, result }, wf ? [wf.peak.buffer, wf.low.buffer, wf.mid.buffer, wf.high.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
}

// una richiesta alla volta: la sessione ONNX non accetta esecuzioni sovrapposte
let queue = Promise.resolve();
self.onmessage = (e) => {
  // un errore imprevisto non deve fermare la coda: le richieste successive aspetterebbero per sempre
  queue = queue.then(() => handle(e.data)).catch((err) => console.error('Worker di analisi', err));
};
