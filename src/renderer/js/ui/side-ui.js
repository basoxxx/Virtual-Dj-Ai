// Pannello laterale: AI DJ (coda e diario), altre schede (es. MASHUP) e sampler a 8 pad.
import { el, button, knob, toast, select } from './controls.js';
import { api } from '../api.js';
import { formatTime, camelotOf } from '../dsp/analysis.js';
import { STRATEGIES, TRANSITIONS } from '../ai/selector.js';
import { BatchAnalyzer } from '../ai/batch-analyzer.js';
import { describeFilters, describeTemporary } from '../ai/segueochat.js';
import { NO_FILTERS } from '../ai/selector.js';
import { withIcon } from './icons.js';
import { parseSetlist, matchEntries, entryLabel, claudePrompt, setlistFromQueue, STYLE_LABELS } from '../ai/setlist.js';

export class SideUI {
  constructor(root, { sampler, automix, onSamplerChange, getTrack, analyzer, getPlaylists, getAllTracks, onAiOptions, planSet, openChat, stems, tabs = [] }) {
    this.root = root;
    this.extraTabs = tabs; // { id, label, pane } tra AI DJ e SAMPLER
    this.stems = stems;
    this.sampler = sampler;
    this.automix = automix;
    this.onSamplerChange = onSamplerChange;
    this.getTrack = getTrack;
    this.analyzer = analyzer;
    this.getPlaylists = getPlaylists;
    this.getAllTracks = getAllTracks;
    this.onAiOptions = onAiOptions;
    this.planSet = planSet; // scaletta da una descrizione, capita come in SegueoChat
    this.openChat = openChat;
    this.build();
  }

  build() {
    const r = this.root;
    r.classList.add('side');
    this.tabs = {};
    const tabBar = el('div', { class: 'tabs' });
    const panes = el('div', { class: 'tab-panes' });
    const addTab = (id, label, pane) => {
      const t = button(label, { className: 'tab', onClick: () => this.show(id) });
      tabBar.append(t);
      panes.append(pane);
      this.tabs[id] = { t, pane };
    };
    addTab('automix', 'AI DJ', this.buildAutomix());
    for (const t of this.extraTabs) addTab(t.id, t.label, t.pane);
    addTab('sampler', 'SAMPLER', this.buildSampler());
    r.append(tabBar, panes);
    this.show('automix');
  }

  show(id) {
    for (const [k, v] of Object.entries(this.tabs)) {
      v.t.classList.toggle('on', k === id);
      v.pane.classList.toggle('show', k === id);
    }
  }

