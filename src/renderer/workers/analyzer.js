// Worker di analisi: BPM, beatgrid, tonalità, forma d'onda e loudness fuori dal thread UI.
import { analyzeTrack } from '../js/dsp/analysis.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate, options } = e.data;
  try {
    const result = analyzeTrack(channels, sampleRate, options);
    const wf = result.waveform;
    self.postMessage({ id, result }, [wf.peak.buffer, wf.low.buffer, wf.mid.buffer, wf.high.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
