"""Le interazioni scritte (messaggi realistici a SegueoChat con le loro richieste, interactions/agent*.jsonl):
controllo, doppioni tolti, frasi del test a mano escluse, divisione fissa addestramento / dev / test (70/10/20)."""
import json
from pathlib import Path

from features import fnv1a, normalize
from handwritten import CASES
from heads import HEADS

DIR = Path(__file__).parent / 'interactions'
# brani e artisti usati da chi ha scritto le interazioni (per dare all'interprete la stessa libreria)
TITLES = ['Golden Hour', 'Night Drive', 'Northern Lights', 'Parallel', 'Glass City', 'Low Tide', 'Open Water', 'Weightless',
          'Sunday Motion', 'Afterglow', 'Electric Dreams', 'Summer Rain', 'Moonlight', 'Paradise City', 'Neon Nights', 'Fuoco',
          'Estate', 'Mare Blu']


def load():
    """Righe valide, senza doppioni e senza le frasi del test scritto a mano: [(testo, etichette complete)]."""
    hand = {normalize(t) for t, _ in CASES}
    seen, out, bad = set(), [], 0
    for f in sorted(DIR.glob('agent*.jsonl')):
        for line in f.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                labels = {h: 'none' for h in HEADS}
                for h, v in row['labels'].items():
                    assert v in HEADS[h] and v != 'none'
                    labels[h] = v
                key = normalize(row['text'])
                assert key and key not in seen and key not in hand
                if labels['talk'] != 'none' and any(labels[h] != 'none' for h in HEADS if h != 'talk'):
                    labels['talk'] = 'none'
                seen.add(key)
                out.append((row['text'], labels))
            except Exception:  # noqa: BLE001
                bad += 1
    return out, bad


def split(rows):
    """Divisione fissa (hash del testo): 70% addestramento, 10% dev (soglie), 20% test."""
    parts = {'train': [], 'dev': [], 'test': []}
    for text, labels in rows:
        r = fnv1a(normalize(text)) % 10
        parts['train' if r < 7 else 'dev' if r == 7 else 'test'].append((text, labels))
    return parts


if __name__ == '__main__':
    rows, bad = load()
    parts = split(rows)
    print(f'{len(rows)} interazioni valide ({bad} scartate):', {k: len(v) for k, v in parts.items()})
    counts = {}
    for _, lab in rows:
        for h, v in lab.items():
            if v != 'none':
                counts[f'{h}:{v}'] = counts.get(f'{h}:{v}', 0) + 1
    print('senza richieste:', sum(1 for _, lab in rows if all(v == 'none' for v in lab.values())))
    print(', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
