// Scheda CHAT: SegueoChat, per dire a parole all'AI DJ come suonare e chiedergli cosa sta facendo.
import { el, button } from './controls.js';
import { icon, withIcon } from './icons.js';

const SUGGESTIONS = [
  'Più energia', 'Transizioni lunghe', 'Solo techno', 'Tagli a raffica per 3 brani', 'Cosa suoni?',
  'Crea una scaletta di 15 brani in crescendo', 'Fai un mashup', 'Chiudi il set dopo questo', 'Aiuto',
];

export class ChatUI {
  constructor({ app, chat }) {
    this.app = app;
    this.chat = chat;
    this.root = this.build();
    chat.addEventListener('change', () => this.render());
    // il motore dipende dalle impostazioni dell'AI locale: si ricontrolla quando si torna sulla scheda
    this.root.addEventListener('pointerenter', () => this.renderEngine());
    this.render();
  }

  build() {
    this.engineBadge = el('span', { class: 'chat-engine' });
    const clear = button(icon('close', 13), { className: 'tiny ghost', title: 'Cancella la conversazione', onClick: () => this.chat.clear() });
    this.list = el('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
    this.chips = el('div', { class: 'chat-chips' }, SUGGESTIONS.map((s) => button(s, { className: 'chat-chip', onClick: () => this.send(s) })));
    this.input = el('textarea', { class: 'chat-input', rows: '1', placeholder: 'Es. "più energia, solo techno"', 'aria-label': 'Messaggio per SegueoChat' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // niente scorciatoie della console mentre si scrive
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send(this.input.value);
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.sendBtn = button(icon('send', 15), { className: 'chat-send primary', title: 'Invia (Invio)', onClick: () => this.send(this.input.value) });
    return el('div', { class: 'tab-pane chat-pane' },
      el('div', { class: 'chat-head' }, el('span', { class: 'chat-title' }, withIcon('chat', 'SegueoChat', 15)), this.engineBadge, el('span', { class: 'spacer' }), clear),
      this.list,
      this.chips,
      el('div', { class: 'chat-form' }, this.input, this.sendBtn));
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(96, this.input.scrollHeight)}px`;
  }

  focus() {
    this.input.focus();
  }

  async send(text) {
    const msg = String(text || '').trim();
    if (!msg || this.chat.busy) return;
    this.input.value = '';
    this.autosize();
    await this.chat.send(msg);
    this.input.focus();
  }

  renderEngine() {
    const e = this.chat.engine;
    this.engineBadge.textContent = e.label;
    this.engineBadge.classList.toggle('on', e.id !== 'rules');
    this.engineBadge.title = e.id === 'model'
      ? 'Capisco i comandi e tanti modi di dire in italiano con il modello Segueo Chat, incluso nell\'app: gira sul computer, senza internet'
      : 'Capisco i comandi più comuni in italiano (il modello Segueo Chat non è installato)';
  }

  render() {
    this.renderEngine();
    const msgs = this.chat.messages;
    const nodes = msgs.length ? msgs.map((m) => this.message(m)) : [this.welcome()];
    if (this.chat.busy) nodes.push(el('div', { class: 'chat-msg assistant thinking' }, el('div', { class: 'chat-bubble' }, 'Ci penso…')));
    this.list.replaceChildren(...nodes);
    this.list.scrollTop = this.list.scrollHeight;
    this.input.disabled = this.chat.busy;
    this.sendBtn.disabled = this.chat.busy;
    this.chips.hidden = msgs.length > 2;
  }

  welcome() {
    return el('div', { class: 'chat-msg assistant' }, el('div', { class: 'chat-bubble' },
      'Ciao, sono SegueoChat. Dimmi come vuoi che suoni: energia, transizioni, generi, BPM, brani da mettere, scalette e mashup. '
      + 'Posso anche dirti cosa sto suonando e perché. Ogni modifica si può annullare.'));
  }

  message(m) {
    const bubble = el('div', { class: 'chat-bubble' }, m.text);
    const node = el('div', { class: `chat-msg ${m.role}${m.undone ? ' undone' : ''}` }, bubble);
    if (m.role !== 'assistant') return node;
    if (m.lines && m.lines.length) node.append(el('ul', { class: 'chat-lines' }, m.lines.map((l) => el('li', {}, l))));
    if (m.errors && m.errors.length) node.classList.add('has-errors');
    const foot = el('div', { class: 'chat-foot' });
    if (m.engine === 'model') foot.append(el('span', { class: 'chat-meta', title: 'Capito dal modello Segueo Chat, incluso nell\'app' }, 'modello Segueo Chat'));
    if (m.undo) foot.append(button(withIcon('undo', 'Annulla', 12), { className: 'tiny ghost chat-undo', title: 'Torna a com\'era prima di questa risposta', onClick: () => this.chat.undo(m.id) }));
    if (m.undone) foot.append(el('span', { class: 'chat-meta' }, 'annullato'));
    if (foot.childNodes.length) node.append(foot);
    return node;
  }
}
