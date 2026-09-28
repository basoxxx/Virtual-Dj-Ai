"""Brani di più generi per il generatore sintetico (dalla v5): selezione bilanciata dal dataset MTG-Jamendo
(brani completi con licenze Creative Commons, alcune non commerciali; https://github.com/MTG/mtg-jamendo-dataset).
Solo in locale (ml/data/jamendo, fuori da git): l'audio serve solo a calcolare le caratteristiche per battuta.

Fino alla v4 il generatore usava brani da club (DJ Mix Dataset) e la musica dell'utente: qui si aggiungono pop,
rock, hip hop, R&B, funk, reggae, latin, dance… con lo stesso numero di brani per gruppo di genere.

Dati: archivi raw_30s/audio-low 00 e 01 (circa 1100 brani) e raw_30s_cleantags.tsv del repository MTG-Jamendo in
ml/data/jamendo. Uscita: ml/data/jamendo/selection.json e ml/data/jamendo/features/jam-<id>.npz.

Uso:  ml/.venv/bin/python ml/transitions/jamendo_features.py [--per-group 16]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from features import extract  # noqa: E402

DATA = ML_DIR / "data" / "jamendo"
OUT = DATA / "features"
# gruppi di genere (tag "genre---" di Jamendo) e se sono generi da club
GROUPS = {
    "pop": (("pop", "electropop", "synthpop", "popfolk", "instrumentalpop"), False),
    "rock": (("rock", "poprock", "indie", "alternative", "punkrock", "metal", "hardrock", "instrumentalrock"), False),
    "hiphop": (("hiphop", "rap", "rnb", "triphop"), False),
    "funk-soul": (("funk", "soul", "disco", "fusion", "jazz", "blues"), False),
    "reggae-latin": (("reggae", "latin", "ska", "world", "african", "bossanova", "salsa"), False),
    "house-techno": (("house", "techno", "deephouse", "minimal", "electronica"), True),
    "dance-trance": (("dance", "trance", "eurodance", "club", "progressive"), True),
    "bass": (("dubstep", "drumnbass", "breakbeat", "jungle", "idm"), True),
    "chill": (("chillout", "downtempo", "lounge"), False),
    "electronic": (("electronic",), True),
}
# generi senza battuta regolare: non servono a insegnare le transizioni
EXCLUDE = {"classical", "orchestral", "soundtrack", "ambient", "darkambient", "newage", "symphonic", "choir",
           "experimental", "atmospheric", "meditative", "piano", "contemporary"}


def select(per_group: int, seed: int = 0) -> list[dict]:
    rows = []
    for line in (DATA / "raw_30s_cleantags.tsv").read_text().splitlines()[1:]:
        p = line.split("\t")
        path = DATA / p[3].replace(".mp3", ".low.mp3")
        genres = [t.split("---")[1] for t in p[5:] if t.startswith("genre---")]
        dur = float(p[4])
        if path.exists() and genres and not EXCLUDE & set(genres) and 150 <= dur <= 480:
            rows.append({"id": p[0].split("_")[1].lstrip("0"), "artist": p[1], "path": str(path.relative_to(DATA)),
                         "duration": dur, "genres": genres})
    rng = np.random.default_rng(seed)
    rng.shuffle(rows)
    chosen, used, artists = [], set(), {}
    for name, (tags, club) in GROUPS.items():
        n = 0
        for r in rows:
            # il primo genere che compare nei gruppi decide (un brano in un solo gruppo), al massimo 2 per artista
            if r["id"] in used or artists.get(r["artist"], 0) >= 2 or not set(tags) & set(r["genres"]):
                continue
            chosen.append({**r, "group": name, "club": club})
            used.add(r["id"])
            artists[r["artist"]] = artists.get(r["artist"], 0) + 1
            n += 1
            if n >= per_group:
                break
    return chosen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-group", type=int, default=16)
    args = ap.parse_args()
    sel = select(args.per_group)
    (DATA / "selection.json").write_text(json.dumps(sel, indent=1))
    counts = {}
    for r in sel:
        counts[r["group"]] = counts.get(r["group"], 0) + 1
    print(f"{len(sel)} brani: {counts}", flush=True)
    for r in sel:
        try:
            extract(DATA / r["path"], OUT, name=f"jam-{r['id']}")
        except Exception as err:
            print(f"ERRORE {r['path']}: {err}", flush=True)


if __name__ == "__main__":
    main()
