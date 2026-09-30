"""Frasi di addestramento e di test per Segueo Chat, generate dai modelli di frase (templates.py).
Il modello legge ogni parte di un messaggio da sola (split_clauses, identica a chat-features.js) e i risultati si
uniscono; si addestra su parti singole (anche neutre) e su messaggi interi. Il test usa messaggi interi costruiti solo
con modelli di frase tenuti fuori dall'addestramento: misura le frasi mai viste."""
import random
import re

from features import fnv1a, normalize
from handwritten import CASES
from heads import HEADS
from templates import T, TEMP_SUFFIX, TEMP_HEADS, PREFIX, SUFFIX, JOIN, GENRES, TITLE_WORDS, NEUTRAL

ALONE = {'info', 'talk', 'view'}  # domande, saluti e fuori tema non si mescolano ai comandi
HEAD_WEIGHT = {'strategy': 3, 'style': 3, 'bars': 2, 'remix': 1, 'mashupOpt': 1, 'returnTempo': 0.5, 'mode': 1, 'control': 3,
               'queue': 2.5, 'genre': 3, 'set': 1.5, 'mashup': 1, 'info': 2.5, 'view': 0.4, 'talk': 1.5}
CLAUSE_RE = re.compile(r"[,;.!?]+|\s+(?:e poi|e anche|poi|ma|e)\s+")


def split_clauses(text):
    """Parti di un messaggio: separate da punteggiatura o da 'e', 'e poi', 'poi', 'ma', 'e anche'."""
    return [c.strip() for c in CLAUSE_RE.split(str(text).lower()) if c and c.strip()]


def is_test(template):
    return fnv1a(template.encode('ascii', 'ignore').decode()) % 5 == 0


# le frasi del test scritto a mano non devono mai finire nell'addestramento
HANDWRITTEN = {normalize(t) for t, _ in CASES}


def split_templates():
    train, test = {}, {}
    for key, items in T.items():
        items = [x for x in items if normalize(x) not in HANDWRITTEN]
        tr = [x for x in items if not is_test(x)]
        te = [x for x in items if is_test(x)]
        if not te and len(tr) > 3:  # almeno un modello di frase nel test
            te, tr = tr[-1:], tr[:-1]
        train[key], test[key] = tr, te or tr
    neutral_tr = [x for x in NEUTRAL if not is_test(x)]
    neutral_te = [x for x in NEUTRAL if is_test(x)] or neutral_tr[-2:]
    temp_tr = [x for x in TEMP_SUFFIX if not is_test(x)]
    temp_te = [x for x in TEMP_SUFFIX if is_test(x)] or temp_tr[-1:]
    return (train, neutral_tr, temp_tr), (test, neutral_te, temp_te)


USED_TITLES = []  # titoli usati dall'ultima frase generata (per dare all'interprete una libreria con quei brani)


def title(rng):
    t = ' '.join(rng.choice(TITLE_WORDS) for _ in range(rng.choice([1, 2, 2, 3])))
    USED_TITLES.append(t)
    return t


def fill(template, rng):
    t = template.replace('{track2}', title(rng)).replace('{track}', title(rng)).replace('{genre}', rng.choice(GENRES))
    n = str(rng.choice([2, 3, 4, 5, 10, 15, 20, 30])) if rng.random() < 0.7 else rng.choice(['due', 'tre', 'quattro', 'cinque', 'dieci'])
    return t.replace('{n}', n)


def typo(s, rng):
    words = s.split(' ')
    idx = [i for i, w in enumerate(words) if len(w) >= 5]
    if not idx:
        return s
    i = rng.choice(idx)
    w = list(words[i])
    j = rng.randrange(1, len(w) - 1)
    op = rng.random()
    if op < 0.4:
        w[j], w[j + 1] = w[j + 1], w[j]
    elif op < 0.7:
        del w[j]
    else:
        w.insert(j, w[j])
    words[i] = ''.join(w)
    return ' '.join(words)


def noisy(text, rng):
    text = rng.choice(PREFIX) + text + rng.choice(SUFFIX)
    if rng.random() < 0.15:
        text = typo(text, rng)
    if rng.random() < 0.05:
        text = typo(text, rng)
    return text


def pick_heads(pool, rng, n):
    heads = sorted({h for h, _ in pool if pool[(h, _)]})
    weights = [HEAD_WEIGHT.get(h, 1) for h in heads]
    chosen = [rng.choices(heads, weights)[0]]
    if chosen[0] in ALONE:
        return chosen
    tries = 0
    while len(chosen) < n and tries < 20:
        tries += 1
        h = rng.choices(heads, weights)[0]
        if h in chosen or h in ALONE:
            continue
        chosen.append(h)
    return chosen


def message(parts, rng, n=None):
    """Un messaggio con 1-3 richieste (a volte con una frase neutra) e le sue etichette."""
    pool, neutral, temp = parts
    n = n or rng.choices([1, 2, 3], [0.55, 0.35, 0.1])[0]
    labels = {h: 'none' for h in HEADS}
    clauses = []
    for h in pick_heads(pool, rng, n):
        key = rng.choice([k for k in pool if k[0] == h and pool[k]])
        labels[h] = key[1]
        clauses.append(fill(rng.choice(pool[key]), rng))
    if any(labels[h] != 'none' for h in TEMP_HEADS) and labels['set'] == 'none' and rng.random() < 0.2:
        suffix = fill(rng.choice(temp), rng)
        if rng.random() < 0.5:
            clauses[-1] += ' ' + suffix
        else:
            clauses.insert(0 if rng.random() < 0.5 else len(clauses), suffix)
        labels['temporary'] = 'yes'
    if labels['talk'] == 'none' and labels['info'] == 'none' and rng.random() < 0.25:
        clauses.insert(rng.randrange(len(clauses) + 1), rng.choice(neutral))
    text = clauses[0]
    for c in clauses[1:]:
        text += rng.choice(JOIN) + c
    return noisy(text, rng), labels


def clause(parts, rng):
    """Una parte singola: una richiesta, una frase neutra o solo "per i prossimi N brani"."""
    pool, neutral, temp = parts
    labels = {h: 'none' for h in HEADS}
    r = rng.random()
    if r < 0.12:
        return noisy(rng.choice(neutral), rng), labels
    if r < 0.17:
        labels['temporary'] = 'yes'
        return noisy(fill(rng.choice(temp), rng), rng), labels
    return message(parts, rng, n=1)


def dataset(n, split='train', seed=0):
    train, test = split_templates()
    parts = train if split == 'train' else test
    rng = random.Random(seed)
    if split == 'train':  # metà parti singole, metà messaggi interi
        return [clause(parts, rng) if rng.random() < 0.5 else message(parts, rng) for _ in range(n)]
    return [message(parts, rng) for _ in range(n)]


if __name__ == '__main__':
    print(split_clauses('Più energia, transizioni lunghe e niente house! poi metti golden hour'))
    for text, labels in dataset(10, 'test', 3):
        print(text, '->', {k: v for k, v in labels.items() if v != 'none'})


def dataset_with_titles(n, split='test', seed=0):
    """Come dataset(), con i titoli dei brani nominati in ogni frase."""
    train, test = split_templates()
    parts = train if split == 'train' else test
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        USED_TITLES.clear()
        text, labels = message(parts, rng)
        out.append((text, labels, list(USED_TITLES)))
    return out
