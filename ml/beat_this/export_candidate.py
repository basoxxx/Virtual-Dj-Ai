"""Esporta il candidato rifinito in ONNX esattamente come export_onnx.py esporta small0 e controlla la parità.

  ml/data/onnx/segueo-analisi-battute-v2-fp32.onnx   fp32, ingresso fisso (1, 1500, 128), uscite "beat", "downbeat"
  ml/data/onnx/segueo-analisi-battute-v2.onnx        int8 dinamico dei MatMul/Gemm (come il modello incluso oggi)

Controlli: stessi ingressi/uscite e stessi operatori del modello incluso (beat_this-small0-int8.onnx), errore dei
logit fp32 contro PyTorch e F-measure (±70 ms) delle battute int8 contro PyTorch sui 25 brani CC (come
beat_parity.py), dimensioni e SHA-256. Non tocca test/ né src/.

Uso:  ml/.venv/bin/python ml/beat_this/export_candidate.py ml/data/beat_this/runs/<run>/best.ckpt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402
from onnxruntime.quantization.shape_inference import quant_pre_process  # noqa: E402
from rotary_embedding_torch import RotaryEmbedding  # noqa: E402

from beat_this.inference import load_model  # noqa: E402
from export_onnx import BeatThisOnnx  # noqa: E402

OUT_INT8 = C.ONNX_DIR / "segueo-analisi-battute-v2.onnx"
OUT_FP32 = C.ONNX_DIR / "segueo-analisi-battute-v2-fp32.onnx"
SHIPPED = C.ONNX_DIR / "segueo" / "segueo-analisi-battute.onnx"


def export(ckpt: str, fp32: Path, int8: Path):
    model = load_model(ckpt, "cpu")
    for m in model.modules():
        if isinstance(m, RotaryEmbedding):
            m.cache_if_possible = False
    wrapper = BeatThisOnnx(model).eval()
    torch.manual_seed(0)
    dummy = torch.randn(1, C.ref.CHUNK, 128)
    with torch.inference_mode():
        torch.onnx.export(wrapper, (dummy,), str(fp32), input_names=["spect"], output_names=["beat", "downbeat"],
                          opset_version=17, do_constant_folding=True, dynamo=False)
    onnx.checker.check_model(str(fp32))
    pre = fp32.with_name(fp32.stem + "-pre.onnx")
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    quantize_dynamic(str(pre), str(int8), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"],
                     per_channel=True, extra_options={"MatMulConstBOnly": True})
    pre.unlink()
    return model


def signature(path: Path) -> dict:
    m = onnx.load(str(path))
    io = lambda vs: [(v.name, [d.dim_value for d in v.type.tensor_type.shape.dim]) for v in vs]  # noqa: E731
    return {"inputs": io(m.graph.input), "outputs": io(m.graph.output), "opset": m.opset_import[0].version,
            "ops": dict(sorted(Counter(n.op_type for n in m.graph.node).items()))}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--name", default="", help="esporta come beat_this-<name>(-int8).onnx invece che come candidato v2")
    a = ap.parse_args()
    global OUT_INT8, OUT_FP32
    if a.name:
        OUT_INT8, OUT_FP32 = C.ONNX_DIR / f"beat_this-{a.name}-int8.onnx", C.ONNX_DIR / f"beat_this-{a.name}.onnx"
    model = export(a.ckpt, OUT_FP32, OUT_INT8)
    report = {"ckpt": a.ckpt}
    s_new, s_old = signature(OUT_INT8), signature(SHIPPED)
    report["same_interface"] = s_new["inputs"] == s_old["inputs"] and s_new["outputs"] == s_old["outputs"]
    report["same_ops"] = s_new["ops"] == s_old["ops"]
    report["interface"] = {k: s_new[k] for k in ("inputs", "outputs", "opset")}
    if not report["same_ops"]:
        report["ops_new"], report["ops_old"] = s_new["ops"], s_old["ops"]

    # parità sui 25 brani CC
    cc = [it for it in C.load_inventory() if it["source"] == "cc"]
    run_torch = C.ref.torch_runner(model)
    sess = {v: ort.InferenceSession(str(p), providers=["CPUExecutionProvider"]) for v, p in (("fp32", OUT_FP32), ("int8", OUT_INT8))}
    errs = {"fp32": [], "int8": []}
    fb = {"fp32": [], "int8": []}
    fdb = {"fp32": [], "int8": []}
    for it in cc:
        spect = C.load_spect(it["id"])
        tl = C.ref.predict_logits(spect, run_torch)
        tb, tdb = C.ref.postprocess(*tl)
        for v, s in sess.items():
            ol = C.ref.predict_logits(spect, C.ref.onnx_runner(s))
            ob, odb = C.ref.postprocess(*ol)
            errs[v].append(max(float(np.abs(ol[0] - tl[0]).max()), float(np.abs(ol[1] - tl[1]).max())))
            fb[v].append(C.f_measure(tb, ob))
            fdb[v].append(C.f_measure(tdb, odb))
    for v in ("fp32", "int8"):
        report[v] = {"maxLogitErr": round(max(errs[v]), 5), "medianMaxLogitErr": round(float(np.median(errs[v])), 5),
                     "beatF": round(float(np.mean(fb[v])), 4), "beatFmin": round(float(np.min(fb[v])), 4),
                     "downbeatF": round(float(np.mean(fdb[v])), 4), "downbeatFmin": round(float(np.min(fdb[v])), 4)}
    for p in (OUT_INT8, OUT_FP32, SHIPPED):
        report[p.name] = {"bytes": p.stat().st_size, "sha256": sha256(p)}
    (C.DATA / f"export{'-' + a.name if a.name else ''}.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
