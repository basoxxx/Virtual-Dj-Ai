"""Addestramento del modello Segueo Chat (capisce che cosa chiede un messaggio a SegueoChat).

    ml/.venv/bin/python ml/segueochat/train.py

Frasi generate dai modelli di frase (data.py), test su modelli di frase mai visti e su frasi scritte a mano
(handwritten.py). Esporta segueo-chat.onnx (ingresso: indici delle caratteristiche, uscita: punteggi di tutte le
teste in fila), le etichette per l'app (src/renderer/js/ai/chat-heads.js) e gli esempi per i test in JavaScript."""
import json
import os
import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).parent))
from data import dataset, split_clauses, noisy  # noqa: E402
from interactions import load as load_interactions, split as split_interactions  # noqa: E402
from features import featurize, normalize  # noqa: E402
from handwritten import CASES  # noqa: E402
from heads import HEADS, NB, offsets, write_js  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'ml' / 'data' / 'segueochat'
MODELS = ROOT / 'src' / 'renderer' / 'models'
FIXTURES = ROOT / 'test' / 'fixtures' / 'segueo-chat'
MODEL_FILE = 'segueo-chat.onnx'

D, H = 64, 192
N_TRAIN, N_TEST, N_DEV, EPOCHS, BATCH = 200_000, 10_000, 4_000, 6, 512
# ogni interazione di addestramento entra più volte, con riempitivi e refusi diversi: pesa più delle frasi generate
INTERACTION_COPIES = 16
FEATURE_DROPOUT = 0.25
OFFS, TOTAL = offsets()


class ChatModel(nn.Module):
    """Media delle caratteristiche (0 = vuoto, non conta), poi una rete piccola con tutte le teste in fila."""

    def __init__(self):
        super().__init__()
        self.emb = nn.Embedding(NB + 1, D, padding_idx=0)
        self.mlp = nn.Sequential(nn.Linear(D, H), nn.ReLU(), nn.Dropout(0.1), nn.Linear(H, TOTAL))

    def forward(self, ids):
        mask = (ids > 0).unsqueeze(-1).float()
        e = self.emb(ids) * mask
        mean = e.sum(1) / mask.sum(1).clamp(min=1.0)
        return self.mlp(mean)


def encode(samples):
    ids = [featurize(t) for t, _ in samples]
    width = max(map(len, ids))
    x = np.zeros((len(ids), width), dtype=np.int64)
    for i, row in enumerate(ids):
        x[i, :len(row)] = row
    y = np.array([[HEADS[h].index(lab[h]) for h in HEADS] for _, lab in samples], dtype=np.int64)
    return torch.from_numpy(x), torch.from_numpy(y)


def loss_fn(logits, y):
    return sum(nn.functional.cross_entropy(logits[:, a:b], y[:, i]) for i, (a, b) in enumerate(OFFS.values()))


def predict(logits):
    return np.stack([logits[:, a:b].argmax(1) for a, b in OFFS.values()], 1)


def softmax_heads(logits):
    out = []
    for a, b in OFFS.values():
        z = logits[:, a:b] - logits[:, a:b].max(1, keepdims=True)
        e = np.exp(z)
        out.append(e / e.sum(1, keepdims=True))
    return out


def threshold(th, kind, head):
    v = th[kind]
    return v[head] if isinstance(v, dict) else v


def combine(full, clauses, th):
    """Decisione per un messaggio (identica a chat-features.js): per ogni testa l'etichetta più sicura tra le parti
    se supera la soglia delle parti, altrimenti quella del messaggio intero se supera la sua soglia; i saluti e il
    fuori tema valgono solo se non c'è nessuna richiesta. Le soglie possono essere diverse per ogni testa."""
    labels = []
    for i, h in enumerate(HEADS):
        best, p = 0, 0.0
        for c in clauses:
            j = int(c[i].argmax())
            if j and c[i][j] > p:
                best, p = j, float(c[i][j])
        if not (best and p >= threshold(th, 'clause', h)):
            j = int(full[i].argmax())
            best = j if j and full[i][j] >= threshold(th, 'full', h) else 0
        labels.append(best)
    talk = list(HEADS).index('talk')
    if any(l for i, l in enumerate(labels) if i != talk):
        labels[talk] = 0
    return labels


