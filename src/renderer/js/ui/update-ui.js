// Aggiornamenti: etichetta nella barra in alto, finestra con novità, download e installazione.
import { el, button, toast } from './controls.js';
import { icon } from './icons.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

export class UpdateUI {
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.info = null;
    this.state = 'idle'; // idle | checking | available | downloading | ready | error
    this.supported = typeof this.api.updateCheck === 'function';
    this.badge = button('', { className: 'update-badge', title: 'Aggiornamento disponibile', onClick: () => this.openDialog() });
    this.badge.hidden = true;
    if (this.supported) {
      this.api.on('update:progress', (p) => this.onProgress(p));
    }
  }

  get auto() {
    const u = this.app.settings.updates || {};
    return u.auto !== false;
  }

  setAuto(on) {
    this.app.settings.updates = { ...(this.app.settings.updates || {}), auto: on };
    this.app.saveSettings();
    this.schedule();
  }

  /** Controllo automatico: poco dopo l'avvio e poi ogni 6 ore. */
  schedule() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    if (!this.supported || !this.auto) return;
    this.firstTimer = setTimeout(() => this.check(false), 8000);
    this.timer = setInterval(() => this.check(false), SIX_HOURS);
  }

  async check(manual) {
    if (!this.supported || this.state === 'downloading') return this.info;
    this.state = 'checking';
    this.emit();
    try {
      this.info = await this.api.updateCheck();
      this.state = this.info.available ? 'available' : 'idle';
      if (this.info.available) {
        this.badge.hidden = false;
        this.badge.replaceChildren(icon('refresh', 13), el('span', {}, `Aggiorna a ${this.info.latest}`));
        if (!manual && !this.notified) {
          this.notified = true;
          toast(`È disponibile Segueo ${this.info.latest}`, 'ok', 5000);
        }
      } else if (manual) {
        toast(`Hai già l'ultima versione (${this.info.current})`, 'ok');
      }
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      if (manual) toast(`Controllo aggiornamenti non riuscito: ${err.message}`, 'error');
    }
    this.emit();
    return this.info;
  }

  emit() {
    if (this.onChange) this.onChange();
    if (this.dialog) this.renderDialog();
  }

  onProgress({ done, total }) {
    this.progress = { done, total };
    if (this.dialog) this.renderDialog();
  }

  openDialog() {
    if (!this.info || !this.info.available) return;
    this.closeDialog();
    this.dialog = el('div', { class: 'modal-overlay update-overlay' });
    this.dialog.addEventListener('pointerdown', (e) => {
      if (e.target === this.dialog && this.state !== 'downloading') this.closeDialog();
    });
    document.body.append(this.dialog);
    this.renderDialog();
  }

  closeDialog() {
    if (this.dialog) this.dialog.remove();
    this.dialog = null;
  }

  busyDecks() {
    return this.app.decks.some((d) => d.playing) || this.app.engine.recording;
  }

  async startDownload() {
    this.state = 'downloading';
    this.progress = { done: 0, total: this.info.asset.size };
    this.renderDialog();
    try {
      const res = await this.api.updateDownload();
      this.verified = res.verified;
      this.state = 'ready';
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
    }
    this.renderDialog();
  }

  async installNow() {
    try {
      const result = await this.api.updateInstall();
      if (result === 'manual') {
        toast(navigator.platform.startsWith('Mac')
          ? 'Si è aperto l\'installer: trascina Segueo nella cartella Applicazioni'
          : 'Si è aperto l\'installer: completa l\'installazione per aggiornare', 'ok', 8000);
        this.closeDialog();
      } else {
        toast('Installazione in corso: l\'app si riaprirà da sola', 'ok', 8000);
      }
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.renderDialog();
    }
  }

  renderDialog() {
    if (!this.dialog || !this.info) return;
    const i = this.info;
    const actions = el('div', { class: 'row end' });
    const body = [];
    body.push(el('div', { class: 'update-head' },
      this.iconImg || (this.iconImg = el('img', { class: 'update-icon', src: 'img/icon.png', alt: '' })),
      el('div', {},
        el('div', { class: 'modal-title' }, `Segueo ${i.latest}`),
        el('div', { class: 'field-hint' }, `Hai la versione ${i.current} · ${mb(i.asset.size)}`))));
    if (i.notes && i.notes.length) {
      body.push(el('div', { class: 'section-label' }, 'NOVITÀ'), el('ul', { class: 'update-notes' }, i.notes.map((n) => el('li', {}, n))));
    }
    if (this.state === 'downloading' || this.state === 'ready') {
      const p = this.progress || { done: 0, total: i.asset.size };
      const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
      body.push(el('div', { class: 'update-progress' }, el('div', { class: 'update-bar', style: { width: `${this.state === 'ready' ? 100 : pct}%` } })),
        el('div', { class: 'field-hint' }, this.state === 'ready'
          ? `Scaricato${this.verified ? ' e verificato (SHA-256)' : ''}. ${this.busyDecks() ? 'Attenzione: la musica in riproduzione si fermerà.' : 'Pronto per l\'installazione.'}`
          : `Download ${pct}% · ${mb(p.done)} di ${mb(p.total)}`));
    }
    if (this.state === 'error') body.push(el('div', { class: 'ai-test error' }, this.error));

    if (this.state === 'available' || this.state === 'error') {
      actions.append(button('Più tardi', { onClick: () => this.closeDialog() }),
        button('Scarica e installa', { className: 'primary', onClick: () => this.startDownload() }));
    } else if (this.state === 'downloading') {
      actions.append(button('Download in corso…', { className: 'primary' }));
      actions.lastChild.disabled = true;
    } else if (this.state === 'ready') {
      actions.append(button('Più tardi', { onClick: () => this.closeDialog() }),
        button('Riavvia e aggiorna', { className: 'primary', onClick: () => this.installNow() }));
    }
    const modal = el('div', { class: 'modal small update-modal' }, body, actions);
    this.dialog.replaceChildren(modal);
  }
}
