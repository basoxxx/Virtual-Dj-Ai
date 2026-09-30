// Persistenza JSON semplice e atomica nella cartella dati dell'utente.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  /** delay: attesa (ms) prima di scrivere; più lunga per file grandi aggiornati spesso (libreria). */
  constructor(file, defaults, { delay = 400 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    this.data = structuredClone(defaults);
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } catch {
      this.data = structuredClone(this.defaults);
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