def message_probs(model, texts):
    """Probabilità del messaggio intero e di ogni sua parte (un solo passaggio del modello per tutte)."""
    rows, owners = [], []
    for k, t in enumerate(texts):
        parts = split_clauses(t)
        for u in [t] + (parts if len(parts) > 1 else []):
            rows.append((u, {h: 'none' for h in HEADS}))
            owners.append(k)
    x, _ = encode(rows)
    with torch.no_grad():
        probs = softmax_heads(model(x).numpy())
    per = [[] for _ in texts]
    for r, k in enumerate(owners):
        per[k].append([p[r] for p in probs])
    return [(v[0], v[1:]) for v in per]


def predict_messages(model, texts, th):
    return np.array([combine(full, clauses, th) for full, clauses in message_probs(model, texts)])


def tune_thresholds(model, samples):
    """Soglie che danno più messaggi giusti con al massimo l'1% di falsi allarmi (su frasi mai viste, non sul test)."""
    texts = [t for t, _ in samples]
    y = np.array([[HEADS[h].index(lab[h]) for h in HEADS] for _, lab in samples])
    cache = message_probs(model, texts)
    best = None
    for tc in (0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        for tf in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99):
            th = {'clause': tc, 'full': tf}
            pred = np.array([combine(f, c, th) for f, c in cache])
            exact = float((pred == y).all(1).mean())
            fp = float(((pred > 0) & (y == 0)).sum() / max(1, (y == 0).sum()))
            if fp <= 0.01 and (best is None or exact > best[0]):
                best = (exact, th)
    return best[1] if best else {'clause': 0.9, 'full': 0.99}


def report(name, pred, y):
    per_head = {h: float((pred[:, i] == y[:, i]).mean()) for i, h in enumerate(HEADS)}
    exact = float((pred == y).all(1).mean())
    # solo le teste con una richiesta vera (non 'none'): quanto spesso la riconosce
    hit = pred[y > 0] == y[y > 0]
    recall = float(hit.mean()) if hit.size else 1.0
    # falsi allarmi: una richiesta vista dove non c'era
    false_pos = float(((pred > 0) & (y == 0)).sum() / max(1, (y == 0).sum()))
    print(f'{name:<34} frasi intere giuste {exact:6.1%}  richieste riconosciute {recall:6.1%}  falsi allarmi {false_pos:6.2%}')
    return {'exact': exact, 'recall': recall, 'false_pos': false_pos, 'per_head': per_head}


def handwritten_xy():
    samples = [(t, {h: lab.get(h, 'none') for h in HEADS}) for t, lab in CASES]
    return encode(samples)


SEED = int(os.environ.get('SEED', '0'))


