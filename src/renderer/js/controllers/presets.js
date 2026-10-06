// Catalogo delle console DJ supportate con riconoscimento automatico dal nome della periferica MIDI.
// Ogni marca usa la stessa convenzione MIDI su tutta la gamma: le mappature sono generate per famiglia
// e adattate modello per modello (numero di deck, codifica dei jog, LED).
//
// Le mappature seguono la documentazione MIDI pubblica dei produttori. Se un controllo di un modello
// specifico non risponde, si può correggere con "Learn" o con la procedura guidata: le correzioni
// dell'utente hanno sempre la precedenza sul profilo.

import { VERIFIED } from './verified-maps.js';

export const TIERS = {
  home: 'Casa / principianti',
  semi: 'Semi-professionale',
  pro: 'Professionale',
};

/** Tutte le azioni controllabili da MIDI (registrate dall'app). */
export function knownActions() {
  const ids = [];
  for (const X of ['A', 'B']) {
    ids.push(`${X}.play`, `${X}.cue`, `${X}.sync`, `${X}.stutter`, `${X}.rewind`, `${X}.eject`, `${X}.keylock`, `${X}.slip`, `${X}.quantize`, `${X}.vinyl`, `${X}.censor`);
    ids.push(`${X}.keySync`, `${X}.keyShift`, `${X}.keySet`, `${X}.tonePlay`);
    for (let h = 1; h <= 8; h++) ids.push(`${X}.hotcue${h}`);
    ids.push(`${X}.hotcueClear`);
    ids.push(`${X}.loop4`, `${X}.autoLoop`, `${X}.loopSize`, `${X}.reloop`, `${X}.loopHalf`, `${X}.loopDouble`, `${X}.loopIn`, `${X}.loopOut`);
    ids.push(`${X}.beatloop`, `${X}.roll`, `${X}.slice`, `${X}.beatjump`);
    ids.push(`${X}.jumpBack`, `${X}.jumpFwd`, `${X}.nudgeDown`, `${X}.nudgeUp`, `${X}.tempoReset`);
    ids.push(`${X}.pitch`, `${X}.jog`, `${X}.jogTouch`, `${X}.jogScratch`, `${X}.jogSearch`);
    ids.push(`${X}.volume`, `${X}.gain`, `${X}.eq.high`, `${X}.eq.mid`, `${X}.eq.low`, `${X}.filter`, `${X}.pfl`);
    for (let f = 1; f <= 2; f++) ids.push(`${X}.fx${f}.on`, `${X}.fx${f}.mix`, `${X}.fx${f}.param`);
    ids.push(`${X}.load`);
  }
  ids.push('xfader', 'xfCurve', 'xfEnable', 'master', 'hpVolume', 'cueMix', 'mic', 'automix', 'aiMixNow', 'aiSkip', 'record', 'view');
  ids.push('browse', 'browseFast', 'loadAuto', 'vinylAll');
  for (let p = 1; p <= 8; p++) ids.push(`sampler${p}`);
  ids.push('samplerStop');
  return ids;
}

const note = (ch, n) => `note:${ch}:${n}`;
const cc = (ch, n) => `cc:${ch}:${n}`;
const DECKS = ['A', 'B'];
// voce con parametro (es. dimensione del loop, numero dell'hot cue): l'azione lo riceve in entry.arg
const withArg = (a, arg) => ({ a, arg });

// --- Famiglie ---------------------------------------------------------------------------

