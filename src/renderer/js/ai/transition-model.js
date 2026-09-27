// Modello C (sperimentale): pianificatore delle transizioni addestrato su mix di DJ reali (ml/transitions).
// Qui ci sono le parti pure, usate dal worker e dai test: ingressi per battuta dei due deck, identici a
// ml/transitions/build_dataset.py, e lettura delle curve previste battuta per battuta.

export const TM_MAX_BEATS = 128;
export const TM_DECK = 16;
export const TM_INPUTS = 2 * TM_DECK + 3;
// uscite per battuta: crossfader 0..1, EQ del deck uscente e dell'entrante (basso/medio/alto, -1..0 = fino a -30 dB), filtri -1..1
export const TM_CONTROLS = ['crossfader', 'eqA_low', 'eqA_mid', 'eqA_high', 'eqB_low', 'eqB_mid', 'eqB_high', 'filterA', 'filterB'];

const mod = (a, n) => ((a % n) + n) % n;

/**
 * Ingressi di un deck per L battute; identico a deck_block in Python.
 * t, pos, bar: Float64Array/array di L valori; wave: L×4 (peak, low, mid, high); present: L booleani.
 */
export function deckBlock(t, wave, pos, bar, duration, present) {
  const L = t.length;
  const out = new Float32Array(L * TM_DECK);
  for (let j = 0; j < L; j++) {
    if (!present[j]) continue;
    const o = j * TM_DECK;
    for (let c = 0; c < 4; c++) out[o + c] = wave[j * 4 + c];
    out[o + 4 + Math.min(3, Math.max(0, pos[j]))] = 1;
    [8, 16].forEach((period, i) => {
      const ang = (2 * Math.PI * mod(bar[j], period)) / period;
      out[o + 8 + 2 * i] = Math.sin(ang);
      out[o + 9 + 2 * i] = Math.cos(ang);
    });
    out[o + 12] = t[j] / duration;
    out[o + 13] = Math.min(t[j] / 60, 4);
    out[o + 14] = Math.min((duration - t[j]) / 60, 4);
    out[o + 15] = 1;
  }
  return out;
}

/** Media della forma d'onda (computeWaveform: peak, low, mid, high) tra una battuta e la successiva. */
export function perBeatWave(waveform, times, beatSec) {
  const out = new Float32Array(times.length * 4);
  if (!waveform) return out;
  const arrs = [waveform.peak, waveform.low, waveform.mid, waveform.high];
  const rate = waveform.binsPerSecond;
  for (let j = 0; j < times.length; j++) {
    const a = Math.max(0, Math.round(times[j] * rate));
    const b = Math.min(waveform.length, Math.max(a + 1, Math.round((times[j] + beatSec) * rate)));
    if (a >= waveform.length) continue;
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let i = a; i < b; i++) s += arrs[c][i];
      out[j * 4 + c] = s / (b - a);
    }
  }
  return out;
}

/** Battute della griglia del deck (bpm, gridOffset) a partire da `start` secondi: tempi, posizione, battuta. */
export function gridBeats(deck, start, L) {
  const beat = 60 / deck.bpm;
  const k0 = Math.round((start - deck.gridOffset) / beat);
  const t = new Float64Array(L);
  const pos = new Int32Array(L);
  const bar = new Int32Array(L);
  const present = new Array(L);
  for (let j = 0; j < L; j++) {
    const k = k0 + j;
    t[j] = deck.gridOffset + k * beat;
    pos[j] = mod(k, 4);
    bar[j] = Math.floor(k / 4);
    present[j] = t[j] >= 0 && t[j] < deck.duration;
  }
  return { t, pos, bar, present, beat };
}

/**
 * Tensore d'ingresso (128 × 35) e maschera (128) per una transizione di L battute:
 * `from` parte da fromStart secondi, `to` da toStart (come nel piano dell'AI DJ).
 * from/to: { waveform, bpm, gridOffset, duration } del brano (BPM originale, senza pitch).
 */
export function transitionInput(from, fromStart, to, toStart, L) {
  L = Math.max(1, Math.min(TM_MAX_BEATS, Math.round(L)));
  const x = new Float32Array(TM_MAX_BEATS * TM_INPUTS);
  const mask = new Float32Array(TM_MAX_BEATS);
  const decks = [[from, fromStart], [to, toStart]].map(([d, start]) => {
    const g = gridBeats(d, start, L);
    return deckBlock(g.t, perBeatWave(d.waveform, g.t, g.beat), g.pos, g.bar, d.duration, g.present);
  });
  const ratio = Math.log2(to.bpm / from.bpm);
  for (let j = 0; j < L; j++) {
    const o = j * TM_INPUTS;
    x.set(decks[0].subarray(j * TM_DECK, (j + 1) * TM_DECK), o);
    x.set(decks[1].subarray(j * TM_DECK, (j + 1) * TM_DECK), o + TM_DECK);
    x[o + 2 * TM_DECK] = j / L;
    x[o + 2 * TM_DECK + 1] = L / TM_MAX_BEATS;
    x[o + 2 * TM_DECK + 2] = ratio;
    mask[j] = 1;
  }
  return { x, mask, length: L };
}

/** Controlli a una posizione (in battute, anche frazionaria) interpolando le curve previste (L × 9). */
export function curvesAt(curves, length, beat) {
  const b = Math.max(0, Math.min(length - 1, beat));
  const i = Math.floor(b);
  const f = b - i;
  const i2 = Math.min(length - 1, i + 1);
  const v = (c) => curves[i * 9 + c] * (1 - f) + curves[i2 * 9 + c] * f;
  return {
    xf: v(0),
    eqA: [v(1), v(2), v(3)],
    eqB: [v(4), v(5), v(6)],
    filterA: v(7),
    filterB: v(8),
  };
}
