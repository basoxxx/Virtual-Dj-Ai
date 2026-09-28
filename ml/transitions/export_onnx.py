"""Esporta il modello C (pianificatore delle transizioni) in ONNX fp32 e int8 e salva i riferimenti per i test JS.

Ingressi: x (1, 128, 35), mask (1, 128) float (1 = battuta valida). Uscita: controls (1, 128, 9).
File: ml/data/onnx/<nome>.onnx e <nome>-int8.onnx; riferimenti in test/fixtures/transition-model/.

Uso:  ml/.venv/bin/python ml/transitions/export_onnx.py [--ckpt ml/data/runs/planner-v2.pt --name transition-planner-v2]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.quantization.shape_inference import quant_pre_process

ML_DIR = Path(__file__).resolve().parents[1]
REPO = ML_DIR.parent
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import N_IN, deck_block  # noqa: E402
from model import MAX_BEATS, TransitionPlanner  # noqa: E402

ONNX_DIR = ML_DIR / "data" / "onnx"
FIX = REPO / "test" / "fixtures" / "transition-model"


class Wrapper(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x, mask):
        return self.net(x, mask)


def deck_block_fixture(rng) -> dict:
    L = 40
    t = np.sort(rng.uniform(-2, 250, L))
    wave = rng.uniform(0, 1, (L, 4)).astype(np.float32)
    pos = rng.integers(0, 4, L)
    bar = rng.integers(-3, 70, L)
    present = rng.random(L) > 0.15
    out = deck_block(t, wave, pos, bar, 240.0, present)
    return {"t": t.tolist(), "wave": wave.reshape(-1).tolist(), "pos": pos.tolist(), "bar": bar.tolist(),
            "duration": 240.0, "present": present.tolist(), "expected": out.reshape(-1).tolist()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=str(ML_DIR / "data" / "runs" / "transition-planner.pt"))
    ap.add_argument("--name", default="transition-planner-v1", help="nome dei file ONNX (senza estensione)")
    args = ap.parse_args()
    net = TransitionPlanner(N_IN)
    net.load_state_dict(torch.load(args.ckpt, map_location="cpu"))
    net.eval()
    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    fp32 = ONNX_DIR / f"{args.name}.onnx"
    int8 = ONNX_DIR / f"{args.name}-int8.onnx"
    x = torch.zeros(1, MAX_BEATS, N_IN)
    mask = torch.ones(1, MAX_BEATS)
    with torch.inference_mode():
        # il wrapper va messo in valutazione: a fine export torch ripristina la sua modalità su tutto il modello
        torch.onnx.export(Wrapper(net).eval(), (x, mask), str(fp32), input_names=["x", "mask"], output_names=["controls"],
                          opset_version=17, do_constant_folding=True, dynamo=False)
    net.eval()
    onnx.checker.check_model(str(fp32))
    pre = ONNX_DIR / f"{args.name}-pre.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    quantize_dynamic(str(pre), str(int8), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"],
                     per_channel=True, extra_options={"MatMulConstBOnly": True})
    pre.unlink()

    # parità su transizioni reali (se il dataset c'è) o su ingressi casuali
    rng = np.random.default_rng(0)
    data_path = ML_DIR / "data" / "djmix" / "transitions.npz"
    if data_path.exists():
        d = np.load(data_path)
        X, M = d["X"][:16], d["mask"][:16].astype(np.float32)
        # dataset da 128 battute, modello dalla v5 da 256: battute in più a zero e fuori dalla maschera
        pad = MAX_BEATS - X.shape[1]
        if pad > 0:
            X = np.pad(X, ((0, 0), (0, pad), (0, 0)))
            M = np.pad(M, ((0, 0), (0, pad)))
    else:
        X = rng.normal(0, 1, (16, MAX_BEATS, N_IN)).astype(np.float32)
        M = np.ones((16, MAX_BEATS), np.float32)
    with torch.inference_mode():
        ref = net(torch.from_numpy(X), torch.from_numpy(M)).numpy()
    report = {"fp32MB": round(fp32.stat().st_size / 1e6, 2), "int8MB": round(int8.stat().st_size / 1e6, 2)}
    outs = {}
    for name, path in (("fp32", fp32), ("int8", int8)):
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        outs[name] = np.concatenate([sess.run(["controls"], {"x": X[i:i + 1], "mask": M[i:i + 1]})[0] for i in range(len(X))])
        err = np.abs(outs[name] - ref)[M.astype(bool)]
        report[f"{name}MaxErr"] = round(float(err.max()), 5)
        report[f"{name}MeanErr"] = round(float(err.mean()), 5)
    print(json.dumps(report))

    FIX.mkdir(parents=True, exist_ok=True)
    fx = {"deckBlock": deck_block_fixture(rng), "report": report,
          "model": {"x": X[0].reshape(-1).tolist(), "mask": M[0].tolist(),
                    "fp32": outs["fp32"][0].reshape(-1).tolist(), "int8": outs["int8"][0].reshape(-1).tolist()}}
    (FIX / "reference.json").write_text(json.dumps(fx))


if __name__ == "__main__":
    main()
