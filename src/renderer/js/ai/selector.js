// Motore decisionale dell'AI DJ (offline, senza dipendenze):
// sceglie il brano successivo e pianifica la transizione come farebbe un DJ.
import { camelotOf } from '../dsp/analysis.js';

export const STRATEGIES = {
  steady: 'Mantieni l\'energia',
  rise: 'Energia crescente',
  wave: 'Onde (sali e scendi)',
  chill: 'Rilassata',
  peak: 'Picco (solo energia alta)',
};

export const TRANSITIONS = {
  auto: 'Automatica (sceglie l\'AI)',
  bassswap: 'Bass swap (EQ)',
  filter: 'Filtro',
  echo: 'Echo out',
  fade: 'Dissolvenza',
  cut: 'Taglio sul beat',
};

/** Rapporto di tempo più vicino a 1 considerando metà/doppio tempo. */
export function tempoRatio(fromBpm, toBpm) {
  if (!fromBpm || !toBpm) return 0;
  let r = fromBpm / toBpm;
  while (r > 1.5) r /= 2;
  while (r < 0.67) r *= 2;
  return r;
}

export function bpmScore(fromBpm, toBpm) {
  const r = tempoRatio(fromBpm, toBpm);
  if (!r) return 0.35;
  const diff = Math.abs(r - 1) * 100; // % di pitch necessario
  if (diff <= 1) return 1;
  if (diff <= 3) return 0.9 - (diff - 1) * 0.05;
  if (diff <= 6) return 0.8 - (diff - 3) * 0.12;
  if (diff <= 10) return 0.44 - (diff - 6) * 0.1;
  return 0;
}

/** Punteggio armonico sulla ruota Camelot. */
export function keyScore(fromKey, toKey) {
  const a = camelotOf(fromKey);
  const b = camelotOf(toKey);
  if (!a || !b) return 0.4;
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  const la = a.slice(-1);
  const lb = b.slice(-1);
  const d = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
  if (na === nb && la === lb) return 1;
  if (na === nb) return 0.9; // relativa maggiore/minore
  if (la === lb && d === 1) return 0.9; // ±1 sulla ruota
  if (la === lb && d === 2) return 0.55; // cambio di energia
  if (la !== lb && d === 1) return 0.45; // diagonale
  if (la === lb && (nb - na + 12) % 12 === 7) return 0.5; // +1 semitono ("energy boost")
  return 0.1;
}

/** Energia desiderata per il prossimo brano (1..10) in base alla strategia e all'avanzamento del set. */
export function targetEnergy(strategy, currentEnergy, step) {
  const cur = currentEnergy || 6;
  switch (strategy) {
    case 'rise':
      return Math.min(10, cur + (step % 2 === 0 ? 1 : 0));
    case 'wave': {
      const phase = Math.sin((step / 6) * Math.PI * 2);
      return Math.max(3, Math.min(10, 6.5 + phase * 3));
    }
    case 'chill':
      return Math.min(cur, 5);
    case 'peak':
      return 9;
    default:
      return cur;
  }
}

function genreSimilarity(a, b) {
  if (!a || !b) return 0.5;
  const ta = new Set(a.toLowerCase().split(/[,/;&]+|\s+/).filter((w) => w.length > 2));
  const tb = b.toLowerCase().split(/[,/;&]+|\s+/).filter((w) => w.length > 2);
  if (!ta.size || !tb.length) return 0.5;
  return tb.some((w) => ta.has(w)) ? 1 : 0.2;
}

