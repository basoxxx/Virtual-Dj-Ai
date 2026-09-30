// Modello Segueo Chat: parti pure, identiche a ml/segueochat (features.py, data.py, train.py), usate dal worker,
// dall'app e dai test. Testo -> caratteristiche con hash; decisione per un messaggio dalle probabilità delle sue parti.
import { CHAT_HEADS, CHAT_BUCKETS, CHAT_MAX_FEATURES } from './chat-heads.js';

const HEADS = Object.keys(CHAT_HEADS);

/** Minuscole senza accenti, cifre come 0, solo lettere e spazi (come normalize in features.py). */
export function chatNormalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[0-9]/g, '0').replace(/[^a-z0 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Parole, pezzi di 3-5 lettere (con i bordi) e coppie di parole, come feature_strings in features.py. */
export function featureStrings(text) {
  const n = chatNormalize(text);
  const words = n ? n.split(' ') : [];
  const out = [];
  for (const w of words) {
    out.push(`w:${w}`);
    const g = `<${w}>`;
    for (const len of [3, 4, 5]) for (let i = 0; i + len <= g.length; i++) out.push(`c:${g.slice(i, i + len)}`);
  }
  for (let i = 0; i + 1 < words.length; i++) out.push(`b:${words[i]}_${words[i + 1]}`);
  return out.slice(0, CHAT_MAX_FEATURES);
}

/** Indici delle caratteristiche (1..CHAT_BUCKETS); un testo vuoto dà [0]. */
export function chatFeaturize(text) {
  const ids = featureStrings(text).map((f) => (fnv1a(f) % CHAT_BUCKETS) + 1);
  return ids.length ? ids : [0];
}

/** Parti di un messaggio: separate da punteggiatura o da "e", "e poi", "poi", "ma", "e anche" (come split_clauses). */
export function splitClauses(text) {
  return String(text || '').toLowerCase().split(/[,;.!?]+|\s+(?:e poi|e anche|poi|ma|e)\s+/).map((c) => c && c.trim()).filter(Boolean);
}

/** Probabilità di ogni testa dai punteggi in fila del modello. */
export function softmaxHeads(logits) {
  const out = [];
  let o = 0;
  for (const h of HEADS) {
    const n = CHAT_HEADS[h].length;
    let max = -Infinity;
    for (let i = 0; i < n; i++) max = Math.max(max, logits[o + i]);
    const e = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      e.push(Math.exp(logits[o + i] - max));
      sum += e[i];
    }
    out.push(e.map((v) => v / sum));
    o += n;
  }
  return out;
}

const argmax = (a) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);

/**
 * Decisione per un messaggio (come combine in train.py): per ogni testa l'etichetta più sicura tra le parti se supera
 * la soglia delle parti, altrimenti quella del messaggio intero se supera la sua; saluti e fuori tema solo se non c'è
 * nessuna richiesta. Restituisce { testa: etichetta } solo per le teste riconosciute.
 */
export function chatDecide(full, clauses, thresholds) {
  const labels = HEADS.map((h, i) => {
    let best = 0;
    let p = 0;
    for (const c of clauses) {
      const j = argmax(c[i]);
      if (j && c[i][j] > p) [best, p] = [j, c[i][j]];
    }
    if (!(best && p >= thresholds.clause[h])) {
      const j = argmax(full[i]);
      best = j && full[i][j] >= thresholds.full[h] ? j : 0;
    }
    return best;
  });
  const talk = HEADS.indexOf('talk');
  if (labels.some((l, i) => l && i !== talk)) labels[talk] = 0;
  const out = {};
  HEADS.forEach((h, i) => {
    if (labels[i]) out[h] = CHAT_HEADS[h][labels[i]];
  });
  return out;
}

/** Testi da passare al modello per un messaggio: il messaggio intero e, se ne ha più d'una, le sue parti. */
export function chatInputs(text) {
  const parts = splitClauses(text);
  return [String(text || ''), ...(parts.length > 1 ? parts : [])];
}
