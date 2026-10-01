// Separazione di voce e base con Demucs v4 (htdemucs_ft, sotto-modello voce; Meta, codice MIT) in ONNX.
// Qui c'è la parte che il modello ONNX non contiene, identica a demucs (ml/mashup/export_demucs.py):
// STFT/ISTFT come HTDemucs._spec/_ispec e divisione in blocchi come demucs.apply.apply_model
// (split=True, overlap 0,25, pesi triangolari, shifts=0). Nessuna dipendenza dal DOM.
import { fft } from './analysis.js';

export const DEMUCS_SR = 44100;
export const DEMUCS_CHUNK = 343980; // 7,8 s: la lunghezza di addestramento di htdemucs
export const DEMUCS_SOURCES = ['drums', 'bass', 'other', 'vocals'];
const NFFT = 4096;
const HOP = 1024;
const BINS = NFFT / 2; // l'ultima frequenza (Nyquist) si scarta
export const DEMUCS_FRAMES = Math.ceil(DEMUCS_CHUNK / HOP); // 336

const WINDOW = (() => {
  const w = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  return w;
})();

// padding "reflect" (senza ripetere il campione di bordo), come F.pad(mode="reflect")
function reflectPad(x, left, right) {
  const n = x.length;
  const out = new Float64Array(n + left + right);
  for (let i = 0; i < out.length; i++) {
    let j = i - left;
    if (j < 0) j = -j;
    if (j >= n) j = 2 * (n - 1) - j;
    out[i] = x[j];
  }
  return out;
}

/**
 * STFT di un canale come HTDemucs._spec: padding di 1,5 hop più il resto dell'ultimo hop, torch.stft
 * (n_fft 4096, hop 1024, Hann, centrata con "reflect", normalizzata), senza Nyquist, frame [2, 2 + le).
 * Scrive reale e immaginario in out[(ch*2 + 0|1) * BINS * T + f * T + t].
 */
export function stftChannel(x, out, ch, T = DEMUCS_FRAMES) {
  const pad = (HOP / 2) * 3;
  const le = Math.ceil(x.length / HOP);
  const a = reflectPad(x, pad, pad + le * HOP - x.length);
  const b = reflectPad(a, NFFT / 2, NFFT / 2); // center=True di torch.stft
  const norm = 1 / Math.sqrt(NFFT);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const baseRe = (ch * 2) * BINS * T;
  const baseIm = (ch * 2 + 1) * BINS * T;
  for (let t = 0; t < T; t++) {
    const s0 = (t + 2) * HOP;
    for (let i = 0; i < NFFT; i++) {
      re[i] = b[s0 + i] * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let f = 0; f < BINS; f++) {
      out[baseRe + f * T + t] = re[f] * norm;
      out[baseIm + f * T + t] = im[f] * norm;
    }
  }
}

/**
 * ISTFT come HTDemucs._ispec: zero su Nyquist e 2 frame vuoti per lato, torch.istft (normalizzata,
 * centrata, somma pesata dalle finestre al quadrato), poi taglio di 1,5 hop. spec: reale e immaginario
 * (BINS × T) di un canale di una sorgente; restituisce `length` campioni.
 */
export function istftChannel(specRe, specIm, length, T = DEMUCS_FRAMES) {
  const pad = (HOP / 2) * 3;
  const frames = T + 4;
  const total = NFFT + HOP * (frames - 1);
  const y = new Float64Array(total);
  const env = new Float64Array(total);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const scale = Math.sqrt(NFFT) / NFFT; // normalized=True e 1/N dell'inversa
  for (let fr = 0; fr < frames; fr++) {
    const t = fr - 2;
    re.fill(0);
    im.fill(0);
    if (t >= 0 && t < T) {
      for (let f = 0; f < BINS; f++) {
        re[f] = specRe[f * T + t];
        im[f] = specIm[f * T + t];
      }
      // spettro hermitiano completo (Nyquist a zero), poi inversa con la FFT diretta coniugando
      for (let f = 1; f < BINS; f++) {
        re[NFFT - f] = re[f];
        im[NFFT - f] = -im[f];
      }
      for (let i = 0; i < NFFT; i++) im[i] = -im[i];
      fft(re, im);
    }
    const s0 = fr * HOP;
    for (let i = 0; i < NFFT; i++) {
      y[s0 + i] += re[i] * scale * WINDOW[i];
      env[s0 + i] += WINDOW[i] * WINDOW[i];
    }
  }
  const out = new Float32Array(length);
  const start = NFFT / 2 + pad; // center=True di torch.istft, poi il taglio di _ispec
  for (let i = 0; i < length; i++) {
    const j = start + i;
    out[i] = j < total && env[j] > 1e-11 ? y[j] / env[j] : 0;
  }
  return out;
}

