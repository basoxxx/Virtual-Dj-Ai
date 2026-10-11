// Analisi in background della libreria (BPM, tonalità, energia, punti di mix)
// così l'AI DJ conosce i brani prima ancora di caricarli. Con librerie grandi dura ore: prima i brani che servono
// subito (priorità) e pausa quando c'è da separare voce e base (la separazione non aspetta tutta la libreria).
import { api } from '../api.js';
import { analyzeBytes, analysisPatch, isFullyAnalyzed, needsAiRefine, refineInBackground, refineOnce, POOL_SIZE } from '../audio/analyzer-client.js';

// rifinitura AI fatta qui solo se si fa in background (altrimenti la fa il deck quando carica il brano)
const refineHere = (t) => refineInBackground() && needsAiRefine(t);

export class BatchAnalyzer extends EventTarget {
  /**
   * priority(): funzione (brano) -> numero, rifatta a ogni brano: prima i numeri più bassi.
   * shouldYield(): true finché l'analisi deve restare in pausa tra un brano e l'altro.
   */
  constructor(ctx, { priority = () => () => 0, shouldYield = () => false } = {}) {
    super();
    this.ctx = ctx;
    this.priority = priority;
    this.shouldYield = shouldYield;
    this.running = false;
    this.active = 0; // brani in analisi in questo momento (la prima passata ne fa più insieme)
    this.timing = { first: null, refine: null }; // secondi per brano, media mobile (per il tempo rimanente)
    this.paused = false;
    this.stopRequested = false;
    this.done = 0;
    this.total = 0;
    this.current = null;
    this.failed = []; // { track, reason } dei brani non riusciti nell'ultima analisi
    this.analyzed = new Set(); // brani analizzati nell'ultima analisi
    this.aiError = null; // perché la rifinitura AI non è disponibile (modello mancante, onnxruntime...)
  }

