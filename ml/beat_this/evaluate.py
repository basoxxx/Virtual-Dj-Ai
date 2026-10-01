"""Confronto tra modelli Beat This! sui dati tenuti da parte (mai usati per addestrare né per scegliere il modello).

Previsioni da ml/data/beat_this/pred/<nome>/ (infer.py); griglia dell'app = beatGrid() di beat-this.js in Node.

  cc     25 brani di Kevin MacLeod: BPM ±0,5 e acc2 contro il BPM dell'autore, battuta forte (offset entro ±70 ms
         da una battuta forte di riferimento dei primi 30 s, riferimento = final0 fp32 come in summarize.py),
         griglia F (griglia dell'app contro le battute di final0, ±70 ms)
  tag    brani della chiavetta con tag BPM affidabile (usb_bpm.py): ±0,5 e a meno di metà/doppio (anche 2/3, 3/2)
  gand   62 brani dei set di Gand con la griglia dei warp marker (estesa al tratto udibile del brano):
         F battute e battute forti (±70 ms, primi 5 s esclusi); anche sul sottoinsieme "verificato" senza modelli
         (attacco della cassa, flusso delle bande basse ripiegato sul periodo, entro ±25 ms dalla griglia), BPM dell'app ±0,5 e acc2, fase della battuta forte della griglia dell'app (±70 ms)
  usb    brani della chiavetta tenuti fuori ("test"): accordo con final0 (F battute e battute forti, stesso BPM
         dell'app ±0,5, stessa fase della battuta forte)

Uso:  ml/.venv/bin/python ml/beat_this/evaluate.py small0-int8 final0 cand-int8 [--gand-check final0] [--out f.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402

PRED = C.DATA / "pred"
CC_REF = C.ML_DIR / "data" / "reference" / "cc_beats.json"


def ok_tag2(est, ref):
    """Come ok2 di usb_bpm.py: entro il 4% ammettendo metà, doppio, 2/3 e 3/2."""
    return bool(est) and any(abs(est - ref * f) <= 0.04 * ref * f for f in (1, 2, 0.5, 2 / 3, 1.5))


def grid_times(bpm, offset, end):
    period = 60 / bpm
    first = offset - np.floor(offset / period) * period
    return np.arange(first, end, period)


def load_preds(name: str, ids) -> dict:
    out = {}
    for tid in ids:
        p = PRED / name / f"{tid}.npz"
        if p.exists():
            with np.load(p) as z:
                out[tid] = {"beats": z["beats"].astype(float), "downbeats": z["downbeats"].astype(float)}
    return out


def evaluate(name: str, inv: list[dict], teacher: dict, teacher_grid: dict, gand_check=False) -> dict:
    by = {s: [it for it in inv if it["split"] == s[1] and it["source"] == s[0]]
          for s in (("cc", "test"), ("usb", "tag"), ("gand", "test"), ("usb", "test"))}
    ids = [it["id"] for v in by.values() for it in v]
    preds = load_preds(name, ids)
    grids = C.app_grids(preds)
    res = {}

    # set CC
    cc_ref = json.loads(CC_REF.read_text())
    rows = []
    for it in by[("cc", "test")]:
        g = grids.get(it["id"])
        if not g:
            continue
        r = cc_ref[Path(it["path"]).name]
        end = r["beats"][-1] + 0.5
        rows.append({"title": it["title"], "bpm": g["bpm"], "true": it["bpm"], "conf": g["confidence"],
                     "ok": C.ok_bpm(g["bpm"], it["bpm"]), "acc2": C.ok_acc2(g["bpm"], it["bpm"]),
                     "down": C.on_downbeat(g["offset"], r["downbeats"]),
                     "gridF": C.f_measure(r["beats"], grid_times(g["bpm"], g["offset"], end)) if g["bpm"] else 0.0})
    res["cc"] = {"n": len(rows), "bpm05": sum(r["ok"] for r in rows), "acc2": sum(r["acc2"] for r in rows),
                 "downbeat": sum(r["down"] for r in rows), "gridF": float(np.mean([r["gridF"] for r in rows])),
                 "wrong": [f"{r['title']}: {r['bpm']} (autore {r['true']}, conf {r['conf']:.2f})" for r in rows if not r["ok"]]}

    # tag della chiavetta
    rows = []
    for it in by[("usb", "tag")]:
        g = grids.get(it["id"])
        if g is None:
            continue
        rows.append({"ok": C.ok_bpm(g["bpm"], it["bpm"]), "ok2": ok_tag2(g["bpm"], it["bpm"]),
                     "name": Path(it["path"]).name, "bpm": g["bpm"], "tag": it["bpm"]})
    res["tag"] = {"n": len(rows), "bpm05": sum(r["ok"] for r in rows), "acc2": sum(r["ok2"] for r in rows),
                  "wrong": [f"{r['name'][:40]}: {r['bpm']} (tag {r['tag']})" for r in rows if not r["ok"]]}

    # Gand
    rows = []
    for it in by[("gand", "test")]:
        p = preds.get(it["id"])
        if p is None:
            continue
        spect = np.load(C.spect_path(it["id"]))
        dur = len(spect) / C.FPS
        tb, td = C.gand_truth(it, spect)
        g = grids[it["id"]]
        true_bpm = 60 / it["period"]
        row = {"name": Path(it["path"]).name, "set": it["set"], "kick_ms": C.kick_offset(it, spect),
               "F_beat": C.f_measure(tb, p["beats"]),
               "F_down": C.f_measure(td, p["downbeats"]), "bpm": g["bpm"], "true": round(true_bpm, 3),
               "ok": C.ok_bpm(g["bpm"], true_bpm), "acc2": C.ok_acc2(g["bpm"], true_bpm),
               "phase": C.grid_phase_ok(g["bpm"], g["offset"], it["period"], it["sec0"]) if C.ok_bpm(g["bpm"], true_bpm) else False,
               "gridF": C.f_measure(tb, grid_times(g["bpm"], g["offset"], dur)) if g["bpm"] else 0.0}
        if gand_check:
            # scarto con segno tra le battute del modello e la griglia vera (solo battute vicine)
            b = p["beats"][(p["beats"] > tb[0] - 0.1) & (p["beats"] < tb[-1] + 0.1)]
            k = np.round((b - it["sec0"]) / it["period"])
            d = b - it["sec0"] - k * it["period"]
            d = d[np.abs(d) < 0.07]
            row["median_ms"] = round(1000 * float(np.median(d)), 1) if len(d) else None
            row["on_grid"] = round(len(d) / max(1, len(b)), 3)
        rows.append(row)
    res["gand"] = {"n": len(rows), "F_beat": float(np.mean([r["F_beat"] for r in rows])),
                   "F_down": float(np.mean([r["F_down"] for r in rows])), "bpm05": sum(r["ok"] for r in rows),
                   "acc2": sum(r["acc2"] for r in rows), "phase": sum(r["phase"] for r in rows),
                   "gridF": float(np.mean([r["gridF"] for r in rows])),
                   "per_set": {s: {"n": sum(r["set"] == s for r in rows),
                                   "F_beat": float(np.mean([r["F_beat"] for r in rows if r["set"] == s])),
                                   "F_down": float(np.mean([r["F_down"] for r in rows if r["set"] == s]))}
                               for s in sorted({r["set"] for r in rows})},
                   "wrong": [f"{r['name'][:40]}: {r['bpm']} (vero {r['true']})" for r in rows if not r["ok"]]}
    # brani con i warp marker verificati senza modelli: attacco della cassa entro ±25 ms dalla griglia
    ver = [r for r in rows if abs(r["kick_ms"]) <= 25]
    res["gand_ok"] = {"n": len(ver), "F_beat": float(np.mean([r["F_beat"] for r in ver])),
                      "F_down": float(np.mean([r["F_down"] for r in ver])), "bpm05": sum(r["ok"] for r in ver),
                      "phase": sum(r["phase"] for r in ver), "gridF": float(np.mean([r["gridF"] for r in ver]))}
    if gand_check:
        res["gand"]["rows"] = rows

    # musica dell'utente tenuta fuori: accordo con final0
    rows = []
    for it in by[("usb", "test")]:
        p, t = preds.get(it["id"]), teacher.get(it["id"])
        if p is None or t is None:
            continue
        g, gt = grids[it["id"]], teacher_grid[it["id"]]
        same = C.ok_bpm(g["bpm"], gt["bpm"]) if gt["bpm"] else False
        rows.append({"F_beat": C.f_measure(t["beats"], p["beats"]), "F_down": C.f_measure(t["downbeats"], p["downbeats"]),
                     "bpm": same, "phase": same and C.grid_phase_ok(g["bpm"], g["offset"], 60 / gt["bpm"], gt["offset"]),
                     "conf": g["confidence"]})
    res["usb"] = {"n": len(rows), "F_beat": float(np.mean([r["F_beat"] for r in rows])),
                  "F_down": float(np.mean([r["F_down"] for r in rows])), "bpm": sum(r["bpm"] for r in rows),
                  "phase": sum(r["phase"] for r in rows), "conf": float(np.mean([r["conf"] for r in rows]))}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+")
    ap.add_argument("--teacher", default="final0")
    ap.add_argument("--gand-check", action="store_true")
    ap.add_argument("--out", default=str(C.DATA / "eval.json"))
    a = ap.parse_args()
    inv = C.load_inventory()
    test_ids = [it["id"] for it in inv if it["source"] == "usb" and it["split"] == "test"]
    teacher = load_preds(a.teacher, test_ids)
    teacher_grid = C.app_grids(teacher)
    out = {}
    for name in a.models:
        r = evaluate(name, inv, teacher, teacher_grid, a.gand_check)
        out[name] = r
        cc, tg, gd, us = r["cc"], r["tag"], r["gand"], r["usb"]
        print(f"\n== {name}")
        print(f"CC ({cc['n']}): bpm±0,5 {cc['bpm05']}  acc2 {cc['acc2']}  battuta forte {cc['downbeat']}  griglia F {cc['gridF']:.3f}")
        print("   sbagliati:", "; ".join(cc["wrong"]))
        print(f"tag chiavetta ({tg['n']}): ±0,5 {tg['bpm05']}  metà/doppio {tg['acc2']}")
        print(f"Gand ({gd['n']}): F battute {gd['F_beat']:.4f}  F battute forti {gd['F_down']:.4f}  BPM ±0,5 {gd['bpm05']}  "
              f"acc2 {gd['acc2']}  fase battuta forte {gd['phase']}  griglia F {gd['gridF']:.4f}")
        print("   per set:", ", ".join(f"{s} {v['F_beat']:.3f}/{v['F_down']:.3f}" for s, v in gd["per_set"].items()))
        go = r["gand_ok"]
        print(f"Gand con marker verificati ({go['n']}): F battute {go['F_beat']:.4f}  F battute forti {go['F_down']:.4f}  "
              f"BPM ±0,5 {go['bpm05']}  fase battuta forte {go['phase']}  griglia F {go['gridF']:.4f}")
        if gd["wrong"]:
            print("   BPM sbagliati:", "; ".join(gd["wrong"]))
        print(f"chiavetta tenuta fuori ({us['n']}), accordo con {a.teacher}: F battute {us['F_beat']:.4f}  "
              f"F battute forti {us['F_down']:.4f}  stesso BPM {us['bpm']}  stessa fase {us['phase']}  conf media {us['conf']:.3f}")
        if a.gand_check:
            for row in sorted(gd["rows"], key=lambda r: r["F_beat"]):
                print(f"   {row['set']} {row['name'][:45]:45s} F {row['F_beat']:.3f}/{row['F_down']:.3f} bpm {row['bpm']} "
                      f"(vero {row['true']}) fase {row['phase']} mediana {row.get('median_ms')} ms in griglia {row.get('on_grid')}")
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False, default=float))


if __name__ == "__main__":
    main()
