import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const migrate = require('../src/main/migrate.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-migrate-'));
}

test('migrateUserData: copia i dati del vecchio nome e salta cache e lock', () => {
  const root = tmpDir();
  const oldDir = path.join(root, migrate.LEGACY_NAME);
  const newDir = path.join(root, 'Segueo');
  fs.mkdirSync(path.join(oldDir, 'Local Storage', 'leveldb'), { recursive: true });
  fs.mkdirSync(path.join(oldDir, 'GPUCache'));
  fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"volume":0.8}');
  fs.writeFileSync(path.join(oldDir, 'library.json'), '{"tracks":[]}');
  fs.writeFileSync(path.join(oldDir, 'Local Storage', 'leveldb', '000003.log'), 'midi');
  fs.writeFileSync(path.join(oldDir, 'SingletonLock'), 'x');
  fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(newDir, 'SingletonLock'), 'nuovo');

  assert.equal(migrate.migrateUserData(oldDir, newDir), true);
  assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"volume":0.8}');
  assert.equal(fs.readFileSync(path.join(newDir, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'midi');
  assert.equal(fs.existsSync(path.join(newDir, 'GPUCache')), false);
  assert.equal(fs.readFileSync(path.join(newDir, 'SingletonLock'), 'utf8'), 'nuovo');
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateUserData: non tocca una cartella nuova già in uso né una vecchia inesistente', () => {
  const root = tmpDir();
  const oldDir = path.join(root, migrate.LEGACY_NAME);
  const newDir = path.join(root, 'Segueo');
  assert.equal(migrate.migrateUserData(oldDir, newDir), false);
  fs.mkdirSync(oldDir);
  fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(oldDir, 'settings.json'), 'vecchio');
  fs.writeFileSync(path.join(newDir, 'settings.json'), 'nuovo');
  assert.equal(migrate.migrateUserData(oldDir, newDir), false);
  assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), 'nuovo');
  fs.rmSync(root, { recursive: true, force: true });
});

test('macBundleRename: rinomina solo il vecchio bundle, se la destinazione è libera', () => {
  const root = tmpDir();
  const exec = (bundle) => path.join(root, bundle, 'Contents', 'MacOS', 'Segueo');
  const move = migrate.macBundleRename(exec('Virtual DJ AI.app'), 'Segueo');
  assert.deepEqual(move, {
    from: path.join(root, 'Virtual DJ AI.app'),
    to: path.join(root, 'Segueo.app'),
    execPath: exec('Segueo.app'),
  });
  assert.equal(migrate.macBundleRename(exec('Segueo.app'), 'Segueo'), null);
  fs.mkdirSync(path.join(root, 'Segueo.app'));
  assert.equal(migrate.macBundleRename(exec('Virtual DJ AI.app'), 'Segueo'), null);
  fs.rmSync(root, { recursive: true, force: true });
});
