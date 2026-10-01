"""Confronto di più modelli Segueo Chat sugli stessi insiemi, come evaluate.py (soglie per testa scelte sul dev per
l'insieme interprete + modello), con le interazioni di test divise per origine: quelle dei file agent1..10 (lo stesso
test del modello del 30/09) e quelle nuove (agent11 e successivi).

    ml/.venv/bin/python ml/segueochat/compare.py nome=modello.onnx [nome=modello.onnx ...] [--out risultati.json]"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from data import dataset_with_titles  # noqa: E402
from evaluate import OrtModel, merged, metrics, rules, tune  # noqa: E402
from features import normalize  # noqa: E402
from handwritten import CASES  # noqa: E402
from heads import HEADS  # noqa: E402
from interactions import DIR, TITLES, load as load_interactions, split as split_interactions  # noqa: E402
from train import combine, message_probs  # noqa: E402

OLD_FILES = [f'agent{i}.jsonl' for i in range(1, 11)]


def old_texts():
    out = set()
    for name in OLD_FILES:
        for line in (DIR / name).read_text(encoding='utf-8').splitlines():
            if line.strip():
                out.add(normalize(json.loads(line)['text']))
    return out


def sets():
    inter = split_interactions(load_interactions()[0])
    old = old_texts()
    return {
        'dev': [(t, lab, TITLES) for t, lab in inter['dev']] * 2 + dataset_with_titles(1500, 'test', seed=5),
        'interazioni_vecchie': [(t, lab, TITLES) for t, lab in inter['test'] if normalize(t) in old],
        'interazioni_nuove': [(t, lab, TITLES) for t, lab in inter['test'] if normalize(t) not in old],
        'mano': [(t, {h: lab.get(h, 'none') for h in HEADS}, []) for t, lab in CASES],
        'modelli_mai_visti': dataset_with_titles(6000, 'test', seed=2),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out_path = Path(sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv else None
    if out_path:
        args = [a for a in args if a != str(out_path)]
    models = dict(a.split('=', 1) for a in args)
    data = {}
    for k, v in sets().items():
        data[k] = {'texts': [t for t, _, _ in v], 'y': np.array([[HEADS[h].index(l[h]) for h in HEADS] for _, l, _ in v]),
                   'rules': rules([(t, ti) for t, _, ti in v])}
    print({k: len(v['texts']) for k, v in data.items()})
    res = {}
    for name, path in models.items():
        m = OrtModel(path)
        probs = {k: message_probs(m, d['texts']) for k, d in data.items()}
        th = tune({**data['dev'], 'probs': probs['dev']})
        r = {'file': str(path), 'bytes': Path(path).stat().st_size, 'soglie': th}
        for k, d in data.items():
            pred = np.array([combine(f, c, th) for f, c in probs[k]])
            r[k] = {'modello': metrics(pred, d['y']), 'insieme': metrics(merged(d['rules'], pred), d['y'])}
        r['regole'] = {k: metrics(d['rules'], d['y']) for k, d in data.items()}
        res[name] = r
        print(f"\n{name} ({r['bytes'] / 1e6:.1f} MB)")
        for k in data:
            for kind in ('modello', 'insieme'):
                x = r[k][kind]
                print(f"  {k:<20} {kind:<8} giusti {x['exact']:6.1%}  capite {x['recall']:6.1%}  capite male {x['wrong']:5.1%}  "
                      f"falsi allarmi {x['false_pos']:5.2%}")
        if out_path:
            out_path.write_text(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
