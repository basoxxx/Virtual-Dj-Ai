// Migrazione dal vecchio nome dell'app ("Virtual DJ AI") al nuovo ("Segueo").
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_NAME = 'Virtual DJ AI';
const LEGACY_BUNDLE = `${LEGACY_NAME}.app`;

// File di Chromium che non vanno copiati: cache rigenerabili e lock della vecchia istanza.
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'Crashpad', 'logs',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

/**
 * Copia la cartella dati del vecchio nome in quella nuova (libreria, impostazioni, mappature MIDI, localStorage).
 * Non fa nulla se la nuova cartella contiene già dati dell'app o se la vecchia non esiste.
 * Restituisce true se ha copiato.
 */
function migrateUserData(oldDir, newDir) {
  if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) return false;
  if (['settings.json', 'library.json'].some((f) => fs.existsSync(path.join(newDir, f)))) return false;
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of fs.readdirSync(oldDir)) {
    if (SKIP.has(name)) continue;
    fs.cpSync(path.join(oldDir, name), path.join(newDir, name), { recursive: true, force: false, errorOnExist: false });
  }
  return true;
}

/**
 * macOS: l'aggiornamento dalla vecchia versione sostituisce "Virtual DJ AI.app" mantenendo il vecchio nome.
 * Se l'app in esecuzione si trova lì, restituisce il percorso di destinazione (<cartella>/<nuovo>.app)
 * e il nuovo eseguibile; null se non serve rinominare o non si può.
 */
function macBundleRename(execPath, productName) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (path.basename(bundle) !== LEGACY_BUNDLE) return null;
  const target = path.join(path.dirname(bundle), `${productName}.app`);
  if (fs.existsSync(target)) return null;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return null;
  }
  return { from: bundle, to: target, execPath: path.join(target, path.relative(bundle, execPath)) };
}

module.exports = { LEGACY_NAME, migrateUserData, macBundleRename };