/** Pioneer DJ serie DDJ (rekordbox / Serato): un canale MIDI per deck, mixer sul canale 7. */
function pioneerDDJ() {
  const m = {};
  DECKS.forEach((X, d) => {
    m[note(d, 0x0b)] = `${X}.play`;
    m[note(d, 0x0c)] = `${X}.cue`;
    m[note(d, 0x58)] = `${X}.sync`;
    m[note(d, 0x36)] = `${X}.jogTouch`;
    m[cc(d, 0x21)] = { a: `${X}.jog`, enc: 'rel64' };
    m[cc(d, 0x22)] = { a: `${X}.jogScratch`, enc: 'rel64' };
    // pitch a 14 bit (byte basso sul CC +32); valore alto = più veloce (verificato sulle mappe Mixxx dei DDJ)
    m[cc(d, 0x00)] = { a: `${X}.pitch`, hires: true };
    m[cc(d, 0x13)] = `${X}.volume`;
    m[cc(d, 0x04)] = `${X}.gain`;
    m[cc(d, 0x07)] = `${X}.eq.high`;
    m[cc(d, 0x0b)] = `${X}.eq.mid`;
    m[cc(d, 0x0f)] = `${X}.eq.low`;
    m[note(d, 0x54)] = `${X}.pfl`;
    m[note(d, 0x10)] = `${X}.loopIn`;
    m[note(d, 0x11)] = `${X}.loopOut`;
    m[note(d, 0x4d)] = `${X}.reloop`;
    m[note(d, 0x14)] = `${X}.loop4`;
    m[cc(6, 0x17 + d)] = `${X}.filter`;
    m[note(6, 0x46 + d)] = `${X}.load`;
    // pad in modalità HOT CUE: canale 8 (deck 1) e 10 (deck 2)
    for (let h = 0; h < 8; h++) m[note(7 + 2 * d, h)] = `${X}.hotcue${h + 1}`;
  });
  // pad in modalità SAMPLER del deck 1
  for (let p = 0; p < 8; p++) m[note(7, 0x30 + p)] = `sampler${p + 1}`;
  m[cc(6, 0x1f)] = 'xfader';
  m[cc(6, 0x40)] = { a: 'browse', enc: 'twos' };
  return m;
}

// Pad delle Hercules: ogni modo dei pad manda note diverse (pad 1 = base, SHIFT + pad = base + 8).
const ROLL_SIZES = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16];
const JUMPS = [-1, 1, -2, 2, -4, 4, -8, 8];
const JUMPS_SHIFT = [-16, 16, -32, 32, -64, 64, -128, 128];

/**
 * Hercules DJControl (Inpulse, Starlight, Mix): canale 1 generale, deck sui canali 2 e 3,
 * con SHIFT premuto gli stessi comandi arrivano sui canali 5 e 6, pad sui canali 7 e 8.
 * Fonte: mappature Mixxx dei modelli Hercules e manuale dell'Inpulse 500. I jog mandano ±1 per tick
 * (`res` = tick per giro), i fader principali sono a 14 bit (qui si usa il byte alto).
 */
