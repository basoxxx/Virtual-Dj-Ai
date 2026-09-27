// Beat This! (CPJKU, licenza MIT): parti del modello che girano in JavaScript.
// - frontend identico a beat_this/preprocessing.py (log-mel su audio mono a 22050 Hz)
// - divisione in blocchi da 1500 frame e ricomposizione come beat_this/inference.py
// - post-processing "minimal" di beat_this/model/postprocessor.py
// - griglia a tempo costante (BPM, prima battuta forte, confidenza) ricavata dalle battute
// Nessuna dipendenza dal DOM: usabile nel worker di analisi e nei test Node.
import { fft } from './analysis.js';

export const BT_SAMPLE_RATE = 22050;
export const BT_FPS = 50;
export const BT_CHUNK = 1500;
export const BT_BORDER = 6;
export const BT_MELS = 128;
const N_FFT = 1024;
const HOP = 441;
const F_MIN = 30;
const F_MAX = 11000;
const LOG_MULTIPLIER = 1000;

// scala mel "slaney" (lineare sotto 1 kHz, logaritmica sopra) come torchaudio
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;
const hzToMel = (f) => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP);
const melToHz = (m) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : F_SP * m);

let filterbank = null;

/** Filtri mel triangolari (senza normalizzazione) come torchaudio.functional.melscale_fbanks. */
export function melFilterbank() {
  if (filterbank) return filterbank;
  const nFreqs = N_FFT / 2 + 1;
  const nyquist = Math.floor(BT_SAMPLE_RATE / 2);
  const freqs = new Float64Array(nFreqs);
  for (let k = 0; k < nFreqs; k++) freqs[k] = (nyquist * k) / (nFreqs - 1);
  const mMin = hzToMel(F_MIN);
  const mMax = hzToMel(F_MAX);
  const pts = new Float64Array(BT_MELS + 2);
  for (let i = 0; i < pts.length; i++) pts[i] = melToHz(mMin + ((mMax - mMin) * i) / (BT_MELS + 1));
  // per ogni banda si tengono solo i bin non nulli (le bande si sovrappongono a coppie)
  const bands = [];
  for (let m = 0; m < BT_MELS; m++) {
    const lo = pts[m];
    const mid = pts[m + 1];
    const hi = pts[m + 2];
    let start = -1;
    const w = [];
    for (let k = 0; k < nFreqs; k++) {
      const down = (freqs[k] - lo) / (mid - lo);
      const up = (hi - freqs[k]) / (hi - mid);
      const v = Math.max(0, Math.min(down, up));
      if (v > 0) {
        if (start < 0) start = k;
        w.push(v);
      } else if (start >= 0) break;
    }
    bands.push({ start: Math.max(0, start), weights: Float32Array.from(w) });
  }
  filterbank = bands;
  return bands;
}

/**
 * Spettrogramma log-mel (frame × 128, per righe) di un segnale mono a 22050 Hz:
 * STFT n_fft 1024, hop 441, finestra di Hann, centrata con padding "reflect",
 * normalizzata per la lunghezza del frame, magnitudo, 128 bande mel 30–11000 Hz, log1p(1000·x).
 */
