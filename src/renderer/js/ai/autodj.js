// AI DJ: mixa in automatico. Sceglie il brano successivo (motore interno o LLM locale),
// lo precarica, calcola il punto di mix allineato alle frasi, sincronizza tempo e fase
// ed esegue la transizione muovendo crossfader, EQ, filtri ed effetti come un DJ.
import { rankCandidates, planTransition, transitionState, buildSet } from './selector.js';
import { formatTime } from '../dsp/analysis.js';
import { planCurves } from './transition-planner.js';
import { curvesAt } from './transition-model.js';

const DEFAULT_OPTIONS = {
  mode: 'ai', // 'ai' = sceglie l'AI, 'queue' = segue la coda
  source: 'library', // 'library' oppure id di una playlist
  strategy: 'steady',
  style: 'auto',
  bars: 16,
  useLLM: false,
  returnTempo: true,
  notes: '',
};

export class AutoDJ extends EventTarget {
  constructor({ engine, decks, getControls, getPool, llm }) {
    super();
    this.engine = engine;
    this.decks = decks;
    this.getControls = getControls;
    this.getPool = getPool;
    this.llm = llm;
    this.options = { ...DEFAULT_OPTIONS };
    this.queue = [];
    this.enabled = false;
    this.history = [];
    this.log = [];
    this.plan = null;
    this.transition = null;
    this.selecting = false;
    this.timer = null;
    this.step = 0;
  }

  // --- compatibilità con la vecchia coda Automix ---------------------------------

  get mixLength() {
    return this.options.bars;
  }

  set mixLength(v) {
    this.options.bars = v;
  }