function herculesDJControl({ pads = 8, padModes = {}, loop = 'inout', assistant = true, fxButtons = false, xfCurve = false, mixMaster = false, jogRes = 248, hiresMixer = false, vinylAll = false } = {}) {
  const m = {};
  DECKS.forEach((X, d) => {
    const ch = d + 1;
    const sh = d + 4;
    const pad = d + 6;
    m[note(ch, 0x07)] = `${X}.play`;
    m[note(ch, 0x06)] = `${X}.cue`;
    m[note(ch, 0x05)] = `${X}.sync`;
    m[note(sh, 0x07)] = `${X}.stutter`;
    m[note(sh, 0x06)] = `${X}.rewind`;
    m[note(sh, 0x05)] = `${X}.keySync`;
    m[note(ch, 0x08)] = `${X}.jogTouch`;
    m[note(sh, 0x08)] = `${X}.jogTouch`;
    m[cc(ch, 0x09)] = { a: `${X}.jog`, enc: 'twos', res: jogRes };
    m[cc(ch, 0x0a)] = { a: `${X}.jogScratch`, enc: 'twos', res: jogRes };
    m[cc(sh, 0x09)] = { a: `${X}.jogSearch`, enc: 'twos', res: jogRes };
    m[cc(sh, 0x0a)] = { a: `${X}.jogSearch`, enc: 'twos', res: jogRes };
    // fader del pitch a 14 bit (byte basso sul CC +32): in alto il "−" (manda 0 in basso = più veloce)
    m[cc(ch, 0x08)] = { a: `${X}.pitch`, invert: true, hires: true };
    m[cc(sh, 0x08)] = { a: `${X}.pitch`, invert: true, hires: true };
    // sull'Inpulse 500 anche volume, EQ e gain sono a 14 bit
    const mixer = (a) => (hiresMixer ? { a, hires: true } : a);
    m[cc(ch, 0x00)] = mixer(`${X}.volume`);
    m[cc(sh, 0x00)] = mixer(`${X}.volume`);
    m[cc(ch, 0x01)] = `${X}.filter`;
    m[cc(ch, 0x02)] = mixer(`${X}.eq.low`);
    m[cc(ch, 0x03)] = mixer(`${X}.eq.mid`);
    m[cc(ch, 0x04)] = mixer(`${X}.eq.high`);
    m[cc(ch, 0x05)] = mixer(`${X}.gain`);
    m[note(ch, 0x0c)] = `${X}.pfl`;
    m[note(ch, 0x0d)] = `${X}.load`;
    m[note(sh, 0x0d)] = `${X}.eject`;
    // Starlight e Mix hanno un solo tasto Vinyl (sul canale del deck A) per entrambi i deck
    if (vinylAll) {
      if (d === 0) m[note(ch, 0x03)] = 'vinylAll';
    } else {
      m[note(ch, 0x03)] = `${X}.vinyl`;
    }
    if (pads === 8) {
      m[note(ch, 0x01)] = `${X}.slip`;
      m[note(ch, 0x02)] = `${X}.quantize`;
      m[note(sh, 0x02)] = `${X}.keylock`;
    }
    if (loop === 'inout') {
      // IN (tenuto: loop di 4 battute), OUT, SHIFT+IN = ÷2, SHIFT+OUT = ×2
      m[note(ch, 0x09)] = `${X}.loopIn`;
      m[note(ch, 0x0a)] = `${X}.loopOut`;
    } else if (loop === 'auto') {
      m[note(ch, 0x09)] = `${X}.loop4`;
      m[note(ch, 0x0a)] = `${X}.reloop`;
    }
    if (loop) {
      m[note(sh, 0x09)] = `${X}.loopHalf`;
      m[note(sh, 0x0a)] = `${X}.loopDouble`;
    }
    if (pads === 8) {
      // encoder LOOP: gira = dimensione (÷2 / ×2), premi = loop on/off, SHIFT+premi = reloop
      m[cc(ch, 0x0e)] = { a: `${X}.loopSize`, enc: 'twos' };
      m[cc(sh, 0x0e)] = { a: `${X}.loopSize`, enc: 'twos' };
      m[note(ch, 0x2c)] = `${X}.autoLoop`;
      m[note(sh, 0x2c)] = `${X}.reloop`;
    }

    // --- pad
    const P = { hotcue: 0x00, sampler: 0x30, ...padModes };
    for (let i = 0; i < pads; i++) {
      m[note(pad, P.hotcue + i)] = `${X}.hotcue${i + 1}`;
      m[note(pad, P.hotcue + 8 + i)] = withArg(`${X}.hotcueClear`, i + 1);
      const sample = pads === 8 ? i + 1 : d * 4 + i + 1;
      m[note(pad, P.sampler + i)] = `sampler${sample}`;
      if (pads === 8) m[note(pad, P.sampler + 8 + i)] = withArg('samplerStop', sample);
      if (P.beatloop != null) {
        const sizes = pads === 8 ? ROLL_SIZES : [1, 2, 4, 8];
        m[note(pad, P.beatloop + i)] = withArg(`${X}.beatloop`, sizes[i]);
        m[note(pad, P.beatloop + 8 + i)] = withArg(`${X}.roll`, sizes[i]);
      }
      if (P.roll != null) {
        const sizes = pads === 8 ? ROLL_SIZES : [1, 2, 4, 8];
        m[note(pad, P.roll + i)] = withArg(`${X}.roll`, sizes[i]);
        m[note(pad, P.roll + 8 + i)] = withArg(`${X}.roll`, sizes[i]);
      }
      if (P.slicer != null) m[note(pad, P.slicer + i)] = withArg(`${X}.slice`, i + 1);
      if (P.slicer2 != null) m[note(pad, P.slicer2 + i)] = withArg(`${X}.slice`, i + 1);
      if (P.beatjump != null) {
        m[note(pad, P.beatjump + i)] = withArg(`${X}.beatjump`, JUMPS[i]);
        m[note(pad, P.beatjump + 8 + i)] = withArg(`${X}.beatjump`, JUMPS_SHIFT[i]);
      }
      if (P.toneplay != null) {
        // TonePlay: pad 1–4 = 0…+3 semitoni, pad 5–8 = −4…−1 (riparte dall'hot cue); con SHIFT cambia solo la tonalità
        const st = i < 4 ? i : i - 8;
        m[note(pad, P.toneplay + i)] = withArg(`${X}.tonePlay`, st);
        m[note(pad, P.toneplay + 8 + i)] = withArg(`${X}.keySet`, st);
      }
    }
    if (P.fx != null) {
      m[note(pad, P.fx)] = `${X}.fx1.on`;
      m[note(pad, P.fx + 1)] = `${X}.fx2.on`;
    }
  });
  m[cc(0, 0x00)] = 'xfader';
  m[cc(0, 0x01)] = { a: 'browse', enc: 'twos' };
  // encoder di navigazione: con SHIFT scorre di 10 righe, premuto carica sul deck libero
  m[cc(3, 0x01)] = { a: 'browseFast', enc: 'twos' };
  if (assistant) {
    m[note(0, 0x00)] = 'loadAuto';
    m[note(0, 0x03)] = 'automix';
  }
  if (fxButtons) {
    // FX1–FX4 al centro: effetti 1 e 2 del deck A, poi del deck B
    m[note(0, 0x14)] = 'A.fx1.on';
    m[note(0, 0x15)] = 'A.fx2.on';
    m[note(0, 0x16)] = 'B.fx1.on';
    m[note(0, 0x17)] = 'B.fx2.on';
  }
  if (xfCurve) {
    m[cc(0, 0x0b)] = 'xfCurve';
    m[note(0, 0x18)] = 'xfEnable';
  }
  if (mixMaster) {
    m[cc(0, 0x03)] = 'master';
    m[cc(0, 0x04)] = 'hpVolume';
  }
  return m;
}

