// Modello Segueo Chat nell'app: capisce che cosa chiede un messaggio a SegueoChat (energia, stile dei cambi, comandi,
// domande...). Gira in un worker con onnxruntime-web, solo CPU; se il modello manca SegueoChat usa solo l'interprete.
import { chatInputs, chatFeaturize, softmaxHeads, chatDecide } from './chat-features.js';
import { CHAT_THRESHOLDS } from './chat-heads.js';

export const CHAT_MODEL = 'segueo-chat-v2.onnx';
// dopo questo tempo senza messaggi il worker si chiude e libera la memoria
const IDLE_MS = 120000;

export class ChatModel {
  constructor({ model = CHAT_MODEL, idleMs = IDLE_MS } = {}) {
    this.model = model;
    this.idleMs = idleMs;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.unavailable = false;
  }

  get available() {
    return !this.unavailable;
  }

  getWorker() {
    clearTimeout(this.idle);
    if (!this.worker) {
      this.worker = new Worker(new URL('../../workers/chat.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.logits);
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'errore del modello Segueo Chat'));
        this.pending.clear();
        this.worker = null;
      };
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

  run(inputs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.getWorker().postMessage({ id, model: this.model, inputs });
    });
  }

  /** Richieste riconosciute nel messaggio: { testa: etichetta }, oppure null se il modello non c'è. */
  async predict(text) {
    if (this.unavailable) return null;
    try {
      const logits = await this.run(chatInputs(text).map(chatFeaturize));
      const probs = logits.map(softmaxHeads);
      return chatDecide(probs[0], probs.slice(1), CHAT_THRESHOLDS);
    } catch (err) {
      if (/non installato/.test(err.message)) this.unavailable = true;
      throw err;
    }
  }
}
