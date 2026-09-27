// AI locale (LLM): sceglie i brani e crea scalette a partire da una descrizione.
// Se il modello non risponde o sbaglia formato si ricade sempre sul motore interno.
import { api } from '../api.js';
import { camelotOf } from '../dsp/analysis.js';

const SYSTEM = 'Sei un DJ professionista esperto di mixaggio armonico (ruota Camelot), BPM e gestione dell\'energia della pista. '
  + 'Rispondi SEMPRE e SOLO con JSON valido, senza testo aggiuntivo.';

export function describeTrack(t, i) {
  const parts = [`${i}.`, `${t.artist ? `${t.artist} - ` : ''}${t.title}`];
  if (t.bpm) parts.push(`${t.bpm.toFixed(1)} BPM`);
  if (t.key) parts.push(`key ${t.key} (${camelotOf(t.key)})`);
  if (t.energy) parts.push(`energia ${t.energy}/10`);
  if (t.genre) parts.push(`genere ${t.genre}`);
  if (t.year) parts.push(t.year);
  return parts.join(' | ');
}

/** Estrae il primo oggetto/array JSON da una risposta testuale. */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // cerca il primo blocco bilanciato
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // prova il formato successivo
      }
    }
  }
  return null;
}

export class LocalLLM {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  get enabled() {
    const c = this.getConfig();
    return Boolean(c && c.llm && c.model && c.endpoint);
  }

  config() {
    const c = this.getConfig();
    return { provider: c.provider, endpoint: c.endpoint, model: c.model, apiKey: c.apiKey };
  }

  async models(cfg) {
    return api.aiModels(cfg || this.config());
  }

  async ask(messages, temperature = 0.4) {
    const content = await api.aiChat({ ...this.config(), messages, temperature });
    return extractJson(content);
  }

  async test() {
    const res = await this.ask([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Rispondi con {"ok": true, "messaggio": "<un saluto breve da DJ in italiano>"}' },
    ], 0.7);
    if (!res) throw new Error('Il modello ha risposto ma non in JSON');
    return res.messaggio || res.message || 'OK';
  }

  /**
   * Sceglie il prossimo brano tra i candidati già filtrati dal motore interno.
   * @returns {Promise<{index:number, reason:string}|null>}
   */
  async chooseNext(current, candidates, { strategy, history = [], notes = '' }) {
    const list = candidates.map((t, i) => describeTrack(t, i)).join('\n');
    const played = history.slice(-6).map((t) => `- ${t.artist ? `${t.artist} - ` : ''}${t.title}`).join('\n') || '(nessuno)';
    const prompt = `In onda ora: ${current ? describeTrack(current, '>') : '(niente, è il primo brano)'}
Ultimi brani suonati:
${played}
Obiettivo energia del set: ${strategy}.${notes ? `\nRichiesta del DJ: ${notes}` : ''}

Candidati:
${list}

Scegli il candidato migliore da mixare dopo il brano in onda (BPM vicini, tonalità compatibili, energia coerente con l'obiettivo, varietà).
Rispondi con: {"index": <numero del candidato>, "reason": "<motivazione breve in italiano>"}`;
    const res = await this.ask([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]);
    const index = res && Number.isInteger(Number(res.index)) ? Number(res.index) : -1;
    if (index < 0 || index >= candidates.length) return null;
    return { index, reason: String(res.reason || '').slice(0, 200) };
  }

  /** Crea una scaletta dalla libreria a partire da una richiesta in linguaggio naturale. */
  async buildSet(request, pool, length = 15) {
    const limited = pool.slice(0, 350);
    const list = limited.map((t, i) => describeTrack(t, i)).join('\n');
    const prompt = `Richiesta del DJ: "${request}"

Libreria disponibile:
${list}

Crea una scaletta di circa ${length} brani scelti SOLO da questa libreria, nell'ordine in cui vanno suonati,
rispettando la richiesta e mixando in modo armonico con BPM compatibili.
Rispondi con: {"tracks": [<numeri dei brani in ordine>], "title": "<titolo del set>", "reason": "<spiegazione breve>"}`;
    const res = await this.ask([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], 0.6);
    const idx = res && Array.isArray(res.tracks) ? res.tracks : Array.isArray(res) ? res : [];
    const seen = new Set();
    const tracks = [];
    for (const v of idx) {
      const i = Number(typeof v === 'object' && v ? v.index : v);
      if (Number.isInteger(i) && i >= 0 && i < limited.length && !seen.has(i)) {
        seen.add(i);
        tracks.push(limited[i]);
      }
    }
    return { tracks, title: res && res.title, reason: res && res.reason };
  }
}
