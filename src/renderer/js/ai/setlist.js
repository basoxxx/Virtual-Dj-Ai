// Scalette da file: un DJ set già deciso (brani in ordine e quando cambiare stile) scritto a mano o
// da un assistente come Claude. Qui si legge il file, si trovano i brani nella libreria e si prepara il
// testo da dare a Claude (formato + elenco della libreria). Nessuna dipendenza dal DOM: si prova con node.
import { camelotOf, formatTime } from '../dsp/analysis.js';

export const SETLIST_VERSION = 1;

// valori accettati, in italiano come li scriverebbe una persona (più i nomi interni)
const STYLE_WORDS = [
  ['auto', ['automatica', 'automatico', 'auto', 'ai', 'sceglie l\'ai']],
  ['bassswap', ['bass swap', 'bassswap', 'bass-swap', 'eq', 'scambio dei bassi']],
  ['filter', ['filtro', 'filter', 'filtri']],
  ['echo', ['echo', 'echo out', 'eco']],
  ['fade', ['dissolvenza', 'fade', 'sfumata']],
  ['cut', ['taglio', 'taglio sul beat', 'cut', 'stacco']],
  ['rapid', ['raffica', 'tagli a raffica', 'a raffica', 'rapid']],
  ['model', ['dance', 'modello dance', 'modello ai dance', 'modello', 'model']],
  ['model-techno', ['techno', 'modello techno', 'modello ai techno', 'model-techno', 'mix lunghi']],
];
const STRATEGY_WORDS = [
  ['steady', ['costante', 'mantieni', 'mantieni l\'energia', 'steady', 'stabile']],
  ['rise', ['crescente', 'in crescendo', 'crescendo', 'sali', 'rise']],
  ['wave', ['onde', 'a onde', 'sali e scendi', 'wave']],
  ['chill', ['rilassata', 'rilassato', 'chill', 'tranquilla']],
  ['peak', ['picco', 'energia alta', 'peak']],
];
export const STYLE_LABELS = { auto: 'automatica', bassswap: 'bass swap', filter: 'filtro', echo: 'echo', fade: 'dissolvenza', cut: 'taglio', rapid: 'raffica', model: 'dance', 'model-techno': 'techno' };
export const STRATEGY_LABELS = { steady: 'costante', rise: 'crescente', wave: 'onde', chill: 'rilassata', peak: 'picco' };
const MAX_BARS = 64;

export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

function lookup(table, value) {
  const v = fold(value).replace(/[_]+/g, ' ');
  for (const [id, words] of table) if (id === v || words.includes(v)) return id;
  return null;
}

/** "2:30", "1:02:30", "150", 150 → secondi (null se non è un tempo). */
export function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (!m) return null;
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = fold(v);
  if (['si', 'sì', 'true', 'on', '1', 'vero'].includes(s)) return true;
  if (['no', 'false', 'off', '0', 'falso'].includes(s)) return false;
  return null;
}

/** Impostazioni dell'AI DJ da un oggetto della scaletta (nomi italiani o interni). */
export function optionPatch(o, where, warnings) {
  const patch = {};
  if (!o || typeof o !== 'object') return patch;
  const style = pick(o, 'transizioni', 'transizione', 'stile', 'style');
  if (style !== undefined) {
    const id = lookup(STYLE_WORDS, style);
    if (id) patch.style = id;
    else warnings.push(`${where}: transizioni "${style}" sconosciute (valori: ${Object.values(STYLE_LABELS).join(', ')})`);
  }
  const bars = pick(o, 'battute', 'bars');
  if (bars !== undefined) {
    const n = Math.round(Number(bars));
    if (n >= 1) patch.bars = Math.min(MAX_BARS, n);
    else warnings.push(`${where}: battute "${bars}" non valide`);
  }
  const energy = pick(o, 'energia', 'strategy');
  if (energy !== undefined) {
    const id = lookup(STRATEGY_WORDS, energy);
    if (id) patch.strategy = id;
    else warnings.push(`${where}: energia "${energy}" sconosciuta (valori: ${Object.values(STRATEGY_LABELS).join(', ')})`);
  }
  for (const [key, opt] of [['remix', 'remix'], ['mashup', 'mashup'], ['ritorna_bpm', 'returnTempo'], ['returnTempo', 'returnTempo']]) {
    if (o[key] === undefined) continue;
    const b = bool(o[key]);
    if (b === null) warnings.push(`${where}: "${key}" deve essere true o false`);
    else patch[opt] = b;
  }
  return patch;
}