/**
 * Valuta un candidato rispetto al brano in onda.
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreCandidate(current, cand, { strategy = 'steady', step = 0, recent = new Set(), random = Math.random } = {}) {
  const reasons = [];
  if (!current) {
    const e = cand.energy || 5;
    const want = strategy === 'peak' ? 9 : strategy === 'chill' ? 3 : 5;
    return { score: 1 - Math.abs(e - want) / 10 + random() * 0.2, reasons: ['brano di apertura'] };
  }
  const b = bpmScore(current.bpm, cand.bpm);
  const k = keyScore(current.key, cand.key);
  const want = targetEnergy(strategy, current.energy, step);
  const e = cand.energy ? 1 - Math.min(1, Math.abs(cand.energy - want) / 5) : 0.5;
  const g = genreSimilarity(current.genre, cand.genre);
  let score = 0.34 * b + 0.3 * k + 0.22 * e + 0.09 * g + 0.05 * random();
  if (current.artist && cand.artist && current.artist === cand.artist) score -= 0.08;
  if (recent.has(cand.id)) score -= 1;
  if (cand.playCount) score -= Math.min(0.05, cand.playCount * 0.005);

  const r = tempoRatio(current.bpm, cand.bpm);
  if (r) reasons.push(`BPM ${cand.bpm.toFixed(0)} (${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%)`);
  if (cand.key) reasons.push(`key ${camelotOf(current.key) || '?'}→${camelotOf(cand.key)}${k >= 0.9 ? ' ✓' : ''}`);
  if (cand.energy) reasons.push(`energia ${current.energy || '?'}→${cand.energy}`);
  return { score, reasons };
}

export function rankCandidates(current, pool, opts = {}) {
  return pool
    .filter((t) => !current || t.id !== current.id)
    .map((t) => ({ track: t, ...scoreCandidate(current, t, opts) }))
    .sort((a, b) => b.score - a.score);
}

/** Costruisce una scaletta concatenando le scelte migliori. */
export function buildSet(pool, { length = 20, strategy = 'steady', seed = null, random = Math.random } = {}) {
  const set = [];
  const recent = new Set();
  let current = seed;
  if (seed) recent.add(seed.id);
  for (let step = 0; step < length; step++) {
    const ranked = rankCandidates(current, pool.filter((t) => !recent.has(t.id)), { strategy, step, recent, random });
    if (!ranked.length) break;
    const pick = ranked[0].track;
    set.push(pick);
    recent.add(pick.id);
    current = pick;
  }
  return set;
}

/**
 * Pianifica la transizione tra due brani.
 * @returns {{type:string, bars:number, sync:boolean, why:string}}
 */
export function planTransition(from, to, { style = 'auto', bars = 16 } = {}) {
  const r = tempoRatio(from && from.bpm, to && to.bpm);
  const pitchNeeded = r ? Math.abs(r - 1) * 100 : 100;
  const canSync = r && pitchNeeded <= 8;
  if (style !== 'auto') {
    return { type: style, bars: style === 'cut' ? 1 : bars, sync: canSync && style !== 'cut', why: 'scelta manuale' };
  }
  if (!canSync) {
    return { type: 'echo', bars: 8, sync: false, why: `tempi troppo diversi (${pitchNeeded.toFixed(0)}%): echo out` };
  }
  const k = keyScore(from.key, to.key);
  const rising = (to.energy || 5) > (from.energy || 5);
  if (k < 0.5) return { type: 'filter', bars: Math.min(bars, 8), sync: true, why: 'tonalità non compatibili: filtro per non far stonare' };
  if (rising) return { type: 'bassswap', bars, sync: true, why: 'energia in salita: bass swap' };
  if ((to.energy || 5) < (from.energy || 5) - 2) return { type: 'fade', bars, sync: true, why: 'si scende di energia: dissolvenza lunga' };
  return { type: Math.random() < 0.6 ? 'bassswap' : 'filter', bars, sync: true, why: 'brani compatibili' };
}

/**
 * Automazione della transizione a un avanzamento p (0..1).
 * Restituisce i valori da applicare: crossfader (-1..1 dal deck uscente all'entrante),
 * EQ bassi (-1..0), filtro (-1..1), livello del player uscente, echo.
 */
export function transitionState(type, p) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t));
  const s = { xf: ease(p), outLow: 0, inLow: 0, outFilter: 0, outPlayer: 1, echo: 0 };
  switch (type) {
    case 'bassswap':
      s.xf = p < 0.5 ? ease(p / 0.5) * 0.5 : 0.5 + ease((p - 0.5) / 0.5) * 0.5;
      s.inLow = p < 0.5 ? -1 : 0;
      s.outLow = p < 0.5 ? 0 : -1;
      break;
    case 'filter':
      s.outFilter = ease(p / 0.9) * 0.85;
      s.xf = ease((p - 0.15) / 0.85);
      break;
    case 'echo':
      s.echo = p >= 0.35 ? 1 : 0;
      s.outPlayer = p >= 0.6 ? 0 : 1;
      s.xf = ease((p - 0.55) / 0.45);
      break;
    case 'cut':
      s.xf = p >= 0.5 ? 1 : 0;
      break;
    default:
      break;
  }
  return s;
}
