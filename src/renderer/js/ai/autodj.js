// AI DJ: mixa in automatico. Sceglie il brano successivo (motore interno o LLM locale),
// lo precarica, calcola il punto di mix allineato alle frasi, sincronizza tempo e fase
// ed esegue la transizione muovendo crossfader, EQ, filtri ed effetti come un DJ.
import { rankCandidates, planTransition, transitionState, buildSet, keyScore } from './selector.js';
import { formatTime } from '../dsp/analysis.js';
import { planCurves, isModelStyle, TRANSITION_STYLES } from './transition-planner.js';
import { rapidTiming } from './rapid.js';
import { curvesAt } from './transition-model.js';
import { needsAiRefine } from '../audio/analyzer-client.js';
import { planRemix, REMIX_ACTIONS } from './remix.js';
import { FADE_BARS, MASHUP_MIN_KEY, DEFAULT_MASHUP_BARS, savedStartAt } from './mashup-plan.js';

const DEFAULT_OPTIONS = {
  mode: 'ai', // 'ai' = sceglie l'AI, 'queue' = segue la coda
  source: 'library', // 'library' oppure id di una playlist
  strategy: 'steady',
  style: 'auto',
  bars: 16,
  useLLM: false,
  returnTempo: true,
  notes: '',
  remix: false, // remix dal vivo mentre un brano suona da solo
  mashup: false, // voce del prossimo brano sulla base di quello in onda (serve il modello Demucs)
};

