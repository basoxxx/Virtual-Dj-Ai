// Genera build/icon.png (1024x1024): un disco in vinile stilizzato con i colori dei deck.
// Nessuna dipendenza: PNG scritto a mano con zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 1024;
const px = Buffer.alloc(S * S * 4);

function mix(a, b, t) {
  return a + (b - a) * t;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - S / 2 + 0.5;
    const dy = y - S / 2 + 0.5;
    const r = Math.hypot(dx, dy) / (S / 2);
    const ang = Math.atan2(dy, dx);
    let R = 0; let G = 0; let B = 0; let A = 0;
    // sfondo arrotondato (squircle)
    const sq = (Math.abs(dx) / (S / 2)) ** 5 + (Math.abs(dy) / (S / 2)) ** 5;
    if (sq <= 0.94) {
      const t = (y / S);
      R = mix(22, 10, t); G = mix(26, 12, t); B = mix(38, 18, t); A = 255;
      if (r < 0.8) {
        // vinile con solchi
        const groove = 0.5 + 0.5 * Math.sin(r * 180);
        const shine = 0.5 + 0.5 * Math.cos(2 * ang - 0.6);
        const base = 14 + groove * 8 + shine * 22 * (r > 0.34 ? 1 : 0);
        R = base; G = base; B = base + 4;
        if (r < 0.34) {
          // etichetta: metà blu (deck A) e metà arancio (deck B)
          const blue = [46, 168, 255];
          const orange = [255, 106, 61];
          const c = dx < 0 ? blue : orange;
          const k = 0.85 + 0.15 * (1 - r / 0.34);
          R = c[0] * k; G = c[1] * k; B = c[2] * k;
          if (Math.abs(dx) < 6) { R = 13; G = 15; B = 20; }
        }
        if (r < 0.05) { R = 13; G = 15; B = 20; }
      }
      // anello di avanzamento
      if (r > 0.84 && r < 0.9 && ang > -Math.PI / 2 && ang < Math.PI * 0.65) {
        R = 46; G = 168; B = 255;
      }
    }
    const i = (y * S + x) * 4;
    px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = A;
  }
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`icona scritta: ${out} (${png.length} byte)`);
