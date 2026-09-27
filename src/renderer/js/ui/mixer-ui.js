// Mixer: canali A/B, master, cuffia, microfono, crossfader.
import { el, button, knob, fader, vuMeter, select } from './controls.js';
import { icon } from './icons.js';

const dbFmt = (v) => (Math.abs(v) < 0.01 ? '0' : `${v > 0 ? '+' : ''}${(v < 0 ? v * 30 : v * 6).toFixed(0)}`);

export class MixerUI {
  constructor(root, { engine, strips, decks, mic, sampler, accents }) {
    this.root = root;
    this.engine = engine;
    this.strips = strips;
    this.decks = decks;
    this.mic = mic;
    this.sampler = sampler;
    this.accents = accents;
    this.meters = [];
    this.controls = {};
    this.build();
  }

  channel(strip, i) {
    const accent = this.accents[i];
    const id = strip.name;
    const eq = {};
    const kills = {};
    const knobs = el('div', { class: 'mix-channel' });
    knobs.style.setProperty('--deck-accent', accent);
    const gain = knob({ label: 'GAIN', min: -12, max: 12, value: 0, def: 0, bipolar: true, size: 30, color: accent, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`, onChange: (v) => strip.setTrim(v) });
    knobs.append(el('div', { class: 'eq-row' }, el('div', { class: 'ch-label' }, id), gain));
    for (const band of ['high', 'mid', 'low']) {
      eq[band] = knob({ label: band.toUpperCase(), min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 30, color: accent, format: dbFmt, onChange: (v) => strip.setEq(band, v) });
      kills[band] = button('K', { className: 'kill', title: `Kill ${band}`, onClick: () => {
        strip.setKill(band, !strip.kills[band]);
        kills[band].setOn(strip.kills[band]);
      } });
      knobs.append(el('div', { class: 'eq-row' }, eq[band], kills[band]));
    }
    const filter = knob({ label: 'FILTER', min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 30, color: '#ffd60a', format: (v) => (Math.abs(v) < 0.03 ? '' : v < 0 ? 'LP' : 'HP'), onChange: (v) => strip.setFilter(v) });
    knobs.append(filter);

    const cue = button(icon('headphones', 15), { className: 'cue-btn toggle', title: 'Preascolto in cuffia (PFL)', onClick: () => {
      strip.setCue(!strip.cue);
      cue.setOn(strip.cue);
    } });
    const vu = vuMeter({ width: 10, height: 112, segments: 20 });
    const vol = fader({ vertical: true, min: 0, max: 1, value: 0.85, def: 0.85, className: 'volume', onChange: (v) => strip.setVolume(v) });
    strip.setVolume(0.85);
    const xfAssign = select([{ value: 'A', label: 'A' }, { value: 'thru', label: 'THRU' }, { value: 'B', label: 'B' }], i === 0 ? 'A' : 'B', (v) => strip.setCrossfaderAssign(v), 'xf-assign');
    strip.setCrossfaderAssign(i === 0 ? 'A' : 'B');
    const faderCol = el('div', { class: 'mix-fader-col' },
      el('div', { class: 'fader-row' }, i === 0 ? vu : null, vol, i === 1 ? vu : null),
      el('div', { class: 'row tight center' }, cue, xfAssign));
    faderCol.style.setProperty('--deck-accent', accent);
    this.meters.push({ meter: strip.meter, canvas: vu });
    this.controls[id] = { gain, eq, kills, filter, cue, vol, xfAssign };
    return { knobs, faderCol };
  }

  build() {
    const r = this.root;
    r.classList.add('mixer');
    const chA = this.channel(this.strips[0], 0);
    const chB = this.channel(this.strips[1], 1);

    const master = knob({ label: 'MASTER', value: 0.8, def: 0.8, size: 38, color: '#fff', format: (v) => `${Math.round(v * 100)}`, onChange: (v) => this.engine.setMasterVolume(v) });
    const masterVu = vuMeter({ width: 16, height: 112, segments: 24 });
    this.meters.push({ meter: this.engine.masterMeter, canvas: masterVu, clip: true });
    const hpVol = knob({ label: 'CUFFIA', value: 0.8, def: 0.8, size: 28, color: '#fff', onChange: (v) => this.engine.setHeadphoneVolume(v) });
    const cueMix = knob({ label: 'CUE/MIX', value: 0, def: 0, size: 28, color: '#fff', format: (v) => (v < 0.05 ? 'CUE' : v > 0.95 ? 'MST' : ''), onChange: (v) => this.engine.setCueMix(v) });
    const limiter = button('LIMIT', { className: 'small toggle', title: 'Limiter sul master', onClick: () => {
      this.engine.setLimiter(!this.engine.limiterOn);
      limiter.setOn(this.engine.limiterOn);
    } });
    limiter.setOn(true);
    this.limiterBtn = limiter;
    this.clipEl = el('div', { class: 'clip' }, 'CLIP');

    // microfono
    const mic = this.mic;
    this.micOn = button('MIC', { className: 'small toggle mic-on', title: 'Microfono in onda (Spazio)', onClick: () => mic.setOnAir(!mic.onAir) });
    this.talkBtn = button('TALK', { className: 'small toggle', title: 'Talkover: abbassa la musica quando il mic è attivo', onClick: () => mic.setTalkover(!mic.talkover) });
    const micGain = knob({ label: 'MIC', value: 0.7, def: 0.7, size: 24, color: '#ff375f', onChange: (v) => mic.setGain(v) });
    const micHi = knob({ label: 'HI', min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 24, color: '#ff375f', onChange: (v) => mic.setEq('high', v) });
    const micLo = knob({ label: 'LO', min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 24, color: '#ff375f', onChange: (v) => mic.setEq('low', v) });
    const micEcho = knob({ label: 'ECHO', value: 0, def: 0, size: 24, color: '#ff375f', onChange: (v) => mic.setEcho(v) });
    mic.setGain(0.7);
    const micVu = vuMeter({ width: 90, height: 6, segments: 18, horizontal: true });
    this.meters.push({ meter: mic.meter, canvas: micVu });
    mic.addEventListener('change', () => {
      this.micOn.setOn(mic.onAir);
      this.talkBtn.setOn(mic.talkover);
    });
    this.talkBtn.setOn(true);

    const center = el('div', { class: 'mix-center' },
      master,
      el('div', { class: 'row tight center' }, hpVol, cueMix),
      el('div', { class: 'mic-box' },
        el('div', { class: 'row tight center' }, this.micOn, this.talkBtn),
        micVu,
        el('div', { class: 'row tight center nowrap' }, micGain, micHi, micLo, micEcho)));

    const masterCol = el('div', { class: 'mix-master-col' }, masterVu, this.clipEl, limiter);

    // crossfader
    this.xfader = fader({ vertical: false, min: -1, max: 1, value: 0, def: 0, center: true, className: 'crossfader', onChange: (v) => this.engine.setCrossfader(v) });
    this.engine.addEventListener('crossfader', (e) => this.xfader.setValue(e.detail));
    const curve = select([{ value: 'smooth', label: '◠' }, { value: 'linear', label: '╱' }, { value: 'cut', label: '⊓' }], 'smooth', (v) => this.engine.setCrossfaderCurve(v), 'xf-curve');
    curve.title = 'Curva crossfader: morbida / lineare / scratch';
    this.curveSel = curve;

    r.append(
      el('div', { class: 'mix-top' }, chA.knobs, center, chB.knobs),
      el('div', { class: 'mix-bottom' }, chA.faderCol, masterCol, chB.faderCol),
      el('div', { class: 'xf-row' }, el('span', { class: 'xf-label a' }, 'A'), this.xfader, el('span', { class: 'xf-label b' }, 'B'), curve));
    this.masterKnob = master;
    this.hpVolKnob = hpVol;
    this.cueMixKnob = cueMix;
  }

  frame() {
    let clip = false;
    for (const m of this.meters) {
      const v = m.meter.read();
      m.canvas.draw(v);
      if (m.clip && v.clip) clip = true;
    }
    this.clipEl.classList.toggle('on', clip);
  }
}
