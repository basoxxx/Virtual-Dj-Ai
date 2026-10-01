// Parti separate dei brani (voce e base) per i mashup: modello Demucs scaricato su richiesta,
// separazione in un worker (un brano alla volta) e file WAV salvati nella cartella dati dell'utente.
import { api } from '../api.js';
import { DEMUCS_SR } from '../dsp/demucs.js';
import { vocalEntryFrom } from './mashup-plan.js';

export const SEPARATION_MODEL = 'segueo-separazione-voce-v2.onnx';

export class StemManager extends EventTarget {
  /** isBusy(): true se in quel momento non si deve separare (es. analisi della libreria in corso). */
  constructor({ isBusy = () => false } = {}) {
    super();
    this.isBusy = isBusy;
    this.queue = [];
    this.running = null; // { track, progress }
    this.ready = new Map(); // id del brano -> true
    this.failed = new Map(); // id del brano -> messaggio
    this.modelInstalled = null;
    this.downloading = null; // { done, total }
    api.on('models:progress', (p) => {
      if (p.name !== SEPARATION_MODEL) return;
      this.downloading = { done: p.done, total: p.total };
      this.emit();
    });
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { running: this.running, queued: this.queue.length, downloading: this.downloading, modelInstalled: this.modelInstalled },
    }));
  }

  async checkModel() {
    try {
      this.modelInstalled = (await api.modelStatus(SEPARATION_MODEL)).installed;
    } catch {
      this.modelInstalled = false;
    }
    this.emit();
    return this.modelInstalled;
  }

  async downloadModel() {
    this.downloading = { done: 0, total: 0 };
    this.emit();
    try {
      const st = await api.downloadModel(SEPARATION_MODEL);
      this.modelInstalled = st.installed;
    } finally {
      this.downloading = null;
      this.emit();
    }
    return this.modelInstalled;
  }

  /** Il brano ha già voce e base su disco? */
  async has(track) {
    if (!track) return false;
    if (this.ready.get(track.id)) return true;
    const st = await api.stemsStatus(track.id);
    const ok = Boolean(st.vocals && st.instrumental);
    if (ok) this.ready.set(track.id, true);
    return ok;
  }

  /** Byte del WAV con la sola voce del brano (già separato). */
  readVocals(track) {
    return api.readStem(track.id, 'vocals');
  }

  /** Inizio (s) della prima frase di 4 battute in cui si sente bene la voce del brano (già separato). */
  async vocalEntry(track, bpm = track.bpm) {
    const bytes = await this.readVocals(track);
    const ctx = new OfflineAudioContext(1, 1, 22050);
    const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return vocalEntryFrom(audio.getChannelData(0), audio.sampleRate, bpm, track.gridOffset || 0);
  }

  /** Dimentica l'errore di separazione del brano, così si può riprovare (su richiesta dell'utente). */
  clearFailure(track) {
    this.failed.delete(track.id);
  }

  /** Separa il brano se serve (in coda, uno alla volta); si risolve quando voce e base sono su disco. */
  ensure(track) {
    return new Promise((resolve, reject) => {
      this.has(track).then((ok) => {
        if (ok) return resolve(true);
        if (this.failed.has(track.id)) return reject(new Error(this.failed.get(track.id)));
        const job = this.queue.find((j) => j.track.id === track.id) || (this.running && this.running.track.id === track.id && this.running);
        if (job) {
          job.waiters.push({ resolve, reject });
          return undefined;
        }
        this.queue.push({ track, waiters: [{ resolve, reject }] });
        this.emit();
        this.next();
        return undefined;
      }, reject);
    });
  }

  async next() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = { ...job, progress: 0 };
    this.emit();
    try {
      // la separazione usa circa 3 GB: mai insieme all'analisi di un brano (che intanto si mette in pausa)
      while (this.isBusy()) await new Promise((r) => setTimeout(r, 2000));
      if (!(await this.checkModel())) throw new Error('modello per separare voce e base non scaricato');
      const bytes = await api.readFile(job.track.path);
      // decodifica a 44,1 kHz (la frequenza di Demucs) con il ricampionatore del browser
      const ctx = new OfflineAudioContext(2, 1, DEMUCS_SR);
      const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const left = audio.getChannelData(0).slice();
      const right = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : left.slice();
      const out = await this.separate(left, right, (p) => {
        this.running.progress = p;
        this.emit();
      });
      await api.saveStem(job.track.id, 'vocals', out.vocals);
      await api.saveStem(job.track.id, 'instrumental', out.instrumental);
      this.ready.set(job.track.id, true);
      job.waiters.forEach((w) => w.resolve(true));
    } catch (err) {
      const msg = String((err && err.message) || err);
      this.failed.set(job.track.id, msg);
      job.waiters.forEach((w) => w.reject(new Error(msg)));
    } finally {
      this.running = null;
      this.emit();
      this.next();
    }
  }

  separate(left, right, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../../workers/separator.js', import.meta.url), { type: 'module' });
      const done = (fn, v) => {
        worker.terminate();
        fn(v);
      };
      worker.onmessage = (e) => {
        if (e.data.progress != null) onProgress(e.data.progress);
        else if (e.data.error) done(reject, new Error(e.data.error));
        else done(resolve, e.data);
      };
      worker.onerror = (e) => done(reject, new Error(e.message || 'errore del separatore'));
      worker.postMessage({ id: 1, model: SEPARATION_MODEL, left, right }, [left.buffer, right.buffer]);
    });
  }
}
