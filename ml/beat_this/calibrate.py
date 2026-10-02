"""Taratura della soglia delle battute forti sulla validazione (mai sui dati di prova) e checkpoint corretto.

Il modello rifinito trova più battute forti del dovuto (su Gand: precisione giù, richiamo su). La testa di
Beat This! (SumHead) dà downbeat = d e beat = b + d: aggiungere δ al bias di d e togliere δ a quello di b sposta
solo la soglia delle battute forti, senza cambiare architettura né interfaccia ONNX. δ si sceglie sui brani di
validazione (usb e jamendo "val") massimizzando la F-measure delle battute forti contro le etichette di labels.py.

Uso:  ml/.venv/bin/python ml/beat_this/calibrate.py --pred candA-int8 --ckpt ml/data/beat_this/runs/A/best.ckpt
      ml/.venv/bin/python ml/beat_this/calibrate.py --pred C-int8 --ckpt .../runs/C/best.ckpt --human set123 setncs
      -> stampa la curva, scrive <ckpt>-cal.ckpt con il δ migliore
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", required=True, help="cartella in pred/ con i logit dei brani di validazione")
    ap.add_argument("--ckpt", help="checkpoint da correggere")
    ap.add_argument("--human", nargs="*", help="round 2: taratura sui set di Gand indicati (fase della battuta "
                    "forte + F battute forti contro i warp marker) invece che sulle etichette dell'insegnante")
    a = ap.parse_args()
    if a.human:
        best = calibrate_human(a.pred, a.human)
        if a.ckpt:
            write_ckpt(a.ckpt, best[0])
        return
    labels = json.loads((C.DATA / "labels.json").read_text())
    val = sorted(k for k, v in labels.items() if v["split"] == "val" and (C.DATA / "pred" / a.pred / f"{k}.npz").exists())
    data = {}
    for tid in val:
        with np.load(C.DATA / "pred" / a.pred / f"{tid}.npz") as z:
            data[tid] = (z["beat"].astype(np.float32), z["downbeat"].astype(np.float32))
    best = None
    for delta in np.arange(-3.0, 1.01, 0.25):
        fd, fdt = [], []
        for tid, (b, d) in data.items():
            # stesso δ come lo darebbe la testa corretta: battute invariate, battute forti spostate
            _, down = C.ref.postprocess(b, d + delta)
            fd.append(C.f_measure(labels[tid]["downbeats"], down))
            with np.load(C.DATA / "pred" / "final0" / f"{tid}.npz") as z:
                fdt.append(C.f_measure(z["downbeats"], down))
        m, mt = float(np.mean(fd)), float(np.mean(fdt))
        print(f"δ {delta:+.2f}: F battute forti contro etichette {m:.4f}, contro final0 {mt:.4f}", flush=True)
        if best is None or m > best[1]:
            best = (float(delta), m)
    print(f"migliore δ = {best[0]:+.2f} ({len(val)} brani di validazione)")
    if a.ckpt:
        write_ckpt(a.ckpt, best[0])


def calibrate_human(pred: str, sets: list[str]):
    items = [it for it in C.load_inventory() if it["source"] == "gand" and it["set"] in sets]
    data = {}
    for it in items:
        s = np.load(C.spect_path(it["id"]))
        with np.load(C.DATA / "pred" / pred / f"{it['id']}.npz") as z:
            data[it["id"]] = (z["beat"].astype(np.float32), z["downbeat"].astype(np.float32), C.gand_truth(it, s))
    best, zero = None, None
    for delta in np.arange(-2.0, 1.01, 0.25):
        preds, fd = {}, []
        for it in items:
            b, d, (tb, td) = data[it["id"]]
            beats, down = C.ref.postprocess(b, d + delta)
            preds[it["id"]] = {"beats": beats, "downbeats": down}
            fd.append(C.f_measure(td, down))
        g = C.app_grids(preds)
        phase = [C.ok_bpm(g[it["id"]]["bpm"], 60 / it["period"]) and
                 C.grid_phase_ok(g[it["id"]]["bpm"], g[it["id"]]["offset"], it["period"], it["sec0"]) for it in items]
        score = float(np.mean(phase) + np.mean(fd))
        print(f"δ {delta:+.2f}: fase {sum(phase)}/{len(items)}, F battute forti {np.mean(fd):.4f}, punteggio {score:.4f}")
        # a parità di punteggio vince il δ più vicino a 0
        if best is None or score > best[1] + 1e-9 or (abs(score - best[1]) <= 1e-9 and abs(delta) < abs(best[0])):
            best = (float(delta), score)
        if abs(delta) < 1e-9:
            zero = (0.0, score)
    # regola fissata prima: si sposta la soglia solo se il punteggio sale di almeno 0,01 (sotto è rumore)
    if best[1] - zero[1] < 0.01:
        best = zero
    print(f"δ scelto = {best[0]:+.2f} ({len(items)} brani di Gand: {', '.join(sets)}; si cambia solo se +0,01)")
    return best


def write_ckpt(path: str, delta: float):
    """Copia del checkpoint con la soglia delle battute forti spostata di δ (bias della SumHead)."""
    ck = torch.load(path, map_location="cpu", weights_only=False)
    key = "model.task_heads.beat_downbeat_lin.bias"
    bias = ck["state_dict"][key].clone()
    bias[1] += delta
    bias[0] -= delta
    ck["state_dict"][key] = bias
    ck["calibration_delta"] = delta
    out = Path(path).with_name(Path(path).stem + "-cal.ckpt")
    torch.save(ck, out)
    print("scritto", out)


if __name__ == "__main__":
    main()
