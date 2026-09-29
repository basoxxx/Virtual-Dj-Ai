// Scheda MASHUP: i mashup si creano prima del set (la base di un brano con la voce di un altro), scegliendo i brani
// a mano o lasciandoli scegliere all'AI. L'app separa subito voce e base e li salva nella libreria; si provano sui
// deck, si ritoccano, e durante il set l'AI DJ li esegue quando i due brani vanno in onda uno dopo l'altro.
import { el, button, toast, select, confirmDialog } from './controls.js';
import { icon, withIcon } from './icons.js';
import { formatTime, camelotOf } from '../dsp/analysis.js';
import {
  MASHUP_BARS, DEFAULT_MASHUP_BARS, mashupCompatibility, suggestPartners, pickPartner, pickPair, autoBaseStart, barNumber, stepPoint,
} from '../ai/mashup-plan.js';

const ROLES = { base: 'BASE', vocal: 'VOCE' };
const PLACEHOLDERS = { base: 'Trascina qui il brano di cui usare la base', vocal: 'Trascina qui il brano di cui usare la voce' };
const OTHER = { base: 'vocal', vocal: 'base' };

function label(t) {
  return t ? `${t.artist ? `${t.artist} - ` : ''}${t.title || 'Senza titolo'}` : 'brano non più in libreria';
}

function trackInfo(t) {
  if (!t.bpm) return 'BPM e tonalità da analizzare';
  const cam = camelotOf(t.key);
  return [`${t.bpm.toFixed(1)} BPM`, t.key ? `${t.key}${cam ? ` · ${cam}` : ''}` : ''].filter(Boolean).join(' · ');
}

function tempoNote(c) {
  const pitch = `${c.pitch > 0 ? '+' : ''}${c.pitch.toFixed(1)}%`;
  if (!c.tempoOk) return `Tempi molto diversi: la voce andrebbe a ${pitch}`;
  return Math.abs(c.pitch) < 0.05 ? 'Stesso tempo: la voce resta alla sua velocità' : `A tempo con la voce a ${pitch}`;
}

export class MashupUI {
  constructor({ app }) {
    this.app = app;
    this.mashups = app.mashups;
    this.draft = { base: null, vocal: null, bars: DEFAULT_MASHUP_BARS, ai: new Set() }; // ai: ruoli scelti dall'AI
    this.aiTried = { key: null, ids: new Set() }; // proposte dell'AI già fatte: a ogni pressione ne arriva un'altra
    this.openId = null; // mashup salvato aperto per i ritocchi
    this.preview = null; // { id, starting } mashup in prova sui deck
    this.rendered = null; // elenco disegnato: si ridisegna solo quando cambia (non a ogni avanzamento)
    this.statusEls = new Map();
    this.root = this.build();
    this.mashups.addEventListener('change', () => this.refresh());
    app.analyzer.addEventListener('progress', () => {
      if (this.draft.base || this.draft.vocal) this.renderDraft();
    });
    app.automix.addEventListener('change', () => {
      if (app.automix.enabled && this.preview) this.stopPreview();
    });
    for (const d of app.decks) d.addEventListener('state', () => this.refreshPreview());
    this.renderDraft();
    this.renderList();
  }

