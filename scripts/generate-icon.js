// Genera l'icona (1024x1024): una forma d'onda con il passaggio dal deck A (blu) al deck B (arancio).
// Nessuna dipendenza: PNG scritto a mano con zlib. Scrive build/icon.png e le copie per app e sito.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 1024;
const SS = 4; // sottocampioni per lato (antialiasing)
const px = Buffer.alloc(S * S * 4);

const BG = [22, 22, 24];
const BLUE = [46, 168, 255];
const WHITE = [245, 245, 247];
const ORANGE = [255, 106, 61];

// barre in unità 0–100: centro x, altezza (centrate su y = 50), larghezza 4, estremità arrotondate
const BARS = [[19, 12], [25.2, 22], [31.4, 34], [37.6, 20], [43.8, 44], [50, 56], [56.2, 44], [62.4, 20], [68.6, 34], [74.8, 22], [81, 12]]
  .map(([cx, h], i) => ({ cx, h, color: i < 5 ? BLUE : i === 5 ? WHITE : ORANGE }));
const BAR_W = 4;

function inBar(u, v, { cx, h }) {
  const r = BAR_W / 2;
  const top = 50 - h / 2 + r;
  const bottom = 50 + h / 2 - r;
  const dy = v < top ? v - top : v > bottom ? v - bottom : 0;
  return (u - cx) ** 2 + dy ** 2 <= r * r;
}

/** Colore e copertura di un punto, in unità 0–100. */
function sample(u, v) {
  const sq = (Math.abs(u - 50) / 50) ** 5 + (Math.abs(v - 50) / 50) ** 5; // squircle
  if (sq > 0.94) return null;
  for (const bar of BARS) if (inBar(u, v, bar)) return bar.color;
  return BG;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let R = 0; let G = 0; let B = 0; let n = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(((x + (sx + 0.5) / SS) / S) * 100, ((y + (sy + 0.5) / SS) / S) * 100);
        if (!c) continue;
        R += c[0]; G += c[1]; B += c[2]; n++;
      }
    }
    const i = (y * S + x) * 4;
    if (n) {
      px[i] = Math.round(R / n); px[i + 1] = Math.round(G / n); px[i + 2] = Math.round(B / n);
      px[i + 3] = Math.round((255 * n) / (SS * SS));
    }
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
for (const rel of ['build/icon.png', 'src/renderer/img/icon.png', 'site/img/icon.png']) {
  const out = path.join(__dirname, '..', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`icona scritta: ${out} (${png.length} byte)`);
}