/** Il JSON dentro un testo qualsiasi (la risposta di Claude può avere ```json e frasi intorno). */
export function extractJson(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error('Nel testo non c\'è una scaletta: manca il blocco { … } in formato JSON');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error('La scaletta è incompleta: manca la parentesi di chiusura');
  const json = body.slice(start, end + 1)
    .replace(/\/\/[^\n"]*$/gm, '') // commenti a fine riga che a volte compaiono negli esempi
    .replace(/,\s*([}\]])/g, '$1'); // virgola dopo l'ultimo elemento
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`La scaletta non è un JSON valido: ${err.message}`);
  }
}

/** "Artista - Titolo" → { artist, title }. */
function splitLabel(s) {
  const m = String(s).match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: String(s).trim() };
}

/**
 * Legge una scaletta (testo o oggetto già letto).
 * @returns {{ title: string, after: 'stop'|'continue', options: object, entries: Array, warnings: string[] }}
 */
export function parseSetlist(input) {
  const data = typeof input === 'string' ? extractJson(input) : input;
  const warnings = [];
  const root = Array.isArray(data) ? { brani: data } : data;
  if (!root || typeof root !== 'object') throw new Error('La scaletta deve essere un oggetto con l\'elenco "brani"');
  const list = pick(root, 'brani', 'tracks', 'scaletta_brani', 'setlist');
  if (!Array.isArray(list) || !list.length) throw new Error('La scaletta non ha brani: serve l\'elenco "brani"');
  const title = String(pick(root, 'scaletta', 'titolo', 'title', 'nome') ?? 'Scaletta');
  const afterRaw = fold(pick(root, 'dopo', 'after') ?? 'fine');
  const after = ['continua', 'continue', 'ai', 'prosegui'].includes(afterRaw) ? 'continue' : 'stop';
  const options = optionPatch(pick(root, 'impostazioni', 'settings') || {}, 'impostazioni', warnings);
  const entries = list.map((raw, i) => {
    const where = `brano ${i + 1}`;
    if (typeof raw === 'string') return { index: i, ...splitLabel(raw), file: '', options: {}, inAt: null, outAt: null, note: '' };
    if (!raw || typeof raw !== 'object') {
      warnings.push(`${where}: formato non valido`);
      return null;
    }
    let title = String(pick(raw, 'titolo', 'title', 'brano') ?? '').trim();
    let artist = String(pick(raw, 'artista', 'artist') ?? '').trim();
    const file = String(pick(raw, 'file', 'percorso', 'path') ?? '').trim();
    if (!title && !file) {
      warnings.push(`${where}: manca il titolo`);
      return null;
    }
    if (title && !artist) ({ artist, title } = splitLabel(title));
    const time = (key, alt) => {
      const v = pick(raw, key, alt);
      if (v === undefined) return null;
      const t = parseTime(v);
      if (t === null) warnings.push(`${where}: ${key} "${v}" non è un tempo (es. "1:30")`);
      return t;
    };
    return {
      index: i, title, artist, file,
      options: optionPatch(raw, where, warnings),
      inAt: time('entrata', 'mixIn'),
      outAt: time('uscita', 'mixOut'),
      note: String(pick(raw, 'nota', 'note') ?? ''),
    };
  }).filter(Boolean);
  return { title, after, options, entries, warnings };
}

