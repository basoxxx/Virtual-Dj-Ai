// Caricamento di onnxruntime-web (solo CPU/WASM) nei worker, dai file copiati in src/renderer/vendor/
// dal postinstall, e percorso dei modelli scaricati da npm run models.
const VENDOR = new URL('../../vendor/onnxruntime-web/', import.meta.url);
export const MODELS_URL = new URL('../../models/', import.meta.url);

let ortPromise = null;

export function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(new URL('ort.wasm.bundle.min.mjs', VENDOR).href);
      // solo il .wasm: il codice di collegamento è già dentro il bundle
      ort.env.wasm.wasmPaths = { wasm: new URL('ort-wasm-simd-threaded.wasm', VENDOR).href };
      // i thread WASM richiedono l'isolamento cross-origin (SharedArrayBuffer)
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
      return ort;
    })();
    ortPromise.catch(() => {
      ortPromise = null;
    });
  }
  return ortPromise;
}

/** Byte di un modello ONNX installato, o errore se manca. */
export async function fetchModel(name) {
  const res = await fetch(new URL(name, MODELS_URL));
  if (!res.ok) throw new Error(`modello ${name} non installato`);
  return new Uint8Array(await res.arrayBuffer());
}