// Inpulse 300 (come in Mixxx/DJUCED): 2 roll, 3 slicer, 4 sampler, 5 TonePlay, 6 FX, 7 slicer loop, 8 beat jump
const INPULSE_300 = { pads: 8, padModes: { roll: 0x10, slicer: 0x20, toneplay: 0x40, fx: 0x50, slicer2: 0x60, beatjump: 0x70 } };
// Inpulse 500 / T7 (come in Mixxx): 2 loop automatici (SHIFT = roll), 3 slicer, 4 sampler, 5 TonePlay, 6 roll, 7 FX, 8 beat jump
const INPULSE_500 = {
  pads: 8,
  padModes: { beatloop: 0x10, slicer: 0x20, toneplay: 0x40, roll: 0x50, fx: 0x60, beatjump: 0x70 },
  fxButtons: true,
  xfCurve: true,
  jogRes: 720,
  hiresMixer: true,
};

// Colori dei pad RGB dell'Inpulse 500 (tabella della mappa Mixxx): si usa il più vicino al colore dell'hot cue
const HERCULES_PAD_COLORS = [
  [0xff0000, 0x60], [0xffff00, 0x7c], [0x00ff00, 0x1c], [0x00ffff, 0x1f], [0x0000ff, 0x03], [0xff00ff, 0x42],
  [0xff88ff, 0x63], [0xffffff, 0x7f], [0x000088, 0x02], [0x008800, 0x10], [0x008888, 0x12], [0x228800, 0x30],
  [0x880000, 0x40], [0x882200, 0x4c], [0x888800, 0x50], [0x888888, 0x52], [0x88ff00, 0x5c], [0xff8800, 0x74],
];

