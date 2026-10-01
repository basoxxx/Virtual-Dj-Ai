"""Taratura della soglia delle battute forti sulla validazione (mai sui dati di prova) e checkpoint corretto.

Il modello rifinito trova più battute forti del dovuto (su Gand: precisione giù, richiamo su). La testa di
Beat This! (SumHead) dà downbeat = d e beat = b + d: aggiungere δ al bias di d e togliere δ a quello di b sposta
solo la soglia delle battute forti, senza cambiare architettura né interfaccia ONNX. δ si sceglie sui brani di
validazione (usb e jamendo "val") massimizzando la F-measure delle battute forti contro le etichette di labels.py.

Uso:  ml/.venv/bin/python ml/beat_this/calibrate.py --pred candA-int8 --ckpt ml/data/beat_this/runs/A/best.ckpt
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
    a = ap.parse_args()
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
        ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
        key = "model.task_heads.beat_downbeat_lin.bias"
        bias = ck["state_dict"][key].clone()
        bias[1] += best[0]
        bias[0] -= best[0]
        ck["state_dict"][key] = bias
        ck["calibration_delta"] = best[0]
        out = Path(a.ckpt).with_name(Path(a.ckpt).stem + "-cal.ckpt")
        torch.save(ck, out)
        print("scritto", out)


if __name__ == "__main__":
    main()
