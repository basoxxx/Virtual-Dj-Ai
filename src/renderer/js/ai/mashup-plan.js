// Mashup preparati prima del set (scheda MASHUP): calcoli senza DOM né file, usati dalla scheda e dall'AI DJ.
// Un mashup salvato è { id, baseId, vocalId, bars, baseStart, vocalStart }: la voce di un brano entra sulla base
// dell'altro al secondo baseStart della base (null = punto di mix), dal secondo vocalStart del brano della voce.
import { keyScore, bpmScore, tempoRatio } from './selector.js';

export const MASHUP_BARS = [8, 16, 32];
export const DEFAULT_MASHUP_BARS = 16;
// dopo la voce il brano della voce torna completo e la base sfuma in 8 battute
export const FADE_BARS = 8;
// soglia di compatibilità armonica del mashup automatico dell'AI DJ (stessa tonalità, relativa, ±1 Camelot)
export const MASHUP_MIN_KEY = 0.75;
const MAX_PITCH = 8;

/** Durata di una battuta (4 movimenti) in secondi. */
export function barLength(bpm) {
  return 240 / bpm;
}

/** Tonalità e tempo: la voce, agganciata al tempo della base, di quanto cambia velocità (%)? */
export function mashupCompatibility(base, vocal) {
  const key = keyScore(base.key, vocal.key);
  const r = tempoRatio(base.bpm, vocal.bpm);
  const pitch = r ? (r - 1) * 100 : null;
  return {
    known: Boolean(base.key && vocal.key && base.bpm && vocal.bpm),
    keyOk: key >= MASHUP_MIN_KEY,
    tempoOk: pitch != null && Math.abs(pitch) <= MAX_PITCH,
    pitch,
    score: key * bpmScore(base.bpm, vocal.bpm),
  };
}

/** Brani analizzati che fanno coppia con `track` (tonalità compatibile, tempo agganciabile), i migliori prima. */
export function suggestPartners(track, pool, { limit = 6 } = {}) {
  if (!track || !track.bpm || !track.key) return [];
  return pool
    .filter((t) => t && t.id !== track.id && t.bpm && t.key)
    .map((t) => ({ track: t, ...mashupCompatibility(track, t) }))
    .filter((c) => c.keyOk && c.tempoOk)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Inizio (s) della prima frase di 4 battute in cui la voce è ben presente. `samples` è la sola voce (mono),
 * misurata battuta per battuta sulla griglia del brano.
 */
export function vocalEntryFrom(samples, sampleRate, bpm, offset = 0) {
  const bar = barLength(bpm);
  const duration = samples.length / sampleRate;
  const rms = [];
  for (let t = offset; t + bar < duration; t += bar) {
    let s = 0;
    const a = Math.floor(t * sampleRate);
    const b = Math.floor((t + bar) * sampleRate);
    for (let i = a; i < b; i += 4) s += samples[i] * samples[i];
    rms.push(Math.sqrt(s / ((b - a) / 4)));
  }
  const max = Math.max(...rms, 1e-9);
  const first = rms.findIndex((v) => v > 0.3 * max);
  return offset + Math.max(0, Math.floor(Math.max(0, first) / 4) * 4) * bar;
}

/**
 * Punto della base (s, inizio di una battuta) in cui entra la voce se non è scelto a mano: il punto di mix del
 * brano, con spazio per la voce e per la dissolvenza finale.
 */
export function autoBaseStart(track, bars = DEFAULT_MASHUP_BARS) {
  const bar = barLength(track.bpm);
  const offset = track.gridOffset || 0;
  const latest = track.duration - (bars + FADE_BARS) * bar - 0.5;
  const at = Math.min(track.mixOut && track.mixOut < track.duration - 4 ? track.mixOut : latest - 8, latest);
  return offset + Math.max(0, Math.floor((at - offset) / bar + 1e-6)) * bar;
}

/** Numero della battuta (da 1) a quel secondo del brano. */
export function barNumber(sec, track) {
  return Math.round((sec - (track.gridOffset || 0)) / barLength(track.bpm)) + 1;
}

/** Sposta un punto di `bars` battute restando sulla griglia e dentro il brano. */
export function stepPoint(sec, bars, track) {
  const bar = barLength(track.bpm);
  const offset = track.gridOffset || 0;
  const last = Math.max(0, Math.floor((track.duration - offset) / bar) - 1);
  const n = Math.round((sec - offset) / bar) + bars;
  return offset + Math.max(0, Math.min(last, n)) * bar;
}

/**
 * Inizio del mashup salvato nel brano in onda: il punto scelto nella scheda MASHUP (o quello automatico) se è
 * ancora davanti di almeno un secondo, altrimenti null e vale il punto di mix normale.
 */
export function savedStartAt(saved, deck) {
  if (!deck.bpm || !deck.duration) return null;
  const info = { bpm: deck.bpm, gridOffset: deck.gridOffset, duration: deck.duration, mixOut: deck.track && deck.track.mixOut };
  const at = saved.baseStart ?? autoBaseStart(info, saved.bars || DEFAULT_MASHUP_BARS);
  return at >= deck.position + 1 && at < deck.duration - 4 * barLength(deck.bpm) ? at : null;
}
