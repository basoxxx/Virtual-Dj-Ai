"""Transizioni di DJ veri dai loro mix (Gabry Ponte dalla v7, LUM!X dalla v8): tracklist, mix e brani scaricati da
dj_sets_download.py, tutto solo in locale in ml/data/<dj>.

Allineamento come per i set Mixotic nuovi (align.py: diagonali nella matrice di somiglianza brano × mix, un
candidato per brano con inizi crescenti nell'ordine della tracklist). Quando la tracklist ha i tempi ("cue", dove
il brano entra nel mix) si tengono solo i candidati con il tratto riconosciuto tra poco prima del cue del brano e
poco dopo il cue del successivo: è l'indizio che per Mixotic dava la ricostruzione di Gand. Tratto suonato, curve
di crossfader ed EQ, finestre e controlli come in mixotic_new_dataset.py (errore del fit sotto MAX_FIT, ordine nel
mix coerente con la tracklist).

Controllo indipendente (solo con i cue): istante in cui il crossfader stimato passa metà corsa contro il cue del
brano entrante.

Uso:  ml/.venv/bin/python ml/transitions/dj_sets_dataset.py --dj gabry|lumix [--window 128]
      -> ml/data/<dj>/features/, alignments/<mix>.json, transitions[-128].npz
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
from features import extract  # noqa: E402
from mixotic_dataset import AUDIBLE, MAX_FIT, PRE, SMOOTH, pack, window  # noqa: E402

DATA = ML_DIR / "data" / "gabry"  # cambia con --dj
FEAT = DATA / "features"
PREFIX = {"gabry": "gp-", "lumix": "lx-"}
# soglie di z più basse che per i set Mixotic nuovi (6): con i tempi della tracklist, o anche solo con l'ordine, i
# brani dei mix radiofonici si susseguono senza buchi; provate 4/4, 3/4, 3/3,5: con 3/3,5 le transizioni tenute
# passano da 21 a 27 con errore del fit mediano 0,161 (0,177 con 4/4) e metà crossfader a 9 s dal cue
DJ = "gabry"
MIN_Z = 3.0
MIN_Z_NO_CUE = 3.5
BEFORE, AFTER = 45.0, 45.0  # secondi di tolleranza intorno ai cue


AUDIO_EXT = {".m4a", ".webm", ".opus", ".mp3", ".ogg", ".wav", ".mp4"}


def features() -> None:
    # solo file completi (niente .part/.ytdl dei download in corso)
    for p in sorted(p for p in (DATA / "mixes").glob("*.*") if p.suffix in AUDIO_EXT):
        extract(p, FEAT, name=f"mix-{p.stem}")
    for p in sorted(p for p in (DATA / "tracks").glob("*-*.*") if p.suffix in AUDIO_EXT):
        try:
            extract(p, FEAT, name=p.stem)
        except Exception as err:
            print(f"ERRORE {p.name}: {err}", flush=True)


def align_mix(key: str, mix: dict) -> dict:
    fm = np.load(FEAT / f"mix-{key}.npz")
    mb = fm["beats"]
    tl = mix["tracks"]
    entries, cands, sims = [], [], []
    for i, t in enumerate(tl):
        path = FEAT / f"{t['id']}.npz"
        if not path.exists():
            continue
        ft = np.load(path)
        S = similarity(ft, fm)
        cs = candidates(S, k=40, sep=16)
        if t["cue"] is not None:
            nxt = next((u["cue"] for u in tl[i + 1:] if u["cue"] is not None), None)
            hi = (nxt if nxt is not None else t["cue"] + (t["duration"] or 240)) + AFTER
            lo = t["cue"] - BEFORE
            cs = [c for c in cs if lo <= mb[min(c["mixBeat"], len(mb) - 1)] <= hi]
        entries.append({"pos": t["pos"] - 1, "id": t["id"], "title": f"{t['artist']} - {t['title']}", "cue": t["cue"]})
        cands.append(cs[:10])
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
    out = {"mix": key, "beats": int(len(mb)), "tracks": tracks}
    (DATA / "alignments").mkdir(parents=True, exist_ok=True)
    (DATA / "alignments" / f"{key}.json").write_text(json.dumps(out, indent=1))
    return out


def played_ranges(al: dict, n_mix: int, min_z: float) -> None:
    """Come mixotic_new_dataset.played_ranges, con la soglia di z per mix."""
    ok = {t["pos"]: t for t in al["tracks"] if not t.get("failed") and t["z"] >= min_z}
    for t in al["tracks"]:
        if t.get("failed"):
            continue
        if t["z"] < min_z:
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


def build(key: str, mix: dict, win: int) -> tuple[list[dict], dict]:
    al = align_mix(key, mix)
    fm = np.load(FEAT / f"mix-{key}.npz")
    mb = fm["beats"]
    has_cues = any(t["cue"] is not None for t in mix["tracks"])
    played_ranges(al, len(mb), MIN_Z if has_cues else MIN_Z_NO_CUE)
    det = {t["pos"]: t["detected"]["mixBeats"] for t in al["tracks"] if not t.get("failed")}
    cues = {t["pos"] - 1: t["cue"] for t in mix["tracks"]}
    cache: dict = {}

    def feat(i: str):
        if i not in cache:
            cache[i] = np.load(FEAT / f"{i}.npz")
        return cache[i]

    full = transitions_of_mix(key, al=al, fm=fm, track_feat=feat, smooth=SMOOTH, audible=AUDIBLE, max_beats=10_000)
    out = []
    for it in full:
        a_det, b_det = det[it["posA"]], det[it["posA"] + 1]
        if not a_det[0] < b_det[0] < a_det[1] + 64:
            it["fitError"] = max(it["fitError"], 9.0)  # ordine nel mix incoerente: scartata
        it["set"] = f"{PREFIX[DJ]}{key}"
        it["rawLength"] = R = it["length"]
        xf = it["y"][:, 0]
        j_half = int(np.argmax(xf >= 0.5)) if (xf >= 0.5).any() else None
        it["halfTime"] = float(mb[it["mixStartBeat"] + j_half]) if j_half is not None else None
        it["cueB"] = cues.get(it["posA"] + 1)
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
    global DATA, FEAT, DJ
    ap = argparse.ArgumentParser()
    ap.add_argument("--dj", choices=sorted(PREFIX), default="gabry")
    ap.add_argument("--window", type=int, default=MAX_BEATS, help="finestra massima in battute (128 = come fino alla v4)")
    ap.add_argument("--no-features", action="store_true", help="non ricalcolare le caratteristiche mancanti")
    args = ap.parse_args()
    DJ, DATA = args.dj, ML_DIR / "data" / args.dj
    FEAT = DATA / "features"
    win = args.window
    if not args.no_features:
        features()
    lists = json.loads((DATA / "tracklists.json").read_text())
    kept = []
    for key, mix in lists.items():
        if not (FEAT / f"mix-{key}.npz").exists():
            continue
        tr, al = build(key, mix, win)
        good = [t for t in al["tracks"] if not t.get("failed")]
        base = [t for t in tr if t["kind"] == "inizio-0"]
        ok = {t["posA"] for t in base if t["fitError"] <= MAX_FIT}
        print(f"== {key}: {len(good)} brani allineati su {len(mix['tracks'])}, {len(base)} transizioni, {len(ok)} con fit <= {MAX_FIT}")
        for t in base:
            dt = f"{t['halfTime'] - t['cueB']:+6.1f} s" if t["halfTime"] is not None and t["cueB"] is not None else "   n/d  "
            print(f"  {t['posA'] + 1:2d}->{t['posA'] + 2:2d}  battute {t['rawLength']:3d}  fit {t['fitError']:.3f}  "
                  f"zA {t['zA']:.1f} zB {t['zB']:.1f}  metà crossfader - cue {dt}")
        kept += [t for t in tr if t["posA"] in ok]
    if not kept:
        raise SystemExit("nessuna transizione affidabile")
    out = DATA / ("transitions.npz" if win == MAX_BEATS else f"transitions-{win}.npz")
    np.savez_compressed(out, **pack(kept))
    base = [t for t in kept if t["kind"] == "inizio-0"]
    raw = [t["rawLength"] for t in base]
    dts = [abs(t["halfTime"] - t["cueB"]) for t in base if t["halfTime"] is not None and t["cueB"] is not None]
    print(f"{len(base)} transizioni tenute ({len(kept)} finestre); durata completa: mediana {np.median(raw):.0f} battute "
          f"(min {min(raw)}, max {max(raw)}); fit mediano {np.median([t['fitError'] for t in base]):.3f}"
          + (f"; metà crossfader - cue: mediana {np.median(dts):.1f} s su {len(dts)}" if dts else ""))


if __name__ == "__main__":
    main()
