// Griglia a tempo costante dell'app (beatGrid di src/renderer/js/dsp/beat-this.js) per molti brani.
// Ingresso su stdin: { id: { beats: [...], downbeats: [...] } }; uscita su stdout: { id: griglia }.
import { beatGrid } from '../../src/renderer/js/dsp/beat-this.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const items = JSON.parse(raw);
const out = {};
for (const [id, { beats, downbeats }] of Object.entries(items)) out[id] = beatGrid(beats, downbeats);
process.stdout.write(JSON.stringify(out));
