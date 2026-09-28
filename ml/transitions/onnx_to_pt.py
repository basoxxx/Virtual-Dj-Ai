"""Ricava il checkpoint PyTorch del modello C da un file ONNX fp32 pubblicato (release models-v1), per
ripartire da una versione già rilasciata anche su un computer che non ha i .pt originali.

I pesi dei layer lineari sono esportati come costanti trasposte dei MatMul, nell'ordine del forward: si
assegnano in quell'ordine e si verifica che l'uscita coincida con onnxruntime.

Uso:  ml/.venv/bin/python ml/transitions/onnx_to_pt.py ml/data/onnx/transition-planner-v4.onnx ml/data/runs/planner-v4.pt
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import numpy_helper

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import N_IN  # noqa: E402
from model import TransitionPlanner  # noqa: E402


def convert(onnx_path: Path) -> dict:
    m = onnx.load(str(onnx_path))
    inits = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
    net = TransitionPlanner(N_IN, max_beats=inits["net.pos"].shape[1])
    sd = net.state_dict()
    out = {}
    for k in sd:
        if f"net.{k}" in inits:
            out[k] = torch.from_numpy(inits[f"net.{k}"].copy())
    linear = [k for k in sd if k.endswith(".weight") and sd[k].ndim == 2]
    mats = [n.input[1] for n in m.graph.node if n.op_type == "MatMul" and n.input[1] in inits]
    if len(mats) != len(linear):
        raise SystemExit(f"{len(mats)} MatMul costanti contro {len(linear)} layer lineari")
    for k, name in zip(linear, mats):
        w = inits[name].T
        if w.shape != tuple(sd[k].shape):
            raise SystemExit(f"forma diversa per {k}: {w.shape} contro {tuple(sd[k].shape)}")
        out[k] = torch.from_numpy(w.copy())
    net.load_state_dict(out)
    net.eval()
    L = inits["net.pos"].shape[1]
    rng = np.random.default_rng(0)
    x = rng.normal(0, 1, (1, L, N_IN)).astype(np.float32)
    mask = np.ones((1, L), np.float32)
    mask[0, L // 2:] = 0
    ref = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"]).run(None, {"x": x, "mask": mask})[0]
    with torch.no_grad():
        got = net(torch.from_numpy(x), torch.from_numpy(mask)).numpy()
    err = float(np.abs(got - ref)[0, : L // 2].max())
    print(f"{onnx_path.name}: errore massimo contro onnxruntime {err:.2e}")
    if err > 1e-4:
        raise SystemExit("i pesi ricavati non riproducono il modello ONNX")
    return out


if __name__ == "__main__":
    torch.save(convert(Path(sys.argv[1])), sys.argv[2])
