// Tagli a raffica. Misure da set reali (ml/REPORT.md, giorno 11): ogni brano suona circa 21 misure
// (mediana), una volta su tre il successivo entra più avanti dell'inizio (spesso intorno alla misura 35, dove di
// solito c'è il drop), e il cambio è secco sul beat invece di una dissolvenza.

export const RAPID = {
  playBars: [16, 24], // misure suonate per brano, sulle frasi da 8: in media 20 come le 21 misurate
  dropShare: 1 / 3, // quota di entrate direttamente sul drop del brano successivo
  phraseBars: 8,
  dropLevel: 0.85, // il drop è la prima frase con energia >= 85% della frase più forte, dopo una più debole
};

/** Energia media di ogni frase da 8 misure dalla forma d'onda (picchi) sulla griglia del brano. */
export function phraseEnergy(wf, bpm, gridOffset, duration) {
  if (!wf || !wf.peak || !(bpm > 0)) return [];
  const phrase = (RAPID.phraseBars * 4 * 60) / bpm;
  const out = [];
  for (let t = gridOffset; t + phrase <= duration; t += phrase) {
    const a = Math.max(0, Math.floor(t * wf.binsPerSecond));
    const b = Math.min(wf.length, Math.floor((t + phrase) * wf.binsPerSecond));
    let sum = 0;
    for (let i = a; i < b; i++) sum += wf.peak[i];
    out.push({ start: t, energy: b > a ? sum / (b - a) : 0 });
  }
  return out;
}

/** Inizio del drop (s): prima frase, dopo la prima, con energia >= dropLevel della massima e un salto rispetto
 * alla precedente; deve restare spazio per suonare almeno 16 misure. null se non c'è. */
export function dropTime(wf, bpm, gridOffset, duration) {
  const ph = phraseEnergy(wf, bpm, gridOffset, duration);
  if (ph.length < 3) return null;
  const max = Math.max(...ph.map((p) => p.energy));
  if (!(max > 0)) return null;
  const minPlay = (16 * 4 * 60) / bpm;
  for (let i = 1; i < ph.length; i++) {
    const p = ph[i];
    if (p.energy >= RAPID.dropLevel * max && ph[i - 1].energy < RAPID.dropLevel * p.energy && p.start + minPlay <= duration) return p.start;
  }
  return null;
}

/**
 * Tempi della transizione a raffica. cur/next: deck { beatLength, gridOffset, duration, position, bpm, waveform },
 * entry: dove il brano in onda è entrato (s nel brano), defaultMixIn: punto d'ingresso normale del successivo.
 * Il cambio dura 1 misura: il successivo parte una misura prima del taglio, così al taglio è sul suo punto d'ingresso.
 */
export function rapidTiming(cur, next, { entry = 0, defaultMixIn = 0, random = Math.random } = {}) {
  const bar = cur.beatLength * 4;
  const playBars = RAPID.playBars[random() < 0.5 ? 0 : 1];
  const off = cur.gridOffset || 0;
  let cut = off + Math.round((entry + playBars * bar - off) / bar) * bar;
  // non prima di adesso (con una misura per il cambio) né oltre la fine del brano
  const earliest = off + Math.ceil((cur.position + bar + 0.25 - off) / bar) * bar;
  cut = Math.min(Math.max(cut, earliest), cur.duration - 0.5);
  const startAt = cut - bar;
  const nextBar = (next.beatLength || cur.beatLength) * 4;
  const drop = random() < RAPID.dropShare ? dropTime(next.waveform, next.bpm, next.gridOffset || 0, next.duration) : null;
  const target = drop != null ? drop : defaultMixIn + nextBar;
  const mixIn = Math.max(0, target - nextBar);
  return { startAt, mixIn, playBars, fromDrop: drop != null, transTrackSec: bar };
}