// --- ricerca dei brani nella libreria -----------------------------------------------------------

const norm = (s) => fold(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// senza "(Original Mix)", "[Remastered]", "feat. X": per riconoscere lo stesso brano scritto diversamente
const bare = (s) => norm(String(s ?? '').replace(/\s*[([].*?[)\]]/g, ' ').replace(/\s+(feat|ft|featuring)\.?\s+.*$/i, ''));
const baseName = (p) => norm(String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));

function score(entry, t) {
  if (entry.file) {
    const f = norm(entry.file);
    const pth = norm(t.path || '');
    if (pth && (pth === f || pth.endsWith(` ${f}`) || baseName(t.path || '') === baseName(entry.file))) return 10;
    if (!entry.title) return 0;
  }
  const et = norm(entry.title);
  const tt = norm(t.title);
  let s = 0;
  if (et && et === tt) s = 4;
  else if (bare(entry.title) && bare(entry.title) === bare(t.title)) s = 3;
  else if (et.length >= 4 && tt.length >= 4 && (tt.includes(et) || et.includes(tt))) s = 1.5;
  // a volte artista e titolo sono nel nome del file e non nei tag
  else if (et && baseName(t.path || '').includes(et)) s = 1.5;
  if (!s) return 0;
  if (entry.artist) {
    const ea = bare(entry.artist);
    const ta = bare(t.artist) || baseName(t.path || '');
    if (ea && ta && (ta === ea || ta.includes(ea) || ea.includes(ta))) s += 2;
    else if (ea && ta) s -= 1.5;
  }
  return s;
}

