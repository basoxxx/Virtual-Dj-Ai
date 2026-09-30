"""Valutazione di Segueo Chat: interprete dei comandi (regole), modello, e i due insieme come nell'app
(l'interprete decide, il modello completa le richieste che l'interprete non ha capito).

    ml/.venv/bin/python ml/segueochat/evaluate.py [modello.onnx]

Soglie del modello scelte sulle frasi "dev" (modelli di frase mai visti, non il test) per l'insieme."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, str(Path(__file__).parent))
from data import dataset_with_titles  # noqa: E402
from interactions import load as load_interactions, split as split_interactions, TITLES  # noqa: E402
from handwritten import CASES  # noqa: E402
from heads import HEADS  # noqa: E402
from train import combine, message_probs, OUT, MODELS, MODEL_FILE  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NAMES = list(HEADS)


class OrtModel:
    def __init__(self, path):
        self.s = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])

    def __call__(self, x):
        rows = [self.s.run(None, {'ids': (r[r > 0][None, :] if (r > 0).any() else np.zeros((1, 1), np.int64))})[0][0] for r in x.numpy()]
        return torch.from_numpy(np.stack(rows))


def rules(cases):
    res = subprocess.run(['node', str(Path(__file__).parent / 'eval_rules.mjs')], input=json.dumps([{'text': t, 'titles': ti} for t, ti in cases]),
                         capture_output=True, text=True, cwd=ROOT, check=True)
    return np.array([[HEADS[h].index(r.get(h, 'none')) for h in HEADS] for r in json.loads(res.stdout)])


def metrics(pred, y):
    hit = pred[y > 0] == y[y > 0]
    return {
        'exact': float((pred == y).all(1).mean()),
        'recall': float(hit.mean()) if hit.size else 1.0,
        'false_pos': float(((pred > 0) & (y == 0)).sum() / max(1, (y == 0).sum())),
        'wrong': float(((pred > 0) & (y > 0) & (pred != y)).sum() / max(1, (y > 0).sum())),
    }


def merged(rule_pred, model_pred):
    """L'interprete ha la precedenza; il modello riempie solo le teste rimaste vuote (i saluti solo senza richieste)."""
    out = np.where(rule_pred > 0, rule_pred, model_pred)
    talk = NAMES.index('talk')
    others = np.delete(out, talk, axis=1).any(1)
    out[others, talk] = np.where(rule_pred[others, talk] > 0, rule_pred[others, talk], 0)
    return out


GRID_C = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.01)
GRID_F = (0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1.01)
FP_COST = 3  # un'azione sbagliata dà più fastidio di un "non ho capito"


def tune(d):
    """Soglie per ogni testa, scelte sul dev per l'insieme (interprete + modello): per ogni testa la coppia di soglie
    con più richieste capite e meno falsi allarmi (un falso allarme pesa come tre richieste perse). 1.01 = testa spenta."""
    th = {'clause': {h: 0.95 for h in HEADS}, 'full': {h: 0.99 for h in HEADS}}
    y = d['y']
    for _ in range(2):
        for i, h in enumerate(HEADS):
            best = None
            for tc in GRID_C:
                for tf in GRID_F:
                    th['clause'][h], th['full'][h] = tc, tf
                    pred = merged(d['rules'], np.array([combine(f, c, th) for f, c in d['probs']]))[:, i]
                    good = int(((pred == y[:, i]) & (y[:, i] > 0)).sum())
                    bad = int(((pred > 0) & (pred != y[:, i])).sum())
                    score = good - FP_COST * bad
                    if best is None or score > best[0]:
                        best = (score, tc, tf)
            th['clause'][h], th['full'][h] = best[1], best[2]
    return th


