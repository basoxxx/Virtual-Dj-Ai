// SegueoChat: si dice a parole all'AI DJ come suonare (energia, stile e durata dei cambi, generi, BPM, coda,
// scalette, mashup) e si chiede cosa sta facendo. Capiscono i messaggi un interprete di comandi in italiano e il
// modello Segueo Chat (ml/segueochat, incluso nell'app), che completa i modi di dire che l'interprete non conosce.
// Tutto gira sul computer; ogni risposta si può annullare.
import { STRATEGIES, TRANSITIONS, NO_FILTERS, hasFilters } from './selector.js';
import { pickPair } from './mashup-plan.js';

/** Minuscole senza accenti, per confronti tolleranti ("più" = "piu"). */
export function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'");
}

const clean = (s) => fold(s).replace(/[^a-z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const NUM_WORDS = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, quindici: 15, sedici: 16, venti: 20, ventiquattro: 24, trenta: 30, trentadue: 32, quaranta: 40,
  quarantotto: 48, cinquanta: 50, sessanta: 60, sessantaquattro: 64,
};
const NUM = `(\\d+|${Object.keys(NUM_WORDS).join('|')})`;
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s] ?? null);

export const BAR_CHOICES = [4, 8, 16, 32, 48, 64];
const nearestBars = (n) => BAR_CHOICES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));

export const STRATEGY_NAMES = { steady: 'costante', rise: 'crescente', wave: 'a onde', chill: 'rilassata', peak: 'picco' };
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** I cambi per i prossimi brani in parole ("transizioni: tagli a raffica "). */
export function describeTemporary(keys, options) {
  return keys.map((k) => (k === 'filters' ? `filtri: ${describeFilters(options.filters) || 'nessuno'}` : lowerFirst(describeAction({ type: 'option', key: k, value: options[k] })))).join(', ');
}

// generi comuni, oltre a quelli presenti nella libreria
const GENRE_VOCAB = ['deep house', 'tech house', 'progressive house', 'afro house', 'melodic house', 'melodic techno', 'hard techno',
  'house', 'techno', 'trance', 'dance', 'pop', 'hip hop', 'rap', 'drum and bass', 'dnb', 'dubstep', 'nu disco', 'italo disco', 'disco',
  'funk', 'edm', 'reggaeton', 'latin', 'afro', 'minimal', 'progressive', 'electro', 'commerciale', 'lounge', 'chill out', 'ambient',
  'rock', 'r&b', 'soul', 'jazz', 'garage', 'breakbeat', 'hardstyle', 'trap', 'eurodance'];
const GENRE_STOP = new Set(['and', 'the', 'mix', 'music', 'musica', 'edit', 'remix', 'version', 'original', 'club', 'radio', 'various', 'other', 'altro']);