/** Codice colore del pad più vicino a "#rrggbb". */
export function herculesPadColor(hex) {
  const rgb = parseInt(String(hex).replace('#', ''), 16);
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  let best = 0x7f;
  let bestD = Infinity;
  for (const [c, code] of HERCULES_PAD_COLORS) {
    const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = code;
    }
  }
  return best;
}

// guida al beatmatch dell'Inpulse 500: frecce del tempo (troppo veloce/lento, ok) e della fase (avanti/indietro, ok)
const herculesGuide = (ch) => ({
  tooFast: note(ch, 0x1e), tooSlow: note(ch, 0x1f), tempoOk: note(ch, 0x2c),
  ahead: note(ch, 0x1d), behind: note(ch, 0x1c), phaseOk: note(ch, 0x2d),
});

// Inpulse con scheda audio a 4 uscite (casse su 1-2, cuffia su 3-4) e VU dei canali pilotati dal software
const HERCULES_4OUT = { vu: { A: cc(1, 0x40), B: cc(2, 0x40), max: 125 }, audio: { quad: true } };
const HERCULES_500 = {
  ...HERCULES_4OUT,
  padColor: herculesPadColor,
  guide: { A: herculesGuide(1), B: herculesGuide(2) },
  // la nota 0x2C è la pressione dell'encoder del loop in ingresso ma la spia "tempo ok" della guida in uscita
  noLed: [note(1, 0x2c), note(2, 0x2c), note(4, 0x2c), note(5, 0x2c)],
};

/** inMusic (Numark, Denon DJ, Rane, Akai): deck sui canali 1–4, mixer sul canale 16. */
function inMusic({ jog = 'twos' } = {}) {
  const m = {};
  DECKS.forEach((X, d) => {
    m[note(d, 0x00)] = `${X}.play`;
    m[note(d, 0x01)] = `${X}.cue`;
    m[note(d, 0x02)] = `${X}.sync`;
    m[note(d, 0x06)] = `${X}.jogTouch`;
    m[cc(d, 0x06)] = { a: `${X}.jogScratch`, enc: jog };
    m[cc(d, 0x09)] = { a: `${X}.pitch`, invert: true };
    m[cc(d, 0x1c)] = `${X}.volume`;
    m[cc(d, 0x16)] = `${X}.gain`;
    m[cc(d, 0x17)] = `${X}.eq.high`;
    m[cc(d, 0x18)] = `${X}.eq.mid`;
    m[cc(d, 0x19)] = `${X}.eq.low`;
    m[cc(d, 0x1a)] = `${X}.filter`;
    m[note(d, 0x1b)] = `${X}.pfl`;
    m[note(d, 0x0d)] = `${X}.keylock`;
    m[note(d, 0x13)] = `${X}.loop4`;
    m[note(d, 0x14)] = `${X}.reloop`;
    for (let h = 0; h < 8; h++) m[note(d + 4, 0x14 + h)] = `${X}.hotcue${h + 1}`;
    m[note(15, 0x02 + d)] = `${X}.load`;
  });
  m[cc(15, 0x08)] = 'xfader';
  m[cc(15, 0x00)] = { a: 'browse', enc: 'twos' };
  return m;
}

