// Codifica WAV PCM 16 bit.

export function wavHeader(dataBytes, sampleRate, channels) {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return buf;
}

/** Interleave e converte canali float in un file WAV completo. */
export function encodeWav(channels, sampleRate) {
  const n = channels[0].length;
  const c = channels.length;
  const data = new Int16Array(n * c);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < c; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      data[i * c + ch] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return concat([new Uint8Array(wavHeader(data.byteLength, sampleRate, c)), new Uint8Array(data.buffer)]);
}

export function encodeWavFromInt16(chunks, sampleRate, channels) {
  const bytes = chunks.reduce((s, ch) => s + ch.byteLength, 0);
  return concat([
    new Uint8Array(wavHeader(bytes, sampleRate, channels)),
    ...chunks.map((ch) => new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength)),
  ]);
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
