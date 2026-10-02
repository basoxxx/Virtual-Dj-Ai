"""Punteggio di validazione umana (round 2) dei modelli in pred/: solo i set di validazione di Gand (set123,
setncs) e il freno sulla validazione usb/jamendo contro final0. Non stampa nulla dei dati di prova.

Uso:  ml/.venv/bin/python ml/beat_this/val_scores.py small0-int8 candD-int8 candDcal-int8 ...
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import evaluate as E  # noqa: E402

import numpy as np  # noqa: E402


def main():
    inv = C.load_inventory()
    val_ids = [it["id"] for it in inv if it["split"] == "val" and C.spect_path(it["id"]).exists()]
    teacher = E.load_preds("final0", val_ids)
    tg = C.app_grids(teacher)
    gand = [it for it in inv if it["source"] == "gand" and it["set"] in E.GAND_VAL]
    for name in sys.argv[1:]:
        preds = E.load_preds(name, [it["id"] for it in gand])
        g = C.app_grids(preds)
        fb, fd, ph = [], [], []
        for it in gand:
            s = np.load(C.spect_path(it["id"]))
            tb, td = C.gand_truth(it, s)
            fb.append(C.f_measure(tb, preds[it["id"]]["beats"]))
            fd.append(C.f_measure(td, preds[it["id"]]["downbeats"]))
            gg = g[it["id"]]
            ph.append(C.ok_bpm(gg["bpm"], 60 / it["period"]) and C.grid_phase_ok(gg["bpm"], gg["offset"], it["period"], it["sec0"]))
        line = (f"{name:16s} Gand val ({len(gand)}): F battute {np.mean(fb):.4f}  F forti {np.mean(fd):.4f}  "
                f"fase {sum(ph)}  punteggio {np.mean(ph) + np.mean(fd) + np.mean(fb):.4f}")
        vp = E.load_preds(name, val_ids)
        if len(vp) == len(val_ids):
            vg = C.app_grids(vp)
            ks = [k for k in val_ids if tg[k]["bpm"]]
            same = [C.ok_bpm(vg[k]["bpm"], tg[k]["bpm"]) for k in ks]
            phase = [s_ and C.grid_phase_ok(vg[k]["bpm"], vg[k]["offset"], 60 / tg[k]["bpm"], tg[k]["offset"])
                     for s_, k in zip(same, ks)]
            line += f" | freno val ({len(ks)}): stesso BPM {sum(same)}  stessa fase {sum(phase)}"
        print(line)


if __name__ == "__main__":
    main()
