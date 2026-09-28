"""Allineamento mix-brano a livello di battuta (riscritto da zero, ispirato a Kim et al., "A Computational
Analysis of Real-World DJ Mixes using Mix-To-Track Subsequence Alignment", ISMIR 2020).

Le caratteristiche sono medie per battuta (croma + log-mel), quindi indipendenti dal tempo: quando il DJ
suona un brano, nella matrice di somiglianza brano × mix compare una diagonale (battuta k del brano =
battuta k + d del mix). Si cerca la diagonale più forte (media mobile su 32 battute) e il tratto in cui
resta alta; i piccoli errori delle battute del mix spostano la diagonale di ±1-2: si concatenano i tratti
vicini. I brani si cercano nell'ordine della tracklist, dopo l'inizio del brano precedente.

Uso:  ml/.venv/bin/python ml/transitions/align.py mix0010 [--plot]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "djmix"
FEAT = DATA / "features"
ALIGN = DATA / "alignments"
SMOOTH = 32


def _unit(x: np.ndarray) -> np.ndarray:
    return (x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)).astype(np.float32)


def _zunit(x: np.ndarray) -> np.ndarray:
    return _unit((x - x.mean(0)) / (x.std(0) + 1e-6))


def similarity(ft, fm) -> np.ndarray:
    """Somiglianza battuta per battuta brano × mix, centrata per righe e colonne.

    Croma: massimo su -1/0/+1 semitono (il pitch dei giradischi sposta la tonalità);
    log-mel in 4 sottodivisioni della battuta: schema ritmico; log-mel intero: timbro."""
    ct, cm = _unit(ft["chroma"]), _unit(fm["chroma"])
    sc = np.max([np.roll(ct, k, axis=1) @ cm.T for k in (-1, 0, 1)], axis=0)
    sr = _zunit(ft["mel4"]) @ _zunit(fm["mel4"]).T
    st = _zunit(ft["mel"]) @ _zunit(fm["mel"]).T
    S = 0.3 * sc + 0.5 * sr + 0.2 * st
    return S - S.mean(1, keepdims=True) - S.mean(0, keepdims=True) + S.mean()


def beat_vectors(f) -> np.ndarray:
    """Vettore per battuta usato solo per i grafici di controllo."""
    return _zunit(f["mel4"])


def diagonal_scores(S: np.ndarray, w: int = SMOOTH):
    """Per ogni diagonale d (battuta del mix - battuta del brano): media mobile su w battute."""
    n_t, n_m = S.shape
    out = {}
    kernel = np.ones(w, np.float32) / w
    for d in range(-n_t + w, n_m - w):
        diag = np.diagonal(S, offset=d)
        if len(diag) >= w:
            out[d] = np.convolve(diag, kernel, mode="valid")
    return out


def align_track(S: np.ndarray, fixed: dict) -> dict:
    """Tratto suonato del brano lungo la diagonale del candidato scelto (più le diagonali vicine)."""
    scores = diagonal_scores(S)
    best_d = fixed["d"]
    best_v = fixed["score"]
    best_i = fixed["trackBeat"] - max(0, -best_d)
    base = float(np.median(S))
    spread = float(np.percentile(S, 99) - base)
    thr = base + 0.35 * (best_v - base)
    # tratto intorno al picco sulla diagonale migliore, poi estensione sulle diagonali vicine (±2)
    segs = []
    d = best_d
    sm = scores[d]
    lo = hi = best_i
    while lo > 0 and sm[lo - 1] > thr:
        lo -= 1
    while hi < len(sm) - 1 and sm[hi + 1] > thr:
        hi += 1
    i0 = max(0, -d)
    segs.append([i0 + lo, i0 + hi + SMOOTH, d])
    for direction in (-1, 1):
        cur_d, edge = d, (segs[0][0] if direction < 0 else segs[0][1])
        for _ in range(8):
            found = None
            for nd in (cur_d - 1, cur_d + 1, cur_d - 2, cur_d + 2):
                if nd not in scores:
                    continue
                s2, j0 = scores[nd], max(0, -nd)
                k = edge - j0 - (SMOOTH if direction < 0 else 0)
                k = int(np.clip(k, 0, len(s2) - 1))
                if s2[k] > thr:
                    a = b = k
                    while a > 0 and s2[a - 1] > thr:
                        a -= 1
                    while b < len(s2) - 1 and s2[b + 1] > thr:
                        b += 1
                    if (b - a) >= 8:
                        found = (nd, j0 + a, j0 + b + SMOOTH)
                        break
            if not found:
                break
            nd, a, b = found
            if direction < 0 and b > edge - 4:
                segs.insert(0, [a, min(b, edge), nd])
                edge, cur_d = a, nd
            elif direction > 0 and a < edge + 4:
                segs.append([max(a, edge), b, nd])
                edge, cur_d = b, nd
            else:
                break
    t_start, t_end = segs[0][0], segs[-1][1]
    return {
        "offset": best_d,
        "score": best_v,
        "z": fixed["z"],
        "contrast": (best_v - base) / (spread + 1e-9),
        "segments": [[int(a), int(b), int(dd)] for a, b, dd in segs],
        "trackBeats": [int(t_start), int(min(t_end, S.shape[0]))],
        "mixBeats": [int(segs[0][0] + segs[0][2]), int(min(segs[-1][1] + segs[-1][2], S.shape[1]))],
    }


def candidates(S: np.ndarray, k: int = 10, sep: int = 64) -> list[dict]:
    """Le k diagonali migliori (picchi della media mobile distanti almeno `sep` battute nel mix)."""
    scores = diagonal_scores(S)
    peaks = []
    for d, sm in scores.items():
        i0 = max(0, -d)
        j = int(np.argmax(sm))
        peaks.append((float(sm[j]), d, i0 + j))
    peaks.sort(reverse=True)
    vals = np.array([p[0] for p in peaks])
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med))) + 1e-6
    out = []
    for v, d, i in peaks:
        m = i + d
        if all(abs(m - c["mixBeat"]) >= sep for c in out):
            out.append({"d": d, "score": v, "z": (v - med) / mad, "trackBeat": i, "mixBeat": m})
        if len(out) >= k:
            break
    return out


def choose_sequence(cands: list[list[dict]], skip: float = 3.0) -> list[int | None]:
    """Un candidato per brano (o nessuno) con inizi nel mix crescenti, massimizzando la somma degli z;
    ogni brano saltato costa `skip`."""
    n = len(cands)
    start = lambda i, c: cands[i][c]["mixBeat"] - cands[i][c]["trackBeat"]  # noqa: E731
    score: dict[tuple[int, int], float] = {}
    back: dict[tuple[int, int], tuple[int, int] | None] = {}
    for i in range(n):
        for c in range(len(cands[i])):
            best, arg = -skip * i, None  # nessun predecessore: i brani prima sono saltati
            for (j, cj), v in score.items():
                if j < i and start(j, cj) < start(i, c):
                    cand = v - skip * (i - j - 1)
                    if cand > best:
                        best, arg = cand, (j, cj)
            score[(i, c)] = best + cands[i][c]["z"]
            back[(i, c)] = arg
    chosen: list[int | None] = [None] * n
    if not score:
        return chosen
    end = max(score, key=lambda k: score[k] - skip * (n - 1 - k[0]))
    if score[end] - skip * (n - 1 - end[0]) <= -skip * n:
        return chosen
    node: tuple[int, int] | None = end
    while node is not None:
        chosen[node[0]] = node[1]
        node = back[node]
    return chosen


def align_mix(mix_id: str, plot: bool = False) -> dict:
    subset = {m["id"]: m for m in json.loads((DATA / "subset.json").read_text())}
    mix = subset[mix_id]
    fm = np.load(FEAT / f"{mix_id}.npz")
    mb = fm["beats"]
    entries, cands, sims = [], [], []
    for pos, t in enumerate(mix["tracklist"]):
        path = FEAT / f"yt-{t['id']}.npz" if t.get("id") else None
        if not path or not path.exists():
            continue
        ft = np.load(path)
        S = similarity(ft, fm)
        entries.append({"pos": pos, "id": t["id"], "title": t["title"]})
        cands.append(candidates(S))
        sims.append(S)
    chosen = choose_sequence(cands)
    results = []
    for e, cs, S, c_idx in zip(entries, cands, sims, chosen):
        if c_idx is None:
            results.append({**e, "failed": True})
            continue
        a = align_track(S, fixed=cs[c_idx])
        a.update(e)
        a["mixTime"] = [float(mb[a["mixBeats"][0]]), float(mb[min(a["mixBeats"][1], len(mb) - 1)])]
        results.append(a)
        if plot:
            _plot(S, a, DATA / "plots" / f"{mix_id}-{e['pos']:02d}.png")
    out = {"mix": mix_id, "beats": int(len(mb)), "tracks": results}
    ALIGN.mkdir(parents=True, exist_ok=True)
    (ALIGN / f"{mix_id}.json").write_text(json.dumps(out, indent=1))
    return out


def _plot(S, a, dest):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    dest.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(10, 3))
    ax.imshow(S, aspect="auto", origin="lower", cmap="magma", interpolation="nearest")
    for t0, t1, d in a["segments"]:
        ax.plot([t0 + d, t1 + d], [t0, t1], "c-", lw=1)
    ax.set_xlabel("battute del mix")
    ax.set_ylabel("battute del brano")
    fig.tight_layout()
    fig.savefig(dest, dpi=80)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mixes", nargs="+")
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()
    for mix_id in args.mixes:
        out = align_mix(mix_id, plot=args.plot)
        for r in out["tracks"]:
            if r.get("missing") or r.get("failed"):
                print(f"{r['pos']:2d} NON ALLINEATO  {r['title'][:50]}")
            else:
                m0, m1 = r["mixTime"]
                print(f"{r['pos']:2d} mix {m0 / 60:6.2f}-{m1 / 60:6.2f} min  brano battute {r['trackBeats']}  "
                      f"z {r['z']:5.1f} tratti {len(r['segments'])}  {r['title'][:40]}")


if __name__ == "__main__":
    main()