  build() {
    this.parts = {};
    const slots = ['base', 'vocal'].map((role) => this.slot(role));
    this.compat = el('div', { class: 'mash-compat' });
    this.barsSel = select(MASHUP_BARS.map((b) => ({ value: String(b), label: `Voce per ${b} battute` })), String(this.draft.bars), (v) => {
      this.draft.bars = Number(v);
    }, 'ai-select');
    const swap = button('⇅ Scambia', { className: 'small', title: 'Scambia base e voce', onClick: () => {
      const { base, vocal, ai } = this.draft;
      Object.assign(this.draft, { base: vocal, vocal: base, ai: new Set([...ai].map((r) => OTHER[r])) });
      this.renderDraft();
    } });
    const aiBoth = button(withIcon('sparkles', 'Sceglie l\'AI', 13), { className: 'small', title: 'L\'AI propone una base e una voce compatibili per tonalità e tempo (premi di nuovo per un\'altra coppia)', onClick: () => this.aiPick() });
    this.saveBtn = button(withIcon('sparkles', 'Salva e prepara', 13), { className: 'small primary', title: 'Salva il mashup e separa subito voce e base dei due brani', onClick: () => this.saveDraft() });
    this.suggestTitle = el('div', { class: 'section-label' });
    this.suggest = el('div', { class: 'mash-suggest' });
    this.count = el('span', { class: 'mash-count' });
    const prepAll = button('Prepara tutti', { className: 'small', title: 'Separa voce e base di tutti i mashup non ancora pronti', onClick: () => {
      const n = this.mashups.prepareAll();
      toast(n ? `Preparo ${n} mashup: voce e base si separano un brano alla volta` : 'Nessun mashup da preparare');
    } });
    this.list = el('div', { class: 'mash-list' });
    return el('div', { class: 'tab-pane mashup-pane' },
      el('div', { class: 'mash-group' },
        el('div', { class: 'row tight' }, el('span', { class: 'section-label' }, 'NUOVO MASHUP'), el('span', { class: 'spacer' }), aiBoth),
        ...slots,
        el('div', { class: 'row tight' }, swap, this.barsSel),
        this.compat,
        this.saveBtn,
        this.suggestTitle,
        this.suggest),
      el('div', { class: 'mash-group' },
        el('div', { class: 'row tight' }, el('span', { class: 'section-label' }, 'MASHUP SALVATI'), this.count, el('span', { class: 'spacer' }), prepAll),
        this.list,
        el('div', { class: 'hint' }, 'Durante il set l\'AI DJ fa il mashup quando la base e la voce vanno in onda una dopo l\'altra: + Coda le mette in fila. Con l\'opzione Mashup attiva, dopo una base l\'AI sceglie da sola la sua voce.')));
  }