  buildSampler() {
    const s = this.sampler;
    const grid = el('div', { class: 'pads' });
    this.padEls = s.pads.map((p, i) => {
      const name = el('span', { class: 'pad-name' });
      const pad = el('button', { class: 'pad', type: 'button', title: 'Clic: suona/ferma · Clic destro: opzioni' }, el('span', { class: 'pad-num' }, i + 1), name);
      pad.addEventListener('pointerdown', (e) => {
        if (e.button === 0) s.trigger(i);
      });
      pad.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.padMenu(e, i);
      });
      pad.addEventListener('dragover', (e) => e.preventDefault());
      pad.addEventListener('drop', async (e) => {
        e.preventDefault();
        let path = null;
        const id = e.dataTransfer.getData('text/x-track-id');
        if (id) path = this.getTrack(id)?.path;
        else if (e.dataTransfer.files.length) path = api.pathForFile(e.dataTransfer.files[0]);
        if (path) this.loadPad(i, path);
      });
      pad.nameEl = name;
      grid.append(pad);
      return pad;
    });
    const vol = knob({ label: 'VOL', value: 0.8, def: 0.8, size: 30, color: '#ffe14d', onChange: (v) => s.setVolume(v) });
    s.addEventListener('change', () => this.refreshPads());
    this.refreshPads();
    return el('div', { class: 'tab-pane sampler-pane' }, grid,
      el('div', { class: 'row tight center' }, vol, button('STOP TUTTI', { className: 'small', onClick: () => s.stopAll() })),
      el('div', { class: 'hint' }, 'Trascina un brano o un file su un pad per sostituirne il suono. Tasti rapidi: F5–F12.'));
  }

  async loadPad(i, path) {
    try {
      await this.sampler.loadFile(i, path);
      this.onSamplerChange();
    } catch (err) {
      toast(`Campione non valido: ${err.message}`, 'error');
    }
  }

  padMenu(e, i) {
    const s = this.sampler;
    const pad = s.pads[i];
    const menu = el('div', { class: 'ctx-menu' });
    const items = [
      { label: 'Carica campione…', run: async () => {
        const path = await api.pickAudioFile();
        if (path) this.loadPad(i, path);
      } },
      { label: pad.loop ? 'Disattiva loop' : 'Riproduci in loop', run: () => {
        pad.loop = !pad.loop;
        this.refreshPads();
        this.onSamplerChange();
      } },
      { label: 'Ripristina suono predefinito', run: () => {
        s.resetPad(i);
        this.onSamplerChange();
      } },
    ];
    for (const it of items) {
      const n = el('div', { class: 'ctx-item' }, it.label);
      n.addEventListener('click', () => {
        menu.remove();
        it.run();
      });
      menu.append(n);
    }
    document.body.append(menu);
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    document.addEventListener('pointerdown', close, true);
  }

  refreshPads() {
    this.sampler.pads.forEach((p, i) => {
      const el2 = this.padEls[i];
      el2.nameEl.textContent = p.name + (p.loop ? ' ⟳' : '');
      el2.style.setProperty('--pad', p.color || '#888');
      el2.classList.toggle('playing', Boolean(p.source));
    });
  }

  buildAutomix() {
    const a = this.automix;
    const opt = a.options;
    const setOpt = (patch) => {
      a.setOptions(patch);
      this.onAiOptions(a.options);
      this.refreshAutomix();
    };
    this.amToggle = button('Avvia AI DJ', { className: 'toggle automix-toggle', title: 'Mixa in automatico (Ctrl+M)', onClick: () => a.setEnabled(!a.enabled) });
    this.amStatus = el('div', { class: 'ai-status' }, 'Spento');
    this.modeSel = select([
      { value: 'ai', label: 'L\'AI sceglie i brani' },
      { value: 'queue', label: 'Segui solo la coda' },
    ], opt.mode, (v) => setOpt({ mode: v }), 'ai-select');
    this.sourceSel = select([{ value: 'library', label: 'Tutta la libreria' }], opt.source, (v) => setOpt({ source: v }), 'ai-select');
    this.strategySel = select(Object.entries(STRATEGIES).map(([value, label]) => ({ value, label })), opt.strategy, (v) => setOpt({ strategy: v }), 'ai-select');
    this.styleSel = select(Object.entries(TRANSITIONS).map(([value, label]) => ({ value, label })), opt.style, (v) => setOpt({ style: v }), 'ai-select');
    this.barsSel = select([4, 8, 16, 32, 48, 64].map((b) => ({ value: String(b), label: `${b} battute` })), String(opt.bars), (v) => setOpt({ bars: Number(v) }), 'ai-select');
    const tempoCheck = el('input', { type: 'checkbox' });
    tempoCheck.checked = opt.returnTempo;
    tempoCheck.addEventListener('change', () => setOpt({ returnTempo: tempoCheck.checked }));
    this.remixCheck = el('input', { type: 'checkbox' });
    this.remixCheck.checked = Boolean(opt.remix);
    this.remixCheck.addEventListener('change', () => setOpt({ remix: this.remixCheck.checked }));
    this.mashCheck = el('input', { type: 'checkbox' });
    this.mashCheck.checked = Boolean(opt.mashup);
    this.mashCheck.addEventListener('change', () => {
      setOpt({ mashup: this.mashCheck.checked });
      if (this.mashCheck.checked && this.stems && this.stems.modelInstalled === false) toast('Per i mashup scarica il modello che separa voce e base', 'warn');
    });
    this.mashInfo = el('span', { class: 'mini-label' });
    this.mashBtn = button('Scarica modello (174 MB)', { className: 'small', title: 'Segueo Separazione voce: separa voce e base dei brani, sul computer', onClick: async () => {
      this.mashBtn.disabled = true;
      try {
        if (await this.stems.downloadModel()) toast('Modello per i mashup installato');
      } catch (err) {
        toast(`Download non riuscito: ${err.message}`, 'error');
      } finally {
        this.mashBtn.disabled = false;
      }
    } });
    if (this.stems) {
      this.stems.addEventListener('change', () => this.refreshStems());
      this.stems.checkModel();
    }
    // indicazioni date a SegueoChat: filtri, cambi per i prossimi brani, chiusura del set
    this.directives = el('div', { class: 'am-directives' });

    this.prompt = el('textarea', { class: 'ai-prompt', rows: '2', placeholder: 'Descrivi il set (es. "house anni 2000 in crescendo per un aperitivo")' });
    this.prompt.addEventListener('keydown', (e) => e.stopPropagation());
    const genBtn = button(withIcon('sparkles', 'Crea scaletta', 13), { className: 'small primary', title: 'Genera la coda: genere, energia e durata dalla descrizione, capiti come in SegueoChat', onClick: async () => {
      genBtn.disabled = true;
      try {
        const { tracks } = await this.planSet(this.prompt.value.trim());
        a.setQueue(tracks);
        if (tracks.length) toast(`Scaletta pronta: ${tracks.length} brani in coda`);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        genBtn.disabled = false;
      }
    } });

    // scaletta già decisa (es. scritta con Claude): brani in ordine e cambi di stile
    const setBtn = (text, title, fn) => {
      const b = button(text, { className: 'small', title, onClick: async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          b.disabled = false;
        }
      } });
      return b;
    };
    const setButtons = el('div', { class: 'row tight wrap' },
      setBtn(withIcon('sparkles', 'Copia per Claude', 13), 'Copia la richiesta per Claude con l\'elenco della libreria: incollala su claude.ai e descrivi la serata', async () => {
        const tracks = this.getAllTracks();
        if (!tracks.length) throw new Error('La libreria è vuota: aggiungi prima la tua musica');
        await api.writeClipboard(claudePrompt(tracks));
        const pending = BatchAnalyzer.pending(tracks).length;
        toast(pending
          ? `Copiato. Consiglio: analizza prima la libreria (${pending} brani senza BPM o tonalità), così Claude li abbina meglio`
          : 'Copiato: incollalo in una chat con Claude e descrivi la serata', pending ? 'warn' : undefined);
      }),
      setBtn('Incolla scaletta', 'Carica la scaletta copiata dalla risposta di Claude', async () => this.importSetlist(await api.readClipboard())),
      setBtn('Apri file', 'Carica una scaletta salvata (.json)', async () => {
        const f = await api.openSetlist();
        if (f) this.importSetlist(f.text);
      }),
      setBtn('Salva coda', 'Salva la coda come scaletta, per riusarla o farla ritoccare a Claude', async () => {
        if (!a.queue.length) throw new Error('La coda è vuota');
        const after = a.options.mode === 'ai' ? 'continue' : 'stop';
        const data = setlistFromQueue(a.queue, a.options, { title: a.setTitle || 'Coda di Segueo', after, cues: a.cues });
        const saved = await api.saveSetlist({ text: `${JSON.stringify(data, null, 2)}\n`, name: data.scaletta });
        if (saved) toast('Scaletta salvata');
      }));

    this.anaBtn = button('Analizza libreria', { className: 'small', title: 'Calcola BPM, tonalità, energia e punti di mix di tutti i brani', onClick: () => {
      if (this.analyzer.running) this.analyzer.stop();
      else this.analyzer.run(this.getAllTracks());
    } });
    this.anaInfo = el('span', { class: 'mini-label' });
    this.analyzer.addEventListener('progress', () => this.refreshAnalysis());

    this.amList = el('div', { class: 'am-list' });
    this.amList.addEventListener('dragover', (e) => e.preventDefault());
    this.amList.addEventListener('drop', (e) => {
      e.preventDefault();
      const ids = (e.dataTransfer.getData('text/x-track-ids') || '').split(',').filter(Boolean);
      const tracks = ids.map((id) => this.getTrack(id)).filter(Boolean);
      if (tracks.length) a.enqueue(tracks);
    });
    this.logEl = el('div', { class: 'ai-log' });
    a.addEventListener('change', () => this.refreshAutomix());
    a.addEventListener('log', () => this.refreshLog());
    setInterval(() => {
      this.amStatus.textContent = a.status();
    }, 250);
    this.refreshAutomix();
    this.refreshAnalysis();

    const row = (label, control) => el('label', { class: 'ai-row' }, el('span', {}, label), control);
    // tre gruppi: nella vista AI diventano colonne affiancate (comandi già nella scena, impostazioni, coda e diario)
    return el('div', { class: 'tab-pane automix-pane' },
      el('div', { class: 'am-group am-main' },
        this.amToggle, this.amStatus,
        el('div', { class: 'row tight' },
          button(withIcon('forward', 'Mixa ora', 13), { className: 'small', title: 'Avvia la transizione alla prossima battuta', onClick: () => a.mixNow() }),
          button(withIcon('skip', 'Cambia prossimo', 13), { className: 'small', title: 'Scarta il brano preparato', onClick: () => a.skipNext() }))),
      el('div', { class: 'am-group am-settings' },
        el('div', { class: 'am-heading' }, withIcon('gear', 'Impostazioni AI DJ', 14)),
        row('Brani', this.modeSel),
        row('Sorgente', this.sourceSel),
        row('Energia', this.strategySel),
        row('Transizioni', this.styleSel),
        row('Durata mix', this.barsSel),
        el('label', { class: 'check' }, tempoCheck, 'Ritorna al BPM originale dopo il mix'),
        el('label', { class: 'check' }, this.remixCheck, 'Remix dal vivo: loop, eco e filtri sulle frasi'),
        el('label', { class: 'check' }, this.mashCheck, 'Mashup: voce del prossimo brano sulla base di quello in onda'),
        el('div', { class: 'row tight' }, this.mashInfo, this.mashBtn),
        this.directives,
        this.prompt,
        el('div', { class: 'row tight' }, genBtn,
          button('Mescola', { className: 'small', onClick: () => a.shuffle() }),
          button('Svuota', { className: 'small', onClick: () => a.clear() })),
        el('div', { class: 'section-label' }, 'SCALETTA DA CLAUDE'),
        setButtons),
      el('div', { class: 'am-group am-activity' },
        el('div', { class: 'section-label' }, 'CODA'),
        this.amList,
        el('div', { class: 'row tight' }, this.anaBtn, this.anaInfo),
        el('div', { class: 'section-label' }, 'DIARIO DELL\'AI'),
        this.logEl));
  }

  /** Carica una scaletta (testo JSON, anche dentro la risposta di Claude) e la mette in coda. */
  importSetlist(text) {
    const a = this.automix;
    if (!String(text || '').trim()) throw new Error('Negli appunti non c\'è niente: copia prima la scaletta dalla risposta di Claude');
    const set = parseSetlist(text);
    const { found, missing } = matchEntries(set.entries, this.getAllTracks());
    if (!found.length) throw new Error(`Nessuno dei ${set.entries.length} brani della scaletta è nella libreria`);
    a.loadSet({ title: set.title, after: set.after, options: set.options, items: found });
    this.onAiOptions(a.options);
    if (missing.length) a.say(`Non trovati nella libreria (${missing.length}): ${missing.slice(0, 10).map(entryLabel).join('; ')}${missing.length > 10 ? '…' : ''}`);
    for (const w of set.warnings.slice(0, 6)) a.say(`Scaletta: ${w}`);
    // i brani non ancora analizzati si analizzano subito, così il set non aspetta
    const pending = BatchAnalyzer.pending(found.map((x) => x.track));
    if (pending.length && !this.analyzer.running) this.analyzer.run(pending);
    toast(`Scaletta «${set.title}»: ${found.length} brani in coda${missing.length ? ` · ${missing.length} ${missing.length === 1 ? 'non trovato' : 'non trovati'} (vedi diario)` : ''}`, missing.length ? 'warn' : undefined);
  }

  refreshDirectives() {
    const a = this.automix;
    const rows = [];
    const row = (text, action, label, title) => el('div', { class: 'am-directive' }, el('span', {}, text),
      button(label, { className: 'tiny ghost', title, onClick: action }));
    const f = describeFilters(a.options.filters);
    if (f) rows.push(row(`Filtri: ${f}`, () => a.setOptions({ filters: NO_FILTERS }), '×', 'Togli i filtri: tutti i generi e tutti i BPM'));
    if (a.temp) {
      rows.push(row(`Per altri ${a.temp.remaining} brani: ${describeTemporary(Object.keys(a.temp.restore), a.options)}`, () => {
        const { restore } = a.temp;
        a.temp = null;
        a.setOptions(restore);
      }, '×', 'Torna subito alle impostazioni di prima'));
    }
    if (a.endAfterCurrent) rows.push(row('Chiudo il set dopo il brano in onda', () => a.setEndAfterCurrent(false), 'Continua', 'Il set continua'));
    this.directives.replaceChildren(...rows);
    this.directives.hidden = !rows.length;
  }

  refreshSources() {
    const lists = this.getPlaylists();
    this.sourceSel.setOptions([{ value: 'library', label: 'Tutta la libreria' }, ...lists.map((p) => ({ value: p.id, label: `Playlist: ${p.name}` }))], this.automix.options.source);
    if (this.sourceSel.value !== this.automix.options.source) this.sourceSel.value = 'library';
    this.refreshAnalysis();
  }

  refreshAnalysis() {
    const an = this.analyzer;
    if (an.running) {
      this.anaBtn.textContent = 'Ferma analisi';
      this.anaInfo.textContent = an.paused
        ? `${an.done}/${an.total} · in pausa mentre separo voce e base`
        : `${an.done}/${an.total}${an.current ? ` · ${an.current.title}` : ''}`;
    } else {
      const pending = BatchAnalyzer.pending(this.getAllTracks()).length;
      this.anaBtn.textContent = 'Analizza libreria';
      this.anaInfo.textContent = pending ? `${pending} brani da analizzare` : 'Libreria analizzata ✓';
    }
  }

  refreshLog() {
    const entries = this.automix.log.slice(-40);
    this.logEl.replaceChildren(...entries.map((e) => el('div', { class: 'ai-log-row' },
      el('span', { class: 'ai-log-time' }, e.at.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })), e.text)));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  refreshStems() {
    const st = this.stems;
    if (!st) return;
    let text = '';
    if (st.downloading) {
      const { done, total } = st.downloading;
      text = `Download del modello: ${total ? Math.round((done / total) * 100) : 0}%`;
    } else if (st.running) {
      text = `Separo voce e base: ${st.running.track.title} ${Math.round(st.running.progress * 100)}%${st.queue.length ? ` (+${st.queue.length} in coda)` : ''}`;
    } else if (st.modelInstalled === false) {
      text = 'Per i mashup serve il modello Segueo Separazione voce (una volta sola)';
    } else if (st.modelInstalled) {
      text = 'Modello per i mashup installato';
    }
    this.mashInfo.textContent = text;
    this.mashBtn.style.display = st.modelInstalled === false && !st.downloading ? '' : 'none';
  }

  refreshAutomix() {
    const a = this.automix;
    const o = a.options;
    this.remixCheck.checked = Boolean(o.remix);
    this.mashCheck.checked = Boolean(o.mashup);
    this.amToggle.textContent = a.enabled ? 'AI DJ attivo' : 'Avvia AI DJ';
    this.amToggle.setOn(a.enabled);
    this.modeSel.value = o.mode;
    this.strategySel.value = o.strategy;
    this.styleSel.value = o.style;
    this.barsSel.value = String(o.bars);
    this.refreshDirectives();
    this.amList.innerHTML = '';
    if (!a.queue.length) this.amList.append(el('div', { class: 'am-empty' }, o.mode === 'ai' ? 'Coda vuota: l\'AI sceglie dalla sorgente' : 'Coda vuota'));
    const cues = a.cues.filter((c) => !c.used);
    a.queue.forEach((t, i) => {
      // indicazioni della scaletta per questo brano (cambio di stile, entrata/uscita)
      const ci = cues.findIndex((c) => c.track === t);
      const cue = ci >= 0 ? cues.splice(ci, 1)[0] : null;
      const cueText = cue ? [cue.options.style && STYLE_LABELS[cue.options.style], cue.options.bars && `${cue.options.bars}b`,
        cue.inAt != null && `da ${formatTime(cue.inAt, false)}`, cue.outAt != null && `esce ${formatTime(cue.outAt, false)}`].filter(Boolean).join(' · ') : '';
      const row = el('div', { class: 'am-row', draggable: 'true' },
        el('span', { class: 'am-idx' }, i + 1),
        el('span', { class: 'am-title' }, `${t.artist ? `${t.artist} - ` : ''}${t.title}`, cueText ? el('span', { class: 'am-cue', title: cue.note || 'Indicazioni della scaletta' }, cueText) : null),
        el('span', { class: 'am-dur' }, [t.bpm ? t.bpm.toFixed(0) : formatTime(t.duration, false), camelotOf(t.key)].filter(Boolean).join(' ')),
        button('×', { className: 'tiny ghost', onClick: () => a.remove(i) }));
      row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-am-index', String(i)));
      row.addEventListener('drop', (e) => {
        const from = e.dataTransfer.getData('text/x-am-index');
        if (from !== '') {
          e.preventDefault();
          e.stopPropagation();
          a.move(Number(from), i);
        }
      });
      this.amList.append(row);
    });
  }
}
