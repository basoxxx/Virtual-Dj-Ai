// Richieste dal pubblico: "Cerca online" apre il browser sulla ricerca del brano e Segueo resta in attesa nella
// cartella dei download. Ogni file audio che arriva (da qualsiasi sito, anche da Drive) entra in libreria, si
// analizza subito e si mette come prossimo, in coda o su un deck con un clic.
import { el, button, toast } from './controls.js';
import { withIcon, icon } from './icons.js';
import { api } from '../api.js';
import { BatchAnalyzer } from '../ai/batch-analyzer.js';

export const SEARCH_SITES = [
  { value: 'https://www.google.com/search?q={q}', label: 'Google' },
  { value: 'https://www.beatport.com/search?q={q}', label: 'Beatport (acquisto)' },
  { value: 'https://www.beatsource.com/search?q={q}', label: 'Beatsource (acquisto, open format)' },
  { value: 'https://bandcamp.com/search?q={q}', label: 'Bandcamp (acquisto)' },
  { value: 'https://www.amazon.it/s?k={q}&i=digital-music', label: 'Amazon Musica digitale (acquisto)' },
  { value: 'custom', label: 'Un altro sito (es. il tuo record pool)…' },
  { value: 'none', label: 'Non aprire il browser: guarda solo i download' },
];

export const DEFAULT_REQUESTS = { site: SEARCH_SITES[0].value, custom: '', folder: '' };

export class RequestsUI {
  constructor(app) {
    this.app = app;
    this.waiting = false;
    this.arrived = []; // brani arrivati in questa attesa (il più recente per primo)
    this.priorityIds = new Set();
    const lib = app.library;
    this.btn = button(withIcon('globe', 'Cerca online', 13), {
      className: 'small req-btn',
      title: 'Apre il browser con la ricerca del brano (testo nella casella di ricerca) e importa da solo il file che scarichi',
      onClick: () => (this.waiting ? this.stop() : this.start()),
    });
    lib.search.after(this.btn);
    this.bar = el('div', { class: 'req-bar', hidden: true });
    lib.search.parentElement.after(this.bar);
    api.on('requests:arrived', (p) => this.onArrived(p));
    api.on('requests:stopped', () => {
      this.waiting = false;
      this.render();
    });
  }

  get settings() {
    const s = this.app.settings;
    s.requests = { ...DEFAULT_REQUESTS, ...(s.requests || {}) };
    return s.requests;
  }

  template() {
    const s = this.settings;
    return s.site === 'custom' ? s.custom : s.site;
  }

  async start() {
    const query = this.app.library.search.value.trim();
    try {
      const folder = await api.startRequest({ query, template: this.template(), folder: this.settings.folder });
      this.waiting = Boolean(folder);
      this.folder = folder;
      this.arrived = [];
      this.render();
      if (!folder) toast('Nel browser non si possono guardare i download: importa il file trascinandolo qui', 'warn');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async stop() {
    await api.stopRequest();
    this.waiting = false;
    this.render();
  }

  async onArrived({ track, snapshot, error, file }) {
    if (error || !track) {
      toast(`File scaricato ma non importato: ${error || file}`, 'error');
      return;
    }
    const app = this.app;
    app.library.setLibrary(snapshot);
    const t = app.library.track(track.id) || track;
    this.arrived = [t, ...this.arrived.filter((x) => x.id !== t.id)].slice(0, 3);
    this.priorityIds.add(t.id);
    // il brano si vede subito nella libreria
    app.library.search.value = t.title;
    app.library.search.dispatchEvent(new Event('input'));
    toast(`Arrivato: ${label(t)}`);
    this.render();
    this.analyzeSoon();
  }

  /** L'analisi del brano arrivato passa davanti a quella della libreria (che poi riprende). */
  async analyzeSoon() {
    const an = this.app.analyzer;
    if (an.running) {
      an.stop();
      for (let i = 0; i < 600 && an.running; i++) await new Promise((r) => setTimeout(r, 100));
    }
    an.run(BatchAnalyzer.pending(this.app.library.lib.tracks));
  }

  playNext(t) {
    const a = this.app.automix;
    a.queue = [t, ...a.queue.filter((x) => x.id !== t.id)];
    a.emit();
    // se l'AI DJ aveva già preparato un altro brano, si riparte da questo
    if (a.enabled) a.replanNext();
    toast(a.enabled ? `${t.title}: è il prossimo` : `${t.title}: primo in coda (avvia l'AI DJ o caricalo su un deck)`);
  }

  render() {
    this.btn.replaceChildren(...(this.waiting ? [icon('close', 13), ' In attesa…'] : [icon('globe', 13), ' Cerca online']));
    this.btn.classList.toggle('on', this.waiting);
    const rows = [];
    if (this.waiting) {
      rows.push(el('div', { class: 'req-wait' },
        el('span', { class: 'req-dot' }),
        el('span', {}, `Aspetto i brani che scarichi in ${this.folder}`),
        button('Fine', { className: 'tiny ghost', title: 'Smetti di guardare la cartella', onClick: () => this.stop() })));
    }
    for (const t of this.arrived) {
      rows.push(el('div', { class: 'req-track' },
        el('span', { class: 'req-title' }, `✓ ${label(t)}`, t.bpm ? el('span', { class: 'req-meta' }, ` ${t.bpm.toFixed(0)} BPM`) : null),
        button('Prossimo', { className: 'tiny primary', title: 'Il prossimo brano dell\'AI DJ (primo in coda)', onClick: () => this.playNext(t) }),
        button('In coda', { className: 'tiny', onClick: () => {
          this.app.automix.enqueue([t]);
          toast(`${t.title}: in coda`);
        } }),
        button('Deck A', { className: 'tiny', onClick: () => this.app.loadTrack(t, 'A') }),
        button('Deck B', { className: 'tiny', onClick: () => this.app.loadTrack(t, 'B') }),
        button('×', { className: 'tiny ghost', title: 'Nascondi', onClick: () => {
          this.arrived = this.arrived.filter((x) => x !== t);
          this.render();
        } })));
    }
    this.bar.replaceChildren(...rows);
    this.bar.hidden = !rows.length;
  }
}

function label(t) {
  return t.artist ? `${t.artist} - ${t.title}` : t.title;
}
