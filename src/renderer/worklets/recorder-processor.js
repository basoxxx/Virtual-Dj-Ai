// Cattura il master in PCM 16 bit interleaved e lo invia a blocchi al thread principale.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.block = new Int16Array(sampleRate); // ~0,5 s stereo
    this.index = 0;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.recording = true;
        this.index = 0;
      } else if (e.data.type === 'stop') {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.index === 0) return;
    const chunk = this.block.slice(0, this.index);
    this.port.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.recording || !input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || input[0];
    for (let i = 0; i < l.length; i++) {
      const a = Math.max(-1, Math.min(1, l[i]));
      const b = Math.max(-1, Math.min(1, r[i]));
      this.block[this.index++] = a < 0 ? a * 0x8000 : a * 0x7fff;
      this.block[this.index++] = b < 0 ? b * 0x8000 : b * 0x7fff;
      if (this.index >= this.block.length) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
