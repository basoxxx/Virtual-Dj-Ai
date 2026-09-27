// Browser della libreria: sorgenti, playlist, ricerca, ordinamento, lista virtualizzata,
// evidenziazione dei brani compatibili (BPM e tonalità Camelot) con il deck in onda.
import { el, button, toast, askText, confirmDialog } from './controls.js';
import { formatTime, camelotOf, harmonicMatch } from '../dsp/analysis.js';
import { api } from '../api.js';
import { icon, withIcon } from './icons.js';

const ROW_H = 26;

const COLUMNS = [
  { id: 'title', label: 'Titolo', width: '2.4fr' },
  { id: 'artist', label: 'Artista', width: '1.6fr' },
  { id: 'bpm', label: 'BPM', width: '64px', num: true },
  { id: 'key', label: 'Key', width: '70px' },
  { id: 'duration', label: 'Durata', width: '64px', num: true },
  { id: 'genre', label: 'Genere', width: '1fr' },
  { id: 'album', label: 'Album', width: '1.2fr' },
  { id: 'playCount', label: '▶', width: '40px', num: true },
];

export class LibraryUI extends EventTarget {
  constructor(root, { onLoad, onQueue, getMasterDeck }) {
    super();
    this.root = root;
    this.onLoad = onLoad;
    this.onQueue = onQueue;
    this.getMasterDeck = getMasterDeck;
    this.lib = { folders: [], tracks: [], playlists: [], history: [] };
    this.byId = new Map();
    this.source = { type: 'all' };
    this.sort = { col: 'artist', dir: 1 };
    this.query = '';
    this.rows = [];
    this.selected = new Set();
    this.lastClicked = -1;
    this.build();
  }

