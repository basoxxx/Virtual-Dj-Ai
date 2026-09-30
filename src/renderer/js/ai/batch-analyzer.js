// Analisi in background della libreria (BPM, tonalità, energia, punti di mix)
// così l'AI DJ conosce i brani prima ancora di caricarli. Con librerie grandi dura ore: prima i brani che servono
// subito (priorità) e pausa quando c'è da separare voce e base (la separazione non aspetta tutta la libreria).
import { api } from '../api.js';
import { analyze, analysisPatch, analysisEngine, isFullyAnalyzed, needsAiRefine, refineWithAi } from '../audio/analyzer-client.js';

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
    this.stepping = false; // un brano in analisi in questo momento
    this.paused = false;
    this.stopRequested = false;
    this.done = 0;
    this.total = 0;
    this.current = null;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('progress', { detail: { running: this.running, paused: this.paused, done: this.done, total: this.total, current: this.current } }));
  }

  static pending(tracks) {
    return tracks.filter((t) => !isFullyAnalyzed(t) || needsAiRefine(t));
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

  async decode(t) {
    const bytes = await api.readFile(t.path);
    const audio = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const channels = [audio.getChannelData(0)];
    if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1));
    return { bytes, audio, channels };
  }

  /**
   * Due passaggi: prima l'analisi classica di tutti i brani nuovi (veloce, l'AI DJ li può già usare),
   * poi con il motore AI la rifinitura di battute, battuta forte e struttura con Beat This!.
   */
  async run(tracks) {
    if (this.running) return;
    const first = tracks.filter((t) => !isFullyAnalyzed(t));
    if (!first.length && !tracks.some(needsAiRefine)) return;
    this.running = true;
    this.stopRequested = false;
    this.done = 0;
    // i brani nuovi, con il motore AI, passano anche dalla rifinitura
    const refine = tracks.filter((t) => needsAiRefine(t) || (!isFullyAnalyzed(t) && analysisEngine() === 'ai')).length;
    this.total = first.length + refine;
    this.emit();
    while (first.length) {
      await this.yieldIfNeeded();
      if (this.stopRequested) break;
      const t = this.next(first);
      await this.step(t, async () => {
        const { audio, channels } = await this.decode(t);
        const res = await analyze(channels, audio.sampleRate, {
          engine: 'classic',
          waveform: false,
          bpm: !t.analyzed || !t.bpm,
          key: !t.key,
          knownBpm: t.bpm || 0,
          knownOffset: t.gridOffset || 0,
        });
        return analysisPatch(res, audio.duration);
      }, () => {
        // file non decodificabile: non si riprova in questa sessione
        t.analysisFailed = true;
      });
    }
    const second = tracks.filter(needsAiRefine);
    while (second.length) {
      await this.yieldIfNeeded();
      if (this.stopRequested) break;
      const t = this.next(second);
      await this.step(t, async () => {
        const { bytes, audio, channels } = await this.decode(t);
        const res = await refineWithAi(channels, audio.sampleRate, bytes);
        if (!res.beat || res.beat.engine !== 'ai') throw new Error(res.aiError || 'rifinitura AI non riuscita');
        const patch = analysisPatch(res, audio.duration);
        delete patch.gain;
        return t.bpmEngine === 'manual' ? null : patch;
      }, () => {
        t.aiRefineFailed = true;
      });
    }
    this.running = false;
    this.current = null;
    this.emit();
  }

  async step(t, work, onError) {
    this.current = t;
    this.stepping = true;
    this.emit();
    try {
      const patch = await work();
      if (patch) {
        Object.assign(t, patch);
        await api.updateTrack(t.id, patch);
      }
    } catch (err) {
      onError();
      console.warn('Analisi fallita', t.path, err);
    }
    this.stepping = false;
    this.done++;
    this.emit();
    // lascia respirare l'interfaccia
    await new Promise((r) => setTimeout(r, 30));
  }
}
