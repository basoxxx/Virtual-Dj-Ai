// Pannello laterale: sampler a 8 pad e coda Automix.
import { el, button, knob, toast } from './controls.js';
import { api } from '../api.js';
import { formatTime } from '../dsp/analysis.js';

export class SideUI {
  constructor(root, { sampler, automix, onSamplerChange, getTrack }) {
    this.root = root;
    this.sampler = sampler;
    this.automix = automix;
    this.onSamplerChange = onSamplerChange;
    this.getTrack = getTrack;
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
    addTab('sampler', 'SAMPLER', this.buildSampler());
    addTab('automix', 'AUTOMIX', this.buildAutomix());
    r.append(tabBar, panes);
    this.show('sampler');
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
    this.amToggle = button('AUTOMIX OFF', { className: 'toggle automix-toggle', onClick: () => a.setEnabled(!a.enabled) });
    this.amLen = el('input', { type: 'range', min: '2', max: '30', step: '1', value: String(a.mixLength), class: 'range' });
    const lenLabel = el('span', { class: 'mini-label' }, `Transizione: ${a.mixLength}s`);
    this.amLen.addEventListener('input', () => {
      a.mixLength = Number(this.amLen.value);
      lenLabel.textContent = `Transizione: ${a.mixLength}s`;
    });
    this.amList = el('div', { class: 'am-list' });
    this.amList.addEventListener('dragover', (e) => e.preventDefault());
    this.amList.addEventListener('drop', (e) => {
      e.preventDefault();
      const ids = (e.dataTransfer.getData('text/x-track-ids') || '').split(',').filter(Boolean);
      const tracks = ids.map((id) => this.getTrack(id)).filter(Boolean);
      if (tracks.length) a.enqueue(tracks);
    });
    a.addEventListener('change', () => this.refreshAutomix());
    this.refreshAutomix();
    return el('div', { class: 'tab-pane automix-pane' }, this.amToggle,
      el('div', { class: 'row tight' }, lenLabel, this.amLen),
      el('div', { class: 'row tight' },
        button('Mescola', { className: 'small', onClick: () => a.shuffle() }),
        button('Svuota', { className: 'small', onClick: () => a.clear() })),
      this.amList,
      el('div', { class: 'hint' }, 'Trascina qui i brani o usa il menu contestuale della libreria.'));
  }

  refreshAutomix() {
    const a = this.automix;
    this.amToggle.textContent = a.enabled ? 'AUTOMIX ON' : 'AUTOMIX OFF';
    this.amToggle.setOn(a.enabled);
    this.amList.innerHTML = '';
    if (!a.queue.length) this.amList.append(el('div', { class: 'am-empty' }, 'Coda vuota'));
    a.queue.forEach((t, i) => {
      const row = el('div', { class: 'am-row', draggable: 'true' },
        el('span', { class: 'am-idx' }, i + 1),
        el('span', { class: 'am-title' }, `${t.artist ? `${t.artist} - ` : ''}${t.title}`),
        el('span', { class: 'am-dur' }, t.bpm ? t.bpm.toFixed(0) : formatTime(t.duration, false)),
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
