import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const aiAssets = require('../src/main/ai-assets.js');
const manifest = require('../src/main/models.json');

test('modelStatus: Demucs incluso nell\'installer risulta installato senza scaricarlo', () => {
  const demucs = manifest.models.find((m) => m.file === 'htdemucs.onnx');
  assert.equal(demucs.bundle, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-models-'));
  const userData = path.join(root, 'userData');
  const bundledDir = path.join(root, 'bundled');
  assert.equal(aiAssets.modelStatus(userData, 'htdemucs.onnx', bundledDir).installed, false);
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(bundledDir, 'htdemucs.onnx'), Buffer.alloc(demucs.bytes));
  assert.equal(aiAssets.modelStatus(userData, 'htdemucs.onnx', bundledDir).installed, true);
  assert.equal(aiAssets.modelStatus(userData, 'htdemucs.onnx').installed, false);
  fs.rmSync(root, { recursive: true, force: true });
});