def evaluate(model, verbose=True):
    inter = split_interactions(load_interactions()[0])
    sets = {
        # soglie scelte su interazioni dev e modelli di frase mai visti, mai sui test
        'dev': [(t, lab, TITLES) for t, lab in inter['dev']] * 2 + dataset_with_titles(1500, 'test', seed=5),
        'interazioni': [(t, lab, TITLES) for t, lab in inter['test']],
        'mano': [(t, {h: lab.get(h, 'none') for h in HEADS}, []) for t, lab in CASES],
        'test': dataset_with_titles(6000, 'test', seed=2),
    }
    data = {}
    for k, v in sets.items():
        texts = [t for t, _, _ in v]
        data[k] = {
            'texts': texts,
            'y': np.array([[HEADS[h].index(l[h]) for h in HEADS] for _, l, _ in v]),
            'rules': rules([(t, ti) for t, _, ti in v]),
            'probs': message_probs(model, texts),
        }
    th = tune(data['dev'])
    out = {'soglie': th}
    d = data['dev']
    out['dev'] = {'insieme': metrics(merged(d['rules'], np.array([combine(f, c, th) for f, c in d['probs']])), d['y'])}
    if verbose:
        print(f"dev (per scegliere il modello): insieme {out['dev']['insieme']['exact']:.1%} messaggi giusti")
    names = {'interazioni': 'test: interazioni mai viste', 'mano': 'test: frasi scritte a mano', 'test': 'test: modelli di frase mai visti'}
    for k in ('interazioni', 'mano', 'test'):
        x = data[k]
        model_pred = np.array([combine(f, c, th) for f, c in x['probs']])
        out[k] = {'regole': metrics(x['rules'], x['y']), 'modello': metrics(model_pred, x['y']),
                  'insieme': metrics(merged(x['rules'], model_pred), x['y'])}
        if verbose:
            print(f"\n{names[k]} ({len(x['texts'])} messaggi)")
            print(f"{'':<10}{'messaggi giusti':>17}{'richieste capite':>18}{'capite male':>13}{'falsi allarmi':>15}")
            for name, m in out[k].items():
                print(f"{name:<10}{m['exact']:>17.1%}{m['recall']:>18.1%}{m['wrong']:>13.1%}{m['false_pos']:>15.2%}")
    if verbose:
        print('\nsoglie per testa (scelte sul dev, parti/intero):', ', '.join(f"{h} {th['clause'][h]}/{th['full'][h]}" for h in HEADS))
    return out, data


if __name__ == '__main__':
    from heads import write_js
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else MODELS / MODEL_FILE
    model = OrtModel(path)
    res, data = evaluate(model)
    (OUT / 'evaluation.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    # soglie per testa nell'app, e decisioni del modello (senza interprete) per il test di parità in JavaScript
    write_js(ROOT / 'src' / 'renderer' / 'js' / 'ai' / 'chat-heads.js', res['soglie'])
    th = res['soglie']
    dec = [{'text': t, 'labels': {h: HEADS[h][l] for h, l in zip(HEADS, combine(f, c, th)) if l}}
           for t, (f, c) in zip(data['mano']['texts'], data['mano']['probs'])]
    (ROOT / 'test' / 'fixtures' / 'segueo-chat' / 'decisions.json').write_text(json.dumps(dec, ensure_ascii=False))
    # caratteristiche e punteggi di questo modello per il test di parità in JavaScript
    from features import featurize, normalize
    cases = []
    for text, _ in CASES[:24] + [('Più ENERGÌA!!! 124 bpm, l\'ultima', {}), ('', {})]:
        ids = featurize(text)
        logits = model.s.run(None, {'ids': np.array([ids], dtype=np.int64)})[0][0]
        cases.append({'text': text, 'normalized': normalize(text), 'ids': ids, 'logits': [round(float(v), 5) for v in logits]})
    (ROOT / 'test' / 'fixtures' / 'segueo-chat' / 'cases.json').write_text(json.dumps(cases, ensure_ascii=False))
    print('soglie scritte in src/renderer/js/ai/chat-heads.js, decisioni in test/fixtures/segueo-chat/decisions.json')
