// Analisi in background della libreria (BPM, tonalità, energia, punti di mix)
// così l'AI DJ conosce i brani prima ancora di caricarli.
import { api } from '../api.js';
import { analyze, analysisPatch, isFullyAnalyzed } from '../audio/analyzer-client.js';

export class BatchAnalyzer extends EventTarget {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.running = false;
    this.stopRequested = false;
    this.done = 0;
    this.total = 0;
    this.current = null;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('progress', { detail: { running: this.running, done: this.done, total: this.total, current: this.current } }));
  }

  static pending(tracks) {
    return tracks.filter((t) => !isFullyAnalyzed(t));
  }

  stop() {
    this.stopRequested = true;
  }

  async run(tracks) {
    if (this.running) return;
    const todo = BatchAnalyzer.pending(tracks);
    if (!todo.length) return;
    this.running = true;
    this.stopRequested = false;
    this.done = 0;
    this.total = todo.length;
    this.emit();
    for (const t of todo) {
      if (this.stopRequested) break;
      this.current = t;
      this.emit();
      try {
        const bytes = await api.readFile(t.path);
        const audio = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const channels = [audio.getChannelData(0)];
        if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1));
        const res = await analyze(channels, audio.sampleRate, {
          waveform: false,
          bpm: !t.analyzed || !t.bpm,
          key: !t.key,
          knownBpm: t.bpm || 0,
          knownOffset: t.gridOffset || 0,
          encoded: bytes,
        });
        const patch = analysisPatch(res, audio.duration);
        Object.assign(t, patch);
        await api.updateTrack(t.id, patch);
      } catch (err) {
        // file non decodificabile: non si riprova in questa sessione
        t.analysisFailed = true;
        console.warn('Analisi fallita', t.path, err);
      }
      this.done++;
      this.emit();
      // lascia respirare l'interfaccia
      await new Promise((r) => setTimeout(r, 30));
    }
    this.running = false;
    this.current = null;
    this.emit();
  }
}
