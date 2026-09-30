"""Controllo di un file di interazioni: una riga JSON per messaggio, {"text": ..., "labels": {testa: etichetta}}.
    python3 ml/segueochat/interactions/check.py FILE.jsonl"""
import json
import sys

HEADS = {
    'strategy': ['steady', 'rise', 'wave', 'chill', 'peak'],
    'style': ['auto', 'bassswap', 'filter', 'echo', 'fade', 'cut', 'rapid', 'model', 'model-techno'],
    'bars': ['short', 'long', 'verylong'], 'remix': ['on', 'off'], 'mashupOpt': ['on', 'off'], 'returnTempo': ['on', 'off'],
    'mode': ['ai', 'queue'], 'control': ['start', 'stop', 'mixNow', 'skip', 'endAfterCurrent', 'resume'],
    'queue': ['add', 'playNext', 'remove', 'clear', 'shuffle'], 'genre': ['include', 'exclude', 'add', 'clear'],
    'set': ['build'], 'mashup': ['auto', 'explicit'], 'info': ['now', 'next', 'why', 'queue', 'settings', 'help'],
    'temporary': ['yes'], 'view': ['ai', 'console'], 'talk': ['hello', 'thanks', 'offtopic'],
}
ok, errors, seen = 0, [], set()
for n, line in enumerate(open(sys.argv[1], encoding='utf-8'), 1):
    if not line.strip():
        continue
    try:
        row = json.loads(line)
        text, labels = row['text'], row['labels']
        assert isinstance(text, str) and text.strip(), 'testo vuoto'
        for h, v in labels.items():
            assert h in HEADS, f'testa sconosciuta {h}'
            assert v in HEADS[h], f'etichetta {v} non valida per {h}'
        assert not ('talk' in labels and len(labels) > 1), 'talk solo senza altre richieste'
        key = ' '.join(text.lower().split())
        assert key not in seen, 'doppione'
        seen.add(key)
        ok += 1
    except Exception as e:  # noqa: BLE001
        errors.append(f'riga {n}: {e}')
print(f'{ok} righe valide, {len(errors)} errori')
for e in errors[:30]:
    print(e)
