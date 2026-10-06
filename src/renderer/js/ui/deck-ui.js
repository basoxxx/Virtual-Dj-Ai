// Pannello del deck: info brano, forma d'onda d'insieme, jog, trasporto, hot cue, loop, effetti, pitch.
import { el, button, knob, fader, select, toast, askText } from './controls.js';
import { OverviewWaveform, HOTCUE_COLORS } from './waveform.js';
import { JogWheel } from './jog.js';
import { EFFECTS } from '../audio/effects.js';
import { formatTime } from '../dsp/analysis.js';
import { HOTCUE_COUNT } from '../audio/deck.js';
import { icon } from './icons.js';

const LOOP_SIZES = [
  { beats: 0.25, label: '¼' },
  { beats: 0.5, label: '½' },
  { beats: 1, label: '1' },
  { beats: 2, label: '2' },
  { beats: 4, label: '4' },
  { beats: 8, label: '8' },
  { beats: 16, label: '16' },
  { beats: 32, label: '32' },
];

export class DeckUI {
  constructor(root, deck, { accent, side, getOther, onRequestLoad, inputDevices, stems }) {
    this.stems = stems;
    this.root = root;
    this.deck = deck;
    this.accent = accent;
    this.side = side;
    this.getOther = getOther;
    this.onRequestLoad = onRequestLoad;
    this.inputDevices = inputDevices;
    this.remainingMode = true;
    this.build();
    this.bind();
  }

