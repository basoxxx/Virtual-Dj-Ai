"""Caratteristiche per battuta dei brani originali del dataset della tesi di Gand (Werthen-Brabants 2018,
dj_mix_ground_truth_extractor_dataset.zip, solo in locale in ml/data/werthen): ml/data/werthen/features/gand-<set>-<n>.npz.

Uso:  ml/.venv/bin/python ml/transitions/gand_features.py
"""

import sys
import zlib
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from features import extract  # noqa: E402

ROOT = ML_DIR / "data" / "werthen" / "extracted"
OUT = ML_DIR / "data" / "werthen" / "features"


def name_of(set_name: str, file_name: str) -> str:
    return f"gand-{set_name}-{zlib.crc32(file_name.encode()):08x}"


def main():
    for set_dir in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        for wav in sorted((set_dir / "refsongs").glob("*.wav")):
            try:
                extract(wav, OUT, name=name_of(set_dir.name, wav.name))
            except Exception as err:
                print(f"ERRORE {wav.name}: {err}", flush=True)


if __name__ == "__main__":
    main()