export function logMelSpectrogram(mono) {
  const n = mono.length;
  const pad = N_FFT / 2;
  if (n <= pad) throw new Error('Audio troppo corto per l\'analisi AI');
  const frames = 1 + Math.floor(n / HOP);
  const out = new Float32Array(frames * BT_MELS);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const norm = 1 / Math.sqrt(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const mag = new Float64Array(N_FFT / 2 + 1);
  const bands = melFilterbank();
  // campione i del segnale con riflessione ai bordi (senza ripetere il campione di bordo)
  const at = (i) => {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
    return mono[i];
  };
  for (let f = 0; f < frames; f++) {
    const s0 = f * HOP - pad;
    if (s0 >= 0 && s0 + N_FFT <= n) {
      for (let i = 0; i < N_FFT; i++) {
        re[i] = mono[s0 + i] * win[i];
        im[i] = 0;
      }
    } else {
      for (let i = 0; i < N_FFT; i++) {
        re[i] = at(s0 + i) * win[i];
        im[i] = 0;
      }
    }
    fft(re, im);
    for (let k = 0; k <= N_FFT / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
    const row = f * BT_MELS;
    for (let m = 0; m < BT_MELS; m++) {
      const { start, weights } = bands[m];
      let s = 0;
      for (let j = 0; j < weights.length; j++) s += weights[j] * mag[start + j];
      out[row + m] = Math.log1p(LOG_MULTIPLIER * s);
    }
  }
  return { data: out, frames };
}

/**
 * Inizi dei blocchi come split_piece(avoid_short_end=True): bordo di 6 frame,
 * blocchi consecutivi sovrapposti di 12 frame, l'ultimo allineato alla fine del brano.
 */
export function chunkStarts(frames, chunk = BT_CHUNK, border = BT_BORDER) {
  const starts = [];
  for (let s = -border; s < frames - border; s += chunk - 2 * border) starts.push(s);
  if (frames > chunk - 2 * border) starts[starts.length - 1] = frames - (chunk - border);
  return starts;
}

/** Copia un blocco dello spettrogramma (con zeri fuori dal brano) nel tensore d'ingresso del modello. */
export function fillChunk(spect, frames, start, target, chunk = BT_CHUNK) {
  target.fill(0);
  const from = Math.max(0, start);
  const to = Math.min(frames, start + chunk);
  if (to > from) target.set(spect.subarray(from * BT_MELS, to * BT_MELS), (from - start) * BT_MELS);
  return target;
}

/**
 * Esegue il modello su tutti i blocchi e ricompone i logit del brano ("keep_first":
 * nelle sovrapposizioni vale il blocco precedente). `runChunk` riceve un Float32Array
 * (1500 × 128) e restituisce { beat, downbeat } di 1500 logit ciascuno.
 */
export async function predictLogits(spect, frames, runChunk, { chunk = BT_CHUNK, border = BT_BORDER, onProgress } = {}) {
  const beat = new Float32Array(frames).fill(-1000);
  const downbeat = new Float32Array(frames).fill(-1000);
  const starts = chunkStarts(frames, chunk, border);
  const input = new Float32Array(chunk * BT_MELS);
  // in ordine inverso, così i blocchi precedenti sovrascrivono i successivi
  for (let c = starts.length - 1; c >= 0; c--) {
    const start = starts[c];
    const out = await runChunk(fillChunk(spect, frames, start, input, chunk));
    const from = Math.max(0, start + border);
    const to = Math.min(frames, start + chunk - border);
    for (let t = from; t < to; t++) {
      beat[t] = out.beat[t - start];
      downbeat[t] = out.downbeat[t - start];
    }
    if (onProgress) onProgress((starts.length - c) / starts.length);
  }
  return { beat, downbeat };
}

// massimi locali (±3 frame = ±60 ms) con probabilità > 0,5 (logit > 0)
function peakFrames(logits) {
  const n = logits.length;
  const peaks = [];
  for (let t = 0; t < n; t++) {
    const v = logits[t];
    if (!(v > 0)) continue;
    let max = -Infinity;
    for (let k = Math.max(0, t - 3); k <= Math.min(n - 1, t + 3); k++) if (logits[k] > max) max = logits[k];
    if (v === max) peaks.push(t);
  }
  return peaks;
}

// gruppi di picchi adiacenti (distanza ≤ 1 frame) sostituiti dalla loro media
function deduplicate(peaks, width = 1) {
  const out = [];
  if (!peaks.length) return out;
  let p = peaks[0];
  let c = 1;
  for (let i = 1; i < peaks.length; i++) {
    const p2 = peaks[i];
    if (p2 - p <= width) {
      c++;
      p += (p2 - p) / c;
    } else {
      out.push(p);
      p = p2;
      c = 1;
    }
  }
  out.push(p);
  return out;
}

/** Post-processing "minimal": tempi (s) di battute e battute forti dai logit per frame. */
export function minimalPostprocess(beatLogits, downbeatLogits, fps = BT_FPS) {
  const beats = deduplicate(peakFrames(beatLogits)).map((f) => f / fps);
  let downbeats = deduplicate(peakFrames(downbeatLogits)).map((f) => f / fps);
  if (beats.length) {
    // ogni battuta forte si sposta sulla battuta più vicina
    downbeats = downbeats.map((d) => {
      let best = 0;
      for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - d) < Math.abs(beats[best] - d)) best = i;
      return beats[best];
    });
  }
  downbeats = [...new Set(downbeats)].sort((a, b) => a - b);
  return { beats, downbeats };
}