  emit(type = 'change', detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  say(text) {
    const entry = { at: new Date(), text };
    this.log.push(entry);
    if (this.log.length > 60) this.log.shift();
    this.emit('log', entry);
  }

  setOptions(patch) {
    Object.assign(this.options, patch);
    // la pianificazione dipende dalle opzioni: si ricalcola
    if (this.plan && !this.transition) this.plan = null;
    this.emit();
  }

  setQueue(tracks) {
    this.queue = [...tracks];
    this.emit();
  }

  enqueue(tracks) {
    this.queue.push(...tracks);
    this.emit();
  }

  remove(i) {
    this.queue.splice(i, 1);
    this.emit();
  }

  move(from, to) {
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    this.emit();
  }

  clear() {
    this.queue = [];
    this.emit();
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.emit();
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    clearInterval(this.timer);
    if (on) {
      this.say(`AI DJ attivato (${this.options.mode === 'ai' ? 'scelta automatica dei brani' : 'segue la coda'})`);
      this.timer = setInterval(() => this.tick(), 150);
      this.tick();
    } else {
      this.abortTransition();
      this.plan = null;
      this.say('AI DJ disattivato');
    }
    this.emit();
  }

  // --- stato dei deck -------------------------------------------------------------

  current() {
    const playing = this.decks.filter((d) => d.playing);
    if (this.transition) return this.transition.from;
    if (playing.length === 1) return playing[0];
    if (playing.length === 2) return playing.reduce((a, b) => (a.remaining > b.remaining ? b : a));
    return null;
  }

  other(deck) {
    return this.decks[0] === deck ? this.decks[1] : this.decks[0];
  }

  side(deck) {
    return this.decks.indexOf(deck) === 0 ? -1 : 1;
  }

  // --- scelta del brano -----------------------------------------------------------

  sourcePool() {
    return this.getPool(this.options.source).filter((t) => t && t.path);
  }

  async pickNext(currentTrack) {
    if (this.queue.length) {
      const t = this.queue.shift();
      this.emit();
      return { track: t, reason: 'dalla coda' };
    }
    if (this.options.mode === 'queue') return null;
    const played = new Set(this.history.map((t) => t.id));
    if (currentTrack) played.add(currentTrack.id);
    for (const d of this.decks) if (d.track) played.add(d.track.id);
    let pool = this.sourcePool().filter((t) => !played.has(t.id));
    if (!pool.length) {
      // libreria esaurita: si ricomincia evitando solo gli ultimi brani
      const recent = new Set(this.history.slice(-5).map((t) => t.id));
      if (currentTrack) recent.add(currentTrack.id);
      pool = this.sourcePool().filter((t) => !recent.has(t.id));
    }
    if (!pool.length) return null;
    // si preferiscono i brani già analizzati (BPM e tonalità noti)
    const analyzed = pool.filter((t) => t.bpm);
    const candidatesPool = analyzed.length >= 3 ? analyzed : pool;
    const ranked = rankCandidates(currentTrack, candidatesPool, { strategy: this.options.strategy, step: this.step, recent: played });
    const top = ranked.slice(0, 12);
    if (this.options.useLLM && this.llm && this.llm.enabled) {
      try {
        this.say('Chiedo all\'AI locale quale brano mettere…');
        const res = await this.llm.chooseNext(currentTrack, top.map((c) => c.track), {
          strategy: this.options.strategy,
          history: this.history,
          notes: this.options.notes,
        });
        if (res) return { track: top[res.index].track, reason: `AI locale: ${res.reason || 'scelta del modello'}` };
        this.say('Risposta dell\'AI locale non valida: uso il motore interno');
      } catch (err) {
        this.say(`AI locale non disponibile (${err.message}): uso il motore interno`);
      }
    }
    const best = top[0];
    return best ? { track: best.track, reason: best.reasons.join(' · ') } : null;
  }

  // --- ciclo principale -------------------------------------------------------------

  async tick() {
    if (!this.enabled || this.selecting || this.transition) return;
    const cur = this.current();
    if (!cur) {
      await this.startFirst();
      return;
    }
    const next = this.other(cur);
    if (!this.plan || this.plan.from !== cur || this.plan.fromTrack !== cur.track) {
      await this.prepareNext(cur, next);
      return;
    }
    if (this.plan.to && this.plan.to.track !== this.plan.toTrack) {
      // l'utente ha caricato un altro brano sul deck successivo: si ripianifica con quello
      this.plan = null;
      next._aiReady = Boolean(next.track);
      return;
    }
    if (next.playing) return; // l'utente sta suonando manualmente l'altro deck
    if (cur.position >= this.plan.startAt) this.beginTransition(cur, next, this.plan);
  }

  async startFirst() {
    this.selecting = true;
    try {
      const deck = this.decks.find((d) => d.loaded && d.position < 1 && !d.playing && this.plan === null && d._aiReady) || this.decks[0];
      let track = deck._aiReady ? deck.track : null;
      let reason = 'brano pronto sul deck';
      if (!track) {
        const pick = await this.pickNext(null);
        if (!pick) {
          if (!this.warnedEmpty) this.say(this.options.mode === 'queue' ? 'Coda vuota: aggiungi brani o passa alla modalità AI' : 'Libreria vuota: aggiungi della musica');
          this.warnedEmpty = true;
          return;
        }
        ({ track, reason } = pick);
        if (!(await deck.load(track))) return;
      }
      this.warnedEmpty = false;
      deck._aiReady = false;
      this.resetChannel(deck);
      this.engine.setCrossfader(this.side(deck));
      deck.setPitch(0);
      deck.play();
      this.history.push(track);
      this.step++;
      this.say(`Apertura: ${label(track)} (${reason})`);
      this.emit();
    } finally {
      this.selecting = false;
    }
  }

  async prepareNext(cur, next) {
    if (!cur.loaded || !cur.bpm) {
      // senza analisi non si può pianificare: si aspetta
      return;
    }
    this.selecting = true;
    try {
      let track = null;
      let reason = '';
      if (next.loaded && next._aiReady && next.track) {
        track = next.track;
        reason = 'già pronto sul deck';
      } else {
        const pick = await this.pickNext(cur.track);
        if (!pick) {
          if (!this.warnedEnd) this.say('Nessun altro brano disponibile: il set finirà con questo brano');
          this.warnedEnd = true;
          this.plan = { from: cur, fromTrack: cur.track, startAt: Infinity };
          return;
        }
        ({ track, reason } = pick);
        if (next.playing) return;
        if (!(await next.load(track))) {
          this.plan = null;
          return;
        }
        next._aiReady = true;
      }
      this.warnedEnd = false;
      // aspetta l'analisi del brano appena caricato (BPM, punti di mix)
      for (let i = 0; i < 100 && !next.bpm && this.enabled; i++) await sleep(100);
      if (!this.enabled) return;
      this.plan = this.makePlan(cur, next);
      if (this.plan.wantModel) await this.attachModelCurves(this.plan);
      this.resetChannel(next);
      next.seek(this.plan.mixIn);
      this.say(`Prossimo: ${label(next.track)} — ${reason}`);
      this.say(`   Transizione ${TRANSITION_NAMES[this.plan.type] || this.plan.type} di ${this.plan.bars} battute alle ${formatTime(this.plan.startAt, false)} (${this.plan.why})`);
      this.emit();
    } finally {
      this.selecting = false;
    }
  }

  makePlan(cur, next) {
    // con il modello si decide come in automatico (sync, ripiego), poi le curve vengono dal modello
    const wantModel = this.options.style === 'model';
    const t = planTransition(cur.track, next.track, { style: wantModel ? 'auto' : this.options.style, bars: this.options.bars });
    t.wantModel = wantModel && t.sync;
    const bar = cur.beatLength * 4;
    const transTrackSec = Math.max(bar, t.bars * bar);
    let startAt = cur.track.mixOut && cur.track.mixOut < cur.duration - 4 ? cur.track.mixOut : cur.duration - transTrackSec - 8;
    startAt = Math.min(startAt, cur.duration - transTrackSec - 0.5);
    const earliest = cur.position + 1;
    if (startAt < earliest) startAt = earliest;
    // allineamento alla battuta forte (inizio misura) del brano in onda
    const n = Math.ceil((startAt - cur.gridOffset) / bar - 1e-6);
    startAt = cur.gridOffset + n * bar;
    if (startAt + transTrackSec > cur.duration) startAt = Math.max(cur.position + 0.2, cur.duration - transTrackSec - 0.5);
    const mixIn = next.track.mixIn != null && next.track.mixIn < next.duration / 2 ? next.track.mixIn : next.gridOffset || 0;
    return { ...t, from: cur, fromTrack: cur.track, to: next, toTrack: next.track, startAt, mixIn, transTrackSec };
  }

  /** Curve del pianificatore (modello C); se non è disponibile resta il piano a regole. */
  async attachModelCurves(plan) {
    const info = (d) => ({ waveform: d.waveform, bpm: d.bpm, gridOffset: d.gridOffset, duration: d.duration });
    // il modello usa forma d'onda e griglia di entrambi i brani: si aspetta la fine dell'analisi (max 30 s)
    const ready = () => plan.from.waveform && plan.to.waveform && plan.from.bpm && plan.to.bpm;
    for (let i = 0; i < 300 && !ready() && this.enabled; i++) await sleep(100);
    try {
      const { curves, length } = await planCurves(info(plan.from), plan.startAt, info(plan.to), plan.mixIn, plan.bars);
      plan.curves = curves;
      plan.curveLength = length;
      plan.fallbackType = plan.type;
      plan.type = 'model';
      plan.why = 'curve previste dal modello sperimentale';
    } catch (err) {
      this.say(`Modello delle transizioni non disponibile (${err.message}): uso le regole`);
    }
  }

  /** Anticipa la transizione alla prossima battuta forte. */
  mixNow() {
    const cur = this.current();
    if (!this.plan || !cur || this.transition || !Number.isFinite(this.plan.startAt)) {
      this.say('Niente da mixare adesso');
      return;
    }
    const bar = cur.beatLength * 4;
    const n = Math.ceil((cur.position + 0.05 - cur.gridOffset) / bar);
    this.plan.startAt = cur.gridOffset + n * bar;
    this.plan.transTrackSec = Math.min(this.plan.transTrackSec, Math.max(bar, cur.duration - this.plan.startAt - 0.5));
    this.say('Mix anticipato alla prossima battuta');
  }

  /** Scarta il brano preparato e ne sceglie un altro. */
  async skipNext() {
    if (this.transition || this.selecting) return;
    const cur = this.current();
    if (!cur) return;
    const next = this.other(cur);
    if (next.playing) return;
    if (next.track) this.history.push(next.track); // evita di riproporlo subito
    next._aiReady = false;
    this.plan = null;
    this.say('Brano successivo scartato, ne scelgo un altro');
  }

  // --- transizione --------------------------------------------------------------------

  beginTransition(from, to, plan) {
    const controls = this.getControls();
    if (plan.sync && from.bpm && to.bpm) to.sync(from);
    else to.setPitch(0);
    to.seek(plan.mixIn);
    to.play();
    if (plan.sync && from.bpm && to.bpm) to.alignPhase(from);
    const vol = controls[to.id] && controls[to.id].vol;
    if (vol && vol.getValue() < 0.5) vol.set(0.85);
    const duration = (plan.bars * 4 * from.beatLength) / from.tempo;
    this.transition = {
      from, to, plan, controls,
      start: performance.now(),
      duration: Math.min(duration, (plan.transTrackSec / from.tempo) || duration) * 1000,
      applied: {},
      fxBackup: { type: from.fx[1].type, on: from.fx[1].on, mix: from.fx[1].mix },
    };
    this.say(`Mix in corso: ${label(from.track)} → ${label(to.track)}`);
    this.emit();
    const stepFn = () => {
      if (!this.transition) return;
      const tr = this.transition;
      if (!tr.to.playing) {
        this.abortTransition();
        return;
      }
      const p = Math.min(1, (performance.now() - tr.start) / tr.duration);
      if (tr.plan.curves) this.applyModelState(tr, curvesAt(tr.plan.curves, tr.plan.curveLength, p * tr.plan.curveLength));
      else this.applyState(tr, transitionState(tr.plan.type, p));
      if (p < 1) tr.raf = requestAnimationFrame(stepFn);
      else this.finishTransition();
    };
    this.transition.raf = requestAnimationFrame(stepFn);
  }

  setControl(tr, key, ctl, value) {
    if (!ctl || tr.applied[key] === value) return;
    tr.applied[key] = value;
    ctl.set(value);
  }

  applyState(tr, s) {
    const { from, to, controls } = tr;
    const a = this.side(from);
    const b = this.side(to);
    this.engine.setCrossfader(a + (b - a) * s.xf);
    const cf = controls[from.id];
    const ct = controls[to.id];
    if (cf && ct) {
      this.setControl(tr, 'outLow', cf.eq.low, s.outLow);
      this.setControl(tr, 'inLow', ct.eq.low, s.inLow);
      this.setControl(tr, 'outFilter', cf.filter, Math.round(s.outFilter * 50) / 50);
    }
    if (tr.applied.outPlayer !== s.outPlayer) {
      tr.applied.outPlayer = s.outPlayer;
      from.playerGain.gain.setTargetAtTime(s.outPlayer, from.ctx.currentTime, 0.02);
    }
    if (s.echo && !tr.applied.echo) {
      tr.applied.echo = true;
      const slot = from.fx[1];
      slot.setType('echo');
      slot.setParam(0.6);
      slot.setMix(0.55);
      slot.setOn(true);
      from.emit('fx');
    }
  }

  /** Stato previsto dal modello: crossfader, EQ a 3 bande e filtro di entrambi i deck. */
  applyModelState(tr, s) {
    const { from, to, controls } = tr;
    const a = this.side(from);
    const b = this.side(to);
    this.engine.setCrossfader(a + (b - a) * s.xf);
    const cf = controls[from.id];
    const ct = controls[to.id];
    if (!cf || !ct) return;
    const q = (v) => Math.round(v * 50) / 50;
    ['low', 'mid', 'high'].forEach((band, i) => {
      this.setControl(tr, `outEq_${band}`, cf.eq[band], q(s.eqA[i]));
      this.setControl(tr, `inEq_${band}`, ct.eq[band], q(s.eqB[i]));
    });
    this.setControl(tr, 'outFilter', cf.filter, q(s.filterA));
    this.setControl(tr, 'inFilter', ct.filter, q(s.filterB));
  }

  finishTransition() {
    const tr = this.transition;
    if (!tr) return;
    cancelAnimationFrame(tr.raf);
    this.transition = null;
    const { from, to } = tr;
    this.engine.setCrossfader(this.side(to));
    // l'eco finisce di suonare prima di ripulire il canale uscente
    const tail = tr.plan.type === 'echo' ? 2500 : 0;
    from.pause();
    const allEq = Boolean(tr.plan.curves);
    setTimeout(() => {
      this.resetChannel(from, { allEq });
      from.fx[1].setOn(tr.fxBackup.on);
      from.fx[1].setType(tr.fxBackup.type);
      from.fx[1].setMix(tr.fxBackup.mix);
      from.emit('fx');
    }, tail);
    this.resetChannel(to, { allEq });
    to._aiReady = false;
    this.history.push(to.track);
    this.step++;
    this.plan = null;
    this.say(`In onda: ${label(to.track)}`);
    if (this.options.returnTempo && Math.abs(to.pitch) > 0.05) this.rampTempo(to);
    this.emit();
  }

  abortTransition() {
    const tr = this.transition;
    if (!tr) return;
    cancelAnimationFrame(tr.raf);
    this.transition = null;
    this.resetChannel(tr.from, { allEq: Boolean(tr.plan.curves) });
    this.resetChannel(tr.to, { allEq: Boolean(tr.plan.curves) });
    this.plan = null;
    this.say('Transizione interrotta');
    this.emit();
  }

  resetChannel(deck, { allEq = false } = {}) {
    const c = this.getControls()[deck.id];
    if (c) {
      for (const band of allEq ? ['low', 'mid', 'high'] : ['low']) if (c.eq[band].getValue() !== 0) c.eq[band].set(0);
      if (c.filter.getValue() !== 0) c.filter.set(0);
    }
    deck.playerGain.gain.setTargetAtTime(1, deck.ctx.currentTime, 0.02);
  }

  /** Riporta gradualmente il brano al suo tempo originale (circa 32 battute). */
  rampTempo(deck) {
    clearInterval(deck._tempoRamp);
    const start = deck.pitch;
    const beats = 64;
    const total = ((beats * 60) / (deck.bpm || 120)) * 1000;
    const t0 = performance.now();
    deck._tempoRamp = setInterval(() => {
      if (!deck.playing || this.transition) {
        clearInterval(deck._tempoRamp);
        return;
      }
      const k = Math.min(1, (performance.now() - t0) / total);
      deck.setPitch(start * (1 - k));
      if (k >= 1) clearInterval(deck._tempoRamp);
    }, 250);
  }

  // --- scalette ---------------------------------------------------------------------

  async generateSet({ request = '', length = 15 } = {}) {
    const pool = this.sourcePool();
    if (!pool.length) throw new Error('La libreria è vuota');
    const cur = this.current();
    if (request && this.options.useLLM && this.llm && this.llm.enabled) {
      this.say(`Chiedo all'AI locale una scaletta: "${request}"`);
      try {
        const res = await this.llm.buildSet(request, pool, length);
        if (res.tracks.length) {
          this.say(`Scaletta AI "${res.title || 'senza titolo'}": ${res.tracks.length} brani. ${res.reason || ''}`);
          return res.tracks;
        }
        this.say('L\'AI locale non ha restituito brani validi: uso il motore interno');
      } catch (err) {
        this.say(`AI locale non disponibile (${err.message}): uso il motore interno`);
      }
    }
    const set = buildSet(pool.filter((t) => t.bpm || pool.length < 5), {
      length,
      strategy: this.options.strategy,
      seed: cur ? cur.track : null,
    });
    this.say(`Scaletta creata dal motore interno: ${set.length} brani (${this.options.strategy})`);
    return set;
  }

  status() {
    if (!this.enabled) return 'Spento';
    if (this.transition) {
      const p = Math.min(1, (performance.now() - this.transition.start) / this.transition.duration);
      return `Mix in corso ${Math.round(p * 100)}%`;
    }
    if (this.selecting) return 'Sceglie il prossimo brano…';
    const cur = this.current();
    if (this.plan && cur && Number.isFinite(this.plan.startAt)) {
      const secs = (this.plan.startAt - cur.position) / (cur.tempo || 1);
      return `Prossimo mix tra ${formatTime(Math.max(0, secs), false)}`;
    }
    return cur ? 'In onda' : 'In attesa';
  }
}

const TRANSITION_NAMES = { bassswap: 'bass swap', filter: 'filtro', echo: 'echo out', fade: 'dissolvenza', cut: 'taglio sul beat', model: 'del modello AI' };

function label(t) {
  return t ? `${t.artist ? `${t.artist} - ` : ''}${t.title}` : '—';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
