"""Caratteristiche per battuta dei brani di una cartella musicale dell'utente (es. la chiavetta con 1146 brani),
per il generatore di transizioni sintetiche. La musica si legge dove sta, non si copia: in ml/data/usb/features
finiscono solo le caratteristiche (usb-<crc32 del percorso>.npz). Riprendibile.

Uso:  ml/.venv/bin/python ml/transitions/usb_features.py [--part 0 --parts 2]
"""

from __future__ import annotations

import argparse
import json
import zlib
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
import sys  # noqa: E402

sys.path.insert(0, str(ML_DIR / "transitions"))
from features import extract  # noqa: E402

USB = ML_DIR / "data" / "usb"
OUT = USB / "features"


def name_of(path: str) -> str:
    return f"usb-{zlib.crc32(path.encode()):08x}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", type=int, default=0)
    ap.add_argument("--parts", type=int, default=1)
    args = ap.parse_args()
    items = [i for i in json.loads((USB / "inventory.json").read_text()) if i.get("duration", 0) > 30]
    items = items[args.part::args.parts]
    for i, it in enumerate(items):
        try:
            extract(Path(it["path"]), OUT, name=name_of(it["path"]))
        except Exception as err:
            print(f"ERRORE {it['path']}: {err}", flush=True)
        if i % 25 == 0:
            print(f"parte {args.part}: {i}/{len(items)}", flush=True)


if __name__ == "__main__":
    main()