/** Generi riconoscibili: quelli comuni più i generi (e le loro parole) presenti nella libreria. */
export function genreVocabulary(tracks = []) {
  const set = new Set(GENRE_VOCAB);
  for (const t of tracks) {
    if (!t || !t.genre) continue;
    for (const g of String(t.genre).split(/[,/;]+/)) {
      const phrase = clean(g);
      if (phrase.length >= 3) set.add(phrase);
      for (const w of phrase.split(' ')) if (w.length >= 3 && !GENRE_STOP.has(w)) set.add(w);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/** Generi nominati in una frase (i più lunghi prima: "deep house" invece di "house"). */
export function findGenres(phrase, vocab) {
  let text = ` ${clean(phrase)} `;
  const found = [];
  for (const g of vocab) {
    const re = new RegExp(` ${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `);
    if (re.test(text)) {
      found.push(g);
      text = text.replace(re, ' ');
    }
  }
  return found;
}

/** Brani che corrispondono a una frase ("golden hour", "golden hour di nova reyes", "nova reyes"), i migliori prima. */
export function matchTracks(query, tracks, limit = 5) {
  const q = clean(query).replace(/^(qualcosa|un pezzo|un brano|una canzone|un po') (di|dei|degli) /, '').replace(/^(il|lo|la|i|gli|le|l') /, '')
    .replace(/ (per favore|grazie|pls)$/, '').trim();
  if (q.length < 2) return [];
  const parts = [];
  for (const sep of [' di ', ' by ', ' - ']) {
    const i = q.indexOf(sep);
    if (i > 0) parts.push([q.slice(0, i).trim(), q.slice(i + sep.length).trim()]);
  }
  const scored = [];
  for (const t of tracks) {
    if (!t) continue;
    const title = clean(t.title);
    const artist = clean(t.artist);
    let s = 0;
    if (title === q || `${artist} ${title}` === q || `${title} ${artist}` === q) s = 100;
    for (const [a, b] of parts) {
      if ((title === a && artist.includes(b)) || (artist === a && title === b)) s = Math.max(s, 95);
    }
    if (!s && title.length >= 3 && q.includes(title) && artist && q.includes(artist)) s = 90;
    if (!s && q.length >= 3 && title.includes(q)) s = 60 + 30 * (q.length / title.length);
    if (!s && title.length >= 4 && q.includes(title)) s = 50 + 20 * (title.length / q.length);
    if (!s && artist && artist === q) s = 45;
    if (s) scored.push({ t, s });
  }
  scored.sort((a, b) => b.s - a.s || String(a.t.title).length - String(b.t.title).length);
  return scored.slice(0, limit).map((x) => x.t);
}

/** Filtri nuovi a partire da quelli attuali e da un'azione {genres, exclude, bpmMin, bpmMax, add, clear}. */
export function mergeFilters(cur = NO_FILTERS, a = {}) {
  if (a.clear) return NO_FILTERS;
  const f = { genres: [...(cur.genres || [])], exclude: [...(cur.exclude || [])], bpmMin: cur.bpmMin || 0, bpmMax: cur.bpmMax || 0 };
  if (a.genres && a.genres.length) {
    f.genres = a.add ? [...new Set([...f.genres, ...a.genres])] : [...a.genres];
    f.exclude = f.exclude.filter((g) => !a.genres.includes(g));
  }
  if (a.exclude && a.exclude.length) {
    f.exclude = [...new Set([...f.exclude, ...a.exclude])];
    f.genres = f.genres.filter((g) => !a.exclude.includes(g));
  }
  if ('bpmMin' in a) f.bpmMin = a.bpmMin || 0;
  if ('bpmMax' in a) f.bpmMax = a.bpmMax || 0;
  if (f.bpmMin && f.bpmMax && f.bpmMin > f.bpmMax) [f.bpmMin, f.bpmMax] = [f.bpmMax, f.bpmMin];
  return f;
}

/** I filtri in parole ("solo techno · niente house · 120–126 BPM"); '' se non ce ne sono. */
export function describeFilters(f) {
  if (!hasFilters(f)) return '';
  const out = [];
  if (f.genres && f.genres.length) out.push(`solo ${f.genres.join(', ')}`);
  if (f.exclude && f.exclude.length) out.push(`niente ${f.exclude.join(', ')}`);
  if (f.bpmMin && f.bpmMax) out.push(`${f.bpmMin}–${f.bpmMax} BPM`);
  else if (f.bpmMin) out.push(`da ${f.bpmMin} BPM in su`);
  else if (f.bpmMax) out.push(`fino a ${f.bpmMax} BPM`);
  return out.join(' · ');
}

const label = (t) => (t ? `${t.artist ? `${t.artist} - ` : ''}${t.title || 'Senza titolo'}` : '—');

/** Un'azione in parole, per la risposta e per il diario dell'AI. */
export function describeAction(a, { playlists = [], tracksById = null } = {}) {
  const name = (id) => (tracksById && tracksById.get(id) ? label(tracksById.get(id)) : id);
  switch (a.type) {
    case 'option':
      switch (a.key) {
        case 'strategy': return `Energia: ${STRATEGY_NAMES[a.value]}`;
        case 'style': return `Transizioni: ${TRANSITIONS[a.value]}`;
        case 'bars': return `Durata del mix: ${a.value} battute`;
        case 'remix': return a.value ? 'Remix dal vivo acceso' : 'Remix dal vivo spento';
        case 'mashup': return a.value ? 'Mashup automatici accesi' : 'Mashup automatici spenti';
        case 'returnTempo': return a.value ? 'Dopo il mix torno al BPM originale' : 'Dopo il mix resto al nuovo BPM';
        case 'mode': return a.value === 'queue' ? 'Suono solo la coda' : 'Scelgo io i brani';
        case 'source': {
          const p = playlists.find((x) => x.id === a.value);
          return p ? `Brani dalla playlist ${p.name}` : 'Brani da tutta la libreria';
        }
        default: return '';
      }
    case 'filters': return a.clear ? 'Filtri tolti: tutti i generi e tutti i BPM' : `Filtri: ${describeFilters(mergeFilters(NO_FILTERS, a)) || 'nessuno'}`;
    case 'control':
      return {
        start: 'AI DJ acceso', stop: 'AI DJ spento', mixNow: 'Mix anticipato alla prossima battuta', skip: 'Prossimo brano cambiato',
        endAfterCurrent: 'Chiudo il set dopo il brano in onda', resume: 'Il set continua',
      }[a.op];
    case 'queue':
      if (a.op === 'clear') return 'Coda svuotata';
      if (a.op === 'shuffle') return 'Coda mescolata';
      return `${{ add: 'In coda', playNext: 'Come prossimo', remove: 'Tolto dalla coda' }[a.op]}: ${a.tracks.map(name).join(', ')}`;
    case 'buildSet': return `Scaletta di ${a.length} brani${a.request ? ` (${a.request})` : ''}`;
    case 'mashup': return a.auto ? 'Mashup scelto da me' : `Mashup: voce di ${name(a.vocalId)} sulla base di ${name(a.baseId)}`;
    case 'temporary': return `Per i prossimi ${a.count} brani: ${a.actions.map((x) => lowerFirst(describeAction(x, { playlists }))).join(', ')}`;
    case 'view': return a.value === 'ai' ? 'Vista AI' : 'Console';
    default: return '';
  }
}

// --- interprete dei comandi -----------------------------------------------------------------------

const RE = {
  question: /\?|^(cosa|che|quale|quali|qual|chi|come|quanto|quando|perche|dove)\b/,
  help: /\b(aiuto|help|cosa sai fare|cosa puoi fare|che comandi|quali comandi|come (ti )?(si )?usa|come funzioni)\b/,
  now: /(cosa|che cosa|che brano|quale brano|che pezzo|cosa sta).{0,20}(suon|in onda|sta andando|sento|stiamo ascoltando)|in onda (ora|adesso)\??$|^che (brano|pezzo) e/,
  next: /(prossimo|dopo)\b.{0,25}\?|cosa (metti|suoni|mixi) dopo|chi (c'e|viene) dopo|qual e il prossimo|quando (mixi|cambi)|quanto manca/,
  why: /\bperche\b/,
  queue: /(cosa c'e|cosa ce|mostra(mi)?|fammi vedere|quali brani|com'e|leggimi).{0,12}\bcoda\b|^coda\??$/,
  settings: /(come stai suonando|come sei impostat|impostazioni attuali|riepilogo|stato del set|situazione|cosa stai facendo|come (va|procede) il set)/,
  thanks: /^(grazie|ok|okay|perfetto|bravo|brava|ottimo|top|va bene|benissimo)\b/,
  hello: /^(ciao|salve|buonasera|buongiorno|hey|ehi)\b/,
};

/**
 * Comandi riconosciuti in un messaggio. ctx: { tracks, playlists, genres (da genreVocabulary), filters (attuali) }.
 * @returns {{actions: object[], notes: string[], words: number, smallTalk: string|null}}
 */
export function parseMessage(text, ctx = {}) {
  const tracks = ctx.tracks || [];
  const playlists = ctx.playlists || [];
  const vocab = ctx.genres || genreVocabulary(tracks);
  const t = fold(text).replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean).length;
  const actions = [];
  const notes = [];
  const add = (a) => actions.push(a);
  const has = (re) => re.test(t);
  let smallTalk = null;

  if (!t) return { actions, notes, words, smallTalk };
  const question = RE.question.test(t);

  // --- domande
  if (has(RE.help)) add({ type: 'info', what: 'help' });
  else if (question || words <= 4) {
    if (has(RE.now)) add({ type: 'info', what: 'now' });
    if (has(RE.why)) add({ type: 'info', what: 'why' });
    else if (has(RE.next)) add({ type: 'info', what: 'next' });
    if (has(RE.queue)) add({ type: 'info', what: 'queue' });
    if (has(RE.settings)) add({ type: 'info', what: 'settings' });
  }
  if (actions.length && question) return { actions, notes, words, smallTalk };

  // --- scaletta: generi, energia e BPM della frase valgono solo per la scaletta
  const setM = t.match(new RegExp(`\\b(crea|creami|fammi|fai|prepara|preparami|costruisci|genera|proponi|voglio)\\b.{0,12}\\b(scaletta|set|playlist|lista)\\b(.*)`));
  if (setM) {
    let rest = setM[3];
    let length = 15;
    const n = rest.match(new RegExp(`\\b(?:di|da|con)? ?${NUM} (?:brani|pezzi|canzoni|tracce)`));
    if (n) {
      length = num(n[1]) || 15;
      rest = rest.replace(n[0], ' ');
    }
    const dur = rest.match(new RegExp(`\\b(?:di|da|per)? ?(un'ora|un ora|mezz'ora|mezzora|${NUM} ore|${NUM} minuti)`));
    if (dur) {
      const minutes = /mezz/.test(dur[1]) ? 30 : /ora$/.test(dur[1]) ? 60 : /ore/.test(dur[1]) ? 60 * num(dur[2]) : num(dur[3]) || 60;
      length = Math.max(3, Math.round(minutes / 3.5));
      rest = rest.replace(dur[0], ' ');
    }
    const sub = parseMessage(rest, { ...ctx, _nested: true });
    const strategy = (sub.actions.find((a) => a.type === 'option' && a.key === 'strategy') || {}).value;
    let f = sub.actions.filter((a) => a.type === 'filters').reduce((acc, a) => mergeFilters(acc, a), NO_FILTERS);
    // in una scaletta basta nominare il genere ("20 brani house")
    const named = findGenres(rest, vocab).filter((g) => !(f.exclude || []).includes(g) && !(f.genres || []).includes(g));
    if (named.length && !(f.genres || []).length) f = mergeFilters(f, { genres: named });
    add({ type: 'buildSet', request: rest.replace(/\s+/g, ' ').replace(/^[\s,:-]*(di|con|per)?\s*/, '').trim(), length: Math.min(60, length), ...(strategy ? { strategy } : {}), ...(hasFilters(f) ? { filters: f } : {}) });
    return { actions, notes, words, smallTalk };
  }

  // --- mashup
  const mv = t.match(/voce di (.+?) (?:sulla|sopra la|sopra alla|su|con la|nella) base di (.+?)(?:[,.;!?]|$| e (?:mettil|accod|suonal))/)
    || t.match(/base di (.+?) (?:e|con) (?:la )?voce di (.+?)(?:[,.;!?]|$)/);
  if (mv) {
    const [vocalQ, baseQ] = /^voce/.test(mv[0]) ? [mv[1], mv[2]] : [mv[2], mv[1]];
    const vocal = matchTracks(vocalQ, tracks)[0];
    const base = matchTracks(baseQ, tracks)[0];
    if (vocal && base && vocal.id !== base.id) add({ type: 'mashup', vocalId: vocal.id, baseId: base.id });
    else notes.push(`Non trovo ${!vocal ? `"${vocalQ}"` : `"${baseQ}"`} nella libreria`);
  } else if (/\b(fai|fammi|crea|creami|proponi|prepara|preparami|voglio) (un |dei |qualche )?mashup\b/.test(t)) {
    // "ogni tanto", "durante la serata": i mashup automatici del set, non uno subito
    if (/ogni tanto|di tanto in tanto|ogni (qualche|tot|\d+) (brani|pezzi|canzoni)|durante (la serata|il set|la festa)/.test(t)) add({ type: 'option', key: 'mashup', value: true });
    else add({ type: 'mashup', auto: true });
  }

  // --- controlli
  const endSet = /(chiudi|finisci|termina|concludi|chiudiamo|finiamo) (il set|la serata|qui|cosi)|ultimo brano|(fermati|stop|basta|finisci|chiudi) dopo (questo|questa|il brano|la canzone)|dopo questo (basta|stop|fine|chiudi)/.test(t);
  if (endSet) add({ type: 'control', op: 'endAfterCurrent' });
  else if (/(non chiudere|non finire|continua (il set|a suonare|pure)|vai avanti|andiamo avanti|riprendi il set)/.test(t)) add({ type: 'control', op: 'resume' });
  else if (/(^|\s)(fermati|fermo|stop|smetti|basta cosi)\b|(ferma|spegni|disattiva) (tutto|l'ai|l'ai dj|il dj|la musica|l'automix)/.test(t)) add({ type: 'control', op: 'stop' });
  else if (/(^|\s)(parti|partiamo|inizia|iniziamo|comincia|cominciamo|start|via)\b|(accendi|avvia|attiva|fai partire|metti in moto) (l'ai|l'ai dj|il dj|la musica|il set|l'automix)|\b(mixa|suona|fai) tu\b/.test(t)) add({ type: 'control', op: 'start' });
  if (/(mixa|cambia|passa|vai|mix) (ora|adesso|subito|al prossimo|al prossimo brano)|anticipa (il )?mix|questo (brano |pezzo )?non mi piace|basta con questo/.test(t)) add({ type: 'control', op: 'mixNow' });
  if (/(cambia|scarta|salta|non mi piace) (il )?prossimo|(un altro|altro) prossimo|prossimo no\b/.test(t)) add({ type: 'control', op: 'skip' });

  // --- vista
  if (/(vista|schermata) (ai|dell'ai)|mostra(mi)? (la )?vista ai/.test(t)) add({ type: 'view', value: 'ai' });
  else if (/(torna|passa|vai) (alla|in) console|vista console|mostra(mi)? la console/.test(t)) add({ type: 'view', value: 'console' });

  // --- opzioni: energia (vince l'ultima nominata)
  const strategyRe = [
    ['rise', /piu energi|piu carich|alza (l'|la )?energia|energia crescente|in crescendo|crescendo|sempre piu|fai salire|spingi|pompa|carica la pista|scalda(re)? la pista|scaldiamo|parte (soft|piano|tranquill).{0,30}(esplod|sale|cresc)|poi esplod/g],
    ['peak', /picco|massima energia|al massimo|a palla|peak ?time|spacca|pista esplosiva|fai esplodere|solo (pezzi|brani) (forti|energici|carichi)/g],
    ['chill', /rilass|chill|tranquill|calm|\bsoft\b|morbid|meno energi|abbassa (l'|la )?energia|piu leggero|piu leggera|sottofondo|aperitivo/g],
    ['wave', /\bonde\b|a onde|sali e scendi|su e giu|alterna/g],
    ['steady', /mantieni|stessa energia|energia costante|energia stabile|costante|non cambiare (l'|la )?energia/g],
  ];
  let strategy = null;
  let at = -1;
  for (const [value, re] of strategyRe) {
    for (const m of t.matchAll(re)) if (m.index > at) [strategy, at] = [value, m.index];
  }
  // "parte soft e poi esplode": conta dove si vuole arrivare
  if (/(parte|parti|inizia|comincia) (soft|piano|tranquill|calm|rilassat).{0,40}(esplod|sale|sal[ie]re|cresc|spinge|carica)/.test(t)) strategy = 'rise';
  if (strategy) add({ type: 'option', key: 'strategy', value: strategy });

  // --- filtri: togli, BPM, generi
  const clearFilters = /(togli|rimuovi|azzera|cancella|leva|niente|senza) (i |tutti i )?filtri|qualsiasi genere|tutti i generi|ogni genere|qualunque genere/.test(t);
  if (clearFilters) add({ type: 'filters', clear: true });
  const bpm = {};
  let m = t.match(/(?:tra|fra) (?:i )?(\d{2,3}) e (?:i )?(\d{2,3}) ?bpm/) || t.match(/da (\d{2,3}) a (\d{2,3}) ?bpm/);
  if (m) Object.assign(bpm, { bpmMin: Number(m[1]), bpmMax: Number(m[2]) });
  if ((m = t.match(/(?:sotto|meno di|massimo|max|fino a|non oltre) (?:i |ai )?(\d{2,3}) ?bpm/))) bpm.bpmMax = Number(m[1]);
  if ((m = t.match(/(?:sopra|piu di|almeno|minimo|min|oltre) (?:i |ai )?(\d{2,3}) ?bpm/))) bpm.bpmMin = Number(m[1]);
  if ((m = t.match(/(?:intorno|attorno|circa|sui|sugli) (?:a |ai |agli )?(\d{2,3}) ?bpm/))) Object.assign(bpm, { bpmMin: Number(m[1]) - 3, bpmMax: Number(m[1]) + 3 });
  if (/qualsiasi bpm|tutti i bpm|ogni bpm/.test(t)) Object.assign(bpm, { bpmMin: 0, bpmMax: 0 });
  for (const k of Object.keys(bpm)) if (bpm[k] && (bpm[k] < 50 || bpm[k] > 220)) delete bpm[k];

  const optionWords = /^(il |i |la |le |lo |l'|un |una )?(remix|mashup|filtr|energi|transizion|mix|coda|prossimo|brano|pezzo|vista|console|scaletta|musica$|modello|ai\b|eco\b|echo|taglio|tagli|dissolvenz|bass)/;
  const exclude = [];
  for (const em of t.matchAll(/\b(?:niente|senza|evita|evitiamo|basta|non voglio|non mettere|non suonare|togli|no)\s+(?:la |il |i |le |l'|piu )?(?:musica |brani |pezzi |roba )?([a-z0-9&' ]{3,40})/g)) {
    if (optionWords.test(em[1])) continue;
    exclude.push(...findGenres(em[1].split(/,| e | ma | per | poi /)[0], vocab));
  }
  const include = [];
  let addGenres = false;
  for (const im of t.matchAll(/\b(?:solo|soltanto|suona|suoniamo|suonami|metti|mettiamo|mettimi|voglio|vorrei|facciamo|passa(?:re)? (?:a|al|alla|alle)|vai (?:di|con)|dammi|genere|anche|piu)\s+(?:un po' di |un po di |della |del |di |la |il |i |le |l'|musica |brani |pezzi |roba |qualcosa di )?([a-z0-9&' ]{3,40})/g)) {
    if (optionWords.test(im[1])) continue;
    const found = findGenres(im[1].split(/,| ma | per | poi | e poi /)[0], vocab).filter((g) => !exclude.includes(g));
    if (found.length) {
      include.push(...found);
      if (/^(anche|piu)\b/.test(im[0])) addGenres = true;
    }
  }
  // "solo techno" è un genere; "techno" nei cambi ("transizioni techno") è uno stile e si gestisce sotto
  const styleTechno = /(stile|modello|transizioni|mix|cambi) (ai )?(da |in stile )?techno/.test(t);
  const genreAction = {};
  if (include.length && !(styleTechno && include.every((g) => g === 'techno'))) Object.assign(genreAction, { genres: [...new Set(include)], ...(addGenres ? { add: true } : {}) });
  if (exclude.length) genreAction.exclude = [...new Set(exclude)];
  if (Object.keys(genreAction).length || Object.keys(bpm).length) add({ type: 'filters', ...genreAction, ...bpm });

  // --- opzioni: stile dei cambi
  const styleRe = [
    ['rapid', /raffica|tagli veloci|cambi velocissimi/],
    ['model-techno', /(stile|modello|transizioni|mix|cambi) (ai )?(da |in stile )?techno|mix lunghi techno/],
    ['model', /stile dance|modello (ai )?dance|(transizioni|cambi) (in stile )?dance|(usa|con) il modello (ai|delle transizioni)/],
    ['bassswap', /bass ?swap|scambio (dei |di )?bassi|con (gli )?eq\b|equalizzat/],
    ['echo', /\b(echo|eco)\b/],
    ['fade', /dissolvenz|\bfade\b|sfumat|sfuma\b/],
    ['cut', /\b(tagli netti|taglio netto|cut|stacco secco|stacchi secchi)\b|(transizioni|cambi|mix) (con|a) tagli?\b|\btaglio sul (beat|battere)/],
    ['filter', /(transizioni|cambi|mix|usa il|con il|con i|metti il) (con )?(il )?filtr[oi]|\bfiltro\b(?! (dei|sui|per) (generi|bpm))/],
    ['auto', /transizioni automatiche|(decidi|scegli) tu (le transizioni|lo stile|come mixare|i cambi)/],
  ];
  if (!clearFilters || /(transizioni|cambi|mix) (con|col) (il )?filtro/.test(t)) {
    const style = styleRe.find(([, re]) => re.test(t));
    if (style) add({ type: 'option', key: 'style', value: style[0] });
  }

  // --- opzioni: durata del mix
  const barsM = t.match(new RegExp(`\\b${NUM} battute`));
  if (barsM && !/(prossim[ei]|per) ?(i |le )?\S* ?(brani|pezzi)/.test(barsM.input.slice(0, barsM.index))) {
    const n = num(barsM[1]);
    if (n) add({ type: 'option', key: 'bars', value: nearestBars(n) });
  } else if (/(transizioni|mix|cambi|stacchi|dissolvenze|sfumate) (molto lung|lunghissim)/.test(t)) add({ type: 'option', key: 'bars', value: 64 });
  else if (/(transizioni|mix|cambi|dissolvenze|sfumate) (piu )?lung/.test(t)) add({ type: 'option', key: 'bars', value: 32 });
  else if (/(transizioni|mix|cambi|dissolvenze) (piu )?(cort|brev|veloc|rapid)/.test(t)) add({ type: 'option', key: 'bars', value: 8 });

  // --- opzioni: interruttori
  const toggle = (key, word) => {
    if (new RegExp(`(spegni|disattiva|togli|niente|senza|basta|no|non (fare|usare|voglio))( il| i| col| con il| i| gli| l'| la)? ${word}`).test(t)) add({ type: 'option', key, value: false });
    else if (new RegExp(`(attiva|accendi|metti|usa|voglio|fai|riattiva)( il| i| gli| l'| la| anche il| anche i)? ${word}|${word} (on|acceso|attivo|si)\\b`).test(t)) add({ type: 'option', key, value: true });
  };
  toggle('remix', 'remix');
  if (!actions.some((a) => a.type === 'mashup' || a.key === 'mashup')) toggle('mashup', 'mashup( automatic[io])?');
  if (/(torna|tornare|riporta) al (suo )?(bpm|tempo) originale/.test(t)) add({ type: 'option', key: 'returnTempo', value: true });
  else if (/(resta|rimani|tieni) (al|sul) (nuovo )?(bpm|tempo)|non tornare al (bpm|tempo)/.test(t)) add({ type: 'option', key: 'returnTempo', value: false });

  // --- opzioni: modalità e sorgente
  if (/(segui|suona) (solo )?(la )?coda|solo (i brani )?(della|in|dalla) coda/.test(t)) add({ type: 'option', key: 'mode', value: 'queue' });
  else if (/(scegli|decidi) tu (i brani|cosa suonare|la musica|cosa mettere)|fai tu la scaletta/.test(t)) add({ type: 'option', key: 'mode', value: 'ai' });
  // "usa la playlist X" cambia la sorgente; "aggiungi Y alla playlist X" non è un comando della chat
  const plM = t.match(/(?:usa|suona|scegli dalla|pesca dalla|brani dalla|solo dalla|^dalla|, dalla| dalla) (?:la )?playlist ["']?([^"',.;!?]+)/);
  if (plM) {
    const want = clean(plM[1]);
    const p = playlists.find((x) => clean(x.name) === want) || playlists.find((x) => want.includes(clean(x.name)) || clean(x.name).includes(want));
    if (p) add({ type: 'option', key: 'source', value: p.id });
    else notes.push(`Non trovo la playlist "${plM[1].trim()}"`);
  } else if (/(tutta la libreria|dalla libreria|qualsiasi brano|tutti i brani)/.test(t)) add({ type: 'option', key: 'source', value: 'library' });

  // --- coda
  if (/(svuota|cancella|pulisci|azzera) (la |tutta la )?coda/.test(t)) add({ type: 'queue', op: 'clear' });
  if (/(mescola|rimescola|shuffle)( la)? coda/.test(t)) add({ type: 'queue', op: 'shuffle' });
  const rm = t.match(/(?:togli|rimuovi|leva|cancella) (.+?) dalla coda/);
  if (rm) {
    const found = matchTracks(rm[1], tracks, 1);
    if (found.length) add({ type: 'queue', op: 'remove', tracks: [found[0].id] });
    else notes.push(`Non trovo "${rm[1]}"`);
  }
  const nx = t.match(/(?:metti|suona|fai partire|voglio sentire|mettimi|mettici)? ?(.+?) (?:come prossimo|come prossima|subito dopo|per prossimo|dopo questo|dopo questa)\b/)
    || t.match(/(?:dopo (?:questo|questa)|come prossimo|il prossimo)[, ]+(?:metti|suona|fai partire|voglio)?(?: sentire)? ?(.+)/);
  let queued = false;
  if (nx) {
    const q = nx[1].replace(/^(metti|suona|fai partire|mettimi|mettici) /, '');
    const found = matchTracks(q, tracks, 1);
    if (found.length && !optionWords.test(q)) {
      add({ type: 'queue', op: 'playNext', tracks: [found[0].id] });
      queued = true;
    }
  }
  if (!queued && !rm) {
    for (const qm of t.matchAll(/\b(?:metti|mettimi|mettici|aggiungi|accoda|suona|suonami|voglio sentire|fammi sentire|fai sentire)\s+(?:anche\s+)?(.+?)(?= in coda| alla coda| e poi |,|;|$)/g)) {
      const q = qm[1];
      if (optionWords.test(q) || findGenres(q, vocab).length && !matchTracks(q, tracks, 1).length) continue;
      const found = matchTracks(q, tracks, 1);
      if (found.length) add({ type: 'queue', op: 'add', tracks: [found[0].id] });
      else if (!actions.length && q.split(' ').length <= 6) notes.push(`Non trovo "${q}" nella libreria`);
    }
  }

  // --- "per i prossimi N brani": le opzioni di questo messaggio valgono solo per un po'
  const tempM = t.match(new RegExp(`per (?:i |le )?(?:prossim[ie]) ${NUM} (?:brani|pezzi|canzoni|tracce)`)) || (/per (il |la )?prossim[oa] (brano|pezzo|canzone)/.test(t) && ['', '1']);
  if (tempM) {
    const count = num(tempM[1]) || 1;
    const inner = actions.filter((a) => a.type === 'option' || (a.type === 'filters' && !a.clear));
    if (inner.length) {
      for (const a of inner) actions.splice(actions.indexOf(a), 1);
      add({ type: 'temporary', count: Math.min(20, count), actions: inner });
    }
  }

  if (!actions.length && !ctx._nested && words <= 4) {
    if (RE.thanks.test(t)) smallTalk = 'thanks';
    else if (RE.hello.test(t)) smallTalk = 'hello';
  }
  return { actions, notes, words, smallTalk };
}

// --- richieste riconosciute dal modello Segueo Chat: diventano azioni se l'interprete non le ha già capite ---------

const BARS_OF = { short: 8, long: 32, verylong: 64 };

/** Teste del modello già coperte dalle azioni dell'interprete (per non contraddirlo). */
function coveredHeads(actions) {
  const out = new Set();
  const one = (a) => {
    if (a.type === 'option') out.add(a.key === 'mashup' ? 'mashupOpt' : a.key);
    else if (a.type === 'filters') out.add('genre');
    else if (a.type === 'buildSet') ['set', 'strategy', 'genre'].forEach((h) => out.add(h));
    else if (a.type === 'temporary') {
      out.add('temporary');
      a.actions.forEach(one);
    } else out.add(a.type === 'mashup' ? 'mashup' : a.type);
  };
  actions.forEach(one);
  return out;
}

/** Brani nominati in un messaggio, nell'ordine in cui compaiono (titoli di almeno 3 lettere). */
function mentionedTracks(text, tracks) {
  const t = ` ${clean(text)} `;
  const found = [];
  for (const tr of tracks) {
    const title = clean(tr.title);
    if (title.length < 3) continue;
    const i = t.indexOf(` ${title} `);
    if (i >= 0) found.push({ tr, i });
  }
  return found.sort((a, b) => a.i - b.i || String(b.tr.title).length - String(a.tr.title).length).map((x) => x.tr);
}

/**
 * Azioni dalle richieste riconosciute dal modello (labels = { testa: etichetta }), per le teste che l'interprete
 * non ha già coperto. Titoli, generi e numeri si leggono sempre dalla frase, come fa l'interprete.
 * @returns {{actions: object[], notes: string[], added: boolean}}
 */
export function intentsToActions(labels, text, ctx, ruleActions = []) {
  const covered = coveredHeads(ruleActions);
  const t = fold(text);
  const want = (h) => labels[h] && !covered.has(h);
  const extra = [];
  const notes = [];
  const genres = findGenres(text, ctx.genres || genreVocabulary(ctx.tracks || []));
  // le azioni che cancellano o fermano qualcosa, se le chiede solo il modello, vogliono le parole giuste nella frase
  const isSet = want('set') && labels.set === 'build' && /\b(scalett\w*|set|playlist|lista|brani|pezzi|canzoni|tracce|serata)\b/.test(t);
  if (labels.control === 'stop' && !/\b(ferm\w*|stop\w*|spegn\w*|spegni|basta|smett\w*|blocc\w*|interromp\w*|fine|pausa)\b/.test(t)) delete labels.control;
  // "che tempo fa?" parla del meteo, non del BPM
  if (labels.returnTempo && /\btempo (fa|fara|c'e|fuori)\b|\bmeteo\b/.test(t)) delete labels.returnTempo;
  if (isSet) {
    const n = t.match(new RegExp(`\\b${NUM} (?:brani|pezzi|canzoni|tracce)`));
    const hours = t.match(new RegExp(`(un'ora|un ora|mezz'ora|${NUM} ore)`));
    let length = n ? num(n[1]) || 15 : 15;
    if (!n && hours) length = /mezz/.test(hours[1]) ? 9 : /ore/.test(hours[1]) ? Math.round((60 * (num(hours[2]) || 1)) / 3.5) : 17;
    extra.push({
      type: 'buildSet', request: text.trim(), length: Math.min(60, length),
      ...(labels.strategy ? { strategy: labels.strategy } : {}), ...(genres.length && labels.genre !== 'exclude' ? { filters: mergeFilters(NO_FILTERS, { genres }) } : {}),
    });
  }
  if (!isSet && want('strategy')) extra.push({ type: 'option', key: 'strategy', value: labels.strategy });
  if (want('style')) extra.push({ type: 'option', key: 'style', value: labels.style });
  if (want('bars')) extra.push({ type: 'option', key: 'bars', value: BARS_OF[labels.bars] });
  if (want('remix')) extra.push({ type: 'option', key: 'remix', value: labels.remix === 'on' });
  if (want('mashupOpt')) extra.push({ type: 'option', key: 'mashup', value: labels.mashupOpt === 'on' });
  if (want('returnTempo')) extra.push({ type: 'option', key: 'returnTempo', value: labels.returnTempo === 'on' });
  if (want('mode')) extra.push({ type: 'option', key: 'mode', value: labels.mode });
  if (!isSet && want('genre')) {
    if (labels.genre === 'clear') extra.push({ type: 'filters', clear: true });
    else if (genres.length) extra.push({ type: 'filters', ...(labels.genre === 'exclude' ? { exclude: genres } : { genres, ...(labels.genre === 'add' ? { add: true } : {}) }) });
  }
  if (want('control')) extra.push({ type: 'control', op: labels.control });
  if (want('queue')) {
    if (['clear', 'shuffle'].includes(labels.queue)) extra.push({ type: 'queue', op: labels.queue });
    else {
      const tr = mentionedTracks(text, ctx.tracks || [])[0] || matchTracks(text, ctx.tracks || [], 1)[0];
      if (tr) extra.push({ type: 'queue', op: labels.queue, tracks: [tr.id] });
      else notes.push('Non ho capito quale brano: dimmi il titolo come compare nella libreria');
    }
  }
  if (want('mashup')) {
    if (labels.mashup === 'auto') extra.push({ type: 'mashup', auto: true });
    else {
      const [a, b] = mentionedTracks(text, ctx.tracks || []);
      if (a && b) {
        // la voce è il brano nominato più vicino a "voce"
        const iv = t.indexOf('voce');
        const pos = (tr) => Math.abs(t.indexOf(fold(tr.title)) - iv);
        const [vocal, base] = iv >= 0 && pos(b) < pos(a) ? [b, a] : [a, b];
        extra.push({ type: 'mashup', vocalId: vocal.id, baseId: base.id });
      } else notes.push('Per il mashup dimmi il brano della voce e quello della base (es. "voce di X sulla base di Y")');
    }
  }
  if (want('info')) extra.push({ type: 'info', what: labels.info });
  if (want('view')) extra.push({ type: 'view', value: labels.view });
  let actions = [...ruleActions, ...extra];
  // "per i prossimi N brani": le opzioni e i filtri di questo messaggio valgono solo per un po'
  if (want('temporary') && labels.temporary === 'yes') {
    const inner = actions.filter((a) => a.type === 'option' || (a.type === 'filters' && !a.clear));
    if (inner.length) {
      const m = t.match(new RegExp(`\\b${NUM} (?:brani|pezzi|canzoni|tracce)`));
      const count = m ? num(m[1]) || 2 : /prossim[oa] (brano|pezzo|canzone|traccia)/.test(t) ? 1 : /paio/.test(t) ? 2 : 3;
      actions = [...actions.filter((a) => !inner.includes(a)), { type: 'temporary', count: Math.min(20, count), actions: inner }];
    }
  }
  return { actions, notes, added: extra.length > 0 || actions.some((a) => a.type === 'temporary' && !ruleActions.includes(a)) };
}

export const HELP = [
  'Energia: "più energia", "in crescendo", "rilassata", "a onde", "picco"',
  'Transizioni: "bass swap", "con il filtro", "echo", "dissolvenze", "tagli a raffica", "stile dance", "stile techno"',
  'Durata: "transizioni lunghe", "mix corti", "32 battute"',
  'Generi e BPM: "solo techno", "niente house", "tra 120 e 126 BPM", "togli i filtri"',
  'Brani: "metti Golden Hour come prossimo", "aggiungi Night Drive", "svuota la coda"',
  'Set: "crea una scaletta di 20 brani house in crescendo", "chiudi il set dopo questo", "per i prossimi 3 brani tagli a raffica"',
  'Mashup: "fai un mashup", "voce di Golden Hour sulla base di Glass City"',
  'Comandi: "parti", "fermati", "mixa ora", "cambia il prossimo"',
  'Domande: "cosa suoni?", "qual è il prossimo?", "perché?", "cosa c\'è in coda?", "come stai suonando?"',
];

// --- la chat ------------------------------------------------------------------------------------------

export class SegueoChat extends EventTarget {
  /**
   * env: automix (AutoDJ), mashups (MashupManager, facoltativo), model (ChatModel, facoltativo), getTracks(),
   * getPlaylists(), setOptions(patch) (opzioni dell'AI DJ, salvate), setView(view), random.
   */
  constructor(env) {
    super();
    this.env = env;
    this.messages = [];
    this.busy = false;
    this.seq = 0;
  }

  get automix() {
    return this.env.automix;
  }

  /** Chi capisce i messaggi: interprete e modello Segueo Chat (incluso nell'app); senza modello solo l'interprete. */
  get engine() {
    return this.env.model && this.env.model.available ? { id: 'model', label: 'modello Segueo Chat' } : { id: 'rules', label: 'comandi integrati' };
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  push(msg) {
    const m = { id: ++this.seq, at: new Date(), ...msg };
    this.messages.push(m);
    if (this.messages.length > 80) this.messages.shift();
    this.emit();
    return m;
  }

  clear() {
    this.messages = [];
    this.emit();
  }

  context() {
    const tracks = this.env.getTracks();
    const playlists = this.env.getPlaylists();
    if (this.vocabFor !== tracks || this.vocabSize !== tracks.length) {
      this.vocab = genreVocabulary(tracks);
      this.vocabFor = tracks;
      this.vocabSize = tracks.length;
    }
    return { tracks, playlists, genres: this.vocab, tracksById: new Map(tracks.map((t) => [t.id, t])), filters: this.automix.options.filters };
  }

  /**
   * Che cosa chiede un messaggio, senza eseguirlo: azioni dell'interprete, completate dal modello Segueo Chat con
   * quelle che l'interprete non ha capito.
   */
  async understand(msg, ctx = this.context()) {
    const parsed = parseMessage(msg, ctx);
    let { actions } = parsed;
    const notes = [...parsed.notes];
    let engine = 'rules';
    if (this.env.model && this.env.model.available) {
      try {
        const labels = await this.env.model.predict(msg);
        if (labels) {
          const res = intentsToActions(labels, msg, ctx, actions);
          if (res.added) {
            actions = res.actions;
            engine = 'model';
          }
          if (!actions.length) notes.push(...res.notes);
          if (!parsed.smallTalk && !actions.length && labels.talk) parsed.smallTalk = labels.talk;
        }
      } catch {
        // senza modello resta l'interprete
      }
    }
    return { actions, notes, parsed, engine };
  }

  /** Un messaggio del DJ: si capisce, si esegue e si risponde (con annullamento). */
  async send(text) {
    const msg = String(text || '').trim();
    if (!msg || this.busy) return null;
    this.push({ role: 'user', text: msg });
    const ctx = this.context();
    this.busy = true;
    let understood;
    try {
      understood = await this.understand(msg, ctx);
    } finally {
      this.busy = false;
    }
    const { actions, notes, parsed, engine } = understood;
    const result = await this.apply(actions, ctx);
    const text2 = this.compose({ reply: null, result, notes, parsed, engine });
    const answer = this.push({ role: 'assistant', text: text2, lines: result.lines, errors: result.errors, undo: result.undo, engine });
    if (result.lines.length) this.automix.say(`SegueoChat: ${result.lines.join(' · ')}`);
    return answer;
  }

  /** Scaletta da una descrizione a parole ("house in crescendo per un aperitivo"): genere, energia e durata capiti come in chat. */
  async planSet(description, { length = 15 } = {}) {
    const ctx = this.context();
    const text = String(description || '').trim();
    const { actions } = await this.understand(text ? `crea una scaletta di ${length} brani ${text}` : `crea una scaletta di ${length} brani`, ctx);
    const set = actions.find((a) => a.type === 'buildSet') || { length };
    const tracks = await this.automix.generateSet({
      length: set.length || length, strategy: set.strategy || this.automix.options.strategy, filters: set.filters || this.automix.options.filters,
    });
    return { tracks, strategy: set.strategy || null, filters: set.filters || null };
  }

  compose({ reply, result, notes, parsed, engine }) {
    const parts = [];
    if (reply) parts.push(reply);
    if (result.infos.length) parts.push(...result.infos);
    if (!reply && result.lines.length) parts.push(result.infos.length ? '' : 'Fatto.');
    if (notes.length) parts.push(...notes);
    if (result.errors.length) parts.push(...result.errors);
    if (!parts.filter(Boolean).length) {
      if (parsed.smallTalk === 'thanks') parts.push('Prego! Dimmi pure se vuoi cambiare qualcosa.');
      else if (parsed.smallTalk === 'offtopic') parts.push('Qui mi occupo solo della musica: dimmi come vuoi che suoni (energia, transizioni, generi, brani) o chiedimi cosa sto facendo.');
      else if (parsed.smallTalk === 'hello') parts.push('Ciao! Dimmi come vuoi che suoni: energia, transizioni, generi, brani. Scrivi "aiuto" per qualche esempio.');
      else parts.push('Non ho capito. Prova per esempio "più energia", "transizioni lunghe", "solo techno", "metti Golden Hour come prossimo" o scrivi "aiuto".');
    }
    return parts.filter(Boolean).join('\n');
  }

  /** Esegue le azioni e prepara l'annullamento (opzioni, filtri, coda, chiusura del set, mashup creati). */
  async apply(actions, ctx = this.context()) {
    const a = this.automix;
    const lines = [];
    const infos = [];
    const errors = [];
    const before = { options: { ...a.options }, temp: a.temp ? { remaining: a.temp.remaining, restore: { ...a.temp.restore } } : null, queue: [...a.queue], endAfterCurrent: a.endAfterCurrent, mashups: [] };
    let changed = false;
    const describe = (x) => describeAction(x, ctx);
    const setOpt = (patch) => {
      this.env.setOptions(patch);
      changed = true;
    };
    for (const x of actions) {
      try {
        switch (x.type) {
          case 'option':
            setOpt({ [x.key]: x.value });
            lines.push(describe(x));
            break;
          case 'filters':
            setOpt({ filters: mergeFilters(a.options.filters, x) });
            lines.push(x.clear ? describe(x) : `Filtri: ${describeFilters(a.options.filters) || 'nessuno'}`);
            break;
          case 'temporary': {
            const patch = {};
            let f = a.options.filters;
            for (const y of x.actions) {
              if (y.type === 'option') patch[y.key] = y.value;
              else f = mergeFilters(f, y);
            }
            if (f !== a.options.filters) patch.filters = f;
            a.setTemporary(patch, x.count);
            changed = true;
            lines.push(describe(x));
            break;
          }
          case 'control':
            if (x.op === 'start') a.setEnabled(true);
            else if (x.op === 'stop') a.setEnabled(false);
            else if (x.op === 'mixNow') {
              if (!a.enabled) {
                errors.push('L\'AI DJ è spento: dimmi "parti" per farlo mixare.');
                break;
              }
              if (a.transition || !a.plan || !Number.isFinite(a.plan.startAt)) {
                errors.push(a.transition ? 'Sto già mixando.' : 'Non ho ancora un brano pronto da mixare: tra un attimo sì.');
                break;
              }
              a.mixNow();
            } else if (x.op === 'skip') {
              if (!a.enabled || a.transition || a.selecting) {
                errors.push(!a.enabled ? 'L\'AI DJ è spento: non ho un prossimo brano da cambiare.' : 'Sto già mixando o scegliendo: riprova tra un attimo.');
                break;
              }
              await a.skipNext();
            } else if (x.op === 'endAfterCurrent') {
              if (!a.enabled || !a.current()) {
                errors.push('Non sta suonando niente: non c\'è un set da chiudere.');
                break;
              }
              a.setEndAfterCurrent(true);
              changed = true;
            } else if (x.op === 'resume') {
              a.setEndAfterCurrent(false);
              if (!a.enabled) a.setEnabled(true);
              changed = true;
            }
            lines.push(describe(x));
            break;
          case 'queue':
            if (x.op === 'add') a.enqueue(x.tracks.map((id) => ctx.tracksById.get(id)).filter(Boolean));
            else if (x.op === 'playNext') {
              a.queue.unshift(...x.tracks.map((id) => ctx.tracksById.get(id)).filter(Boolean));
              a.replanNext();
            } else if (x.op === 'remove') a.setQueue(a.queue.filter((t) => !x.tracks.includes(t.id)));
            else if (x.op === 'clear') a.clear();
            else if (x.op === 'shuffle') a.shuffle();
            changed = true;
            lines.push(describe(x));
            break;
          case 'buildSet': {
            const set = await a.generateSet({ length: x.length, strategy: x.strategy || a.options.strategy, filters: x.filters || a.options.filters });
            a.setQueue(set);
            changed = true;
            lines.push(`Scaletta di ${set.length} brani in coda`);
            infos.push(`In coda: ${set.slice(0, 5).map(label).join(', ')}${set.length > 5 ? ` e altri ${set.length - 5}` : ''}.${a.enabled ? '' : ' Dimmi "parti" per cominciare.'}`);
            break;
          }
          case 'mashup': {
            const m = await this.makeMashup(x, ctx);
            before.mashups.push(m.id);
            changed = true;
            lines.push(`Mashup in coda: voce di ${label(ctx.tracksById.get(m.vocalId))} sulla base di ${label(ctx.tracksById.get(m.baseId))}`);
            break;
          }
          case 'view':
            this.env.setView(x.value);
            lines.push(describe(x));
            break;
          case 'info':
            infos.push(this.info(x.what));
            break;
          default:
            break;
        }
      } catch (err) {
        errors.push(String((err && err.message) || err));
      }
    }
    return { lines, infos, errors, undo: changed ? before : null };
  }

  async makeMashup(x, ctx) {
    const mm = this.env.mashups;
    if (!mm) throw new Error('I mashup non sono disponibili');
    let { baseId, vocalId } = x;
    if (x.auto) {
      const pair = pickPair(ctx.tracks, { isSaved: (b, v) => Boolean(mm.find(b, v)), random: this.env.random || Math.random });
      if (!pair) throw new Error('Non trovo due brani analizzati con tonalità e tempo compatibili per un mashup');
      baseId = pair.base.id;
      vocalId = pair.vocal.id;
    }
    const m = mm.find(baseId, vocalId) || await mm.save({ baseId, vocalId, bars: 16, baseStart: null, vocalStart: null });
    mm.prepare(m.id);
    this.automix.enqueue([ctx.tracksById.get(baseId), ctx.tracksById.get(vocalId)].filter(Boolean));
    return m;
  }

  /** Torna a com'era prima di una risposta: opzioni, filtri, cambi temporanei, coda, chiusura del set, mashup creati. */
  async undo(msgId) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg || !msg.undo) return;
    const b = msg.undo;
    const a = this.automix;
    this.env.setOptions(b.options);
    a.temp = b.temp;
    a.setQueue(b.queue);
    if (a.endAfterCurrent !== b.endAfterCurrent) a.setEndAfterCurrent(b.endAfterCurrent);
    for (const id of b.mashups) if (this.env.mashups) await this.env.mashups.remove(id).catch(() => {});
    msg.undo = null;
    msg.undone = true;
    a.say('SegueoChat: modifiche annullate');
    this.push({ role: 'assistant', text: 'Annullato: tutto come prima.', engine: 'rules' });
  }

  /** Risposte sullo stato del set. */
  info(what) {
    const a = this.automix;
    const o = a.options;
    const cur = a.current() || a.decks.find((d) => d.playing);
    const trackLine = (d) => {
      const t = d.track;
      const bits = [d.bpm ? `${d.effectiveBpm.toFixed(0)} BPM` : '', t.key || '', t.energy ? `energia ${t.energy}` : ''].filter(Boolean);
      return `${label(t)}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    };
    switch (what) {
      case 'now': {
        if (!cur || !cur.track) return a.enabled ? 'Sto scegliendo il primo brano.' : 'Non suona niente: dimmi "parti" per cominciare.';
        const left = Math.max(0, Math.round(cur.remaining / (cur.tempo || 1)));
        const tr = a.transition ? ` Sto mixando verso ${label(a.transition.to.track)}.` : '';
        return `In onda: ${trackLine(cur)}, mancano ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.${tr}`;
      }
      case 'next': {
        const p = a.plan;
        if (a.endAfterCurrent) return 'Nessun prossimo: chiudo il set con il brano in onda.';
        if (p && p.toTrack) {
          const secs = cur && Number.isFinite(p.startAt) ? Math.max(0, Math.round((p.startAt - cur.position) / (cur.tempo || 1))) : null;
          return `Il prossimo è ${label(p.toTrack)}${secs != null ? `: mixo tra ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}.`;
        }
        if (a.queue.length) return `Il prossimo in coda è ${label(a.queue[0])}.`;
        return a.enabled ? 'Non ho ancora scelto il prossimo brano.' : 'L\'AI DJ è spento.';
      }
      case 'why': {
        const log = a.log;
        const i = log.map((e) => e.text).findLastIndex((x) => /^Prossimo:/.test(x));
        if (i < 0) return 'Non ho ancora scelto nessun brano da spiegare.';
        return [log[i].text.replace(/^Prossimo: /, 'Ho scelto '), log[i + 1] && /^\s/.test(log[i + 1].text) ? log[i + 1].text.trim() : ''].filter(Boolean).join('. ');
      }
      case 'queue':
        if (!a.queue.length) return o.mode === 'ai' ? 'La coda è vuota: scelgo io i brani dalla libreria.' : 'La coda è vuota.';
        return `In coda (${a.queue.length}): ${a.queue.slice(0, 8).map((t, i) => `${i + 1}. ${label(t)}`).join('; ')}${a.queue.length > 8 ? '…' : ''}`;
      case 'settings': {
        const pl = o.source !== 'library' && this.env.getPlaylists().find((p) => p.id === o.source);
        const parts = [
          `AI DJ ${a.enabled ? 'acceso' : 'spento'}`,
          o.mode === 'queue' ? 'suono solo la coda' : `scelgo i brani da ${pl ? `playlist ${pl.name}` : 'tutta la libreria'}`,
          `energia: ${STRATEGY_NAMES[o.strategy] || o.strategy}`,
          `transizioni: ${TRANSITIONS[o.style] || o.style}, ${o.bars} battute`,
          o.remix ? 'remix dal vivo acceso' : '',
          o.mashup ? 'mashup automatici accesi' : '',
          hasFilters(o.filters) ? `filtri: ${describeFilters(o.filters)}` : '',
          a.temp ? `impostazioni temporanee per altri ${a.temp.remaining} brani` : '',
          a.endAfterCurrent ? 'chiudo il set dopo questo brano' : '',
        ];
        return `${parts.filter(Boolean).join(' · ')}.`;
      }
      case 'help':
        return `Ecco cosa posso fare:\n${HELP.map((h) => `• ${h}`).join('\n')}`;
      default:
        return '';
    }
  }
}