  slot(role) {
    const title = el('div', { class: 'mash-slot-title' });
    const meta = el('div', { class: 'mash-slot-meta' });
    const pick = button(icon('plus', 13), { className: 'tiny', title: 'Usa il brano selezionato nella libreria', onClick: () => {
      const t = this.app.library.selectedTracks()[0];
      if (t) this.useTrack(t, role);
      else toast('Seleziona prima un brano nella libreria', 'warn');
    } });
    const ai = button(icon('sparkles', 13), { className: 'tiny', title: `Lo sceglie l'AI: ${role === 'base' ? 'la base' : 'la voce'} più compatibile (premi di nuovo per un'altra proposta)`, onClick: () => this.aiPick(role) });
    const clear = button('×', { className: 'tiny ghost', title: 'Togli il brano', onClick: () => this.useTrack(null, role) });
    const node = el('div', { class: 'mash-slot' },
      el('span', { class: `mash-tag ${role}` }, ROLES[role]),
      el('div', { class: 'mash-slot-body' }, title, meta),
      el('div', { class: 'mash-slot-btns' }, ai, pick, clear));
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      node.classList.add('drop');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drop');
      const t = this.app.library.track(e.dataTransfer.getData('text/x-track-id'));
      if (t) this.useTrack(t, role);
    });
    this.parts[role] = { title, meta, clear, ai };
    return node;
  }

  /** Il brano diventa la base o la voce del nuovo mashup (anche dal menu della libreria). */
  useTrack(track, role, { byAi = false } = {}) {
    this.draft[role] = track;
    if (byAi) this.draft.ai.add(role);
    else this.draft.ai.delete(role);
    const other = OTHER[role];
    if (track && this.draft[other] && this.draft[other].id === track.id) this.draft[other] = null;
    this.renderDraft();
  }

  /**
   * L'AI sceglie il brano del ruolo indicato, compatibile con quello già scelto nell'altra casella; senza l'altro
   * brano (o dal pulsante in alto) sceglie tutta la coppia. A ogni pressione propone un'alternativa.
   */
  aiPick(role = null) {
    const pool = this.app.library.lib.tracks;
    const saved = (baseId, vocalId) => Boolean(this.mashups.find(baseId, vocalId));
    const anchor = role && this.draft[OTHER[role]];
    if (anchor) {
      const key = `${role}:${anchor.id}`;
      if (this.aiTried.key !== key) this.aiTried = { key, ids: new Set() };
      if (this.draft[role]) this.aiTried.ids.add(this.draft[role].id);
      const isSaved = (id) => (role === 'vocal' ? saved(anchor.id, id) : saved(id, anchor.id));
      let t = pickPartner(anchor, pool, { tried: this.aiTried.ids, isSaved });
      if (!t && this.aiTried.ids.size) {
        // proposte finite: si ricomincia dalla migliore
        this.aiTried.ids.clear();
        t = pickPartner(anchor, pool, { isSaved });
      }
      if (!t) {
        toast(anchor.bpm ? `Nessun brano analizzato ha tonalità e tempo compatibili con ${label(anchor)}` : 'Il brano non è ancora analizzato', 'warn');
        return;
      }
      this.aiTried.ids.add(t.id);
      this.useTrack(t, role, { byAi: true });
      return;
    }
    if (this.aiTried.key !== 'pair') this.aiTried = { key: 'pair', ids: new Set() };
    const { base, vocal } = this.draft;
    if (base && vocal) this.aiTried.ids.add(`${base.id}:${vocal.id}`);
    let pair = pickPair(pool, { tried: this.aiTried.ids, isSaved: saved });
    if (!pair && this.aiTried.ids.size) {
      this.aiTried.ids.clear();
      pair = pickPair(pool, { isSaved: saved });
    }
    if (!pair) {
      toast('Nella libreria non ci sono ancora due brani analizzati con tonalità e tempo compatibili', 'warn');
      return;
    }
    this.aiTried.ids.add(`${pair.base.id}:${pair.vocal.id}`);
    Object.assign(this.draft, { base: pair.base, vocal: pair.vocal, ai: new Set(['base', 'vocal']) });
    this.renderDraft();
  }

  renderDraft() {
    for (const role of ['base', 'vocal']) {
      const t = this.draft[role];
      const p = this.parts[role];
      p.title.textContent = t ? label(t) : PLACEHOLDERS[role];
      p.title.classList.toggle('empty', !t);
      p.meta.textContent = t ? `${trackInfo(t)}${this.draft.ai.has(role) ? ' · scelto dall\'AI' : ''}` : '';
      p.clear.hidden = !t;
      // l'AI riempie questa casella (o tutta la coppia se l'altra è vuota); non sostituisce un brano scelto a mano da solo
      p.ai.hidden = Boolean(t && !this.draft[OTHER[role]] && !this.draft.ai.has(role));
    }
    const { base, vocal } = this.draft;
    this.compat.replaceChildren(...this.compatNotes(base, vocal));
    // con un solo brano scelto si propongono quelli che fanno coppia
    const one = base && !vocal ? 'base' : vocal && !base ? 'vocal' : null;
    this.suggestTitle.hidden = !one;
    this.suggest.hidden = !one;
    if (!one) return;
    this.suggestTitle.textContent = one === 'base' ? 'VOCI ADATTE A QUESTA BASE' : 'BASI ADATTE A QUESTA VOCE';
    const found = suggestPartners(this.draft[one], this.app.library.lib.tracks);
    const target = one === 'base' ? 'vocal' : 'base';
    this.suggest.replaceChildren(...(found.length
      ? found.map((c) => {
        const row = el('div', { class: 'mash-sug', title: `Usa come ${ROLES[target].toLowerCase()}` },
          el('span', { class: 'am-title' }, label(c.track)),
          el('span', { class: 'am-dur' }, `${c.track.bpm.toFixed(0)} · ${camelotOf(c.track.key)}`));
        row.addEventListener('click', () => this.useTrack(c.track, target));
        return row;
      })
      : [el('div', { class: 'am-empty' }, this.draft[one].bpm ? 'Nessun brano analizzato con tonalità e tempo compatibili' : 'Il brano non è ancora analizzato')]));
  }

  compatNotes(base, vocal) {
    if (!base || !vocal) return [el('div', { class: 'mash-note' }, 'Trascina i brani dalla libreria, selezionali e premi +, oppure premi ✨ e li sceglie l\'AI per tonalità e tempo. Con un solo brano l\'app propone quelli compatibili.')];
    const c = mashupCompatibility(base, vocal);
    if (!c.known) return [el('div', { class: 'mash-note warn' }, 'BPM o tonalità ancora da analizzare: il controllo arriva dopo l\'analisi')];
    const keys = `${camelotOf(vocal.key)} su ${camelotOf(base.key)}`;
    return [
      el('div', { class: `mash-note ${c.keyOk ? 'ok' : 'warn'}` }, c.keyOk ? `Tonalità compatibili (${keys})` : `Tonalità lontane (${keys}): la voce può stonare`),
      el('div', { class: `mash-note ${c.tempoOk ? 'ok' : 'warn'}` }, tempoNote(c)),
    ];
  }

  async saveDraft() {
    const { base, vocal, bars } = this.draft;
    if (!base || !vocal) {
      toast(`Scegli anche ${base ? 'la voce' : vocal ? 'la base' : 'la base e la voce'}, oppure premi ✨ e li sceglie l'AI`, 'warn');
      return;
    }
    const dup = this.mashups.find(base.id, vocal.id);
    if (dup) {
      toast('Questo mashup è già salvato', 'warn');
      this.openId = dup.id;
      this.renderList();
      return;
    }
    if (!base.bpm || !vocal.bpm) {
      const an = this.app.analyzer;
      if (an.running) {
        toast('Analisi della libreria in corso: i due brani non hanno ancora BPM e tonalità, riprova tra poco', 'warn');
      } else {
        an.run([base, vocal]);
        toast('Analizzo BPM e tonalità dei due brani: salva di nuovo tra qualche secondo', 'warn');
      }
      return;
    }
    try {
      const m = await this.mashups.save({ baseId: base.id, vocalId: vocal.id, bars, baseStart: null, vocalStart: null });
      this.draft = { base: null, vocal: null, bars, ai: new Set() };
      this.openId = m.id;
      this.renderDraft();
      this.mashups.prepare(m.id);
      toast('Mashup salvato: separo voce e base dei due brani');
    } catch (err) {
      toast(`Mashup non salvato: ${err.message}`, 'error');
    }
  }

  // --- mashup salvati -------------------------------------------------------------

  refresh() {
    const list = this.mashups.list;
    const same = list === this.rendered && list.every((m) => this.statusEls.get(m.id)?.dataset.status === this.mashups.status(m).id);
    if (!same) {
      this.renderList();
      return;
    }
    // solo l'avanzamento della separazione: si aggiornano i testi senza ridisegnare i pulsanti
    for (const m of list) {
      const st = this.mashups.status(m);
      const node = this.statusEls.get(m.id);
      node.textContent = st.text;
      node.title = st.text;
    }
  }

  renderList() {
    const list = this.mashups.list;
    this.rendered = list;
    this.statusEls.clear();
    this.count.textContent = list.length ? String(list.length) : '';
    // i più recenti in alto
    this.list.replaceChildren(...(list.length ? [...list].reverse().map((m) => this.row(m)) : [el('div', { class: 'am-empty' }, 'Nessun mashup salvato')]));
  }

  row(m) {
    const lib = this.app.library;
    const base = lib.track(m.baseId);
    const vocal = lib.track(m.vocalId);
    const st = this.mashups.status(m);
    const live = Boolean(this.preview && this.preview.id === m.id);
    const open = this.openId === m.id && st.id === 'ready';
    const status = el('span', { class: `mash-status ${st.id}`, title: st.text, dataset: { status: st.id } }, st.text);
    this.statusEls.set(m.id, status);
    const actions = el('div', { class: 'row tight' });
    if (st.id === 'ready') {
      actions.append(
        button(live ? '■ Ferma' : '▶ Prova', { className: `small ${live ? 'on' : ''}`, title: live ? 'Ferma la prova' : 'Prova il mashup: base sul deck A, voce sul deck B', onClick: () => (live ? this.stopPreview() : this.startPreview(m.id)) }),
        button(open ? 'Chiudi' : 'Ritocca', { className: 'small', title: 'Punto della base in cui entra la voce, da dove parte la voce, durata', onClick: () => {
          this.openId = open ? null : m.id;
          this.renderList();
        } }));
    }
    if (st.id === 'todo' || st.id === 'failed') {
      actions.append(button(st.id === 'failed' ? 'Riprova' : 'Prepara', { className: 'small', title: 'Separa adesso voce e base dei due brani', onClick: () => this.mashups.prepare(m.id) }));
    }
    if (base && vocal) actions.append(button('+ Coda', { className: 'small', title: 'Metti in coda all\'AI DJ la base e poi la voce', onClick: () => this.enqueue(m.id) }));
    actions.append(el('span', { class: 'spacer' }),
      button(icon('close', 13), { className: 'tiny ghost', title: 'Elimina il mashup (i brani restano in libreria)', onClick: () => this.remove(m.id) }));
    const c = base && vocal && base.bpm && vocal.bpm ? mashupCompatibility(base, vocal) : null;
    const meta = [
      c && c.known ? `${camelotOf(vocal.key)} su ${camelotOf(base.key)}${c.keyOk ? '' : ' (tonalità lontane)'}` : '',
      c ? `${base.bpm.toFixed(0)} BPM` : '',
      `voce per ${m.bars} battute`,
    ].filter(Boolean).join(' · ');
    const name = (role, t) => el('div', { class: 'mash-name' }, el('span', { class: `mash-tag ${role}` }, ROLES[role]), el('span', { class: 'mash-name-text' }, label(t)));
    const node = el('div', { class: `mash-item ${live ? 'live' : ''}` },
      el('div', { class: 'mash-names' }, name('vocal', vocal), name('base', base)),
      el('div', { class: 'mash-state' }, status, el('span', { class: 'mash-meta' }, meta)),
      actions);
    if (open) node.append(this.editor(m, base, vocal));
    return node;
  }

  /** Ritocchi: punto della base in cui entra la voce, da dove parte la voce, durata. Durante la prova si sentono subito. */
  editor(m, base, vocal) {
    const baseAt = m.baseStart ?? autoBaseStart(base, m.bars);
    const point = (text, sec, track, auto, onStep, onAuto, autoTitle) => el('div', { class: 'mash-point' },
      el('span', { class: 'mash-point-label' }, text),
      el('div', { class: 'mash-point-ctl' },
        button('◀', { className: 'tiny', title: 'Indietro di 4 battute (Maiusc: 1 battuta)', onClick: (e) => onStep(e.shiftKey ? -1 : -4) }),
        el('span', { class: 'mash-point-value' }, `${formatTime(sec, false)} · battuta ${barNumber(sec, track)}${auto ? ' · auto' : ''}`),
        button('▶', { className: 'tiny', title: 'Avanti di 4 battute (Maiusc: 1 battuta)', onClick: (e) => onStep(e.shiftKey ? 1 : 4) }),
        button('Auto', { className: 'tiny ghost', title: autoTitle, onClick: onAuto })));
    return el('div', { class: 'mash-editor' },
      point('Entra sulla base a', baseAt, base, m.baseStart == null,
        (bars) => this.edit(m.id, { baseStart: stepPoint(baseAt, bars, base) }),
        () => this.edit(m.id, { baseStart: null }),
        'Punto di mix della base, con spazio per la voce'),
      point('Voce dal punto', m.vocalStart, vocal, false,
        (bars) => this.edit(m.id, { vocalStart: stepPoint(m.vocalStart, bars, vocal) }),
        async () => {
          try {
            await this.edit(m.id, { vocalStart: await this.app.stems.vocalEntry(vocal) });
          } catch (err) {
            toast(err.message, 'error');
          }
        },
        'Prima frase in cui si sente bene la voce'),
      el('label', { class: 'ai-row' }, el('span', {}, 'Durata voce'),
        select(MASHUP_BARS.map((b) => ({ value: String(b), label: `${b} battute` })), String(m.bars), (v) => this.edit(m.id, { bars: Number(v) }), 'ai-select')));
  }

  async edit(id, patch) {
    try {
      const m = await this.mashups.update(id, patch);
      if (m && this.preview && this.preview.id === id && !this.preview.starting) this.cuePreview(m);
    } catch (err) {
      toast(`Modifica non salvata: ${err.message}`, 'error');
    }
  }

  enqueue(id) {
    const m = this.mashups.get(id);
    const lib = this.app.library;
    const base = m && lib.track(m.baseId);
    const vocal = m && lib.track(m.vocalId);
    if (!base || !vocal) return;
    this.app.automix.enqueue([base, vocal]);
    if (this.mashups.status(m).id === 'ready') toast(`In coda all'AI DJ: ${label(base)}, poi la voce di ${label(vocal)}`);
    else toast('In coda all\'AI DJ, ma il mashup non è ancora pronto: senza preparazione voce e base si separano durante il set', 'warn', 6000);
  }

  async remove(id) {
    if (!(await confirmDialog('Eliminare questo mashup? I brani restano in libreria.', 'Elimina'))) return;
    if (this.preview && this.preview.id === id) await this.stopPreview();
    if (this.openId === id) this.openId = null;
    try {
      await this.mashups.remove(id);
    } catch (err) {
      toast(`Mashup non eliminato: ${err.message}`, 'error');
    }
  }

  // --- prova sui deck ---------------------------------------------------------------

  async startPreview(id) {
    const app = this.app;
    const m = this.mashups.get(id);
    if (!m) return;
    if (app.automix.enabled) {
      toast('Spegni l\'AI DJ per provare un mashup sui deck', 'warn');
      return;
    }
    if (this.preview) await this.stopPreview();
    const [a, b] = app.decks;
    if (a.playing || b.playing) {
      toast('Ferma i deck per provare il mashup', 'warn');
      return;
    }
    const base = app.library.track(m.baseId);
    const vocal = app.library.track(m.vocalId);
    this.preview = { id, starting: true };
    this.renderList();
    try {
      if (a.track !== base && !(await a.load(base))) throw new Error(`impossibile caricare "${base.title}"`);
      if (b.track !== vocal && !(await b.load(vocal))) throw new Error(`impossibile caricare "${vocal.title}"`);
      await a.setStem('instrumental');
      await b.setStem('vocals');
      if (!this.preview || this.preview.id !== id) return;
      a.setPitch(0);
      b.sync(a);
      for (const d of [a, b]) {
        const vol = app.mixerUI.controls[d.id] && app.mixerUI.controls[d.id].vol;
        if (vol && vol.getValue() < 0.5) vol.set(0.85);
      }
      // al centro entrambi a volume pieno (come nel mashup dell'AI DJ)
      app.engine.setCrossfader(0);
      this.cuePreview(this.mashups.get(id) || m);
      a.play();
      b.play();
      b.alignPhase(a);
      this.preview.starting = false;
    } catch (err) {
      this.preview = null;
      toast(`Prova non riuscita: ${err.message}`, 'error');
    }
    this.renderList();
  }

  /** Base e voce ai loro punti di partenza, a tempo. */
  cuePreview(m) {
    const [a, b] = this.app.decks;
    a.seek(m.baseStart ?? autoBaseStart(a.track, m.bars));
    b.seek(m.vocalStart);
    if (a.playing) b.alignPhase(a);
  }

  async stopPreview() {
    const p = this.preview;
    this.preview = null;
    if (!p) return;
    const [a, b] = this.app.decks;
    a.pause();
    b.pause();
    await Promise.all([a.setStem('full'), b.setStem('full')]).catch(() => {});
    this.renderList();
  }

  /** Deck fermati a mano dalla console: la prova è finita. */
  refreshPreview() {
    const p = this.preview;
    if (!p || p.starting) return;
    const [a, b] = this.app.decks;
    if (!a.playing && !b.playing) {
      this.preview = null;
      this.renderList();
    }
  }
}
