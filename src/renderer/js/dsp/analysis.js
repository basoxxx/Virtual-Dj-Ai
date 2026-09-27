// Analisi audio pura (senza dipendenze dal DOM): usabile in worker, nel renderer e nei test Node.

export function mixToMono(channels) {
  const n = channels[0].length;
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

function onePoleCoef(cutoff, sampleRate) {
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
}

/**
 * Forma d'onda a tre bande (bassi/medi/alti) per la visualizzazione colorata.
 * Restituisce array normalizzati 0..1 con `binsPerSecond` punti al secondo.
 */
export function computeWaveform(mono, sampleRate, binsPerSecond = 150) {
  const samplesPerBin = Math.max(1, Math.round(sampleRate / binsPerSecond));
  const bins = Math.ceil(mono.length / samplesPerBin);
  const peak = new Float32Array(bins);
  const low = new Float32Array(bins);
  const mid = new Float32Array(bins);
  const high = new Float32Array(bins);
  const aLow = onePoleCoef(220, sampleRate);
  const aHigh = onePoleCoef(2800, sampleRate);
  let lp = 0;
  let lp2 = 0;
  let maxPeak = 1e-9;
  let maxBand = 1e-9;
  for (let b = 0; b < bins; b++) {
    const start = b * samplesPerBin;
    const end = Math.min(mono.length, start + samplesPerBin);
    let pk = 0;
    let sl = 0;
    let sm = 0;
    let sh = 0;
    for (let i = start; i < end; i++) {
      const x = mono[i];
      lp += aLow * (x - lp);
      lp2 += aHigh * (x - lp2);
      const hi = x - lp2;
      const md = lp2 - lp;
      const ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
      sl += lp * lp;
      sm += md * md;
      sh += hi * hi;
    }
    const n = Math.max(1, end - start);
    peak[b] = pk;
    low[b] = Math.sqrt(sl / n);
    mid[b] = Math.sqrt(sm / n);
    high[b] = Math.sqrt(sh / n);
    if (pk > maxPeak) maxPeak = pk;
    const m = Math.max(low[b], mid[b], high[b]);
    if (m > maxBand) maxBand = m;
  }
  for (let b = 0; b < bins; b++) {
    peak[b] /= maxPeak;
    low[b] /= maxBand;
    mid[b] /= maxBand;
    high[b] /= maxBand;
  }
  return { binsPerSecond: sampleRate / samplesPerBin, length: bins, peak, low, mid, high };
}

/**
 * Inviluppo di "onset" con spectral flux (FFT): somma degli aumenti di magnitudine
 * logaritmica per banda. Le note tenute non generano falsi attacchi.
 * Restituisce anche il flusso delle sole basse frequenze (cassa) per la fase.
 */
export function onsetEnvelope(mono, sampleRate) {
  const dec = sampleRate >= 32000 ? 2 : 1;
  const sr = sampleRate / dec;
  const hop = 128;
  const N = 1024;
  const len = Math.floor(mono.length / dec);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let j = 0; j < dec; j++) v += mono[i * dec + j];
    x[i] = v / dec;
  }
  const frames = Math.max(0, Math.floor((len - N) / hop));
  const env = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const half = N / 2;
  const maxBin = Math.min(half, Math.floor((8000 / sr) * N));
  const lowBin = Math.max(2, Math.floor((180 / sr) * N));
  let prev = new Float64Array(half);
  let cur = new Float64Array(half);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < maxBin; k++) {
      const m = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBin) lowFlux += d;
      }
    }
    env[f] = f > 0 ? flux : 0;
    lowEnv[f] = f > 0 ? lowFlux : 0;
    const t = prev;
    prev = cur;
    cur = t;
  }
  // un attacco produce il massimo del flusso quando entra nella parte pesata della finestra:
  // lo scarto (misurato) è circa 0,94·N campioni rispetto all'inizio del frame
  return { env: detrend(env), low: detrend(lowEnv), rate: sr / hop, latency: (0.94 * N) / sr };
}

// sottrae la media locale per evidenziare i transienti
function detrend(env) {
  const w = 16;
  const frames = env.length;
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= 2 * w) acc -= env[i - 2 * w];
    const mean = acc / Math.min(i + 1, 2 * w);
    out[i] = Math.max(0, env[i] - mean);
  }
  return out;
}

// preferenza morbida per i tempi più comuni (gaussiana in ottave centrata a 128 BPM)
function tempoPrior(bpm) {
  const oct = Math.log2(bpm / 128);
  return Math.exp(-0.5 * (oct / 0.9) ** 2);
}