/** Controller programmabili (Xone:K, Behringer CMD, Novation…): layout a griglia sul canale 1. */
function gridController() {
  const m = {};
  DECKS.forEach((X, d) => {
    const base = d * 4;
    m[cc(0, 0x00 + base)] = `${X}.eq.high`;
    m[cc(0, 0x01 + base)] = `${X}.eq.mid`;
    m[cc(0, 0x02 + base)] = `${X}.eq.low`;
    m[cc(0, 0x10 + d)] = `${X}.volume`;
    m[note(0, 0x24 + base)] = `${X}.play`;
    m[note(0, 0x25 + base)] = `${X}.cue`;
    m[note(0, 0x26 + base)] = `${X}.sync`;
    m[note(0, 0x27 + base)] = `${X}.pfl`;
  });
  return m;
}

const FAMILIES = {
  'pioneer-ddj': { brand: 'Pioneer DJ / AlphaTheta', build: pioneerDDJ, leds: true },
  // rev 2: EQ alti/bassi corretti, loop, SHIFT, modi dei pad, jog a impulsi (le vecchie correzioni vengono messe da parte)
  hercules: {
    brand: 'Hercules',
    build: herculesDJControl,
    leds: true,
    rev: 2,
    // all'avvio la console rimanda la posizione di fader e manopole
    init: [[0xb0, 0x7f, 0x7f]],
  },
  numark: { brand: 'Numark', build: () => inMusic({ jog: 'twos' }), leds: true },
  denon: { brand: 'Denon DJ', build: () => inMusic({ jog: 'rel64' }), leds: true },
  rane: { brand: 'Rane', build: () => inMusic({ jog: 'rel64' }), leds: true },
  grid: { brand: 'Generico', build: gridController, leds: false },
};

// --- Modelli ------------------------------------------------------------------------------