  get stepping() {
    return this.active > 0;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('progress', { detail: { running: this.running, paused: this.paused, done: this.done, total: this.total, current: this.current, eta: this.eta(), failed: this.failed } }));
  }

  /** Secondi che mancano alla fine, dalle medie misurate (null finché non c'è una stima). */
  eta() {
    if (!this.running || !this.left) return null;
    const { first, refine } = this.timing;
    const a = this.left.first ? (first == null ? null : this.left.first * first) : 0;
    const b = this.left.refine ? (refine == null ? (first == null ? null : this.left.refine * first * 4) : this.left.refine * refine) : 0;
    return a == null || b == null ? null : a + b;
  }

  measure(kind, seconds) {
    const old = this.timing[kind];
    this.timing[kind] = old == null ? seconds : old * 0.85 + seconds * 0.15;
  }

  static pending(tracks) {
    return tracks.filter((t) => !isFullyAnalyzed(t) || refineHere(t));
  }

  stop() {
    this.stopRequested = true;
  }

  /** Il prossimo brano da analizzare: quello con priorità più alta (a parità, nell'ordine della lista). */
  next(list) {
    const rank = this.priority();
    let best = 0;
    let bestRank = rank(list[0]);
    for (let i = 1; i < list.length && bestRank > 0; i++) {
      const r = rank(list[i]);
      if (r < bestRank) {
        best = i;
        bestRank = r;
      }
    }
    return list.splice(best, 1)[0];
  }

  /** Tra un brano e l'altro: resta in pausa finché serve (es. separazione di voce e base in corso). */
  async yieldIfNeeded() {
    while (!this.stopRequested && this.shouldYield()) {
      if (!this.paused) {
        this.paused = true;
        this.emit();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.paused) {
      this.paused = false;
      this.emit();
    }
  }

  /**
   * Due passaggi: prima l'analisi classica di tutti i brani nuovi (veloce, l'AI DJ li può già usare), più brani
   * insieme su più core; poi con il motore AI la rifinitura di battute, battuta forte e struttura con Beat This!.
   * Ogni brano si decodifica una volta sola per passaggio, mono a 22050 Hz.
   * Non fallisce mai: un errore imprevisto finisce nel riepilogo ('finished'), che l'interfaccia mostra.
   */
  async run(tracks) {
    if (this.running) return;
    const first = tracks.filter((t) => !isFullyAnalyzed(t));
    if (!first.length && !tracks.some(refineHere)) return;
    this.running = true;
    this.stopRequested = false;
    this.done = 0;
    this.failed = [];
    this.analyzed = new Set();
    this.aiError = null;
    let error = null;
    try {
      // i brani nuovi, con il motore AI, passano anche dalla rifinitura
      const refine = tracks.filter((t) => refineHere(t) || (!isFullyAnalyzed(t) && refineInBackground())).length;
      this.total = first.length + refine;
      this.left = { first: first.length, refine };
      this.emit();
      await this.pass(first, POOL_SIZE, 'first', async (t) => {
        const bytes = await readTrack(t);
        const { res, duration } = await analyzeBytes(bytes, {
          engine: 'classic',
          bpm: !t.analyzed || !t.bpm,
          key: !t.key,
          knownBpm: t.bpm || 0,
          knownOffset: t.gridOffset || 0,
        });
        return analysisPatch(res, duration);
      }, (t) => {
        // file non decodificabile: non si riprova in questa sessione
        t.analysisFailed = true;
      });
      const second = tracks.filter(refineHere);
      this.left.refine = second.length;
      // due brani in volo: mentre la rete neurale lavora su uno (nel worker, uno alla volta) il successivo si legge e si decodifica
      await this.pass(second, 2, 'refine', async (t) => {
        // rifinito nel frattempo su un deck, o griglia corretta a mano: niente da fare
        if (!needsAiRefine(t)) return null;
        // se un deck sta già rifinendo questo brano si aspetta il suo risultato (lo salva il deck)
        const { res, duration, shared } = await refineOnce(t, async () => {
          const bytes = await readTrack(t);
          return analyzeBytes(bytes, { engine: 'ai', key: false, bpm: true });
        });
        if (!res.beat || res.beat.engine !== 'ai') {
          const err = new Error(res.aiError || 'rifinitura AI non riuscita');
          // modello mancante, onnxruntime o WASM che non partono: si ferma la rifinitura, i brani restano da rifinire
          throw Object.assign(err, { kind: res.aiSystemic ? 'systemic' : 'ai' });
        }
        if (shared || t.bpmEngine === 'manual') return null;
        const patch = analysisPatch(res, duration);
        delete patch.gain;
        return patch;
      }, (t) => {
        t.aiRefineFailed = true;
      });
    } catch (err) {
      error = err;
      console.error('Analisi della libreria interrotta', err);
    } finally {
      this.running = false;
      this.current = null;
      this.left = null;
      this.emit();
      this.dispatchEvent(new CustomEvent('finished', {
        detail: { analyzed: this.analyzed.size, failed: this.failed, aiError: this.aiError, error: error && String(error.message || error), stopped: this.stopRequested },
      }));
    }
  }

  /** Un passaggio su una lista, con al massimo `parallel` brani insieme, sempre prima quelli più urgenti. */
  async pass(list, parallel, kind, work, onError) {
    const running = new Set();
    const retried = new Set();
    this.passAborted = false;
    while (list.length || running.size) {
      while (list.length && running.size < parallel && !this.stopRequested && !this.passAborted) {
        await this.yieldIfNeeded();
        if (this.stopRequested || this.passAborted) break;
        const t = this.next(list);
        const p = this.step(t, work, onError, kind, !retried.has(t)).then((outcome) => {
          running.delete(p);
          // worker caduto o fermo: il brano si riprova una volta, in fondo alla lista
          if (outcome === 'retry') {
            retried.add(t);
            list.push(t);
          }
        });
        running.add(p);
      }
      if (!running.size) break;
      await Promise.race(running);
    }
  }

  /**
   * Un brano: 'done' oppure 'retry'. Se non riesce si decide in base al motivo (err.kind): 'unreachable' (disco
   * scollegato, file spostato o senza permessi) e 'save' non segnano il brano, che si riprova alla prossima analisi;
   * 'decode' e 'ai' lo segnano con onError; 'systemic' ferma il passaggio senza segnare niente; il resto (worker
   * caduto o fermo) si riprova una volta e poi si segna.
   */
  async step(t, work, onError, kind, canRetry = false) {
    this.current = t;
    this.active++;
    this.emit();
    const t0 = performance.now();
    let outcome = 'done';
    try {
      const patch = await work(t);
      if (patch) {
        Object.assign(t, patch);
        try {
          await api.updateTrack(t.id, patch);
        } catch (err) {
          throw Object.assign(new Error(`salvataggio non riuscito (${err.message})`), { kind: 'save' });
        }
      }
      this.analyzed.add(t);
      // con più brani insieme il tempo per brano è diviso per quanti ne girano in parallelo
      this.measure(kind, (performance.now() - t0) / 1000 / (kind === 'first' ? POOL_SIZE : 2));
    } catch (err) {
      outcome = this.failure(t, err, onError, canRetry);
    }
    this.active--;
    if (outcome !== 'retry') {
      if (this.left && this.left[kind] > 0) this.left[kind]--;
      this.done++;
    }
    this.emit();
    // lascia respirare l'interfaccia
    await new Promise((r) => setTimeout(r, 30));
    return outcome;
  }

  failure(t, err, onError, canRetry) {
    const kind = err.kind || 'worker';
    if (kind === 'systemic') {
      if (!this.aiError) console.warn('Rifinitura AI non disponibile', err);
      this.aiError = err.message;
      this.passAborted = true;
      return 'done';
    }
    console.warn('Analisi fallita', t.path, err);
    if (kind === 'worker' && canRetry) return 'retry';
    if (kind === 'decode' || kind === 'ai' || kind === 'worker') onError(t, err);
    // la rifinitura AI non riuscita su un brano lascia comunque l'analisi classica: non è un brano "non riuscito"
    if (kind !== 'ai') {
      this.analyzed.delete(t);
      this.failed.push({ track: t, reason: err.message });
    }
    return 'done';
  }
}

/** Byte del file del brano; se non si legge (disco scollegato, file spostato, permessi) si riprova alla prossima analisi. */
async function readTrack(t) {
  try {
    return await api.readFile(t.path);
  } catch (err) {
    console.warn('File non leggibile', t.path, err);
    throw Object.assign(new Error('file non raggiungibile (disco scollegato o file spostato?)'), { kind: 'unreachable' });
  }
}