/** Trova ogni brano della scaletta nella libreria. */
export function matchEntries(entries, tracks) {
  const found = [];
  const missing = [];
  for (const e of entries) {
    let best = null;
    let bestScore = 0;
    for (const t of tracks) {
      const s = score(e, t);
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    if (best && bestScore >= 2.5) found.push({ entry: e, track: best });
    else missing.push(e);
  }
  return { found, missing };
}

export function entryLabel(e) {
  return e.artist ? `${e.artist} - ${e.title}` : e.title || e.file;
}

/** Descrizione breve delle impostazioni (per il diario). */
export function describeOptions(o) {
  const parts = [];
  if (o.style) parts.push(`transizioni ${STYLE_LABELS[o.style] || o.style}`);
  if (o.bars) parts.push(`${o.bars} battute`);
  if (o.strategy) parts.push(`energia ${STRATEGY_LABELS[o.strategy]}`);
  if (o.remix !== undefined) parts.push(`remix dal vivo ${o.remix ? 'sì' : 'no'}`);
  if (o.mashup !== undefined) parts.push(`mashup ${o.mashup ? 'sì' : 'no'}`);
  if (o.returnTempo !== undefined) parts.push(`ritorno al BPM ${o.returnTempo ? 'sì' : 'no'}`);
  return parts.join(', ');
}

// --- testo per Claude ------------------------------------------------------------------------

export const FORMAT_GUIDE = `FORMATO DELLA SCALETTA (JSON)
{
  "scaletta": "Nome del set",
  "dopo": "fine",
  "impostazioni": { "transizioni": "bass swap", "battute": 16 },
  "brani": [
    { "artista": "Artista", "titolo": "Titolo" },
    { "artista": "Artista", "titolo": "Titolo", "transizioni": "filtro", "battute": 32 },
    { "artista": "Artista", "titolo": "Titolo", "transizioni": "raffica", "entrata": "0:45", "nota": "si alza il ritmo" },
    { "artista": "Artista", "titolo": "Titolo", "uscita": "3:10" }
  ]
}

REGOLE
- "brani": i brani in ordine di uscita. Artista e titolo devono essere scritti come nella libreria.
- Le impostazioni di un brano valgono per la transizione che lo fa entrare e restano per i brani dopo, finché un altro brano non le cambia. Così si decide quando cambia lo stile del set.
- "transizioni": automatica, bass swap, filtro, echo, dissolvenza, taglio, raffica, dance (modello AI), techno (modello AI, mix lunghi).
- "battute": durata del mix, da 4 a 64 (di solito 8, 16 o 32).
- "entrata": da che punto del brano parte (minuti:secondi). "uscita": quando inizia il mix verso il brano dopo. Sono facoltativi: senza, l'AI DJ sceglie i punti giusti sulle frasi.
- "remix" e "mashup": true o false (remix dal vivo; voce del brano dopo sulla base di questo).
- "dopo": "fine" chiude il set con l'ultimo brano, "continua" lascia scegliere all'AI dopo la scaletta.
- "nota": testo libero che compare nel diario dell'AI.
- Rispondi solo con il JSON, senza commenti.`;

/** Una riga per brano: quello che serve a Claude per scegliere (tempo, tonalità, energia, genere, durata). */
export function libraryLines(tracks) {
  return tracks.filter((t) => t && t.title).map((t) => {
    const parts = [`${t.artist ? `${t.artist} - ` : ''}${t.title}`];
    if (t.bpm) parts.push(`${Math.round(t.bpm * 10) / 10} BPM`);
    const cam = camelotOf(t.key);
    if (t.key) parts.push(cam ? `${t.key} (${cam})` : t.key);
    if (t.energy) parts.push(`energia ${t.energy}/10`);
    if (t.genre) parts.push(t.genre);
    if (t.duration) parts.push(formatTime(t.duration, false));
    return parts.join(' | ');
  });
}

/** Il testo da incollare in Claude: richiesta, formato e libreria. */
export function claudePrompt(tracks) {
  const lines = libraryLines(tracks);
  return [
    'Ciao Claude, aiutami a preparare un DJ set per Segueo, il mio software DJ con AI DJ. Segueo mixa da solo: tu decidi i brani, l\'ordine e quando cambiare lo stile delle transizioni.',
    'Se non ti ho ancora descritto la serata (locale, pubblico, durata, generi, andamento dell\'energia), chiedimelo prima di scrivere la scaletta.',
    'Usa solo i brani della mia libreria qui sotto e scrivi artista e titolo esattamente come compaiono. Tieni conto di BPM, tonalità (Camelot) ed energia per mettere vicini brani che stanno bene insieme.',
    'Alla fine dammi il file della scaletta in questo formato:',
    '',
    FORMAT_GUIDE,
    '',
    `LA MIA LIBRERIA (${lines.length} brani: artista - titolo | BPM | tonalità | energia | genere | durata)`,
    ...lines,
  ].join('\n');
}

/** La coda attuale come scaletta (per salvarla o farla ritoccare a Claude). */
export function setlistFromQueue(queue, options, { title = 'Coda di Segueo', after = 'stop', cues = [] } = {}) {
  const pending = cues.filter((c) => !c.used);
  const brani = queue.map((t) => {
    const out = { artista: t.artist || '', titolo: t.title };
    const i = pending.findIndex((c) => c.track === t);
    if (i >= 0) {
      const c = pending.splice(i, 1)[0];
      const o = c.options || {};
      if (o.style) out.transizioni = STYLE_LABELS[o.style];
      if (o.bars) out.battute = o.bars;
      if (o.strategy) out.energia = STRATEGY_LABELS[o.strategy];
      for (const k of ['remix', 'mashup']) if (o[k] !== undefined) out[k] = o[k];
      if (c.inAt != null) out.entrata = formatTime(c.inAt, false);
      if (c.outAt != null) out.uscita = formatTime(c.outAt, false);
      if (c.note) out.nota = c.note;
    }
    return out;
  });
  return {
    scaletta: title,
    dopo: after === 'continue' ? 'continua' : 'fine',
    impostazioni: { transizioni: STYLE_LABELS[options.style] || 'automatica', battute: options.bars, energia: STRATEGY_LABELS[options.strategy] || 'costante' },
    brani,
  };
}
