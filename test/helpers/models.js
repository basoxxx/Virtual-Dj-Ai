// Modelli ONNX scaricati da npm run models (src/renderer/models, fuori da git). In locale, senza il modello, i test
// che lo usano si saltano; in CI il modello deve esserci: lì non si saltano e falliscono se manca.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MODELS_DIR = fileURLToPath(new URL('../../src/renderer/models/', import.meta.url));

export function modelPath(file) {
  return MODELS_DIR + file;
}

/** Valore per l'opzione skip di test(): il motivo se si salta, false se il test deve girare. */
export function skipWithoutModel(file) {
  return !process.env.CI && !existsSync(modelPath(file)) && `modello ${file} non scaricato (npm run models)`;
}