function interp(arr, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return 0;
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

function combScore(env, period, maxPhaseOut) {
  // miglior fase e punteggio per un dato periodo in frame
  let best = -1;
  let bestPhase = 0;
  const steps = Math.ceil(period);
  for (let p = 0; p < steps; p++) {
    let s = 0;
    let count = 0;
    for (let x = p; x < env.length - 1; x += period) {
      s += interp(env, x);
      count++;
    }
    s /= Math.max(1, count);
    if (s > best) {
      best = s;
      bestPhase = p;
    }
  }
  if (maxPhaseOut) maxPhaseOut.phase = bestPhase;
  return best;
}

/**
 * Rilevamento BPM e prima battuta (beatgrid).
 * @returns {{bpm:number, offset:number, confidence:number}}
 */
export function detectBpm(mono, sampleRate, { min = 70, max = 180 } = {}) {
  // limita l'analisi ai primi ~4 minuti centrali per velocità
  const maxSamples = sampleRate * 240;
  let segment = mono;
  let segStart = 0;
  if (mono.length > maxSamples) {
    segStart = Math.floor((mono.length - maxSamples) / 2);
    segment = mono.subarray(segStart, segStart + maxSamples);
  }
  const { env, low, rate, latency } = onsetEnvelope(segment, sampleRate);
  if (env.length < rate * 4) return { bpm: 0, offset: 0, confidence: 0 };

  const minLag = Math.floor((60 * rate) / (max * 1.02));
  const maxLag = Math.ceil((60 * rate) / (min * 0.98));
  const ac = new Float32Array(maxLag * 2 + 2);
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  for (let lag = minLag; lag <= Math.min(maxLag * 2, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / (n - lag);
  }
  // punteggio con rinforzo armonico (battuta + doppio della battuta), tollerante
  // ai picchi che cadono tra due ritardi interi
  const acAt = (l, w) => {
    let m = -Infinity;
    for (let k = l - w; k <= l + w; k++) if (k >= minLag && k < ac.length && ac[k] > m) m = ac[k];
    return m === -Infinity ? 0 : m;
  };
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    scores.push({ lag, score: (acAt(lag, 1) + 0.5 * acAt(lag * 2, 2)) * tempoPrior((60 * rate) / lag) });
  }
  // i migliori candidati distinti (massimi locali)
  const peaks = scores
    .filter((x, i) => (i === 0 || x.score >= scores[i - 1].score) && (i === scores.length - 1 || x.score >= scores[i + 1].score))
    .sort((a, b) => b.score - a.score);
  const coarse = [];
  for (const pk of peaks) {
    // posizione frazionaria del picco (interpolazione parabolica)
    const y0 = ac[pk.lag - 1] || 0;
    const y1 = ac[pk.lag];
    const y2 = ac[pk.lag + 1] || 0;
    const den = y0 - 2 * y1 + y2;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    let b = (60 * rate) / (pk.lag + frac);
    while (b < min) b *= 2;
    while (b > max) b /= 2;
    if (coarse.every((c) => Math.abs(c - b) > 2)) coarse.push(b);
    if (coarse.length >= 3) break;
  }
  if (!coarse.length) return { bpm: 0, offset: 0, confidence: 0 };

  // rifinitura fine con pettine su tutto il segmento, valutando anche
  // il doppio e la metà del tempo per risolvere l'ambiguità di ottava
  const refine = (center) => {
    let bestCand = center;
    let bestS = -1;
    // la stima iniziale ha una risoluzione di ~1,5 BPM: si esplora ±3 BPM
    for (let cand = center - 3; cand <= center + 3; cand += 0.05) {
      const s = combScore(env, (60 * rate) / cand);
      if (s > bestS) {
        bestS = s;
        bestCand = cand;
      }
    }
    for (let cand = bestCand - 0.06; cand <= bestCand + 0.06; cand += 0.01) {
      const s = combScore(env, (60 * rate) / cand);
      if (s > bestS) {
        bestS = s;
        bestCand = cand;
      }
    }
    return { bpm: bestCand, score: bestS * tempoPrior(bestCand) };
  };
  let bestBpm = coarse[0];
  let best = -1;
  const tried = [];
  for (const base of coarse) {
    for (const c of [base, base * 2, base / 2]) {
      if (c < min * 0.98 || c > max * 1.02 || tried.some((t) => Math.abs(t - c) < 2)) continue;
      tried.push(c);
      const r = refine(c);
      if (r.score > best) {
        best = r.score;
        bestBpm = r.bpm;
      }
    }
  }
  const rounded = Math.round(bestBpm);
  if (Math.abs(bestBpm - rounded) < 0.08) bestBpm = rounded;
  else bestBpm = Math.round(bestBpm * 100) / 100;

  const period = (60 * rate) / bestBpm;
  const ph = {};
  const score = combScore(env, period);
  combScore(low, period, ph);
  let envMean = 0;
  for (let i = 0; i < n; i++) envMean += env[i];
  envMean /= n;
  const confidence = Math.max(0, Math.min(1, (score / (envMean + 1e-9) - 1) / 3));

  // offset della prima battuta in secondi rispetto all'inizio della traccia
  const beatSec = 60 / bestBpm;
  let offset = (segStart / sampleRate + ph.phase / rate + latency) % beatSec;
  if (offset < 0) offset += beatSec;
  return { bpm: bestBpm, offset, confidence };
}

// --- FFT radix-2 ----------------------------------------------------------

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// --- Tonalità ----------------------------------------------------------------

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Camelot: indice = nota tonica
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export function keyName(tonic, minor) {
  return NOTE_NAMES[((tonic % 12) + 12) % 12] + (minor ? 'm' : '');
}

export function camelot(tonic, minor) {
  const t = ((tonic % 12) + 12) % 12;
  return minor ? CAMELOT_MINOR[t] : CAMELOT_MAJOR[t];
}

export function parseKey(name) {
  if (!name) return null;
  const m = /^([A-G])([#b]?)(m|min|minor)?$/i.exec(name.trim().replace('♯', '#').replace('♭', 'b'));
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return { tonic: (base + acc + 12) % 12, minor: Boolean(m[3]) };
}

/** Trasposizione della tonalità quando si cambia pitch senza keylock. */
export function shiftKey(name, semitones) {
  const k = parseKey(name);
  if (!k) return name;
  return keyName(k.tonic + Math.round(semitones), k.minor);
}

export function camelotOf(key) {
  const k = parseKey(key);
  return k ? camelot(k.tonic, k.minor) : '';
}

/** Compatibilità armonica secondo la ruota Camelot (stesso numero, o ±1 con la stessa lettera). */
export function harmonicMatch(a, b) {
  const ca = camelotOf(a);
  const cb = camelotOf(b);
  if (!ca || !cb) return false;
  const na = parseInt(ca, 10);
  const nb = parseInt(cb, 10);
  if (na === nb) return true;
  if (ca.slice(-1) !== cb.slice(-1)) return false;
  const d = Math.abs(na - nb);
  return d === 1 || d === 11;
}

function correlate(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

export function chromagram(mono, sampleRate) {
  const target = 11025;
  const dec = Math.max(1, Math.floor(sampleRate / target));
  const sr = sampleRate / dec;
  const len = Math.floor(mono.length / dec);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < dec; j++) s += mono[i * dec + j];
    x[i] = s / dec;
  }
  const N = 8192;
  const hop = N;
  const chroma = new Float64Array(12);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const binPc = new Int8Array(N / 2).fill(-1);
  const binW = new Float64Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const nearest = Math.round(midi);
    const dev = Math.abs(midi - nearest);
    if (dev > 0.35) continue;
    binPc[k] = ((nearest % 12) + 12) % 12;
    binW[k] = 1 - dev * 2;
  }
  for (let start = 0; start + N <= len; start += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const frame = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      frame[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * binW[k];
    }
    let s = 0;
    for (let i = 0; i < 12; i++) s += frame[i];
    if (s > 1e-6) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / s;
  }
  return chroma;
}

/** Stima della tonalità (Krumhansl-Schmuckler). */
export function detectKey(mono, sampleRate) {
  const chroma = chromagram(mono, sampleRate);
  let best = { score: -Infinity, tonic: 0, minor: false };
  for (let t = 0; t < 12; t++) {
    const rotated = new Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + t) % 12];
    const sMaj = correlate(rotated, MAJOR_PROFILE);
    const sMin = correlate(rotated, MINOR_PROFILE);
    if (sMaj > best.score) best = { score: sMaj, tonic: t, minor: false };
    if (sMin > best.score) best = { score: sMin, tonic: t, minor: true };
  }
  return {
    key: keyName(best.tonic, best.minor),
    camelot: camelot(best.tonic, best.minor),
    confidence: Math.max(0, best.score),
  };
}

