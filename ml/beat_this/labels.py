"""Etichette per l'addestramento dalle battute dell'insegnante (final0, ml/data/beat_this/pred/final0).

Per ogni brano:
  - griglia a tempo costante come beatGrid() dell'app (catena di battute regolari più lunga, retta ai minimi
    quadrati, estensione alle battute entro ±50 ms, BPM intero se non peggiora l'aderenza) e fase della battuta
    forte dal residuo modulo 4 più votato;
  - "griglia": brani a tempo costante (tipici della dance) con ≥ 80% delle battute di final0 entro ±30 ms dalla
    griglia e scarto quadratico ≤ 15 ms. Battute = la griglia stessa tra la prima e l'ultima battuta di final0,
    anche nei break senza batteria (come le etichette di Gand); battute forti = ogni 4 sul residuo più votato se
    coerenti (≥ 85% dei voti), altrimenti quelle di final0 spostate sulla griglia; dove final0 ha ≥ 2 battute di
    fila fuori griglia la perdita è spenta (maschera);
  - "libero": tutti gli altri, etichette = battute e battute forti di final0 così come sono;
  - scartati i brani con meno di 30 battute (parlato, ambient) e i brani "liberi" in cui small0 e final0 leggono
    il tempo a livelli metrici in rapporto 2/3 o 3/4 (ritmi terzinati / 12/8: è l'errore noto di final0 sul set CC,
    meglio non insegnarlo); i doppioni dei brani di valutazione (dedupe.json) sono esclusi.
Uscita: ml/data/beat_this/labels.json  ({id: {"kind", "beats", "downbeats", "mask": [[da, a], ...] in secondi}}).

Uso:  ml/.venv/bin/python ml/beat_this/labels.py      (round 1: maestro final0)
      ml/.venv/bin/python ml/beat_this/labels.py --teacher ens --out ml/data/beat_this/labels-ens.json --check-all \
          --check small0-int8 small0-torch final0 final1 final2       (round 2: media di final0/1/2)
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402

TEACHER = C.DATA / "pred" / "final0"
OUT = C.DATA / "labels.json"


def _fit(ns, ts):
    ns, ts = np.asarray(ns, float), np.asarray(ts, float)
    mn, mt = ns.mean(), ts.mean()
    den = ((ns - mn) ** 2).sum()
    period = ((ns - mn) * (ts - mt)).sum() / den if den > 0 else 0.0
    return period, mt - period * mn


def _longest_run(beats, med):
    best, cur = ([], []), ([0], [beats[0]])
    n, last = 0, beats[0]
    for t in beats[1:]:
        r = (t - last) / med
        k = round(r)
        if k >= 1 and abs(r - k) <= 0.15:
            n += k
            last = t
            cur[0].append(n)
            cur[1].append(t)
        elif r < 0.85:
            continue
        else:
            if len(cur[0]) > len(best[0]):
                best = cur
            n, last = 0, t
            cur = ([0], [t])
    if len(cur[0]) > len(best[0]):
        best = cur
    return best


def fit_grid(beats: np.ndarray, downbeats: np.ndarray, inlier=0.05) -> dict | None:
    """Griglia come beatGrid() di beat-this.js, ma senza ripiegare il tempo in [70, 180]."""
    if len(beats) < 8:
        return None
    med = float(np.sort(np.diff(beats))[(len(beats) - 1) // 2])
    if med <= 0:
        return None
    ns, ts = _longest_run(list(beats), med)
    if len(ns) < 8:
        return None
    period, phase = _fit(ns, ts)
    for _ in range(4):
        if period <= 0:
            return None
        k = np.round((beats - phase) / period)
        keep = np.abs(beats - phase - k * period) <= inlier
        if keep.sum() < 8:
            break
        ns, ts = k[keep], beats[keep]
        period, phase = _fit(ns, ts)
    ns, ts = np.asarray(ns, float), np.asarray(ts, float)
    rms = float(np.sqrt(np.mean((ts - phase - ns * period) ** 2)))
    bpm = 60 / period
    if abs(bpm - round(bpm)) < 0.1:
        p2 = 60 / round(bpm)
        ph2 = float(np.mean(ts - ns * p2))
        rms2 = float(np.sqrt(np.mean((ts - ph2 - ns * p2) ** 2)))
        if rms2 <= rms + 0.003:
            period, phase, rms = p2, ph2, rms2
    res = beats - phase - np.round((beats - phase) / period) * period
    votes = np.zeros(4)
    for d in downbeats:
        k = round((d - phase) / period)
        if abs(d - phase - k * period) <= inlier:
            votes[k % 4] += 1
    return {"period": period, "phase": phase, "rms": rms, "share30": float(np.mean(np.abs(res) <= 0.03)),
            "share50": float(np.mean(np.abs(res) <= 0.05)), "residue": int(np.argmax(votes)),
            "dshare": float(votes.max() / votes.sum()) if votes.sum() else 0.0, "res": res}


def make_labels(beats: np.ndarray, downbeats: np.ndarray) -> dict | None:
    if len(beats) < 30:
        return None
    g = fit_grid(beats, downbeats)
    if g and g["share30"] >= 0.8 and g["rms"] <= 0.015:
        p, ph = g["period"], g["phase"]
        k0 = int(np.ceil((beats[0] - ph) / p - 0.5))
        k1 = int(np.floor((beats[-1] - ph) / p + 0.5))
        k = np.arange(k0, k1 + 1)
        t = ph + k * p
        # tratti con almeno 2 battute di final0 di fila fuori griglia: perdita spenta (±1 battuta)
        off = np.abs(g["res"]) > 0.05
        mask = []
        i = 0
        while i < len(beats):
            if off[i]:
                j = i
                while j + 1 < len(beats) and off[j + 1]:
                    j += 1
                if j > i:
                    mask.append([float(beats[i] - p), float(beats[j] + p)])
                i = j + 1
            else:
                i += 1
        if g["dshare"] >= 0.85:
            down = t[(k - g["residue"]) % 4 == 0]
        else:
            # battute forti incoerenti (cambi di fase a metà brano): quelle di final0, spostate sulla griglia
            kd = np.round((downbeats - ph) / p)
            near = np.abs(downbeats - ph - kd * p) <= 0.05
            down = ph + np.unique(kd[near]) * p
        # round 2: tratti senza battute del maestro (break, oltre 2,5 battute): lì la battuta forte non si sente e
        # con il peso 86 dei positivi la perdita insegnerebbe a segnarla su ogni battuta -> niente perdita
        gap = np.diff(beats) > 2.5 * p
        dgaps = [[float(beats[i] + 0.5 * p), float(beats[i + 1] - 0.5 * p)] for i in np.nonzero(gap)[0]]
        return {"kind": "grid", "beats": t.tolist(), "downbeats": down.tolist(), "mask": mask, "bpm": 60 / p,
                "down_grid": bool(g["dshare"] >= 0.85), "dgaps": dgaps}
    return {"kind": "free", "beats": beats.tolist(), "downbeats": downbeats.tolist(), "mask": [],
            "bpm": 60 / g["period"] if g else 0.0}


def downbeats_agree(lab: dict, members: list[str], tid: str) -> bool:
    """Round 2: le battute forti si insegnano solo se i maestri concordano sulla battuta 1.

    Con il peso 86 dei positivi, se metà dei brani simili ha la battuta forte sull'1 e metà sul 3 (dubbio tipico
    della techno a cassa dritta), al modello conviene segnarla su entrambe: è l'eccesso di battute forti del
    round 1. Brani a griglia: ogni maestro deve votare lo stesso residuo modulo 4 (quota ≥ 0,7) della griglia
    delle etichette; brani liberi: F battute forti di ogni maestro contro le etichette ≥ 0,9."""
    down = np.asarray(lab["downbeats"])
    for m in members:
        pth = C.DATA / "pred" / m / f"{tid}.npz"
        if not pth.exists():
            continue
        with np.load(pth) as z:
            d = z["downbeats"].astype(float)
        if lab["kind"] == "grid":
            if not lab.get("down_grid", True) or len(down) == 0 or len(d) == 0:
                return False
            p = 60 / lab["bpm"]
            ref = int(round((down[0] - lab["beats"][0]) / p)) % 4
            k = np.round((d - lab["beats"][0]) / p).astype(int)
            near = np.abs(d - lab["beats"][0] - k * p) <= 0.05
            votes = np.bincount(k[near] % 4, minlength=4)
            if votes.sum() == 0 or int(np.argmax(votes)) != ref or votes.max() / votes.sum() < 0.7:
                return False
        elif C.f_measure(down, d) < 0.9:
            return False
    return True


def metric_clash(a: float, b: float) -> bool:
    """Tempi in rapporto 2/3, 3/2, 3/4 o 4/3 (entro il 4%)."""
    return bool(a and b) and any(abs(a / b - r) <= 0.04 * r for r in (2 / 3, 3 / 2, 3 / 4, 4 / 3))


def tempo_of(name: str, tid: str) -> float:
    """Tempo (BPM, non ripiegato) della griglia delle battute di un modello, 0 se manca."""
    p = C.DATA / "pred" / name / f"{tid}.npz"
    if not p.exists():
        return 0.0
    with np.load(p) as z:
        g = fit_grid(z["beats"].astype(float), z["downbeats"].astype(float))
    return 60 / g["period"] if g else 0.0


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher", default="final0", help="cartella in pred/ con l'insegnante (final0 o ens)")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--check", nargs="*", default=["small0-int8", "small0-torch"],
                    help="altri modelli: se uno legge il tempo in rapporto 2/3 o 3/4 col maestro, il brano si esclude")
    ap.add_argument("--check-all", action="store_true", help="controllo su tutti i brani (non solo i liberi)")
    ap.add_argument("--down-members", nargs="*", default=[], help="round 2: maestri che devono concordare sulle "
                    "battute forti (altrimenti down_ok = false: niente perdita sulle battute forti del brano)")
    a = ap.parse_args()
    teacher = C.DATA / "pred" / a.teacher
    inv = [it for it in C.load_inventory() if it["split"] in ("train", "val") and (teacher / f"{it['id']}.npz").exists()]
    dedupe = json.loads((C.DATA / "dedupe.json").read_text()) if (C.DATA / "dedupe.json").exists() else {}
    out, kinds = {}, Counter()
    for it in inv:
        if it["id"] in dedupe:
            kinds["doppione di un brano di valutazione"] += 1
            continue
        with np.load(teacher / f"{it['id']}.npz") as z:
            lab = make_labels(z["beats"].astype(float), z["downbeats"].astype(float))
        if lab is None:
            kinds["poche battute"] += 1
            continue
        if lab["kind"] == "free" or a.check_all:
            # tempo secondo gli altri modelli (stessa catena) per riconoscere i casi ambigui (12/8, terzine)
            if any(metric_clash(tempo_of(m, it["id"]), lab["bpm"]) for m in a.check):
                kinds["livello metrico ambiguo (2/3, 3/4)"] += 1
                continue
        lab = {"split": it["split"], "source": it["source"], **lab}
        if a.down_members:
            lab["down_ok"] = downbeats_agree(lab, a.down_members, it["id"])
            kinds["battute forti concordi" if lab["down_ok"] else "battute forti discordi (non insegnate)"] += 1
        kinds[(it["source"], lab["kind"])] += 1
        out[it["id"]] = lab
    Path(a.out).write_text(json.dumps(out))
    for k, v in sorted(kinds.items(), key=str):
        print(k, v)


if __name__ == "__main__":
    main()
