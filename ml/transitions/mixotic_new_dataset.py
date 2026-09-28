"""Transizioni reali dei set Mixotic senza ricostruzione di Gand (dalla v5): 222, 230, 275, 282, 285
(set del "mixotic set" di Sonnleitner et al., ISMIR 2016). Tracklist dai tag MP3 dei mix (Internet Archive,
mixotic.net_202209) e brani originali delle netlabel trovati su Internet Archive (37 su 82, licenze Creative
Commons, molte non commerciali): tutto solo in locale in ml/data/mixotic/tracks, fuori da git.

Allineamento come per il DJ Mix Dataset (align.py): diagonali nella matrice di somiglianza brano × mix, un
candidato per brano con inizi crescenti nell'ordine della tracklist. Il riconoscimento trova spesso solo una
parte del brano: il tratto suonato si allarga lungo la diagonale trovata (dove il brano esiste nel mix) fino
alla fine del tratto rilevato del brano successivo per l'uscente, e fino all'inizio del precedente per
l'entrante; chi si sente davvero lo decide la stima dei guadagni (build_dataset.transitions_of_mix).

Controlli di affidabilità: entrambi i brani consecutivi nella tracklist e allineati con z >= MIN_Z; l'entrante
inizia nel mix dopo l'inizio dell'uscente e prima della sua fine; errore del fit sotto MAX_FIT (come per la v4).

Uso:  ml/.venv/bin/python ml/transitions/mixotic_new_dataset.py [--window 128]
      -> ml/data/mixotic/transitions-nuovi[-128].npz, ml/data/mixotic/alignments/<set>.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from align import align_track, candidates, choose_sequence, similarity  # noqa: E402
from build_dataset import MAX_BEATS, transitions_of_mix  # noqa: E402
from mixotic_dataset import AUDIBLE, MAX_FIT, PRE, SMOOTH, pack, window  # noqa: E402

MIX = ML_DIR / "data" / "mixotic"
TRACKS = MIX / "tracks"
MIN_Z = 6.0


def align_set(set_name: str, tracklist: list[dict]) -> dict:
    fm = np.load(MIX / "features" / f"{set_name}.npz")
    mb = fm["beats"]
    entries, cands, sims = [], [], []
    for t in tracklist:
        path = TRACKS / "features" / f"{t.get('id')}.npz"
        if not t.get("id") or not path.exists():
            continue
        ft = np.load(path)
        S = similarity(ft, fm)
        entries.append({"pos": t["pos"] - 1, "id": t["id"], "title": f"{t['artist']} - {t['title']}"})
        cands.append(candidates(S))
        sims.append(S)
    chosen = choose_sequence(cands)
    tracks = []
    for e, cs, S, k in zip(entries, cands, sims, chosen):
        if k is None:
            tracks.append({**e, "failed": True})
            continue
        a = align_track(S, fixed=cs[k])
        a.update(e)
        a["mixTime"] = [float(mb[a["mixBeats"][0]]), float(mb[min(a["mixBeats"][1], len(mb) - 1)])]
        a["nTrack"] = int(S.shape[0])
        tracks.append(a)
    out = {"mix": set_name, "beats": int(len(mb)), "tracks": tracks}
    (MIX / "alignments").mkdir(parents=True, exist_ok=True)
    (MIX / "alignments" / f"{set_name}.json").write_text(json.dumps(out, indent=1))
    return out


def played_ranges(al: dict, n_mix: int) -> None:
    """Allarga i tratti rilevati lungo la diagonale (un solo tratto per brano, offset del tratto più lungo)."""
    ok = {t["pos"]: t for t in al["tracks"] if not t.get("failed") and t["z"] >= MIN_Z}
    for t in al["tracks"]:
        if t.get("failed"):
            continue
        if t["z"] < MIN_Z:
            t["failed"] = True
            continue
        seg = max(t["segments"], key=lambda s: s[1] - s[0])
        d = seg[2]
        j0, j1 = t["mixBeats"]
        prev, nxt = ok.get(t["pos"] - 1), ok.get(t["pos"] + 1)
        if prev:
            j0 = min(j0, prev["mixBeats"][0])
        if nxt:
            j1 = max(j1, nxt["mixBeats"][1])
        j0, j1 = max(j0, d), min(j1, d + t["nTrack"], n_mix)
        t["detected"] = {"mixBeats": t["mixBeats"], "segments": t["segments"]}
        t["mixBeats"], t["segments"] = [int(j0), int(j1)], [[int(j0 - d), int(j1 - d), int(d)]]


def build(set_name: str, tracklist: list[dict], win: int) -> tuple[list[dict], dict]:
    al = align_set(set_name, tracklist)
    fm = np.load(MIX / "features" / f"{set_name}.npz")
    played_ranges(al, len(fm["beats"]))
    det = {t["pos"]: t["detected"]["mixBeats"] for t in al["tracks"] if not t.get("failed")}
    cache: dict = {}

    def feat(i: str):
        if i not in cache:
            cache[i] = np.load(TRACKS / "features" / f"{i}.npz")
        return cache[i]

    full = transitions_of_mix(set_name, al=al, fm=fm, track_feat=feat, smooth=SMOOTH, audible=AUDIBLE, max_beats=10_000)
    out = []
    for it in full:
        a_det, b_det = det[it["posA"]], det[it["posA"] + 1]
        if not a_det[0] < b_det[0] < a_det[1] + 64:
            it["fitError"] = max(it["fitError"], 9.0)  # ordine nel mix incoerente: scartata
        it["set"] = set_name
        it["rawLength"] = R = it["length"]
        fa, fb = feat(it["idA"]), feat(it["idB"])
        L = min(R, win)
        for pre in PRE:
            if it["kB0"] - pre < 0 or it["kA0"] - pre < 0:
                continue
            out.append({**window(it, fa, fb, -pre, min(win, L + pre)), "kind": f"inizio-{pre}", "pre": pre})
        if R > win:
            out.append({**window(it, fa, fb, R - win, win), "kind": "fine", "pre": 0})
    return out, al


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=MAX_BEATS, help="finestra massima in battute (128 = come fino alla v4)")
    win = ap.parse_args().window
    lists = json.loads((TRACKS / "tracklists.json").read_text())
    kept = []
    for set_name, v in sorted(lists.items()):
        if not (MIX / "features" / f"{set_name}.npz").exists():
            continue
        tr, al = build(set_name, v["tracks"], win)
        good = [t for t in al["tracks"] if not t.get("failed")]
        base = [t for t in tr if t["kind"] == "inizio-0"]
        ok = {t["posA"] for t in base if t["fitError"] <= MAX_FIT}
        print(f"== {set_name}: {len(good)} brani allineati su {len(al['tracks'])}, {len(base)} transizioni, {len(ok)} con fit <= {MAX_FIT}")
        for t in base:
            print(f"  {t['posA'] + 1:2d}->{t['posA'] + 2:2d}  battute {t['rawLength']:3d}  fit {t['fitError']:.3f}  zA {t['zA']:.1f} zB {t['zB']:.1f}")
        kept += [t for t in tr if t["posA"] in ok]
    if not kept:
        raise SystemExit("nessuna transizione affidabile")
    out = MIX / ("transitions-nuovi.npz" if win == MAX_BEATS else f"transitions-nuovi-{win}.npz")
    np.savez_compressed(out, **pack(kept))
    base = [t for t in kept if t["kind"] == "inizio-0"]
    raw = [t["rawLength"] for t in base]
    print(f"{len(base)} transizioni tenute ({len(kept)} finestre); durata completa: mediana {np.median(raw):.0f} battute "
          f"(min {min(raw)}, max {max(raw)}, {sum(r > win for r in raw)} oltre {win}); "
          f"fit mediano {np.median([t['fitError'] for t in base]):.3f}")


if __name__ == "__main__":
    main()
