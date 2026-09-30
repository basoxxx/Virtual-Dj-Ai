// Vista AI: al posto della console mostra cosa sta facendo l'AI DJ (brano in onda, prossimo,
// transizione e mashup) con i comandi essenziali. L'AI continua a mixare anche passando alla
// console classica, dove si può intervenire a mano sopra il suo mix.
import { el, button } from './controls.js';
import { withIcon } from './icons.js';
import { OverviewWaveform } from './waveform.js';
import { formatTime, camelotOf } from '../dsp/analysis.js';
import { TRANSITION_NAMES } from '../ai/autodj.js';

const STEM_LABELS = { vocals: 'Solo voce', instrumental: 'Solo base' };
const MASHUP_LABELS = { preparing: 'Mashup: preparo voce e base…', ready: 'Mashup pronto', failed: 'Mashup non disponibile' };
const SAVED_LABELS = { preparing: 'Mashup salvato: controllo voce e base…', ready: 'Mashup salvato pronto', failed: 'Mashup salvato non disponibile' };

class DeckCard {
  constructor(deck, accent) {
    this.deck = deck;
    this.role = el('span', { class: 'ai-role' }, 'Fermo');
    this.stem = el('span', { class: 'ai-stem' });
    this.title = el('div', { class: 'ai-title' }, 'Nessun brano');
    this.artist = el('div', { class: 'ai-artist' }, '');
    this.bpm = el('span', { class: 'ai-num' }, '—');
    this.key = el('span', { class: 'ai-num' }, '—');
    this.energy = el('span', { class: 'ai-num' }, '—');
    this.time = el('span', { class: 'ai-time' }, '');
    const canvas = el('canvas', { class: 'overview ai-overview' });
    this.overview = new OverviewWaveform(canvas, deck, accent);
    const stat = (value, label) => el('div', { class: 'ai-stat' }, value, el('span', { class: 'ai-stat-label' }, label));
    this.root = el('div', { class: 'ai-deck' },
      el('div', { class: 'ai-deck-head' }, el('span', { class: 'ai-letter' }, deck.id), this.role, this.stem, el('span', { class: 'spacer' }), this.time),
      this.title, this.artist,
      el('div', { class: 'ai-stats' }, stat(this.bpm, 'BPM'), stat(this.key, 'Tonalità'), stat(this.energy, 'Energia')),
      canvas);
    this.root.style.setProperty('--deck-accent', accent);
  }

  update(role) {
    const d = this.deck;
    const t = d.track;
    this.root.classList.toggle('empty', !t);
    this.root.dataset.role = role.id;
    this.role.textContent = role.label;
    this.title.textContent = t ? t.title || 'Senza titolo' : 'Nessun brano';
    this.artist.textContent = t ? t.artist || '' : 'L\'AI caricherà qui il prossimo brano';
    this.bpm.textContent = d.bpm ? d.effectiveBpm.toFixed(1) : '—';
    const cam = camelotOf(d.displayKey);
    this.key.textContent = d.displayKey ? `${d.displayKey}${cam ? ` · ${cam}` : ''}` : '—';
    this.energy.textContent = t && t.energy ? String(t.energy) : '—';
    this.time.textContent = d.loaded ? `-${formatTime(Math.max(0, d.remaining), false)}` : '';
    const stem = STEM_LABELS[d.stem] || '';
    this.stem.textContent = stem;
    this.stem.hidden = !stem;
  }
}

export class AiView {
  constructor(root, { app, accents }) {
    this.app = app;
    this.automix = app.automix;
    this.cards = app.decks.map((d, i) => new DeckCard(d, accents[i]));

    this.ring = el('div', { class: 'ai-ring' });
    this.ringText = el('div', { class: 'ai-ring-text' }, '');
    this.status = el('div', { class: 'ai-state' }, 'Spento');
    this.planEl = el('div', { class: 'ai-plan' }, '');
    this.whyEl = el('div', { class: 'ai-why' }, '');
    this.mashEl = el('div', { class: 'ai-mash' }, '');
    this.xfThumb = el('div', { class: 'ai-xf-thumb' });
    const a = this.automix;
    this.power = button(withIcon('sparkles', 'Avvia AI DJ'), { className: 'ai-power toggle', title: 'Mixa in automatico (Ctrl+M)', onClick: () => a.setEnabled(!a.enabled) });
    this.mixNowBtn = button(withIcon('forward', 'Mixa ora', 14), { title: 'Avvia la transizione alla prossima battuta', onClick: () => a.mixNow() });
    this.skipBtn = button(withIcon('skip', 'Cambia prossimo', 14), { title: 'Scarta il brano preparato', onClick: () => a.skipNext() });
    this.mashBtn = button('Mashup', { className: 'ai-pill toggle', toggle: true, title: 'Voce del prossimo brano sulla base di quello in onda', onClick: () => this.toggleOption('mashCheck') });
    this.remixBtn = button('Remix dal vivo', { className: 'ai-pill toggle', toggle: true, title: 'Loop, eco e filtri sulle frasi mentre un brano suona da solo', onClick: () => this.toggleOption('remixCheck') });
    this.chatBtn = button(withIcon('chat', 'Chat', 14), { title: 'SegueoChat: di\' all\'AI DJ come suonare (Ctrl+K)', onClick: () => app.openChat() });
    this.takeOver = button(withIcon('sliders', 'Console', 14), { className: 'ai-takeover', title: 'Passa alla console per mixare a mano sopra l\'AI (l\'AI continua)', onClick: () => app.setView('console') });

    const center = el('div', { class: 'ai-center' },
      el('div', { class: 'ai-ring-wrap' }, this.ring, this.ringText),
      this.status, this.planEl, this.whyEl, this.mashEl,
      el('div', { class: 'ai-xf', title: 'Crossfader' }, el('span', {}, 'A'), el('div', { class: 'ai-xf-track' }, this.xfThumb), el('span', {}, 'B')),
      this.power,
      el('div', { class: 'ai-actions' }, this.mixNowBtn, this.skipBtn, this.chatBtn),
      el('div', { class: 'ai-actions' }, this.mashBtn, this.remixBtn, this.takeOver));

    root.classList.add('ai-stage');
    root.append(this.cards[0].root, center, this.cards[1].root);
    this.root = root;
  }

