// Etichette dell'interprete di SegueoChat (src/renderer/js/ai/segueochat.js) per le frasi di test, nella forma
// delle teste del modello: legge [{text, titles}] da stdin e scrive [{testa: etichetta}] su stdout.
import { parseMessage, genreVocabulary } from '../../src/renderer/js/ai/segueochat.js';

const input = JSON.parse(await new Promise((r) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => r(s));
}));
const DEMO = ['golden hour', 'night drive', 'northern lights', 'parallel', 'glass city', 'low tide', 'open water', 'weightless'];

function heads(actions, smallTalk) {
  const h = {};
  const put = (k, v) => {
    if (v && !h[k]) h[k] = v;
  };
  const one = (a) => {
    if (a.type === 'option') {
      if (a.key === 'strategy' || a.key === 'style' || a.key === 'mode') put(a.key, a.value);
      else if (a.key === 'bars') put('bars', a.value <= 8 ? 'short' : a.value >= 64 ? 'verylong' : a.value >= 32 ? 'long' : null);
      else if (a.key === 'remix' || a.key === 'returnTempo') put(a.key, a.value ? 'on' : 'off');
      else if (a.key === 'mashup') put('mashupOpt', a.value ? 'on' : 'off');
    } else if (a.type === 'filters') {
      if (a.clear) put('genre', 'clear');
      else if (a.genres && a.genres.length) put('genre', a.add ? 'add' : 'include');
      else if (a.exclude && a.exclude.length) put('genre', 'exclude');
    } else if (a.type === 'control') put('control', a.op);
    else if (a.type === 'queue') put('queue', a.op);
    else if (a.type === 'buildSet') {
      put('set', 'build');
      if (a.strategy) put('strategy', a.strategy);
      if (a.filters && a.filters.genres && a.filters.genres.length) put('genre', 'include');
    } else if (a.type === 'mashup') put('mashup', a.auto ? 'auto' : 'explicit');
    else if (a.type === 'info') put('info', a.what);
    else if (a.type === 'view') put('view', a.value);
    else if (a.type === 'temporary') {
      put('temporary', 'yes');
      a.actions.forEach(one);
    }
  };
  actions.forEach(one);
  if (smallTalk) put('talk', smallTalk);
  return h;
}

const out = input.map(({ text, titles = [] }) => {
  const tracks = [...new Set([...DEMO, ...titles])].map((t, i) => ({ id: `t${i}`, title: t, artist: '', genre: '', bpm: 124, key: 'Am' }));
  const r = parseMessage(text, { tracks, playlists: [], genres: genreVocabulary(tracks) });
  return heads(r.actions, r.smallTalk);
});
process.stdout.write(JSON.stringify(out));
