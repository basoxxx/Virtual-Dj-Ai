"""Caratteristiche del testo per Segueo Chat, identiche a src/renderer/js/ai/chat-features.js:
minuscole senza accenti, solo lettere e cifre (le cifre diventano 0: i numeri li legge l'interprete),
parole, coppie di parole e pezzi di 3-5 lettere, ciascuno con hash FNV-1a a 32 bit in NB contenitori."""
import re
import unicodedata

from heads import NB, MAX_FEATURES


def normalize(text):
    t = unicodedata.normalize('NFD', str(text).lower())
    t = ''.join(c for c in t if unicodedata.category(c) != 'Mn')
    t = re.sub(r'[0-9]', '0', t)
    t = re.sub(r"[^a-z0 ]+", ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def fnv1a(s):
    h = 2166136261
    for b in s.encode('ascii'):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def feature_strings(text):
    words = normalize(text).split(' ') if normalize(text) else []
    out = []
    for w in words:
        out.append('w:' + w)
        g = '<' + w + '>'
        for n in (3, 4, 5):
            for i in range(0, len(g) - n + 1):
                out.append('c:' + g[i:i + n])
    for a, b in zip(words, words[1:]):
        out.append('b:' + a + '_' + b)
    return out[:MAX_FEATURES]


def featurize(text):
    """Indici dei contenitori (1..NB); lista vuota -> [0]."""
    ids = [fnv1a(f) % NB + 1 for f in feature_strings(text)]
    return ids or [0]
