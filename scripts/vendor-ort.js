// postinstall: copia in src/renderer/vendor/ i file di onnxruntime-web che servono al worker
// di analisi (solo CPU/WASM). La cartella è esclusa da git e viene inclusa nell'app da electron-builder.
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.wasm'];
const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor', 'onnxruntime-web');

function main() {
  // percorso diretto: il campo "exports" del pacchetto non espone package.json
  const dist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
  if (!fs.existsSync(dist)) {
    // npm install non deve fallire per questo, ma l'avviso si deve vedere (e npm run dist si rifiuta di continuare)
    process.stderr.write(`\nATTENZIONE: onnxruntime-web non è installato (${dist}).\n`
      + 'L\'analisi AI (battute con Beat This!, AI DJ, mashup) non sarà disponibile: resta quella classica.\n'
      + 'Per averla: npm install onnxruntime-web. Senza, npm run dist non crea il pacchetto (scripts/check-dist.js).\n\n');
    process.exit(0);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(dist, f), path.join(out, f));
  // il pacchetto npm non contiene il file di licenza: testo MIT del repository microsoft/onnxruntime
  fs.writeFileSync(path.join(out, 'LICENSE'), `onnxruntime-web ${require(path.join(dist, '..', 'package.json')).version}
https://github.com/microsoft/onnxruntime

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
  console.log(`onnxruntime-web copiato in ${path.relative(root, out)}`);
}

if (require.main === module) main();

module.exports = { FILES };
