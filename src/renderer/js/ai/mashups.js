// Mashup preparati prima del set (scheda MASHUP): elenco salvato nella libreria, separazione in anticipo di voce e
// base dei due brani e punto in cui entra la voce, così durante il set l'AI DJ li trova già pronti su disco.
import { api } from '../api.js';

export class MashupManager extends EventTarget {
  /** stems: StemManager; getTrack(id): brano della libreria. */
  constructor({ stems, getTrack }) {
    super();
    this.stems = stems;
    this.getTrack = getTrack;
    this.list = [];
    this.ready = new Set(); // id dei mashup con voce e base su disco
    this.preparing = new Set();
    this.errors = new Map(); // id del mashup -> messaggio
    stems.addEventListener('change', () => this.emit());
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** Elenco dalla libreria (a ogni aggiornamento): si ricontrolla cosa è già separato su disco. */
  async setList(list) {
    const items = list || [];
    this.list = items;
    const onDisk = await Promise.all(items.map(async (m) => {
      const base = this.getTrack(m.baseId);
      const vocal = this.getTrack(m.vocalId);
      return Boolean(base && vocal && (await this.stems.has(base)) && (await this.stems.has(vocal)));
    }));
    items.forEach((m, i) => (onDisk[i] ? this.ready.add(m.id) : this.ready.delete(m.id)));
    this.emit();
  }

  get(id) {
    return this.list.find((m) => m.id === id) || null;
  }

  find(baseId, vocalId) {
    return this.list.find((m) => m.baseId === baseId && m.vocalId === vocalId) || null;
  }

  async save(mashup) {
    const saved = await api.saveMashup(mashup);
    const i = this.list.findIndex((m) => m.id === saved.id);
    this.list = i >= 0 ? this.list.map((m, k) => (k === i ? saved : m)) : [...this.list, saved];
    this.emit();
    return saved;
  }

  /** Aggiorna alcuni campi del mashup salvato (l'ultima versione, non una copia vecchia). */
  update(id, patch) {
    const m = this.get(id);
    return m ? this.save({ ...m, ...patch }) : Promise.resolve(null);
  }

  async remove(id) {
    await api.deleteMashup(id);
    this.list = this.list.filter((m) => m.id !== id);
    this.ready.delete(id);
    this.errors.delete(id);
    this.emit();
  }

  /** Stato per la scheda: missing, preparing, failed, ready (voce e base su disco, entrata della voce nota), todo. */
  status(m) {
    const base = this.getTrack(m.baseId);
    const vocal = this.getTrack(m.vocalId);
    if (!base || !vocal) return { id: 'missing', text: 'Brano non più in libreria' };
    if (this.preparing.has(m.id)) {
      const run = this.stems.running;
      if (!run || (run.track.id !== base.id && run.track.id !== vocal.id)) return { id: 'preparing', text: 'In coda per la separazione' };
      if (this.stems.isBusy()) return { id: 'preparing', text: 'Aspetta la fine dell\'analisi della libreria' };
      return { id: 'preparing', text: `Separo ${run.track.id === vocal.id ? 'la voce' : 'la base'}: ${Math.round(run.progress * 100)}%` };
    }
    if (this.errors.has(m.id)) return { id: 'failed', text: this.errors.get(m.id) };
    if (this.ready.has(m.id) && m.vocalStart != null) return { id: 'ready', text: 'Pronto' };
    return { id: 'todo', text: 'Da preparare' };
  }

  /** Separa voce e base dei due brani (in coda, uno alla volta) e trova dove entra la voce. */
  async prepare(id) {
    const m = this.get(id);
    if (!m || this.preparing.has(id)) return;
    this.preparing.add(id);
    this.errors.delete(id);
    this.emit();
    try {
      const base = this.getTrack(m.baseId);
      const vocal = this.getTrack(m.vocalId);
      if (!base || !vocal) throw new Error('brano non più in libreria');
      // un errore precedente (es. modello mancante) non blocca un nuovo tentativo chiesto dall'utente
      this.stems.clearFailure(base);
      this.stems.clearFailure(vocal);
      await Promise.all([this.stems.ensure(base), this.stems.ensure(vocal)]);
      this.ready.add(id);
      const cur = this.get(id);
      if (cur && cur.vocalStart == null) {
        if (!vocal.bpm) throw new Error('analizza prima il brano della voce (BPM)');
        await this.update(id, { vocalStart: await this.stems.vocalEntry(vocal) });
      }
    } catch (err) {
      this.errors.set(id, String((err && err.message) || err));
    } finally {
      this.preparing.delete(id);
      this.emit();
    }
  }

  /** Prepara tutti i mashup non ancora pronti; restituisce quanti sono partiti. */
  prepareAll() {
    const todo = this.list.filter((m) => ['todo', 'failed'].includes(this.status(m).id));
    todo.forEach((m) => this.prepare(m.id));
    return todo.length;
  }
}