def main():
    torch.manual_seed(SEED)
    random.seed(SEED)
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rng = random.Random(7 + SEED)
    inter = split_interactions(load_interactions()[0])
    extra = [(t if k == 0 else noisy(t, rng), lab) for t, lab in inter['train'] for k in range(INTERACTION_COPIES)]
    xtr, ytr = encode(dataset(N_TRAIN, 'train', seed=1 + 100 * SEED) + extra)
    print(f'interazioni: {len(inter["train"])} di addestramento (x{INTERACTION_COPIES}), {len(inter["dev"])} dev, {len(inter["test"])} test')
    test_samples = dataset(N_TEST, 'test', seed=2)
    dev_samples = dataset(N_DEV, 'test', seed=5)
    xte, yte = encode(test_samples)
    xhw, yhw = handwritten_xy()
    print(f'dati: {len(xtr)} frasi di addestramento, {len(xte)} di test (modelli mai visti), {len(xhw)} scritte a mano '
          f'({time.time() - t0:.0f} s)')

    model = ChatModel()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-5)
    steps = EPOCHS * (len(xtr) // BATCH)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(len(xtr))
        total = 0.0
        for i in range(0, len(xtr) - BATCH + 1, BATCH):
            idx = perm[i:i + BATCH]
            xb = xtr[idx]
            xb = xb[:, :int((xb > 0).sum(1).max())].clone()
            # caratteristiche spente a caso: il modello non deve dipendere da una parola sola
            xb[torch.rand(xb.shape) < FEATURE_DROPOUT] = 0
            loss = loss_fn(model(xb), ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += float(loss) * len(idx)
        model.eval()
        with torch.no_grad():
            p = predict(model(xte).numpy())
        print(f'epoca {epoch + 1}: perdita {total / len(xtr):.4f}, test frasi intere {float((p == yte.numpy()).all(1).mean()):.1%}')

    model.eval()
    th = tune_thresholds(model, dev_samples)
    print(f'soglie scelte (su frasi mai viste, non sul test): parti {th["clause"]}, messaggio intero {th["full"]}')
    hw_texts = [t for t, _ in CASES]
    res = {
        'soglie': th,
        'test_modelli_mai_visti': report('test (modelli di frase mai visti)', predict_messages(model, [t for t, _ in test_samples], th), yte.numpy()),
        'test_scritto_a_mano': report('test scritto a mano', predict_messages(model, hw_texts, th), yhw.numpy()),
    }
    torch.save(model.state_dict(), OUT / 'segueo-chat.pt')

    # esportazione ONNX: ids [1, n] -> logits [1, TOTAL]
    fp32 = OUT / 'segueo-chat-fp32.onnx'
    torch.onnx.export(model, (torch.tensor([featurize('più energia')]),), str(fp32), input_names=['ids'], output_names=['logits'],
                      dynamic_axes={'ids': {1: 'n'}}, opset_version=17, dynamo=False)
    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic
    int8 = OUT / 'segueo-chat-int8.onnx'
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8, op_types_to_quantize=['Gather', 'MatMul', 'Gemm'])

    def ort_eval(path, x):
        s = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
        rows = []
        for row in x.numpy():
            ids = row[row > 0][None, :] if (row > 0).any() else np.zeros((1, 1), np.int64)
            rows.append(s.run(None, {'ids': ids})[0][0])
        return np.stack(rows)

    sizes = {p.name: p.stat().st_size for p in (fp32, int8)}
    with torch.no_grad():
        ref = model(xhw).numpy()
    lo32, lo8 = ort_eval(fp32, xhw), ort_eval(int8, xhw)
    print(f'ONNX fp32 {sizes[fp32.name] / 1e6:.1f} MB (scarto {np.abs(lo32 - ref).max():.1e}), '
          f'int8 {sizes[int8.name] / 1e6:.1f} MB (scarto {np.abs(lo8 - ref).max():.2f})')

    class OrtModel:
        """Il modello int8 con la stessa interfaccia del modello PyTorch, per le stesse misure."""

        def __init__(self, path):
            self.s = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])

        def __call__(self, x):
            rows = [self.s.run(None, {'ids': (r[r > 0][None, :] if (r > 0).any() else np.zeros((1, 1), np.int64))})[0][0] for r in x.numpy()]
            return torch.from_numpy(np.stack(rows))

    q = OrtModel(int8)
    res['int8_scritto_a_mano'] = report('int8, test scritto a mano', predict_messages(q, hw_texts, th), yhw.numpy())
    res['int8_modelli_mai_visti'] = report('int8, test mai visti (3000)', predict_messages(q, [t for t, _ in test_samples[:3000]], th), yte.numpy()[:3000])
    # si usa l'int8 se non perde precisione, altrimenti il fp32
    chosen = int8 if res['int8_scritto_a_mano']['exact'] >= res['test_scritto_a_mano']['exact'] - 0.005 else fp32
    shutil.copy(chosen, MODELS / MODEL_FILE)
    print(f'modello per l\'app: {chosen.name} -> src/renderer/models/{MODEL_FILE}')
    res['file'] = chosen.name
    res['bytes'] = chosen.stat().st_size
    (OUT / 'metrics.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))

    # etichette per l'app e esempi per i test JavaScript (caratteristiche e punteggi del modello scelto)
    write_js(ROOT / 'src' / 'renderer' / 'js' / 'ai' / 'chat-heads.js', th)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    s = ort.InferenceSession(str(chosen), providers=['CPUExecutionProvider'])
    cases = []
    for text, _ in CASES[:24] + [('Più ENERGÌA!!! 124 bpm, l\'ultima', {}), ('', {})]:
        ids = featurize(text)
        logits = s.run(None, {'ids': np.array([ids], dtype=np.int64)})[0][0]
        cases.append({'text': text, 'normalized': normalize(text), 'ids': ids, 'logits': [round(float(v), 5) for v in logits]})
    (FIXTURES / 'cases.json').write_text(json.dumps(cases, ensure_ascii=False))
    print(f'fatto in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