/** Loudness approssimata (RMS in dB) e guadagno per normalizzare a -14 dB RMS. */
export function loudness(mono) {
  let s = 0;
  let count = 0;
  const step = 4;
  for (let i = 0; i < mono.length; i += step) {
    s += mono[i] * mono[i];
    count++;
  }
  const rms = Math.sqrt(s / Math.max(1, count));
  const db = 20 * Math.log10(rms + 1e-9);
  const gainDb = Math.max(-12, Math.min(12, -14 - db));
  return { rmsDb: db, gainDb };
}

/**
 * Struttura del brano per il mix automatico: energia per battuta (bar),
 * fine dell'intro, inizio dell'outro e punti di mix allineati alle frasi da 8 battute.
 */
export function trackStructure(mono, sampleRate, bpm, offset = 0) {
  const duration = mono.length / sampleRate;
  if (!(bpm > 0) || duration < 10) {
    return { mixIn: 0, mixOut: Math.max(0, duration - 12), introEnd: 0, outroStart: duration, barEnergy: [] };
  }
  const bar = (60 / bpm) * 4;
  const nBars = Math.max(1, Math.floor((duration - offset) / bar));
  const energy = new Float32Array(nBars);
  let max = 1e-9;
  for (let b = 0; b < nBars; b++) {
    const start = Math.floor((offset + b * bar) * sampleRate);
    const end = Math.min(mono.length, Math.floor((offset + (b + 1) * bar) * sampleRate));
    let s = 0;
    let n = 0;
    for (let i = start; i < end; i += 8) {
      s += mono[i] * mono[i];
      n++;
    }
    energy[b] = Math.sqrt(s / Math.max(1, n));
    if (energy[b] > max) max = energy[b];
  }
  for (let b = 0; b < nBars; b++) energy[b] /= max;
  const sorted = [...energy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const loud = median * 0.8;
  let first = 0;
  while (first < nBars - 1 && energy[first] < loud) first++;
  let last = nBars - 1;
  while (last > 0 && energy[last] < loud) last--;
  const phrase = 8;
  const introBar = first < 4 ? 0 : first;
  // l'outro inizia alla fine della frase (multipla di 8 battute) che contiene l'ultima battuta "piena"
  let outroBar = Math.ceil((last + 1) / phrase) * phrase;
  if (outroBar > nBars) outroBar = Math.floor(nBars / phrase) * phrase || nBars;
  // punto d'uscita: almeno 16 battute prima della fine, allineato alle frasi
  let mixOutBar = Math.min(outroBar, nBars - 16);
  mixOutBar = Math.max(Math.floor(nBars / 2), Math.floor(mixOutBar / phrase) * phrase);
  if (nBars < 24) mixOutBar = Math.max(0, nBars - 8);
  const barEnergy = [];
  const step = Math.max(1, Math.ceil(nBars / 256));
  for (let b = 0; b < nBars; b += step) barEnergy.push(Math.round(energy[b] * 100) / 100);
  return {
    mixIn: offset,
    mixOut: offset + mixOutBar * bar,
    introEnd: offset + introBar * bar,
    outroStart: offset + Math.min(outroBar, nBars) * bar,
    barEnergy,
    sustained: energy.filter((e) => e > 0.7).length / nBars,
  };
}

/** Livello di energia 1..10 (volume medio e quanto a lungo il brano resta "pieno"). */
export function energyLevel(rmsDb, sustained = 0.5) {
  const loudPart = Math.max(0, Math.min(1, (rmsDb + 24) / 16));
  const e = 1 + 9 * (0.6 * loudPart + 0.4 * Math.max(0, Math.min(1, sustained)));
  return Math.round(e);
}

export function analyzeTrack(channels, sampleRate, { bpm = true, key = true, waveform = true, knownBpm = 0, knownOffset = 0 } = {}) {
  const mono = mixToMono(channels);
  const result = { loudness: loudness(mono) };
  if (waveform) result.waveform = computeWaveform(mono, sampleRate);
  if (bpm) result.beat = detectBpm(mono, sampleRate);
  if (key) result.key = detectKey(mono, sampleRate);
  const b = result.beat && result.beat.bpm ? result.beat : { bpm: knownBpm, offset: knownOffset };
  if (b.bpm > 0) {
    result.structure = trackStructure(mono, sampleRate, b.bpm, b.offset);
    result.energy = energyLevel(result.loudness.rmsDb, result.structure.sustained);
  } else {
    result.energy = energyLevel(result.loudness.rmsDb);
  }
  return result;
}

// --- Utilità di formattazione -------------------------------------------------

export function formatTime(sec, tenths = true) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((sec * 10) % 10)}` : base;
}
