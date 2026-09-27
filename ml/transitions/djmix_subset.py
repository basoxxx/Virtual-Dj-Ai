"""Sottoinsieme del DJ Mix Dataset (mir-aidj/djmix-dataset) per il modello delle transizioni.

Il dataset non ha licenza: metadati e audio si usano solo in locale (ml/data/djmix, fuori da git)
per estrarre caratteristiche; non si ridistribuiscono. Selezione deterministica:
  - mix di musica elettronica da club (house, techno, trance, drum & bass…), da SoundCloud, Mixcloud o YouTube
  - almeno 8 transizioni tra brani identificati consecutivi e almeno l'80% dei brani identificati
  - al massimo 3 mix per artista/serie (prima categoria del mix), per varietà

Uso:  ml/.venv/bin/python ml/transitions/djmix_subset.py [--mixes 200]
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "djmix"
GENRES = {"House", "Techno", "Tech House", "Progressive House", "Trance", "Drum & Bass", "Progressive Trance",
          "Deep House", "Minimal", "Deep Tech House", "Progressive", "Electro", "Psytrance"}
SOURCES = {"soundcloud", "mixcloud", "youtube"}


def select(mixes: list[dict], n: int) -> list[dict]:
    per_artist: Counter = Counter()
    out = []
    for m in sorted(mixes, key=lambda m: m["id"]):
        cats = [t["key"].removeprefix("Category:") for t in m["tags"]]
        if m["audio_source"] not in SOURCES or not GENRES.intersection(cats):
            continue
        if m["num_available_transitions"] < 8 or m["num_identified_tracks"] < 0.8 * m["num_total_tracks"]:
            continue
        artist = next((c for c in cats if c not in GENRES), "?")
        if per_artist[artist] >= 3:
            continue
        per_artist[artist] += 1
        out.append(m)
    # i mix con più transizioni per primi, a parità l'ordine per id
    out.sort(key=lambda m: (-m["num_available_transitions"], m["id"]))
    return sorted(out[:n], key=lambda m: m["id"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mixes", type=int, default=200)
    args = ap.parse_args()
    mixes = json.loads((DATA / "djmix-dataset.json").read_text())
    chosen = select(mixes, args.mixes)
    (DATA / "subset.json").write_text(json.dumps(chosen, indent=1, ensure_ascii=False))
    tracks = {t["id"] for m in chosen for t in m["tracklist"] if t.get("id")}
    print(f"{len(chosen)} mix, {sum(m['num_available_transitions'] for m in chosen)} transizioni, {len(tracks)} brani")
    print(Counter(m["audio_source"] for m in chosen))


if __name__ == "__main__":
    main()
