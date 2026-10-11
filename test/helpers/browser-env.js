// Da importare prima dei moduli del renderer che usano api.js: window.api c'è (vuoto, lo riempiono i test) e
// api.js non ripiega sull'implementazione per il browser.
globalThis.window = globalThis.window || {};
globalThis.window.api = globalThis.window.api || {};