  /** Le opzioni passano dal pannello AI DJ, così restano sincronizzate e salvate. */
  toggleOption(name) {
    const check = this.app.sideUI[name];
    if (!check) return;
    check.checked = !check.checked;
    check.dispatchEvent(new Event('change'));
  }

  roles() {
    const a = this.automix;
    const out = new Map();
    const tr = a.transition;
    if (tr) {
      out.set(tr.from, { id: 'out', label: tr.mashup ? 'Base' : 'In uscita' });
      out.set(tr.to, { id: 'in', label: tr.mashup ? 'Voce in entrata' : 'In entrata' });
    } else {
      const cur = a.enabled ? a.current() : null;
      if (cur) out.set(cur, { id: 'air', label: 'In onda' });
      if (a.plan && a.plan.to && a.plan.to !== cur) out.set(a.plan.to, { id: 'next', label: 'Prossimo' });
    }
    for (const d of this.app.decks) {
      if (!out.has(d)) out.set(d, d.playing ? { id: 'air', label: 'In onda' } : { id: 'idle', label: d.loaded ? 'Pronto' : 'Vuoto' });
    }
    return out;
  }

  frame() {
    const a = this.automix;
    const roles = this.roles();
    this.cards.forEach((c) => {
      c.update(roles.get(c.deck));
      c.overview.draw();
    });

    // anello: avanzamento della transizione, oppure del brano in onda fino al punto di mix
    let p = 0;
    let ringLabel = '';
    const tr = a.transition;
    const cur = a.enabled ? a.current() : null;
    if (tr) {
      p = Math.min(1, (performance.now() - tr.start) / tr.duration);
      ringLabel = `${Math.round(p * 100)}%`;
    } else if (cur && a.plan && Number.isFinite(a.plan.startAt) && a.plan.startAt > 0) {
      p = Math.min(1, cur.position / a.plan.startAt);
      ringLabel = formatTime(Math.max(0, (a.plan.startAt - cur.position) / (cur.tempo || 1)), false);
    } else if (cur && cur.duration) {
      p = cur.position / cur.duration;
    }
    this.ring.style.setProperty('--p', p.toFixed(4));
    this.ring.classList.toggle('mixing', Boolean(tr));
    this.ringText.textContent = ringLabel;

    this.status.textContent = a.status();
    const plan = tr ? tr.plan : a.plan;
    if (plan && plan.type && Number.isFinite(plan.startAt)) {
      this.planEl.textContent = `${tr && tr.mashup ? 'Mashup' : `Transizione ${TRANSITION_NAMES[plan.type] || plan.type}`} · ${plan.bars} battute`;
      this.whyEl.textContent = plan.why || '';
    } else {
      this.planEl.textContent = a.enabled ? '' : 'Accendi l\'AI DJ: sceglie i brani e mixa da sola';
      this.whyEl.textContent = '';
    }
    const mash = plan && plan.mashup ? (plan.mashup.saved ? SAVED_LABELS : MASHUP_LABELS)[plan.mashup.status] || '' : '';
    this.mashEl.textContent = mash;
    this.mashEl.hidden = !mash;

    const x = (this.app.engine.crossfader + 1) / 2;
    this.xfThumb.style.left = `${(x * 100).toFixed(1)}%`;

    this.power.setOn(a.enabled);
    this.power.lastChild.textContent = a.enabled ? 'AI DJ attivo' : 'Avvia AI DJ';
    this.mixNowBtn.disabled = !a.enabled || Boolean(tr);
    this.skipBtn.disabled = !a.enabled || Boolean(tr);
    this.mashBtn.setOn(a.options.mashup);
    this.remixBtn.setOn(a.options.remix);
  }
}