  build() {
    const r = this.root;
    r.classList.add('library');
    this.sidebar = el('div', { class: 'lib-sidebar' });
    this.search = el('input', { class: 'lib-search', type: 'search', placeholder: 'Cerca titolo, artista, BPM, tonalità…' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.refreshRows();
    });
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.search.value = '';
        this.query = '';
        this.refreshRows();
        this.search.blur();
      }
      if (e.key === 'Enter' && this.rows.length) {
        this.onLoad(this.rows[0], null);
        this.search.blur();
      }
    });
    this.status = el('div', { class: 'lib-status' });
    this.header = el('div', { class: 'lib-header lib-grid' });
    for (const c of COLUMNS) {
      const h = el('div', { class: `lib-th ${c.num ? 'num' : ''}`, dataset: { col: c.id } }, c.label);
      h.addEventListener('click', () => {
        this.sort = { col: c.id, dir: this.sort.col === c.id ? -this.sort.dir : 1 };
        this.sortTouched = true;
        this.refreshRows();
      });
      this.header.append(h);
    }
    this.viewport = el('div', { class: 'lib-viewport', tabindex: '0' });
    this.spacer = el('div', { class: 'lib-spacer' });
    this.rowsHost = el('div', { class: 'lib-rows' });
    this.viewport.append(this.spacer, this.rowsHost);
    this.viewport.addEventListener('scroll', () => this.renderRows());
    this.viewport.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.renderRows()).observe(this.viewport);
    this.empty = el('div', { class: 'lib-empty' },
      el('div', { class: 'big' }, icon('music', 44)),
      el('div', {}, 'La libreria è vuota'),
      el('div', { class: 'row center' },
        button('+ Aggiungi cartella musicale', { className: 'primary', onClick: () => this.addFolder() }),
        button('+ Aggiungi file', { onClick: () => this.addFiles() })),
      el('div', { class: 'hint' }, 'Puoi anche trascinare file audio direttamente sui deck o qui.'));
    const main = el('div', { class: 'lib-main' },
      el('div', { class: 'lib-toolbar' }, this.search, this.status),
      this.header, this.viewport, this.empty);
    const gridCols = COLUMNS.map((c) => c.width).join(' ');
    r.style.setProperty('--lib-cols', gridCols);
    r.append(this.sidebar, main);
    r.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    });
    r.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const res = await api.addFiles(paths);
      this.setLibrary(res.snapshot);
      toast(`${res.added.length} brani aggiunti`);
    });
    this.menu = null;
    document.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target)) this.closeMenu();
    });
  }

  async reload() {
    this.setLibrary(await api.getLibrary());
  }

  setLibrary(lib) {
    const prev = this.byId;
    this.lib = lib;
    this.byId = new Map();
    for (const t of lib.tracks) {
      // mantiene gli oggetti già caricati nei deck (stesso riferimento)
      const old = prev.get(t.id);
      if (old) {
        Object.assign(old, t);
        this.byId.set(t.id, old);
      } else {
        this.byId.set(t.id, t);
      }
    }
    this.lib.tracks = [...this.byId.values()];
    if (this.source.type === 'playlist' && !lib.playlists.find((p) => p.id === this.source.id)) this.source = { type: 'all' };
    this.renderSidebar();
    this.refreshRows();
    this.dispatchEvent(new CustomEvent('changed'));
  }

  track(id) {
    return this.byId.get(id);
  }

  renderSidebar() {
    const s = this.sidebar;
    s.innerHTML = '';
    const item = (label, source, extra = null, count = null, text = '') => {
      const active = this.source.type === source.type && this.source.id === source.id;
      const node = el('div', { class: `lib-src ${active ? 'active' : ''}` }, el('span', { class: 'src-label' }, label), count != null ? el('span', { class: 'src-count' }, count) : null, extra);
      node.addEventListener('click', () => {
        this.source = source;
        this.sortTouched = false;
        this.renderSidebar();
        this.refreshRows();
      });
      if (source.type === 'playlist') {
        node.addEventListener('dragover', (e) => {
          e.preventDefault();
          node.classList.add('drop');
        });
        node.addEventListener('dragleave', () => node.classList.remove('drop'));
        node.addEventListener('drop', async (e) => {
          e.preventDefault();
          node.classList.remove('drop');
          const ids = (e.dataTransfer.getData('text/x-track-ids') || '').split(',').filter(Boolean);
          if (ids.length) {
            await api.addToPlaylist(source.id, ids);
            await this.reload();
            toast(`${ids.length} brani aggiunti alla playlist`);
          }
        });
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.openMenu(e, [
            { label: 'Rinomina', run: async () => {
              const name = await askText('Nome della playlist', text);
              if (name) {
                await api.renamePlaylist(source.id, name);
                this.reload();
              }
            } },
            { label: 'Metti tutto in Automix', run: () => this.onQueue(this.playlistTracks(source.id)) },
            { label: 'Elimina playlist', run: async () => {
              if (await confirmDialog(`Eliminare la playlist "${text}"?`, 'Elimina')) {
                await api.deletePlaylist(source.id);
                this.reload();
              }
            } },
          ]);
        });
      }
      return node;
    };
    s.append(el('div', { class: 'lib-group' }, 'LIBRERIA'));
    s.append(item(withIcon('music', 'Tutti i brani'), { type: 'all' }, null, this.lib.tracks.length));
    s.append(item(withIcon('clock', 'Cronologia'), { type: 'history' }));
    s.append(item(withIcon('star', 'Più suonati'), { type: 'top' }));
    s.append(item(withIcon('plusCircle', 'Aggiunti di recente'), { type: 'recent' }));
    s.append(el('div', { class: 'lib-group' }, 'PLAYLIST', button('+', { className: 'tiny', title: 'Nuova playlist', onClick: async (e) => {
      e.stopPropagation();
      const name = await askText('Nome della nuova playlist', 'Nuova playlist');
      if (name) {
        await api.createPlaylist(name);
        this.reload();
      }
    } })));
    for (const p of this.lib.playlists) s.append(item(withIcon('list', p.name), { type: 'playlist', id: p.id }, null, p.tracks.length, p.name));
    s.append(el('div', { class: 'lib-group' }, 'CARTELLE', button('+', { className: 'tiny', title: 'Aggiungi cartella', onClick: (e) => {
      e.stopPropagation();
      this.addFolder();
    } })));
    for (const f of this.lib.folders) {
      const name = f.split(/[\\/]/).filter(Boolean).pop() || f;
      const rm = button('×', { className: 'tiny ghost', title: 'Rimuovi cartella dalla libreria', onClick: async (e) => {
        e.stopPropagation();
        if (await confirmDialog(`Rimuovere la cartella "${name}" dalla libreria? (i file non vengono cancellati)`, 'Rimuovi')) {
          this.setLibrary(await api.removeFolder(f));
        }
      } });
      const node = item(withIcon('folder', name), { type: 'folder', id: f }, rm);
      node.title = f;
      s.append(node);
    }
    s.append(el('div', { class: 'lib-actions' },
      button('+ Cartella', { className: 'small', onClick: () => this.addFolder() }),
      button('+ File', { className: 'small', onClick: () => this.addFiles() }),
      button(icon('refresh', 14), { className: 'small', title: 'Aggiorna libreria', onClick: async () => {
        this.setLibrary(await api.rescan());
        toast('Libreria aggiornata');
      } })));
  }

  async addFolder() {
    this.setLibrary(await api.addFolder());
  }

  async addFiles() {
    const res = await api.addFiles();
    this.setLibrary(res.snapshot);
    if (res.added.length) toast(`${res.added.length} brani aggiunti`);
  }

  playlistTracks(id) {
    const p = this.lib.playlists.find((x) => x.id === id);
    return p ? p.tracks.map((t) => this.byId.get(t)).filter(Boolean) : [];
  }

  sourceTracks() {
    const src = this.source;
    const all = this.lib.tracks;
    switch (src.type) {
      case 'history': {
        const seen = [];
        for (let i = this.lib.history.length - 1; i >= 0; i--) {
          const t = this.byId.get(this.lib.history[i].id);
          if (t) seen.push(t);
        }
        return { list: seen, ordered: true };
      }
      case 'top':
        return { list: all.filter((t) => t.playCount > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 200), ordered: true };
      case 'recent':
        return { list: [...all].sort((a, b) => b.added - a.added).slice(0, 300), ordered: true };
      case 'playlist':
        return { list: this.playlistTracks(src.id), ordered: true };
      case 'folder': {
        const prefix = src.id;
        return { list: all.filter((t) => t.path.startsWith(prefix)), ordered: false };
      }
      default:
        return { list: all, ordered: false };
    }
  }

  refreshRows() {
    const { list, ordered } = this.sourceTracks();
    let rows = list;
    if (this.query) {
      const terms = this.query.split(/\s+/);
      rows = rows.filter((t) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.key} ${camelotOf(t.key)} ${t.bpm ? Math.round(t.bpm) : ''}`.toLowerCase();
        return terms.every((q) => hay.includes(q));
      });
    }
    if (!ordered || this.sortTouched) {
      const { col, dir } = this.sort;
      rows = [...rows].sort((a, b) => {
        const va = a[col] ?? '';
        const vb = b[col] ?? '';
        if (typeof va === 'number' || typeof vb === 'number') return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
        return String(va).localeCompare(String(vb), undefined, { sensitivity: 'base', numeric: true }) * dir;
      });
    }
    this.rows = rows;
    this.header.querySelectorAll('.lib-th').forEach((h) => {
      h.classList.toggle('sorted', h.dataset.col === this.sort.col);
      h.classList.toggle('desc', h.dataset.col === this.sort.col && this.sort.dir < 0);
    });
    this.spacer.style.height = `${rows.length * ROW_H}px`;
    this.status.textContent = `${rows.length} brani`;
    this.empty.classList.toggle('show', this.lib.tracks.length === 0);
    this.renderRows(true);
  }

  renderRows() {
    const vp = this.viewport;
    const start = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - 5);
    const count = Math.ceil(vp.clientHeight / ROW_H) + 10;
    const end = Math.min(this.rows.length, start + count);
    const master = this.getMasterDeck();
    const mKey = master && master.displayKey;
    const mBpm = master && master.bpm ? master.effectiveBpm : 0;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const t = this.rows[i];
      const row = el('div', { class: `lib-row lib-grid ${this.selected.has(t.id) ? 'selected' : ''} ${i % 2 ? 'odd' : ''}`, draggable: 'true', style: { top: `${i * ROW_H}px` } });
      const loadedIn = t._deck ? el('span', { class: `in-deck d${t._deck}` }, t._deck) : null;
      const bpmClose = mBpm && t.bpm && Math.abs(t.bpm - mBpm) / mBpm < 0.06;
      const keyOk = mKey && t.key && harmonicMatch(mKey, t.key);
      const cells = {
        title: el('div', { class: 'cell title' }, loadedIn, t.title || '—'),
        artist: el('div', { class: 'cell' }, t.artist || ''),
        bpm: el('div', { class: `cell num ${bpmClose ? 'match' : ''}` }, t.bpm ? t.bpm.toFixed(1) : ''),
        key: el('div', { class: `cell ${keyOk ? 'match' : ''}` }, t.key ? `${t.key} · ${camelotOf(t.key)}` : ''),
        duration: el('div', { class: 'cell num' }, t.duration ? formatTime(t.duration, false) : ''),
        genre: el('div', { class: 'cell' }, t.genre || ''),
        album: el('div', { class: 'cell' }, t.album || ''),
        playCount: el('div', { class: 'cell num dim' }, t.playCount || ''),
      };
      for (const c of COLUMNS) row.append(cells[c.id]);
      row.addEventListener('click', (e) => this.onRowClick(e, i));
      row.addEventListener('dblclick', () => this.onLoad(t, null));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.selected.has(t.id)) {
          this.selected = new Set([t.id]);
          this.renderRows();
        }
        this.rowMenu(e, t, i);
      });
      row.addEventListener('dragstart', (e) => {
        if (!this.selected.has(t.id)) this.selected = new Set([t.id]);
        e.dataTransfer.setData('text/x-track-id', t.id);
        e.dataTransfer.setData('text/x-track-ids', [...this.selected].join(','));
        e.dataTransfer.effectAllowed = 'copy';
      });
      frag.append(row);
    }
    this.rowsHost.replaceChildren(frag);
  }

  onRowClick(e, i) {
    const t = this.rows[i];
    if (e.shiftKey && this.lastClicked >= 0) {
      const [a, b] = [Math.min(i, this.lastClicked), Math.max(i, this.lastClicked)];
      for (let k = a; k <= b; k++) this.selected.add(this.rows[k].id);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(t.id)) this.selected.delete(t.id);
      else this.selected.add(t.id);
    } else {
      this.selected = new Set([t.id]);
    }
    this.lastClicked = i;
    this.viewport.focus();
    this.renderRows();
  }

  onKey(e) {
    if (!this.rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const i = Math.max(0, Math.min(this.rows.length - 1, this.lastClicked + (e.key === 'ArrowDown' ? 1 : -1)));
      this.selected = new Set([this.rows[i].id]);
      this.lastClicked = i;
      const top = i * ROW_H;
      if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
      if (top + ROW_H > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = top + ROW_H - this.viewport.clientHeight;
      this.renderRows();
    } else if (e.key === 'Enter' && this.lastClicked >= 0) {
      e.stopPropagation();
      this.onLoad(this.rows[this.lastClicked], null);
    }
  }

  selectedTracks() {
    return this.rows.filter((t) => this.selected.has(t.id));
  }

  rowMenu(e, t, index) {
    const sel = this.selectedTracks();
    const items = [
      { label: 'Carica sul deck A', run: () => this.onLoad(t, 'A') },
      { label: 'Carica sul deck B', run: () => this.onLoad(t, 'B') },
      { label: `Aggiungi ad Automix (${sel.length})`, run: () => this.onQueue(sel) },
      { sep: true },
      ...this.lib.playlists.map((p) => ({ label: `Aggiungi a "${p.name}"`, run: async () => {
        await api.addToPlaylist(p.id, sel.map((x) => x.id));
        this.reload();
        toast(`Aggiunti a ${p.name}`);
      } })),
      { label: 'Nuova playlist con la selezione…', run: async () => {
        const name = await askText('Nome della nuova playlist', 'Nuova playlist');
        if (!name) return;
        const p = await api.createPlaylist(name);
        await api.addToPlaylist(p.id, sel.map((x) => x.id));
        this.reload();
      } },
    ];
    if (this.source.type === 'playlist') {
      const src = this.source;
      items.push({ label: 'Rimuovi dalla playlist', run: async () => {
        const p = this.lib.playlists.find((x) => x.id === src.id);
        const idx = p ? p.tracks.indexOf(t.id) : index;
        await api.removeFromPlaylist(src.id, idx);
        this.reload();
      } });
    }
    items.push({ sep: true });
    if (api.isElectron) items.push({ label: 'Mostra nella cartella', run: () => api.revealFile(t.path) });
    items.push({ label: 'Rianalizza BPM/Key al prossimo caricamento', run: async () => {
      for (const x of sel) {
        x.analyzed = false;
        x.key = '';
        await api.updateTrack(x.id, { analyzed: false, key: '' });
      }
      this.renderRows();
    } });
    items.push({ label: 'Rimuovi dalla libreria', run: async () => {
      for (const x of sel) await api.removeTrack(x.id);
      this.selected.clear();
      this.reload();
    } });
    this.openMenu(e, items);
  }

  openMenu(e, items) {
    this.closeMenu();
    const menu = el('div', { class: 'ctx-menu' });
    for (const it of items) {
      if (it.sep) {
        menu.append(el('div', { class: 'sep' }));
        continue;
      }
      const node = el('div', { class: 'ctx-item' }, it.label);
      node.addEventListener('click', () => {
        this.closeMenu();
        it.run();
      });
      menu.append(node);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 8)}px`;
    this.menu = menu;
  }

  closeMenu() {
    if (this.menu) this.menu.remove();
    this.menu = null;
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }
}