// retta ai minimi quadrati t = phase + n·period
function fitLine(ns, ts) {
  const m = ns.length;
  let sn = 0;
  let st = 0;
  for (let i = 0; i < m; i++) {
    sn += ns[i];
    st += ts[i];
  }
  const mn = sn / m;
  const mt = st / m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    num += (ns[i] - mn) * (ts[i] - mt);
    den += (ns[i] - mn) ** 2;
  }
  const period = den > 0 ? num / den : 0;
  return { period, phase: mt - period * mn };
}

function rms(ns, ts, phase, period) {
  let s = 0;
  for (let i = 0; i < ns.length; i++) s += (ts[i] - phase - ns[i] * period) ** 2;
  return Math.sqrt(s / Math.max(1, ns.length));
}

// catena più lunga di battute regolari: intervalli ≈ multipli interi dell'intervallo tipico
// (battute mancanti ammesse, battute in più saltate); si interrompe a un cambio di livello metrico
function longestRun(beats, med) {
  let best = { ns: [], ts: [] };
  let cur = { ns: [0], ts: [beats[0]] };
  let n = 0;
  let last = beats[0];
  const close = () => {
    if (cur.ns.length > best.ns.length) best = cur;
  };
  for (let i = 1; i < beats.length; i++) {
    const r = (beats[i] - last) / med;
    const k = Math.round(r);
    if (k >= 1 && Math.abs(r - k) <= 0.15) {
      n += k;
      last = beats[i];
      cur.ns.push(n);
      cur.ts.push(beats[i]);
    } else if (r < 0.85) {
      continue;
    } else {
      close();
      n = 0;
      last = beats[i];
      cur = { ns: [0], ts: [beats[i]] };
    }
  }
  close();
  return best;
}

/**
 * Griglia a tempo costante dalle battute di Beat This!: BPM (con arrotondamento all'intero
 * solo se non peggiora l'aderenza alle battute), offset della prima battuta forte (in [0, 1 battuta)
 * di 4 tempi) e confidenza 0..1 (quota di battute sulla griglia × coerenza delle battute forti).
 * La griglia si stima sulla catena di battute regolari più lunga e poi si estende a tutto il brano,
 * così un tratto in cui il modello cambia livello metrico (es. 80 ↔ 120 in un 12/8) non la sposta.
 */
