// Remix dal vivo: mentre un brano suona da solo l'AI DJ lo ricompone con i comandi del deck
// (loop con slip, eco, filtro, beat jump) sui confini delle frasi della griglia.
// Qui c'è solo la pianificazione, pura e testabile; l'esecuzione è in autodj.js.

export const REMIX_ACTIONS = {
  roll: 'loop roll prima della frase',
  echo: 'eco sulla fine della frase',
  build: 'filtro in salita prima della frase',
  repeat: 'ripete la frase appena suonata',
};

const PHRASE_BARS = 8;

/** Energia (0..1) della battuta di indice `bar`, da barEnergy (ridotta a 256 punti sui brani lunghi). */
export function barEnergyAt(track, bar) {
  const e = track.barEnergy || [];
  if (!e.length || bar < 0) return null;
  const barSec = (60 / track.bpm) * 4;
  const nBars = Math.max(1, Math.floor((track.duration - track.gridOffset) / barSec));
  const step = Math.max(1, Math.ceil(nBars / 256));
  const i = Math.floor(bar / step);
  return i < e.length ? e[i] : null;
}

function phraseEnergy(track, firstBar) {
  let s = 0;
  let n = 0;
  for (let b = firstBar; b < firstBar + PHRASE_BARS; b++) {
    const v = barEnergyAt(track, b);
    if (v != null) {
      s += v;
      n++;
    }
  }
  return n ? s / n : null;
}

/**
 * Prossimo gesto dopo `position` (s) per un brano { bpm, gridOffset, duration, barEnergy }:
 * { action, at, until, boundary } in secondi del brano, oppure { action: 'none', boundary } per saltare
 * la frase, oppure null se non c'è spazio (fine del brano o transizione in arrivo entro 2 frasi).
 */
export function planRemix(track, position, { nextMixAt = Infinity, rate = 0.45, rng = Math.random, last = null } = {}) {
  if (!(track && track.bpm > 0)) return null;
  const beat = 60 / track.bpm;
  const bar = 4 * beat;
  const phrase = PHRASE_BARS * bar;
  const offset = track.gridOffset || 0;
  // prossimo confine di frase con almeno 2 battute di anticipo (il filtro parte 2 battute prima)
  const k = Math.ceil((position + 2 * bar - offset) / phrase - 1e-9);
  const boundary = offset + k * phrase;
  if (boundary + 2 * phrase > track.duration || boundary + 2 * phrase > nextMixAt) return null;
  if (rng() > rate) return { action: 'none', boundary };
  const barIdx = Math.round((boundary - offset) / bar);
  const before = phraseEnergy(track, barIdx - PHRASE_BARS);
  const after = phraseEnergy(track, barIdx);
  const choices = [];
  // pesi: il roll e il filtro preparano una frase più energica, l'eco ne chiude una più calma,
  // la ripetizione allunga una frase molto energica che sta per finire
  const rising = before != null && after != null && after > before + 0.1;
  const falling = before != null && after != null && after < before - 0.1;
  choices.push(['roll', rising ? 3 : 1]);
  choices.push(['build', rising ? 3 : 1]);
  choices.push(['echo', falling ? 3 : 1]);
  if (before != null && before >= 0.8 && falling && barIdx >= PHRASE_BARS) choices.push(['repeat', 3]);
  const pool = choices.filter(([a]) => a !== last);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  let action = pool[0][0];
  for (const [a, w] of pool) {
    r -= w;
    if (r <= 0) {
      action = a;
      break;
    }
  }
  const start = { roll: boundary - beat, echo: boundary - 2 * beat, build: boundary - 2 * bar, repeat: boundary }[action];
  return { action, at: start, until: boundary, boundary, jumpBeats: action === 'repeat' ? -PHRASE_BARS * 4 : 0 };
}
