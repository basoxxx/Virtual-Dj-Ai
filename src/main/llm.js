// Connessione a un modello linguistico LOCALE (Ollama, LM Studio, llama.cpp, Jan, LocalAI…).
// Le richieste partono dal processo principale per evitare restrizioni CORS/CSP del renderer.

function base(endpoint) {
  const url = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Indirizzo non valido: deve iniziare con http:// o https://');
  return url;
}

function openaiBase(endpoint) {
  const b = base(endpoint);
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

async function request(url, options, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && err.name === 'TimeoutError') throw new Error('Il modello non ha risposto in tempo');
    throw new Error(`Impossibile contattare ${url}: il server AI locale è avviato?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Errore ${res.status} dal server AI: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function listModels({ provider, endpoint, apiKey }) {
  if (provider === 'ollama') {
    const data = await request(`${base(endpoint)}/api/tags`, {}, 8000);
    return (data.models || []).map((m) => m.name);
  }
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const data = await request(`${openaiBase(endpoint)}/models`, { headers }, 8000);
  return (data.data || []).map((m) => m.id);
}

async function chat({ provider, endpoint, model, apiKey, messages, temperature = 0.4, json = true }) {
  if (!model) throw new Error('Nessun modello selezionato');
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'ollama') {
    const body = { model, messages, stream: false, options: { temperature } };
    if (json) body.format = 'json';
    const data = await request(`${base(endpoint)}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) }, 120000);
    return (data.message && data.message.content) || '';
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = { model, messages, temperature, stream: false };
  const data = await request(`${openaiBase(endpoint)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, 120000);
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

module.exports = { listModels, chat };
