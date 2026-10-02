"""Tabelle in Markdown (per il report) dai risultati di evaluate.py (ml/data/beat_this/eval.json).

Uso:  ml/.venv/bin/python ml/beat_this/tables.py [--names small0-int8=small0,final0=final0,...]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(C.DATA / "eval.json"))
    ap.add_argument("--names", default="", help="nome=etichetta,... nell'ordine voluto")
    a = ap.parse_args()
    ev = json.loads(Path(a.file).read_text())
    order = [kv.split("=") for kv in a.names.split(",")] if a.names else [[k, k] for k in ev]
    rows = [(lab, ev[k]) for k, lab in order if k in ev]

    print("| Modello | CC bpm ±0,5 | CC acc2 | CC battuta forte | CC griglia F | Tag ±0,5 | Tag metà/doppio |")
    print("|---|---|---|---|---|---|---|")
    for lab, r in rows:
        cc, tg = r["cc"], r["tag"]
        print(f"| {lab} | {cc['bpm05']}/{cc['n']} | {cc['acc2']}/{cc['n']} | {cc['downbeat']}/{cc['n']} | {cc['gridF']:.3f} "
              f"| {tg['bpm05']}/{tg['n']} | {tg['acc2']}/{tg['n']} |")
    print()
    print("| Modello | Gand F battute | Gand F battute forti | Gand BPM ±0,5 | Gand fase battuta forte | Gand griglia F "
          "| verificati: F battute | verificati: F battute forti | verificati: fase |")
    print("|---|---|---|---|---|---|---|---|---|")
    for lab, r in rows:
        g, o = r["gand"], r["gand_ok"]
        print(f"| {lab} | {g['F_beat']:.3f} | {g['F_down']:.3f} | {g['bpm05']}/{g['n']} | {g['phase']}/{g['n']} | {g['gridF']:.3f} "
              f"| {o['F_beat']:.3f} | {o['F_down']:.3f} | {o['phase']}/{o['n']} |")
    if all("gand_test" in r for _, r in rows):
        print()
        print("| Modello | val Gand: F battute | val: F forti | val: fase | prova Gand: F battute | prova: F forti | prova: fase "
              "| prova verificati: F battute | verificati: F forti | verificati: fase |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for lab, r in rows:
            v, t, o = r["gand_val"], r["gand_test"], r["gand_test_ok"]
            print(f"| {lab} | {v['F_beat']:.3f} | {v['F_down']:.3f} | {v['phase']}/{v['n']} | {t['F_beat']:.3f} | {t['F_down']:.3f} "
                  f"| {t['phase']}/{t['n']} | {o['F_beat']:.3f} | {o['F_down']:.3f} | {o['phase']}/{o['n']} |")
    print()
    print("| Modello | F battute | F battute forti | stesso BPM dell'app | stessa fase della battuta forte | confidenza media |")
    print("|---|---|---|---|---|---|")
    for lab, r in rows:
        u = r["usb"]
        print(f"| {lab} | {u['F_beat']:.3f} | {u['F_down']:.3f} | {u['bpm']}/{u['n']} | {u['phase']}/{u['n']} | {u['conf']:.3f} |")


if __name__ == "__main__":
    main()
