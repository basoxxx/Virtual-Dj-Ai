// Avvisi del processo principale per l'interfaccia (toast). Quelli nati quando l'interfaccia non è pronta (avvio,
// migrazione, file illeggibili, interfaccia che si ricarica) aspettano che li chieda. onDelivered dice quando sono
// arrivati all'utente: serve a chi, altrimenti, deve avvisare di nuovo al prossimo avvio (es. una registrazione salvata).
class Notices {
  /** send(notice): manda all'interfaccia; false se non c'è una finestra (l'avviso aspetta). */
  constructor(send, { dedupeMs = 30000 } = {}) {
    this.send = send;
    this.dedupeMs = dedupeMs;
    this.ready = false;
    this.pending = [];
    this.last = new Map(); // messaggio -> quando: lo stesso avviso al massimo ogni dedupeMs
  }

  add(message, type = 'error', ms = 9000, onDelivered = null) {
    const now = Date.now();
    if (now - (this.last.get(message) || 0) < this.dedupeMs) return;
    this.last.set(message, now);
    const entry = { notice: { message, type, ms }, onDelivered };
    if (this.ready && this.send(entry.notice)) this.delivered([entry]);
    else this.pending.push(entry);
  }

  /** L'interfaccia è pronta: riceve quelli in attesa, da qui in poi arrivano in diretta. */
  take() {
    this.ready = true;
    return this.delivered(this.pending.splice(0));
  }

  /** Quelli in attesa, da mostrare in un altro modo (es. l'interfaccia non riesce a ripartire). */
  drain() {
    return this.delivered(this.pending.splice(0));
  }

  /** L'interfaccia si ricarica: gli avvisi aspettano la nuova. */
  reset() {
    this.ready = false;
  }

  delivered(entries) {
    for (const e of entries) {
      if (!e.onDelivered) continue;
      try {
        e.onDelivered();
      } catch (err) {
        console.error('Avviso consegnato, ma il seguito non è riuscito:', err);
      }
    }
    return entries.map((e) => e.notice);
  }
}

module.exports = { Notices };