export function beatGrid(beats, downbeats = [], { min = 70, max = 180, inlier = 0.05 } = {}) {
  if (beats.length < 8) return { bpm: 0, offset: 0, confidence: 0 };
  const ibis = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const med = [...ibis].sort((a, b) => a - b)[Math.floor(ibis.length / 2)];
  if (!(med > 0)) return { bpm: 0, offset: 0, confidence: 0 };
  const run = longestRun(beats, med);
  if (run.ns.length < 8) return { bpm: 0, offset: 0, confidence: 0 };
  let { period, phase } = fitLine(run.ns, run.ts);
  // estensione a tutto il brano: indice dalla griglia corrente, si tengono le battute vicine
  let inN = run.ns;
  let inT = run.ts;
  for (let pass = 0; pass < 4 && period > 0; pass++) {
    const keepN = [];
    const keepT = [];
    for (const t of beats) {
      const k = Math.round((t - phase) / period);
      if (Math.abs(t - phase - k * period) <= inlier) {
        keepN.push(k);
        keepT.push(t);
      }
    }
    if (keepN.length < 8) break;
    inN = keepN;
    inT = keepT;
    ({ period, phase } = fitLine(inN, inT));
  }
  if (!(period > 0)) return { bpm: 0, offset: 0, confidence: 0 };
  let bpm = 60 / period;
  // BPM intero se la griglia arrotondata resta aderente alle battute
  const rounded = Math.round(bpm);
  if (Math.abs(bpm - rounded) < 0.1) {
    const p2 = 60 / rounded;
    let s = 0;
    for (let i = 0; i < inN.length; i++) s += inT[i] - inN[i] * p2;
    const ph2 = s / inN.length;
    if (rms(inN, inT, ph2, p2) <= rms(inN, inT, phase, period) + 0.003) {
      bpm = rounded;
      period = p2;
      phase = ph2;
    }
  }
  if (!Number.isInteger(bpm)) bpm = Math.round(bpm * 100) / 100;
  let onGrid = 0;
  for (const t of beats) {
    const k = Math.round((t - phase) / period);
    if (Math.abs(t - phase - k * period) <= inlier) onGrid++;
  }
  const gridShare = onGrid / beats.length;

  // fase della battuta forte: il residuo modulo 4 più frequente tra le battute forti rilevate
  const votes = [0, 0, 0, 0];
  for (const d of downbeats) {
    const k = Math.round((d - phase) / period);
    if (Math.abs(d - phase - k * period) <= inlier) votes[((k % 4) + 4) % 4]++;
  }
  const totalVotes = votes[0] + votes[1] + votes[2] + votes[3];
  const r = votes.indexOf(Math.max(...votes));
  const downbeatShare = totalVotes ? votes[r] / totalVotes : 0;

  // tempo di riferimento dentro [min, max] (metà o doppio), come l'analisi classica
  let grid = period;
  while (60 / grid < min) grid /= 2;
  while (60 / grid > max) grid *= 2;
  if (grid !== period) bpm = Math.round((60 / grid) * 100) / 100;
  // l'offset resta su una battuta forte vera anche quando il tempo è stato dimezzato o raddoppiato
  const bar = totalVotes ? 4 * Math.max(period, grid) : grid;
  const first = totalVotes ? phase + r * period : phase;
  let offset = first % bar;
  if (offset < 0) offset += bar;
  const confidence = Math.max(0, Math.min(1, gridShare * (totalVotes ? 0.6 + 0.4 * downbeatShare : 0.6)));
  return { bpm, offset, confidence, beatsPerBar: 4, downbeatShare, gridShare };
}

/**
 * Sessione ONNX Runtime del modello (ingresso "spect" 1×1500×128, uscite "beat" e "downbeat").
 * `ort` è il modulo onnxruntime-web (worker) o onnxruntime-web/node (test).
 */
export async function createBeatThisSession(ort, model, options = {}) {
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...options });
  const run = async (input) => {
    const res = await session.run({ spect: new ort.Tensor('float32', input, [1, BT_CHUNK, BT_MELS]) });
    return { beat: res.beat.data, downbeat: res.downbeat.data };
  };
  return { session, run, release: () => session.release() };
}

/** Battute, battute forti e griglia di un brano mono a 22050 Hz. */
export async function trackBeats(runChunk, mono22050, opts = {}) {
  const { data, frames } = logMelSpectrogram(mono22050);
  const logits = await predictLogits(data, frames, runChunk, opts);
  const { beats, downbeats } = minimalPostprocess(logits.beat, logits.downbeat);
  return { beats, downbeats, grid: beatGrid(beats, downbeats, opts) };
}