/** Pesi triangolari di apply_model (massimo al centro del blocco, normalizzati a 1). */
export function chunkWeights(n = DEMUCS_CHUNK) {
  const w = new Float32Array(n);
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) w[i] = i + 1;
  for (let i = half; i < n; i++) w[i] = n - i;
  const max = Math.max(half, n - half);
  for (let i = 0; i < n; i++) w[i] /= max;
  return w;
}

/**
 * Blocco d'ingresso del modello come TensorChunk.padded: `length` campioni da `offset`, completati
 * simmetricamente fino a 343980 con l'audio vicino (zeri fuori dal brano), normalizzati con mean/std.
 */
export function paddedChunk(channels, offset, length, target = DEMUCS_CHUNK, mean = 0, std = 1) {
  const total = channels[0].length;
  const delta = target - length;
  const start = offset - Math.floor(delta / 2);
  const out = channels.map(() => new Float32Array(target));
  for (let c = 0; c < channels.length; c++) {
    const a = Math.max(0, start);
    const b = Math.min(total, start + target);
    // audio normalizzato come il brano intero in demucs; fuori dal brano restano zeri (dopo la normalizzazione)
    for (let i = a; i < b; i++) out[c][i - start] = (channels[c][i] - mean) / std;
  }
  return { chunk: out, trim: Math.floor(delta / 2) };
}

/**
 * Separazione di un brano stereo (Float32Array per canale, 44,1 kHz) in voce e base (mix − voce: con htdemucs
 * è 0,1 dB meglio della somma delle altre sorgenti e risparmia 6 ISTFT su 8 per blocco; il sotto-modello voce di
 * htdemucs_ft ha le altre uscite inservibili). `runCore(mix, spec)` esegue il modello ONNX: mix Float32Array (2 × 343980), spec (4 × 2048 × 336);
 * restituisce { freq: (4 × 4 × 2048 × 336), time: (4 × 2 × 343980) }. onProgress(0..1).
 */
export async function separate(channels, runCore, { onProgress } = {}) {
  const n = channels[0].length;
  // normalizzazione del brano intero come demucs.api / separate
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (channels[0][i] + channels[1][i]);
    sum += m;
    sum2 += m * m;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(1e-12, sum2 / n - mean * mean) * (n / Math.max(1, n - 1)));
  const vocals = [new Float32Array(n), new Float32Array(n)];
  const sumW = new Float32Array(n);
  const weights = chunkWeights();
  const stride = Math.floor(0.75 * DEMUCS_CHUNK);
  const offsets = [];
  for (let o = 0; o < n; o += stride) offsets.push(o);
  const T = DEMUCS_FRAMES;
  const spec = new Float32Array(4 * BINS * T);
  const mix = new Float32Array(2 * DEMUCS_CHUNK);
  for (let k = 0; k < offsets.length; k++) {
    const offset = offsets[k];
    const length = Math.min(DEMUCS_CHUNK, n - offset);
    // normalizzazione blocco per blocco (non una copia dell'intero brano: meno memoria)
    const { chunk, trim } = paddedChunk(channels, offset, length, DEMUCS_CHUNK, mean, std);
    for (let c = 0; c < 2; c++) {
      mix.set(chunk[c], c * DEMUCS_CHUNK);
      stftChannel(chunk[c], spec, c, T);
    }
    const { freq, time } = await runCore(mix, spec);
    // voce, canale c: ISTFT del ramo in frequenza + ramo nel tempo, poi centro del blocco
    const s = DEMUCS_SOURCES.indexOf('vocals');
    for (let c = 0; c < 2; c++) {
      const base = (s * 4 + c * 2) * BINS * T;
      const wave = istftChannel(freq.subarray(base, base + BINS * T), freq.subarray(base + BINS * T, base + 2 * BINS * T), DEMUCS_CHUNK, T);
      const tb = (s * 2 + c) * DEMUCS_CHUNK;
      for (let i = 0; i < length; i++) {
        const j = trim + i;
        vocals[c][offset + i] += weights[i] * (wave[j] + time[tb + j]);
      }
    }
    for (let i = 0; i < length; i++) sumW[offset + i] += weights[i];
    if (onProgress) onProgress((k + 1) / offsets.length);
  }
  for (const ch of vocals) for (let i = 0; i < n; i++) ch[i] = (ch[i] / sumW[i]) * std + mean;
  const inst = vocals.map((ch, c) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = channels[c][i] - ch[i];
    return out;
  });
  return { vocals, instrumental: inst };
}
