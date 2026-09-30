"""Etichette del modello Segueo Chat: una "testa" per ogni tipo di richiesta, ognuna con 'none' se il messaggio
non la contiene. Da qui si genera src/renderer/js/ai/chat-heads.js (stesso ordine delle uscite del modello ONNX)."""
import json
from pathlib import Path

HEADS = {
    'strategy': ['none', 'steady', 'rise', 'wave', 'chill', 'peak'],
    'style': ['none', 'auto', 'bassswap', 'filter', 'echo', 'fade', 'cut', 'rapid', 'model', 'model-techno'],
    'bars': ['none', 'short', 'long', 'verylong'],
    'remix': ['none', 'on', 'off'],
    'mashupOpt': ['none', 'on', 'off'],
    'returnTempo': ['none', 'on', 'off'],
    'mode': ['none', 'ai', 'queue'],
    'control': ['none', 'start', 'stop', 'mixNow', 'skip', 'endAfterCurrent', 'resume'],
    'queue': ['none', 'add', 'playNext', 'remove', 'clear', 'shuffle'],
    'genre': ['none', 'include', 'exclude', 'add', 'clear'],
    'set': ['none', 'build'],
    'mashup': ['none', 'auto', 'explicit'],
    'info': ['none', 'now', 'next', 'why', 'queue', 'settings', 'help'],
    'temporary': ['none', 'yes'],
    'view': ['none', 'ai', 'console'],
    'talk': ['none', 'hello', 'thanks', 'offtopic'],
}

# caratteristiche: parole, coppie di parole e pezzi di 3-5 lettere, con hash in NB contenitori (0 = vuoto)
NB = 1 << 15
MAX_FEATURES = 512


def offsets():
    out, o = {}, 0
    for k, labels in HEADS.items():
        out[k] = (o, o + len(labels))
        o += len(labels)
    return out, o


def write_js(path, thresholds):
    body = json.dumps(HEADS, ensure_ascii=False, indent=2)
    Path(path).write_text(
        "// Generato da ml/segueochat/heads.py e train.py: etichette del modello Segueo Chat (nell'ordine delle sue\n"
        "// uscite) e soglie di confidenza per le parti del messaggio e per il messaggio intero.\n"
        f"export const CHAT_HEADS = {body};\n\n"
        f"export const CHAT_BUCKETS = {NB};\n"
        f"export const CHAT_MAX_FEATURES = {MAX_FEATURES};\n"
        f"export const CHAT_THRESHOLDS = {json.dumps(thresholds)};\n",
        encoding='utf-8')