export class AutoDJ extends EventTarget {
  constructor({ engine, decks, getControls, getPool, llm, stems = null, getMashups = () => [], random = Math.random }) {
    super();
    this.stems = stems;
    this.getMashups = getMashups; // mashup salvati nella scheda MASHUP
    this.random = random;
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
      this.cancelRemix();
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
    // con l'opzione mashup, dopo la base di un mashup salvato arriva il brano della sua voce
    const saved = this.options.mashup && currentTrack ? this.getMashups().find((m) => m.baseId === currentTrack.id && pool.some((t) => t.id === m.vocalId)) : null;
    if (saved) return { track: pool.find((t) => t.id === saved.vocalId), reason: 'mashup salvato con il brano in onda' };
    // si preferiscono i brani già analizzati (BPM e tonalità noti)
    const analyzed = pool.filter((t) => t.bpm);
    const candidatesPool = analyzed.length >= 3 ? analyzed : pool;
    const top = rankCandidates(currentTrack, candidatesPool, { strategy: this.options.strategy, step: this.step, recent: played, limit: 12 });
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
    else if (this.options.remix) this.remixTick(cur);
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
      deck._aiEntry = deck.position || 0;
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
      // aspetta l'analisi del brano appena caricato (BPM, punti di mix) e, con il motore AI,
      // la rifinitura di griglia e battuta forte (il piano si allinea alle frasi)
      for (let i = 0; i < 100 && !next.bpm && this.enabled; i++) await sleep(100);
      for (let i = 0; i < 300 && needsAiRefine(next.track) && this.enabled; i++) await sleep(100);
      if (!this.enabled) return;
      this.plan = this.makePlan(cur, next);
      if (this.plan.wantModel) await this.attachModelCurves(this.plan);
      if (this.options.mashup && this.stems) {
        // il brano successivo si separa subito: quando andrà in onda la sua base sarà già pronta
        this.stems.ensure(next.track).catch(() => {});
      }
      if (this.plan.saved) this.prepareSavedMashup(this.plan);
      else if (this.options.mashup) this.prepareMashup(this.plan);
      this.resetChannel(next);
      next.seek(this.plan.mixIn);
      this.say(`Prossimo: ${label(next.track)} — ${reason}`);
      if (this.plan.saved) this.say(`   Mashup salvato alle ${formatTime(this.plan.startAt, false)}: voce per ${this.plan.saved.bars || DEFAULT_MASHUP_BARS} battute`);
      else this.say(`   Transizione ${TRANSITION_NAMES[this.plan.type] || this.plan.type} di ${this.plan.bars} battute alle ${formatTime(this.plan.startAt, false)} (${this.plan.why})`);
      this.emit();
    } finally {
      this.selecting = false;
    }
  }

  makePlan(cur, next) {
    const plan = this.planFor(cur, next);
    // mashup salvato nella scheda MASHUP: la voce entra dove è stato deciso (se quel punto non è già passato)
    const saved = this.getMashups().find((m) => m.baseId === cur.track.id && m.vocalId === next.track.id);
    if (saved) {
      plan.saved = saved;
      const at = savedStartAt(saved, cur);
      if (at != null) plan.startAt = at;
    }
    return plan;
  }

  planFor(cur, next) {
    // con il modello si decide come in automatico (sync, ripiego), poi le curve vengono dal modello
    const wantModel = isModelStyle(this.options.style);
    const t = planTransition(cur.track, next.track, { style: wantModel ? 'auto' : this.options.style, bars: this.options.bars });
    t.wantModel = wantModel && t.sync;
    if (wantModel) t.modelStyle = this.options.style;
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
    if (t.type === 'rapid') {
      // tagli a raffica: il brano in onda suona solo 16-24 misure da dove è entrato, il successivo a volte dal drop
      const r = rapidTiming(cur, next, { entry: cur._aiEntry || 0, defaultMixIn: mixIn, random: this.random });
      const why = `stile LUM!X: ${r.playBars} misure, ${r.fromDrop ? 'entrata sul drop' : 'entrata dal punto di mix'}`;
      return { ...t, why, from: cur, fromTrack: cur.track, to: next, toTrack: next.track, startAt: r.startAt, mixIn: r.mixIn, transTrackSec: r.transTrackSec };
    }
    return { ...t, from: cur, fromTrack: cur.track, to: next, toTrack: next.track, startAt, mixIn, transTrackSec };
  }

  /** Curve del pianificatore (modello C); se non è disponibile resta il piano a regole. */
  async attachModelCurves(plan) {
    const info = (d) => ({ waveform: d.waveform, bpm: d.bpm, gridOffset: d.gridOffset, duration: d.duration });
    // il modello usa forma d'onda e griglia di entrambi i brani: si aspetta la fine dell'analisi (max 30 s)
    const ready = () => plan.from.waveform && plan.to.waveform && plan.from.bpm && plan.to.bpm;
    for (let i = 0; i < 300 && !ready() && this.enabled; i++) await sleep(100);
    // il modello conosce transizioni fino alla sua finestra (32 misure fino alla v4, 64 dalla v5)
    const style = plan.modelStyle || 'model';
    const maxBars = TRANSITION_STYLES[style].beats / 4;
    if (plan.bars > maxBars) {
      this.say(`Il modello delle transizioni arriva a ${maxBars} battute: transizione accorciata da ${plan.bars}`);
      plan.bars = maxBars;
      plan.transTrackSec = Math.min(plan.transTrackSec, maxBars * plan.from.beatLength * 4);
    }
    try {
      const { curves, length } = await planCurves(info(plan.from), plan.startAt, info(plan.to), plan.mixIn, plan.bars, { style });
      plan.curves = curves;
      plan.curveLength = length;
      plan.fallbackType = plan.type;
      plan.type = style;
      plan.why = `curve previste dal modello AI, stile ${TRANSITION_STYLES[style].name}`;
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
    this.cancelRemix();
    if (plan.mashup) {
      if (plan.mashup.status === 'ready') {
        this.beginMashup(from, to, plan);
        return;
      }
      this.say(plan.mashup.status === 'preparing' ? 'Mashup: voce e base non ancora pronte, transizione normale' : 'Mashup non disponibile, transizione normale');
    }
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
    if (tr.mashup) {
      from.setStem('full').catch(() => {});
      to.setStem('full').catch(() => {});
    }
    setTimeout(() => {
      this.resetChannel(from, { allEq });
      from.fx[1].setOn(tr.fxBackup.on);
      from.fx[1].setType(tr.fxBackup.type);
      from.fx[1].setMix(tr.fxBackup.mix);
      from.emit('fx');
    }, tail);
    this.resetChannel(to, { allEq });
    to._aiReady = false;
    to._aiEntry = to.position; // punto del brano in cui è andato in onda (per i tagli a raffica)
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
    if (tr.mashup) {
      tr.from.setStem('full').catch(() => {});
      tr.to.setStem('full').catch(() => {});
    }
    this.resetChannel(tr.from, { allEq: Boolean(tr.plan.curves) });
    this.resetChannel(tr.to, { allEq: Boolean(tr.plan.curves) });
    this.plan = null;
    this.say('Transizione interrotta');
    this.emit();
  }

  // --- mashup ------------------------------------------------------------------------

  /** Con l'opzione mashup e due brani compatibili prepara in background voce e base di entrambi. */
  async prepareMashup(plan) {
    if (!this.stems || !plan.sync || keyScore(plan.fromTrack.key, plan.toTrack.key) < MASHUP_MIN_KEY) return;
    plan.mashup = { status: 'preparing' };
    try {
      if (!(await this.stems.checkModel())) throw new Error('scarica prima il modello per separare voce e base (pannello AI DJ)');
      this.say(`Mashup: preparo voce e base di ${label(plan.toTrack)} e ${label(plan.fromTrack)}`);
      await Promise.all([this.stems.ensure(plan.fromTrack), this.stems.ensure(plan.toTrack)]);
      const vocalStart = await this.stems.vocalEntry(plan.toTrack, plan.toTrack.bpm || plan.to.bpm);
      if (this.plan !== plan) return;
      plan.mashup = { status: 'ready', vocalStart };
      this.say(`Mashup pronto: la voce di ${label(plan.toTrack)} entrerà sulla base di ${label(plan.fromTrack)}`);
    } catch (err) {
      plan.mashup = { status: 'failed' };
      this.say(`Mashup non possibile: ${err.message}`);
    }
  }

  /**
   * Mashup salvato nella scheda MASHUP: si fa anche con l'opzione mashup spenta e senza controlli di tonalità
   * (l'ha scelto il DJ). Voce e base di solito sono già su disco; se mancano si separano adesso.
   */
  async prepareSavedMashup(plan) {
    const { saved } = plan;
    plan.mashup = { status: 'preparing', saved: true };
    try {
      if (!this.stems) throw new Error('separazione di voce e base non disponibile');
      await Promise.all([this.stems.ensure(plan.fromTrack), this.stems.ensure(plan.toTrack)]);
      const vocalStart = saved.vocalStart ?? await this.stems.vocalEntry(plan.toTrack, plan.toTrack.bpm || plan.to.bpm);
      if (this.plan !== plan) return;
      plan.mashup = { status: 'ready', saved: true, vocalStart, bars: saved.bars || DEFAULT_MASHUP_BARS };
      this.say(`Mashup salvato pronto: la voce di ${label(plan.toTrack)} entrerà sulla base di ${label(plan.fromTrack)}`);
    } catch (err) {
      plan.mashup = { status: 'failed', saved: true };
      this.say(`Mashup salvato non possibile (${err.message}): transizione normale`);
    }
  }

  /**
   * Transizione mashup: il brano in onda passa alla sola base, entra la voce del prossimo a tempo per
   * 16 battute (o quelle del mashup salvato), poi il prossimo torna completo e il primo sfuma in 8 battute.
   */
  async beginMashup(from, to, plan) {
    const beat = from.beatLength;
    const remaining = from.duration - from.position;
    const fadeBars = FADE_BARS;
    const mashBars = Math.max(4, Math.min(plan.mashup.bars || DEFAULT_MASHUP_BARS, Math.floor(remaining / (4 * beat)) - fadeBars));
    this.transition = {
      from, to, plan, controls: this.getControls(), mashup: true, mashBars, fadeBars, applied: {},
      start: performance.now(), duration: (((mashBars + fadeBars) * 4 * beat) / from.tempo) * 1000,
      fxBackup: { type: from.fx[1].type, on: from.fx[1].on, mix: from.fx[1].mix },
    };
    try {
      await from.setStem('instrumental');
      if (from.bpm && to.bpm) to.sync(from);
      await to.setStem('vocals');
      to.seek(plan.mashup.vocalStart);
      to.play();
      if (from.bpm && to.bpm) to.alignPhase(from);
    } catch (err) {
      this.say(`Mashup interrotto: ${err.message}`);
      this.abortTransition();
      return;
    }
    const vol = this.transition.controls[to.id] && this.transition.controls[to.id].vol;
    if (vol && vol.getValue() < 0.5) vol.set(0.85);
    this.say(`Mashup: voce di ${label(to.track)} sulla base di ${label(from.track)} per ${mashBars} battute`);
    this.emit();
    const stepFn = () => {
      const tr = this.transition;
      if (!tr) return;
      if (!tr.to.playing) {
        this.abortTransition();
        return;
      }
      const p = Math.min(1, (performance.now() - tr.start) / tr.duration);
      const split = tr.mashBars / (tr.mashBars + tr.fadeBars);
      const a = this.side(tr.from);
      const b = this.side(tr.to);
      if (p < split) {
        // entrambi a volume pieno: con la curva "smooth" il centro non abbassa nessuno dei due
        this.engine.setCrossfader(a + (b - a) * 0.5);
      } else {
        if (!tr.applied.full) {
          tr.applied.full = true;
          tr.to.setStem('full').catch(() => {});
        }
        const q = (p - split) / (1 - split);
        this.engine.setCrossfader(a + (b - a) * (0.5 + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * q))));
      }
      if (p < 1) tr.raf = requestAnimationFrame(stepFn);
      else this.finishTransition();
    };
    this.transition.raf = requestAnimationFrame(stepFn);
  }

  // --- remix dal vivo ------------------------------------------------------------------

  remixTick(deck) {
    const r = this.remix;
    if (r && r.deck === deck && r.track === deck.track && (r.pending || deck.position < r.plan.boundary)) return;
    this.cancelRemix();
    const info = { bpm: deck.bpm, gridOffset: deck.gridOffset, duration: deck.duration, barEnergy: deck.track && deck.track.barEnergy };
    const plan = planRemix(info, deck.position, { nextMixAt: this.plan ? this.plan.startAt : Infinity, rng: this.random, last: r && r.plan.action });
    if (!plan) return;
    const rem = { deck, track: deck.track, plan, timers: [], pending: plan.action !== 'none' };
    this.remix = rem;
    if (plan.action === 'none') return;
    const at = (sec, fn) => rem.timers.push(setTimeout(fn, Math.max(0, ((sec - deck.position) / deck.tempo) * 1000)));
    at(plan.at, () => this.remixStart(rem));
    at(plan.until, () => this.remixEnd(rem));
  }

  remixStart(rem) {
    const { deck, plan } = rem;
    if (this.remix !== rem || !deck.playing || this.transition) return;
    this.say(`Remix: ${REMIX_ACTIONS[plan.action]}`);
    if (plan.action === 'roll') {
      rem.slip = deck.slip;
      deck.setSlip(true);
      deck.autoLoop(0.5);
      rem.timers.push(setTimeout(() => deck.loopScale(0.5), ((deck.beatLength / 2) / deck.tempo) * 1000));
    } else if (plan.action === 'echo') {
      const slot = deck.fx[1];
      rem.fx = { type: slot.type, on: slot.on, mix: slot.mix, param: slot.param };
      slot.setType('echo');
      slot.setParam(0.5);
      slot.setMix(0.5);
      slot.setOn(true);
      deck.emit('fx');
    } else if (plan.action === 'build') {
      const ctl = this.getControls()[deck.id];
      const t0 = performance.now();
      const len = ((plan.until - plan.at) / deck.tempo) * 1000;
      rem.timers.push(setInterval(() => {
        const q = Math.min(1, (performance.now() - t0) / len);
        if (ctl) ctl.filter.set(Math.round(q * 0.55 * 50) / 50);
      }, 60));
    } else if (plan.action === 'repeat') {
      deck.beatJump(plan.jumpBeats);
    }
  }

  remixEnd(rem) {
    const { deck, plan } = rem;
    rem.pending = false;
    if (plan.action === 'roll' && deck.loop.active) {
      deck.setLoopActive(false);
      deck.setSlip(Boolean(rem.slip));
    } else if (plan.action === 'echo' && rem.fx) {
      // lascia suonare la coda dell'eco per una battuta
      setTimeout(() => {
        const slot = deck.fx[1];
        slot.setOn(rem.fx.on);
        slot.setType(rem.fx.type);
        slot.setMix(rem.fx.mix);
        if (rem.fx.param != null) slot.setParam(rem.fx.param);
        deck.emit('fx');
      }, ((deck.beatLength * 4) / deck.tempo) * 1000);
    } else if (plan.action === 'build') {
      rem.timers.forEach((t) => clearInterval(t));
      const ctl = this.getControls()[deck.id];
      if (ctl) ctl.filter.set(0);
    }
  }

  cancelRemix() {
    const rem = this.remix;
    if (!rem) return;
    rem.timers.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    if (rem.pending && rem.plan.action !== 'none') this.remixEnd(rem);
    this.remix = null;
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

export const TRANSITION_NAMES = { bassswap: 'bass swap', filter: 'filtro', echo: 'echo out', fade: 'dissolvenza', cut: 'taglio sul beat', rapid: 'a raffica (stile LUM!X)', model: 'del modello AI (dance)', 'model-techno': 'del modello AI (techno)' };

function label(t) {
  return t ? `${t.artist ? `${t.artist} - ` : ''}${t.title}` : '—';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