  build() {
    const d = this.deck;
    const r = this.root;
    r.classList.add('deck', `deck-${this.side}`);
    r.style.setProperty('--deck-accent', this.accent);

    // intestazione
    this.cover = el('div', { class: 'deck-cover' }, d.id);
    this.title = el('div', { class: 'deck-title' }, 'Nessun brano');
    this.artist = el('div', { class: 'deck-artist' }, 'Trascina un brano dalla libreria');
    this.bpmEl = el('div', { class: 'deck-bpm', title: 'Doppio clic per modificare il BPM' }, '---.--');
    this.keyEl = el('div', { class: 'deck-key' }, '');
    this.timeEl = el('div', { class: 'deck-time', title: 'Clic: tempo trascorso/rimanente' }, '-00:00.0');
    this.durEl = el('div', { class: 'deck-dur' }, '00:00');
    this.pitchEl = el('div', { class: 'deck-pitch' }, '0.00%');
    this.analyzingEl = el('div', { class: 'deck-analyzing' }, 'ANALISI…');
    const header = el('div', { class: 'deck-header' },
      el('div', { class: 'deck-letter' }, d.id),
      this.cover,
      el('div', { class: 'deck-meta' }, this.title, this.artist),
      el('div', { class: 'deck-numbers' },
        el('div', { class: 'deck-num-row' }, this.timeEl, this.durEl),
        el('div', { class: 'deck-num-row' }, this.bpmEl, el('span', { class: 'unit' }, 'BPM'), this.keyEl, this.pitchEl)),
      this.analyzingEl);

    this.overviewCanvas = el('canvas', { class: 'overview' });
    this.overview = new OverviewWaveform(this.overviewCanvas, d, this.accent);

    // jog
    this.jogCanvas = el('canvas', { class: 'jog' });
    this.jog = new JogWheel(this.jogCanvas, d, this.accent);
    this.vinylBtn = button('VINYL', { className: 'small toggle', title: 'Modalità vinile: toccando il jog si fa scratch', onClick: () => { d.vinyl = !d.vinyl; this.refresh(); } });
    this.slipBtn = button('SLIP', { className: 'small toggle', title: 'Slip: dopo loop/scratch riprende dove sarebbe arrivato', onClick: () => d.setSlip(!d.slip) });
    this.revBtn = button('REV', { className: 'small toggle', title: 'Riproduzione al contrario', onClick: () => d.setReverse(!d.reverse) });
    this.censorBtn = button('CENSOR', { className: 'small', title: 'Tieni premuto: reverse momentaneo con slip', onDown: () => d.censor(true), onUp: () => d.censor(false) });
    this.stemBtn = button('STEM', { className: 'small toggle', title: 'Brano completo / solo voce / solo base (Segueo Separazione voce, sul computer)', onClick: () => this.cycleStem() });
    const jogCol = el('div', { class: 'jog-col' }, this.jogCanvas,
      el('div', { class: 'row tight' }, this.vinylBtn, this.slipBtn, this.revBtn, this.censorBtn, this.stemBtn));

    // trasporto
    this.cueBtn = button('CUE', { className: 'transport cue', onDown: () => d.cueDown(), onUp: () => d.cueUp() });
    this.playBtn = button('PLAY', { className: 'transport play', onClick: () => d.togglePlay() });
    this.syncBtn = button('SYNC', { className: 'transport sync', onClick: () => {
      if (!d.sync(this.getOther())) toast('Sync: serve il BPM su entrambi i deck', 'warn');
    } });
    this.stutterBtn = button(icon('restart', 18), { className: 'transport small-t', title: 'Riparti dal cue (stutter)', onClick: () => d.cuePlay() });

    // hot cue
    this.hotBtns = [];
    const hot = el('div', { class: 'hotcues' });
    for (let i = 0; i < HOTCUE_COUNT; i++) {
      const b = button(String(i + 1), { className: 'hotcue', title: 'Clic: imposta/salta · Clic destro o Shift+clic: cancella' });
      b.style.setProperty('--hc', HOTCUE_COLORS[i]);
      b.addEventListener('click', (e) => (e.shiftKey ? d.deleteHotcue(i) : d.hotcue(i)));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        d.deleteHotcue(i);
      });
      this.hotBtns.push(b);
      hot.append(b);
    }

    // loop
    this.loopBtns = LOOP_SIZES.map((s) => {
      const b = button(s.label, { className: 'loop-size', title: `Loop di ${s.beats} battute`, onClick: () => d.autoLoop(s.beats) });
      b.dataset.beats = s.beats;
      return b;
    });
    this.reloopBtn = button('RELOOP', { className: 'small', onClick: () => d.reloop() });
    const loopBox = el('div', { class: 'loop-box' },
      el('div', { class: 'section-label' }, 'LOOP'),
      el('div', { class: 'loop-sizes' }, this.loopBtns),
      el('div', { class: 'row tight' },
        button('IN', { className: 'small', onClick: () => d.loopIn() }),
        button('OUT', { className: 'small', onClick: () => d.loopOut() }),
        this.reloopBtn,
        button('½×', { className: 'small', title: 'Dimezza loop', onClick: () => d.loopScale(0.5) }),
        button('2×', { className: 'small', title: 'Raddoppia loop', onClick: () => d.loopScale(2) })),
      el('div', { class: 'row tight' },
        el('span', { class: 'mini-label' }, 'JUMP'),
        button('◀◀ 4', { className: 'small', onClick: () => d.beatJump(-4) }),
        button('◀ 1', { className: 'small', onClick: () => d.beatJump(-1) }),
        button('1 ▶', { className: 'small', onClick: () => d.beatJump(1) }),
        button('4 ▶▶', { className: 'small', onClick: () => d.beatJump(4) }),
        el('span', { class: 'mini-label' }, 'MOVE'),
        button('◀', { className: 'small', title: 'Sposta loop indietro di 1 battuta', onClick: () => d.loopMove(-1) }),
        button('▶', { className: 'small', title: 'Sposta loop avanti di 1 battuta', onClick: () => d.loopMove(1) })));

    // effetti
    const fxBoxes = d.fx.map((slot, i) => {
      const paramLabel = el('span', { class: 'mini-label' }, '');
      const onBtn = button(`FX${i + 1}`, { className: 'small toggle fx-on', onClick: () => {
        slot.setOn(!slot.on);
        onBtn.setOn(slot.on);
      } });
      const sel = select(EFFECTS.map((f) => ({ value: f.id, label: f.name })), 'none', (v) => {
        slot.setType(v);
        paramLabel.textContent = EFFECTS.find((f) => f.id === v).param;
        if (v !== 'none' && !slot.on) {
          slot.setOn(true);
          onBtn.setOn(true);
        }
      }, 'fx-select');
      const wet = knob({ label: 'DRY/WET', value: 0.5, def: 0.5, size: 30, color: this.accent, onChange: (v) => slot.setMix(v) });
      const param = knob({ label: 'PARAM', value: 0.5, def: 0.5, size: 30, color: this.accent, onChange: (v) => slot.setParam(v) });
      const box = el('div', { class: 'fx-box' }, el('div', { class: 'row tight' }, onBtn, sel), el('div', { class: 'row tight center' }, wet, param), paramLabel);
      box.fxControls = { onBtn, sel, wet, param, slot };
      return box;
    });
    this.fxBoxes = fxBoxes;

    const pads = el('div', { class: 'deck-pads' },
      el('div', { class: 'section-label' }, 'HOT CUE'), hot, loopBox,
      el('div', { class: 'fx-row' }, fxBoxes));

    // pitch
    this.pitchFader = fader({ vertical: true, min: -1, max: 1, value: 0, def: 0, invert: true, center: true, className: 'pitch', onChange: (v) => d.setPitch(v * d.pitchRange) });
    this.rangeSel = select([8, 16, 25, 50, 100].map((r) => ({ value: String(r), label: `±${r}%` })), '8', (v) => {
      const pct = d.pitch;
      d.setPitchRange(Number(v));
      d.setPitch(pct);
      this.pitchFader.setValue(d.pitch / d.pitchRange);
    }, 'range-select');
    this.keylockBtn = button('KEY', { className: 'small toggle', title: 'Keylock: mantiene la tonalità cambiando il tempo', onClick: () => d.setKeylock(!d.keylock) });
    const pitchCol = el('div', { class: 'pitch-col' },
      this.rangeSel,
      el('div', { class: 'pitch-scale' }, el('span', {}, '−'), el('span', {}, '+')),
      this.pitchFader,
      button('0', { className: 'small', title: 'Azzera pitch', onClick: () => { d.setPitch(0); this.pitchFader.setValue(0); } }),
      el('div', { class: 'row tight' },
        button('−', { className: 'small nudge', title: 'Rallenta (nudge)', onDown: () => d.bend(-4), onUp: () => d.bend(0) }),
        button('+', { className: 'small nudge', title: 'Accelera (nudge)', onDown: () => d.bend(4), onUp: () => d.bend(0) })),
      this.keylockBtn);

    // barra inferiore
    this.lineSel = select([{ value: '', label: 'Sorgente: file' }], '', async (v) => {
      try {
        await d.setLineInput(v || null);
      } catch (err) {
        toast(`Ingresso non disponibile: ${err.message}`, 'error');
        this.lineSel.value = '';
      }
    }, 'line-select');
    const tools = el('div', { class: 'row tight deck-tools' },
      button('TAP', { className: 'small', title: 'Batti il tempo per impostare il BPM', onClick: () => d.tapTempo() }),
      button('GRID', { className: 'small', title: 'Allinea la beatgrid alla posizione attuale', onClick: () => d.setGridHere() }),
      button('×2', { className: 'small', title: 'Raddoppia BPM', onClick: () => d.setBpm(d.bpm * 2) }),
      button('÷2', { className: 'small', title: 'Dimezza BPM', onClick: () => d.setBpm(d.bpm / 2) }),
      this.quantBtn = button('Q', { className: 'small toggle', title: 'Quantize: cue e loop agganciati alla battuta', onClick: () => { d.quantize = !d.quantize; this.refresh(); } }),
      button(icon('eject', 14), { className: 'small', title: 'Espelli', onClick: () => { if (!d.eject()) toast('Ferma il deck prima di espellere', 'warn'); } }),
      this.lineSel);

    const transport = el('div', { class: 'transport-row' }, this.cueBtn, this.playBtn, this.syncBtn, this.stutterBtn);
    const bodyChildren = this.side === 'left' ? [jogCol, pads, pitchCol] : [pitchCol, pads, jogCol];
    r.append(header, this.overviewCanvas, el('div', { class: 'deck-body' }, bodyChildren), transport, tools);

    // trascinamento dei brani sul deck
    r.addEventListener('dragover', (e) => {
      e.preventDefault();
      r.classList.add('drop');
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      r.classList.remove('drop');
      this.onRequestLoad(e);
    });
    this.timeEl.addEventListener('click', () => {
      this.remainingMode = !this.remainingMode;
    });
    this.bpmEl.addEventListener('dblclick', async () => {
      const v = await askText('BPM del brano', d.bpm ? d.bpm.toFixed(2) : '');
      if (v) d.setBpm(parseFloat(v.replace(',', '.')));
    });
  }

  updateInputs(inputs) {
    const current = this.lineSel.value;
    this.lineSel.setOptions([{ value: '', label: 'Sorgente: file' }, ...inputs.map((i, n) => ({ value: i.deviceId, label: `Linea: ${i.label || `Ingresso ${n + 1}`}` }))], current);
  }

  bind() {
    const d = this.deck;
    d.addEventListener('state', () => this.refresh());
    d.addEventListener('loaded', () => this.refreshTrack());
    d.addEventListener('analyzed', () => this.refreshTrack());
    d.addEventListener('loading', (e) => {
      this.title.textContent = `Caricamento: ${e.detail.title}`;
    });
    d.addEventListener('cover', (e) => {
      this.cover.style.backgroundImage = e.detail ? `url("${e.detail}")` : '';
      this.cover.textContent = e.detail ? '' : d.id;
    });
    d.addEventListener('analyzing', (e) => this.analyzingEl.classList.toggle('show', e.detail));
    d.addEventListener('error', (e) => toast(e.detail, 'error'));
    d.addEventListener('pitch', () => this.pitchFader.setValue(d.pitch / d.pitchRange));
    d.addEventListener('fx', () => this.fxBoxes.forEach((box) => {
      const c = box.fxControls;
      c.sel.value = c.slot.type;
      c.onBtn.setOn(c.slot.on);
      c.wet.setValue(c.slot.mix);
      c.param.setValue(c.slot.param);
    }));
    d.addEventListener('line', (e) => {
      this.lineSel.value = e.detail || '';
      this.refreshTrack();
    });
    this.refreshTrack();
    this.refresh();
  }

  refreshTrack() {
    const d = this.deck;
    const t = d.track;
    if (d.lineDevice) {
      this.title.textContent = 'Ingresso linea';
      this.artist.textContent = 'Sorgente esterna dalla scheda audio';
    } else {
      this.title.textContent = t ? t.title : 'Nessun brano';
      this.artist.textContent = t ? [t.artist, t.album].filter(Boolean).join(' — ') || '—' : 'Trascina un brano dalla libreria';
    }
    this.durEl.textContent = formatTime(d.duration, false);
    if (!d.cover) {
      this.cover.style.backgroundImage = '';
      this.cover.textContent = d.id;
    }
    this.refresh();
  }

  /** STEM: brano completo → solo voce → solo base; se il brano non è separato, lo separa. */
  async cycleStem() {
    const d = this.deck;
    const track = d.track;
    if (!track || !this.stems) return;
    try {
      if (!(await this.stems.has(track))) {
        if (!(await this.stems.checkModel())) {
          toast('Scarica prima il modello per separare voce e base (pannello AI DJ)', 'warn');
          return;
        }
        toast(`Separo voce e base di "${track.title}": l'avanzamento è nel pannello AI DJ`);
        await this.stems.ensure(track);
        toast(`Voce e base di "${track.title}" pronte: premi STEM per sceglierle`);
        return;
      }
      const order = ['full', 'vocals', 'instrumental'];
      await d.setStem(order[(order.indexOf(d.stem || 'full') + 1) % order.length]);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  refresh() {
    const d = this.deck;
    this.stemBtn.textContent = { vocals: 'VOCE', instrumental: 'BASE' }[d.stem] || 'STEM';
    this.stemBtn.setOn(Boolean(d.stem) && d.stem !== 'full');
    this.playBtn.setOn(d.playing);
    this.playBtn.textContent = d.playing ? 'PAUSA' : 'PLAY';
    this.cueBtn.setOn(!d.playing && d.loaded && Math.abs(d.position - d.cuePoint) < 0.02);
    this.keylockBtn.setOn(d.keylock);
    this.slipBtn.setOn(d.slip);
    this.revBtn.setOn(d.reverse);
    this.vinylBtn.setOn(d.vinyl);
    this.quantBtn.setOn(d.quantize);
    this.rangeSel.value = String(d.pitchRange);
    this.hotBtns.forEach((b, i) => b.classList.toggle('set', d.hotcues[i] != null));
    this.loopBtns.forEach((b) => b.setOn(d.loop.active && Number(b.dataset.beats) === d.loop.beats));
    this.reloopBtn.setOn(d.loop.active);
    this.bpmEl.textContent = d.bpm ? d.effectiveBpm.toFixed(2) : '---.--';
    this.keyEl.textContent = d.displayKey ? `${d.displayKey}${d.keyShift ? ` ${d.keyShift > 0 ? '+' : ''}${d.keyShift}` : ''}` : '';
    this.keyEl.title = d.keyShift ? `Tonalità trasposta di ${d.keyShift} semitoni` : '';
    this.pitchEl.textContent = `${d.pitch >= 0 ? '+' : ''}${d.pitch.toFixed(2)}%`;
    const other = this.getOther();
    this.syncBtn.classList.toggle('matched', Boolean(other && other.bpm && d.bpm && Math.abs(other.effectiveBpm - d.effectiveBpm) < 0.05));
    this.root.classList.toggle('playing', d.playing);
  }

  frame() {
    const d = this.deck;
    this.overview.draw();
    this.jog.draw();
    const t = this.remainingMode ? -d.remaining : d.position;
    this.timeEl.textContent = `${t < 0 ? '-' : ''}${formatTime(Math.abs(t))}`;
    this.timeEl.classList.toggle('warn', d.playing && d.remaining < 30);
    const cueOn = !d.playing && d.loaded && Math.abs(d.position - d.cuePoint) < 0.02;
    this.cueBtn.classList.toggle('on', cueOn);
    // lampeggio del play in pausa
    if (!d.playing && d.loaded) this.playBtn.classList.toggle('blink', Math.floor(performance.now() / 500) % 2 === 0);
    else this.playBtn.classList.remove('blink');
  }
}
