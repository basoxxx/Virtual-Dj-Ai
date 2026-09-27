// Brano sintetico deterministico (cassa, rullante, charleston, basso, accordi) per i test
// dell'analisi. Lo stesso segnale viene scritto in WAV da ml/beat_this/export_onnx.py per
// calcolare gli output di riferimento in Python.

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function musicClip(sampleRate, seconds, { bpm = 124, offset = 0.25 } = {}) {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  const beat = 60 / bpm;
  const add = (t0, len, fn) => {
    const s0 = Math.round(t0 * sampleRate);
    const n = Math.min(Math.round(len * sampleRate), out.length - s0);
    for (let i = Math.max(0, -s0); i < n; i++) out[s0 + i] += fn(i / sampleRate);
  };
  let seed = 12345;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  // giro di accordi (La minore, Fa, Do, Sol) e note di basso, una battuta ciascuno
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const roots = [45, 41, 36, 43];
  for (let n = 0; offset + n * beat < seconds; n++) {
    const t = offset + n * beat;
    const inBar = n % 4;
    const bar = Math.floor(n / 4);
    // cassa con accento sul primo tempo
    const kickAmp = inBar === 0 ? 0.9 : 0.7;
    add(t, 0.18, (x) => kickAmp * Math.exp(-x / 0.035) * Math.sin(2 * Math.PI * (48 * x + 900 * 0.012 * (1 - Math.exp(-x / 0.012)))));
    // rullante sul 2 e sul 4
    if (inBar === 1 || inBar === 3) add(t, 0.12, (x) => 0.3 * noise() * Math.exp(-x / 0.04) + 0.2 * Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x / 0.03));
    // charleston in levare
    add(t + beat / 2, 0.04, () => 0.12 * noise());
    // basso in ottavi sulla fondamentale
    const f = hz(roots[bar % 4]);
    for (const k of [0, 0.5]) add(t + k * beat, beat * 0.45, (x) => 0.25 * Math.sin(2 * Math.PI * f * x) * Math.min(1, x / 0.005) * Math.exp(-x / 0.2));
    // accordo tenuto su ogni battuta
    if (inBar === 0) {
      for (const m of chords[bar % 4]) add(t, beat * 4, (x) => 0.06 * Math.sin(2 * Math.PI * hz(m) * x) * Math.min(1, x / 0.05));
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const k = 0.89 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/**
 * Riduce a 16 bit come encodeWav e rilegge come soundfile (campione / 32768),
 * così JavaScript e Python partono dagli stessi campioni.
 */
export function toInt16Precision(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    out[i] = Math.trunc(s < 0 ? s * 0x8000 : s * 0x7fff) / 0x8000;
  }
  return out;
}
