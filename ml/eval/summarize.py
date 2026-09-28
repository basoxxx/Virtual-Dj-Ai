"""Riassume i risultati del banco di prova Electron (ml/data/reference/electron-*.json).

Metriche per configurazione:
  bpm±0.5   BPM entro 0,5 dal valore dichiarato dall'autore (incompetech)
  acc2      come sopra ma entro il 4% e ammettendo metà/doppio/triplo/terzo (errori d'ottava)
  gridF     F-measure (±70 ms) della griglia offset + k·60/BPM contro le battute di riferimento
  downbeat  quota di brani il cui offset cade (±70 ms) su una battuta forte di riferimento
  s/5min    tempo di analisi riportato a un brano di 5 minuti (mediana)
  RAM       picco del processo renderer (con i worker) e di tutti i processi dell'app

Uso:  ml/.venv/bin/python ml/eval/summarize.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "eval"))

import numpy as np  # noqa: E402

from beat_parity import f_measure  # noqa: E402

REF = ML_DIR / "data" / "reference"


def grid_times(bpm, offset, end):
    period = 60 / bpm
    first = offset - np.floor(offset / period) * period
    return np.arange(first, end, period)


def acc2(est, true):
    return any(abs(est - true * f) <= 0.04 * true * f for f in (1, 2, 0.5, 3, 1 / 3))


def on_downbeat(offset, downbeats, tol=0.07):
    d = np.asarray(downbeats)
    return bool(len(d)) and float(np.min(np.abs(d - offset))) <= tol


def summarize(path: Path, refs: dict) -> dict:
    data = json.loads(path.read_text())
    rows = data["results"]
    ok = [r for r in rows if r.get("bpm")]
    grid_f, down, exact, a2, secs = [], [], [], [], []
    for r in ok:
        ref = refs[r["file"]]
        end = ref["beats"][-1] + 0.5 if ref["beats"] else r["seconds"]
        grid_f.append(f_measure(ref["beats"], grid_times(r["bpm"], r["offset"], end)))
        # l'offset è la prima battuta forte della griglia: basta confrontarlo con le prime battute forti
        down.append(on_downbeat(r["offset"], [d for d in ref["downbeats"] if d < 30]))
        exact.append(abs(r["bpm"] - r["trueBpm"]) <= 0.5)
        a2.append(acc2(r["bpm"], r["trueBpm"]))
        secs.append(r["ms"] / 1000 * 300 / max(1, r["seconds"]))
    return {
        "config": data["engine"] + (f" {data['model'].replace('beat_this-', '').replace('.onnx', '')}" if data.get("model") else ""),
        "tracks": len(rows),
        "aiFallbacks": sum(1 for r in rows if data["engine"] == "ai" and r.get("engine") != "ai"),
        "bpm±0.5": f"{sum(exact)}/{len(ok)}",
        "acc2": f"{sum(a2)}/{len(ok)}",
        "gridF": round(float(np.mean(grid_f)), 3),
        "downbeat": f"{sum(down)}/{len(ok)}",
        "s/5min": round(float(np.median(secs)), 1),
        "s/5minMax": round(float(np.max(secs)), 1),
        "RAMrendererMB": max(r["peakRendererMB"] for r in rows),
        "RAMtotalMB": max(r["peakTotalMB"] for r in rows),
        "baselineRendererMB": data["baselineRendererMB"],
        "baselineTotalMB": data["baselineTotalMB"],
        "crossOriginIsolated": data.get("crossOriginIsolated"),
        "wrongBpm": [f"{r['file']}: {r['bpm']} (vero {r['trueBpm']})" for r in ok if abs(r["bpm"] - r["trueBpm"]) > 0.5],
    }


def main():
    refs = json.loads((REF / "cc_beats.json").read_text())
    order = ["classic", "ai-beat_this-small0-int8", "ai-beat_this-small0", "ai-beat_this-final0-int8", "ai-beat_this-final0"]
    out = []
    for name in order:
        p = REF / f"electron-{name}.json"
        if p.exists():
            s = summarize(p, refs)
            out.append(s)
            print(json.dumps({k: v for k, v in s.items() if k != "wrongBpm"}, ensure_ascii=False))
            for w in s["wrongBpm"]:
                print("   ", w)
    (REF / "summary.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
