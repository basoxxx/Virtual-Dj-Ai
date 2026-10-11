// Modello Segueo Chat nell'app: capisce che cosa chiede un messaggio a SegueoChat (energia, stile dei cambi, comandi,
// domande...). Gira in un worker con onnxruntime-web, solo CPU; se il modello manca SegueoChat usa solo l'interprete.
import { chatInputs, chatFeaturize, softmaxHeads, chatDecide } from './chat-features.js';
import { CHAT_THRESHOLDS } from './chat-heads.js';

export const CHAT_MODEL = 'segueo-chat-v2.onnx';
// dopo questo tempo senza messaggi il worker si chiude e libera la memoria
const IDLE_MS = 120000;
// tempo massimo per una risposta (il primo messaggio carica anche il modello): poi SegueoChat va avanti senza
const TIMEOUT_MS = 15000;
// dopo due errori di fila (anche timeout, es. CPU occupata da Demucs o Beat This!) si riprova dopo questo tempo
const RETRY_MS = 3 * 60000;

export class ChatModel {
  constructor({ model = CHAT_MODEL, idleMs = IDLE_MS, timeoutMs = TIMEOUT_MS, retryMs = RETRY_MS, now = () => Date.now() } = {}) {
    this.model = model;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.now = now;
    this.pausedUntil = 0; // dopo errori di fila il modello si lascia stare per un po'
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.unavailable = false;
    this.errors = 0; // errori di fila
  }

  get available() {
    return !this.unavailable && this.now() >= this.pausedUntil;
  }

  getWorker() {
    clearTimeout(this.idle);
    if (!this.worker) {
      this.worker = new Worker(new URL('../../workers/chat.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        clearTimeout(p.timer);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.logits);
      };
      this.worker.onerror = (e) => this.fail(e && e.message ? `errore del modello Segueo Chat: ${e.message}` : 'Worker di Segueo Chat non avviato: file mancante?');
      this.worker.onmessageerror = () => this.fail('risposta del modello Segueo Chat non leggibile');
    }
    this.idle = setTimeout(() => this.close(), this.idleMs);
    return this.worker;
  }

  close() {
    if (this.worker && !this.pending.size) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /** Worker caduto, fermo o non avviato: le richieste falliscono e la memoria del modello torna libera. */
  fail(message) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    clearTimeout(this.idle);
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }

  run(inputs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => this.fail('Il modello non ha risposto in tempo'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.getWorker().postMessage({ id, model: this.model, inputs });
    });
  }

  /** Richieste riconosciute nel messaggio: { testa: etichetta }, oppure null se il modello non c'è. */
  async predict(text) {
    if (!this.available) return null;
    try {
      const logits = await this.run(chatInputs(text).map(chatFeaturize));
      const probs = logits.map(softmaxHeads);
      const labels = chatDecide(probs[0], probs.slice(1), CHAT_THRESHOLDS);
      this.errors = 0;
      return labels;
    } catch (err) {
      // modello mancante: per questa sessione solo i comandi integrati; fermo o che sbaglia due volte di fila
      // (anche per timeout, es. all'avvio a freddo con la CPU occupata): si riprova dopo qualche minuto
      if (/non installato/.test(err.message)) this.unavailable = true;
      else if (++this.errors >= 2) {
        this.errors = 0;
        this.pausedUntil = this.now() + this.retryMs;
      }
      throw err;
    }
  }
}
