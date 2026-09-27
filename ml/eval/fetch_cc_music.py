"""Scarica un set di valutazione di brani con BPM noto e licenza chiara (Kevin MacLeod,
incompetech.com, Creative Commons BY 4.0). I file restano in ml/data/audio/cc/ (fuori da git):
servono solo a misurare l'accuratezza di BPM e battute.

Uso:  ml/.venv/bin/python ml/eval/fetch_cc_music.py [--per-genre 5]
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
OUT = ML_DIR / "data" / "audio" / "cc"
CATALOG = "https://incompetech.com/music/royalty-free/pieces.json"
MP3 = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/"
# codici genere del catalogo: 6/7 elettronica e dance, 16 pop, 8 funk, 19 rock, 18 hip hop, 21 reggae
GENRES = {"6": "electronica", "7": "electronica2", "16": "pop", "8": "funk", "19": "rock", "18": "hiphop", "21": "reggae"}


def seconds(s: str) -> int:
    try:
        h, m, sec = s.split(":")
        return int(h) * 3600 + int(m) * 60 + int(sec)
    except ValueError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-genre", type=int, default=5)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(CATALOG, timeout=60) as r:
        pieces = json.load(r)
    chosen = []
    for code, genre in GENRES.items():
        cands = []
        for p in pieces:
            bpm = float(p.get("bpm") or 0)
            feel = p.get("feel") or ""
            instr = (p.get("instruments") or "").lower()
            if p.get("genre") != code or not (70 <= bpm <= 180) or not (120 <= seconds(p.get("length") or "") <= 400):
                continue
            if "drum" not in instr and "beat" not in instr:
                continue
            if "Grooving" not in feel and "Driving" not in feel:
                continue
            cands.append(p)
        cands.sort(key=lambda p: p["title"].strip().lower())
        for p in cands[: args.per_genre]:
            chosen.append({"title": p["title"].strip(), "file": p["filename"], "bpm": float(p["bpm"]), "genre": genre,
                           "license": "CC BY 4.0", "author": "Kevin MacLeod (incompetech.com)"})
    for item in chosen:
        dest = OUT / item["file"]
        if not dest.exists():
            url = MP3 + urllib.parse.quote(item["file"])
            print("scarico", item["file"])
            urllib.request.urlretrieve(url, dest)
    (OUT / "manifest.json").write_text(json.dumps(chosen, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(chosen)} brani in {OUT}")


if __name__ == "__main__":
    main()