const MODELS = [
  // Pioneer DJ / AlphaTheta
  ['pioneer-ddj', 'DDJ-200', 'home', ['DDJ-200']],
  ['pioneer-ddj', 'DDJ-FLX2', 'home', ['DDJ-FLX2']],
  ['pioneer-ddj', 'DDJ-400', 'home', ['DDJ-400']],
  ['pioneer-ddj', 'DDJ-FLX4', 'home', ['DDJ-FLX4']],
  ['pioneer-ddj', 'DDJ-SB3', 'home', ['DDJ-SB3']],
  ['pioneer-ddj', 'DDJ-FLX6 / FLX6-GT', 'semi', ['DDJ-FLX6']],
  ['pioneer-ddj', 'DDJ-SR2', 'semi', ['DDJ-SR2']],
  // REV5 e REV7 hanno messaggi diversi dal REV1 (il REV7 ha i piatti motorizzati): si configurano con la procedura guidata
  ['pioneer-ddj', 'DDJ-REV1', 'semi', ['DDJ-REV1'], { id: 'pioneer-ddj-ddj-rev1-rev5-rev7' }],
  ['pioneer-ddj', 'DDJ-800', 'semi', ['DDJ-800']],
  ['pioneer-ddj', 'DDJ-SX3', 'pro', ['DDJ-SX3']],
  ['pioneer-ddj', 'DDJ-1000', 'pro', ['DDJ-1000'], { id: 'pioneer-ddj-ddj-1000-1000srt' }],
  ['pioneer-ddj', 'DDJ-1000SRT', 'pro', ['DDJ-1000SRT'], { id: 'pioneer-ddj-ddj-1000srt' }],
  ['pioneer-ddj', 'DDJ-FLX10', 'pro', ['DDJ-FLX10']],
  ['pioneer-ddj', 'XDJ-RX3 / XDJ-XZ (modalità PC)', 'pro', ['XDJ-RX', 'XDJ-XZ']],
  ['pioneer-ddj', 'Opus Quad (modalità PC)', 'pro', ['OPUS-QUAD', 'Opus Quad']],
  // Hercules
  // Inpulse 200 (anche MK2/MK3) e Starlight: scheda audio con casse su 1-2 e cuffia su 3-4 (manuali Hercules / Mixxx)
  ['hercules', 'DJControl Starlight', 'home', ['Starlight'], { opts: { pads: 4, loop: null, assistant: false, vinylAll: true, padModes: { beatloop: 0x10, fx: 0x20 } }, audio: { quad: true } }],
  ['hercules', 'DJControl Inpulse 200', 'home', ['Inpulse 200'], { opts: { pads: 4, loop: 'auto', padModes: { roll: 0x10, fx: 0x20 } }, audio: { quad: true } }],
  ['hercules', 'DJControl Inpulse 300', 'home', ['Inpulse 300'], { opts: INPULSE_300, ...HERCULES_4OUT }],
  ['hercules', 'DJControl Inpulse 500', 'semi', ['Inpulse 500'], { opts: INPULSE_500, ...HERCULES_500 }],
  ['hercules', 'DJControl Mix / Mix Ultra', 'home', ['DJControl Mix'], { opts: { pads: 4, loop: null, assistant: false, vinylAll: true, mixMaster: true, padModes: { sampler: 0x10, fx: 0x20, beatloop: 0x30 } } }],
  // T7: piatti motorizzati con posizione assoluta, mappa misurata sull'hardware (verified-maps.js); stessa scheda audio a 4 uscite
  ['hercules', 'DJControl Inpulse T7', 'semi', ['Inpulse T7'], { opts: INPULSE_500, ...HERCULES_4OUT }],
  // Numark
  ['numark', 'Party Mix / Party Mix Live / Party Mix II', 'home', ['Party Mix']],
  ['numark', 'DJ2GO2 Touch', 'home', ['DJ2GO2']],
  ['numark', 'Mixtrack Pro FX / Pro 3', 'home', ['Mixtrack Pro']],
  ['numark', 'Mixtrack Platinum FX', 'home', ['Mixtrack Platinum']],
  ['numark', 'NS4FX', 'semi', ['NS4FX']],
  ['numark', 'Mixstream Pro (modalità PC)', 'semi', ['Mixstream']],
  // Denon DJ
  ['denon', 'MC4000', 'semi', ['MC4000']],
  ['denon', 'MC6000MK2', 'semi', ['MC6000']],
  ['denon', 'MC7000', 'pro', ['MC7000']],
  // SC5000/SC6000 non hanno una mappa MIDI pubblica affidabile: si configurano con la procedura guidata
  ['denon', 'Prime 4 (modalità PC)', 'pro', ['PRIME 4', 'Prime 4'], { id: 'denon-prime-4' }],
  // Rane
  ['rane', 'ONE', 'pro', ['Rane ONE', 'RANE ONE']],
  ['rane', 'Seventy / Seventy-Two', 'pro', ['SEVENTY', 'Seventy']],
  ['rane', 'Four', 'pro', ['RANE FOUR', 'Rane Four']],
  // Programmabili
  ['grid', 'Allen & Heath Xone:K1 / K2 / K3', 'pro', ['XONE:K', 'Xone:K']],
  ['grid', 'Behringer CMD Micro', 'home', ['CMD Micro']],
  ['grid', 'Behringer CMD MM-1', 'semi', ['CMD MM-1', 'CMD MM1'], { id: 'grid-behringer-cmd-mm1' }],
  ['grid', 'Behringer CMD Studio 4a', 'semi', ['CMD Studio 4a', 'Studio 4a']],
  ['grid', 'Novation Launch Control', 'semi', ['Launch Control']],
  ['grid', 'Novation Launch Control XL', 'semi', ['Launch Control XL']],
];

export const PRESETS = MODELS.map(([family, name, tier, match, extra = {}]) => {
  const f = FAMILIES[family];
  const id = extra.id || `${family}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  // mappa verificata del singolo modello (Mixxx o documento del produttore), altrimenti profilo della famiglia
  const v = VERIFIED[id] && Object.keys(VERIFIED[id].mapping).length ? VERIFIED[id] : null;
  return {
    id,
    brand: f.brand,
    name,
    tier,
    family,
    match,
    // ✓ solo per mappe da Mixxx o documenti del produttore (non per quelle della comunità ancora in prova)
    verified: (Boolean(v) && !v.community) || (family === 'hercules' && !v),
    community: Boolean(v && v.community),
    source: v ? v.source : [],
    leds: v ? true : f.leds,
    // rev 2: mappa corretta rispetto al profilo generico della prima versione
    rev: v ? 2 : f.rev || 1,
    init: (v && v.init) || f.init || [],
    keepAlive: (v && v.keepAlive) || null,
    vu: (v && v.vu) || extra.vu || null,
    audio: extra.audio || null,
    guide: extra.guide || null,
    padColor: extra.padColor || null,
    ledOn: v && v.ledOn != null ? v.ledOn : null,
    ledOff: v && v.ledOff != null ? v.ledOff : null,
    noLed: (v && v.noLed) || extra.noLed || [],
    ledOut: (v && v.ledOut) || [],
    mapping: v ? v.mapping : f.build(extra.opts),
  };
}).map((p) => {
  // fader a 14 bit con il byte basso su un CC che non è n+32: indice byte basso → byte alto
  p.lsbOf = {};
  for (const [k, v] of Object.entries(p.mapping)) if (v && v.lsb) p.lsbOf[v.lsb] = k;
  return p;
});

/** Trova il profilo adatto al nome della periferica MIDI (es. "DDJ-FLX4 MIDI 1"). */
export function detectPreset(deviceName) {
  if (!deviceName) return null;
  const name = deviceName.toLowerCase();
  // i nomi più lunghi vincono (es. "DDJ-FLX10" prima di "DDJ-FLX1")
  let best = null;
  let bestLen = 0;
  for (const p of PRESETS) {
    for (const m of p.match) {
      const needle = m.toLowerCase();
      if (name.includes(needle) && needle.length > bestLen) {
        best = p;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** Normalizza una voce di mappatura in { a, enc, invert, arg, res }. */
export function normalizeEntry(v) {
  if (!v) return null;
  if (typeof v === 'string') return { a: v, enc: 'twos', invert: false };
  const e = { a: v.a, enc: v.enc || 'twos', invert: Boolean(v.invert) };
  if (v.arg != null) e.arg = v.arg;
  if (v.res) e.res = v.res;
  if (v.hires) e.hires = true;
  if (v.lsb) e.lsb = v.lsb;
  return e;
}

/** Decodifica un encoder relativo in un passo con segno. */
export function decodeRelative(raw, enc = 'twos') {
  if (enc === 'rel64') return raw - 64;
  if (enc === 'signmag') return raw & 0x40 ? -(raw & 0x3f) : raw & 0x3f;
  return raw < 64 ? raw : raw - 128;
}

/** Ordine della procedura guidata di mappatura. */
export const WIZARD_STEPS = [
  'A.play', 'A.cue', 'A.sync', 'A.jogTouch', 'A.jogScratch', 'A.pitch', 'A.volume', 'A.eq.high', 'A.eq.mid', 'A.eq.low', 'A.filter', 'A.pfl',
  'A.hotcue1', 'A.hotcue2', 'A.hotcue3', 'A.hotcue4', 'A.loop4', 'A.load',
  'B.play', 'B.cue', 'B.sync', 'B.jogTouch', 'B.jogScratch', 'B.pitch', 'B.volume', 'B.eq.high', 'B.eq.mid', 'B.eq.low', 'B.filter', 'B.pfl',
  'B.hotcue1', 'B.hotcue2', 'B.hotcue3', 'B.hotcue4', 'B.loop4', 'B.load',
  'xfader', 'browse', 'master',
];
