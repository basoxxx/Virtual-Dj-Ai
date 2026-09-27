// Analizza i brani come fa l'app (stesso worker e stesso client), un brano alla volta.
import { analyze, configureAnalysis } from '../js/audio/analyzer-client.js';

const { engine, model, files } = await window.bench.start();
configureAnalysis({ engine, model });
const ctx = new AudioContext({ sampleRate: 44100 });
for (const file of files) {
  const bytes = new Uint8Array(await (await fetch(`../__audio/${encodeURIComponent(file)}`)).arrayBuffer());
  const audio = await ctx.decodeAudioData(bytes.slice().buffer);
  const channels = [audio.getChannelData(0)];
  if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1));
  await window.bench.resetPeak();
  const t0 = performance.now();
  // come la libreria (batch-analyzer): niente forma d'onda, BPM e tonalità da calcolare
  const res = await analyze(channels, audio.sampleRate, { waveform: false, bpm: true, key: true, encoded: bytes });
  const ms = performance.now() - t0;
  await window.bench.track({
    file, seconds: Math.round(audio.duration), ms: Math.round(ms),
    bpm: res.beat && res.beat.bpm, offset: res.beat && Math.round(res.beat.offset * 1000) / 1000,
    confidence: res.beat && Math.round((res.beat.confidence || 0) * 100) / 100, engine: res.beat && res.beat.engine,
    aiError: res.aiError || null, key: res.key && res.key.key,
  });
}
await window.bench.done({ crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency });
