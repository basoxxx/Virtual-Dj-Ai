// Catalogo delle console DJ supportate con riconoscimento automatico dal nome della periferica MIDI.
// Ogni marca usa la stessa convenzione MIDI su tutta la gamma: le mappature sono generate per famiglia
// e adattate modello per modello (numero di deck, codifica dei jog, LED).
//
// Le mappature seguono la documentazione MIDI pubblica dei produttori. Se un controllo di un modello
// specifico non risponde, si può correggere con "Learn" o con la procedura guidata: le correzioni
// dell'utente hanno sempre la precedenza sul profilo.

export const TIERS = {
  home: 'Casa / principianti',
  semi: 'Semi-professionale',
  pro: 'Professionale',
};

/** Tutte le azioni controllabili da MIDI (registrate dall'app). */
export function knownActions() {
  const ids = [];
  for (const X of ['A', 'B']) {
    ids.push(`${X}.play`, `${X}.cue`, `${X}.sync`, `${X}.stutter`, `${X}.keylock`, `${X}.slip`, `${X}.censor`);
    for (let h = 1; h <= 8; h++) ids.push(`${X}.hotcue${h}`);
    ids.push(`${X}.loop4`, `${X}.reloop`, `${X}.loopHalf`, `${X}.loopDouble`, `${X}.loopIn`, `${X}.loopOut`);
    ids.push(`${X}.jumpBack`, `${X}.jumpFwd`, `${X}.nudgeDown`, `${X}.nudgeUp`, `${X}.tempoReset`);
    ids.push(`${X}.pitch`, `${X}.jog`, `${X}.jogTouch`, `${X}.jogScratch`);
    ids.push(`${X}.volume`, `${X}.gain`, `${X}.eq.high`, `${X}.eq.mid`, `${X}.eq.low`, `${X}.filter`, `${X}.pfl`);
    for (let f = 1; f <= 2; f++) ids.push(`${X}.fx${f}.on`, `${X}.fx${f}.mix`, `${X}.fx${f}.param`);
    ids.push(`${X}.load`);
  }
  ids.push('xfader', 'master', 'hpVolume', 'cueMix', 'mic', 'automix', 'aiMixNow', 'aiSkip', 'record', 'browse');
  for (let p = 1; p <= 8; p++) ids.push(`sampler${p}`);
  return ids;
}

const note = (ch, n) => `note:${ch}:${n}`;
const cc = (ch, n) => `cc:${ch}:${n}`;
const DECKS = ['A', 'B'];

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
    m[cc(d, 0x00)] = { a: `${X}.pitch`, invert: true };
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

/** Hercules DJControl (Inpulse, Starlight…): mixer sul canale 1, deck sui canali 2 e 3. */
function herculesDJControl() {
  const m = {};
  DECKS.forEach((X, d) => {
    const ch = d + 1;
    m[note(ch, 0x07)] = `${X}.play`;
    m[note(ch, 0x06)] = `${X}.cue`;
    m[note(ch, 0x05)] = `${X}.sync`;
    m[note(ch, 0x08)] = `${X}.jogTouch`;
    m[cc(ch, 0x09)] = { a: `${X}.jog`, enc: 'twos' };
    m[cc(ch, 0x0a)] = { a: `${X}.jogScratch`, enc: 'twos' };
    m[cc(ch, 0x08)] = { a: `${X}.pitch`, invert: true };
    m[cc(ch, 0x00)] = `${X}.volume`;
    m[cc(ch, 0x05)] = `${X}.gain`;
    m[cc(ch, 0x02)] = `${X}.eq.high`;
    m[cc(ch, 0x03)] = `${X}.eq.mid`;
    m[cc(ch, 0x04)] = `${X}.eq.low`;
    m[cc(ch, 0x01)] = `${X}.filter`;
    m[note(ch, 0x0c)] = `${X}.pfl`;
    m[note(ch, 0x0d)] = `${X}.load`;
    m[note(ch, 0x09)] = `${X}.loop4`;
    for (let h = 0; h < 8; h++) m[note(d + 6, h)] = `${X}.hotcue${h + 1}`;
    for (let p = 0; p < 4; p++) m[note(d + 6, 0x30 + p)] = `sampler${d * 4 + p + 1}`;
  });
  m[cc(0, 0x00)] = 'xfader';
  m[cc(0, 0x01)] = { a: 'browse', enc: 'twos' };
  return m;
}

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
  hercules: { brand: 'Hercules', build: herculesDJControl, leds: true },
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
  ['pioneer-ddj', 'DDJ-REV1 / REV5 / REV7', 'semi', ['DDJ-REV']],
  ['pioneer-ddj', 'DDJ-800', 'semi', ['DDJ-800']],
  ['pioneer-ddj', 'DDJ-SX3', 'pro', ['DDJ-SX3']],
  ['pioneer-ddj', 'DDJ-1000 / 1000SRT', 'pro', ['DDJ-1000']],
  ['pioneer-ddj', 'DDJ-FLX10', 'pro', ['DDJ-FLX10']],
  ['pioneer-ddj', 'XDJ-RX3 / XDJ-XZ (modalità PC)', 'pro', ['XDJ-RX', 'XDJ-XZ']],
  ['pioneer-ddj', 'Opus Quad (modalità PC)', 'pro', ['OPUS-QUAD', 'Opus Quad']],
  // Hercules
  ['hercules', 'DJControl Starlight', 'home', ['Starlight']],
  ['hercules', 'DJControl Inpulse 200', 'home', ['Inpulse 200']],
  ['hercules', 'DJControl Inpulse 300', 'home', ['Inpulse 300']],
  ['hercules', 'DJControl Inpulse 500', 'semi', ['Inpulse 500']],
  ['hercules', 'DJControl Mix / Mix Ultra', 'home', ['DJControl Mix']],
  ['hercules', 'DJControl Inpulse T7', 'semi', ['Inpulse T7']],
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
  ['denon', 'SC6000 / SC5000 / Prime 4 (modalità PC)', 'pro', ['SC6000', 'SC5000', 'PRIME 4', 'Prime 4']],
  // Rane
  ['rane', 'ONE', 'pro', ['Rane ONE', 'RANE ONE']],
  ['rane', 'Seventy / Seventy-Two', 'pro', ['SEVENTY', 'Seventy']],
  ['rane', 'Four', 'pro', ['RANE FOUR', 'Rane Four']],
  // Programmabili
  ['grid', 'Allen & Heath Xone:K1 / K2 / K3', 'pro', ['XONE:K', 'Xone:K']],
  ['grid', 'Behringer CMD / Novation Launch Control', 'semi', ['CMD ', 'Launch Control']],
];

export const PRESETS = MODELS.map(([family, name, tier, match]) => {
  const f = FAMILIES[family];
  return {
    id: `${family}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    brand: f.brand,
    name,
    tier,
    family,
    match,
    leds: f.leds,
    mapping: f.build(),
  };
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

/** Normalizza una voce di mappatura in { a, enc, invert }. */
export function normalizeEntry(v) {
  if (!v) return null;
  if (typeof v === 'string') return { a: v, enc: 'twos', invert: false };
  return { a: v.a, enc: v.enc || 'twos', invert: Boolean(v.invert) };
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
