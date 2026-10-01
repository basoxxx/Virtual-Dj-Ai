"""Mix recenti del DJ Mix Dataset come fonte "djmix2" per dj_sets_download.py e dj_sets_dataset.py (dalla v8).

Il DJ Mix Dataset (mir-aidj, solo metadati, senza licenza: uso solo in locale deciso dall'utente) dà per ogni mix
l'audio (SoundCloud/Mixcloud) e la tracklist con l'id YouTube di ogni brano e, spesso, il minuto in cui entra
("[05] Artista - Titolo"). Qui si scelgono i mix digitali (dal 2005) con quasi tutti i brani identificati e con i
tempi, e si scrive ml/data/djmix2/tracklists.txt nel formato di dj_sets_download.py, con l'url YouTube esatto del
brano (niente ricerca: meno richieste a YouTube).

Ordine dei mix: prima dance/EDM e house (lo stile dell'app), poi il resto, dai più recenti; a parità, quelli con
più transizioni disponibili. Il download procede in quest'ordine, mix per mix, finché YouTube lo permette.

Uso:  ml/.venv/bin/python ml/transitions/djmix_sets.py [--max-mixes 300] [--mixed]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
SRC = ML_DIR / "data" / "djmix" / "djmix-dataset.json"
OUT = ML_DIR / "data" / "djmix2"

# programmi e DJ della dance commerciale/EDM e della house, vicini alla musica dell'app (dance, commerciale, house)
DANCE = ("club life", "heldeep", "hexagon", "revealed", "hardwell", "spinnin", "musical freedom", "protocol",
         "dance department", "brainjack", "tiësto", "tiesto", "oliver heldens", "martin garrix", "afrojack",
         "armin", "a state of trance", "asot", "david guetta", "kryder", "don diablo", "r3hab", "nicky romero",
         "w&w", "dimitri vegas", "steve aoki", "axwell", "alesso", "avicii", "swedish house", "fedde le grand",
         "laidback luke", "sander van doorn", "showtek", "quintino", "blasterjaxx", "mixmash", "smash the house",
         "loud & proud", "identity", "future house", "big room", "radio 538", "slam!", "sirius", "electric")
HOUSE = ("house", "essential mix", "defected", "toolroom", "glitterbox", "groove", "drumcode", "cocoon", "solomun",
         "black coffee", "purple disco", "claptone", "hot since 82", "fisher", "chris lake", "camelphat")


def cue_minutes(title: str) -> tuple[int | None, str]:
    """"[05] Artista - Titolo [Etichetta]" -> (300, "Artista - Titolo"); senza tempo o con "[??]" -> (None, ...).

    Formati di mixesdb: "[MM]" e "[MMM]" minuti, "[MM:SS]" minuti e secondi, "[H:MM:SS]"."""
    m = re.match(r"\s*\[([0-9?:]+)\]\s*(.*)", title)
    if not m:
        return None, title.strip()
    stamp, rest = m.groups()
    if "?" in stamp:
        return None, rest.strip()
    p = [int(x) for x in stamp.split(":")]
    sec = p[0] * 60 if len(p) == 1 else p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]
    return sec, rest.strip()


def clean(name: str) -> str:
    name = re.sub(r"\s*\[[^\]]*\]\s*$", "", name)  # etichetta e catalogo in fondo
    return name.replace("|", "/").strip()


def score(m: dict) -> tuple:
    t = m["title"].lower()
    style = 2 if any(k in t for k in DANCE) else 1 if any(k in t for k in HOUSE) else 0
    year = int(m["title"][:4])
    return (style, year >= 2015, year, m["num_available_transitions"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-mixes", type=int, default=300)
    ap.add_argument("--mixed", action="store_true", help="stili alternati invece di prima tutta la dance")
    args = ap.parse_args()
    mixes = json.loads(SRC.read_text())
    good = []
    for m in mixes:
        if not re.match(r"\d{4}", m["title"]) or int(m["title"][:4]) < 2005:
            continue
        if m["audio_source"] not in ("soundcloud", "mixcloud") or not m.get("audio_url"):
            continue
        tl = m["tracklist"]
        n = len(tl)
        ids = sum(1 for t in tl if t["id"])
        cues = sum(1 for t in tl if cue_minutes(t["title"])[0] is not None)
        if n < 6 or ids < 0.8 * n or cues < 0.8 * n or m["num_available_transitions"] < 8:
            continue
        good.append(m)
    good.sort(key=score, reverse=True)
    good = good[: args.max_mixes]
    if args.mixed:
        # stili alternati (dance, house, altro): i mix radiofonici dance hanno voce e brani riconosciuti solo in
        # parte, i set da club danno transizioni più pulite; i primi mix già scaricati restano in testa
        done = {p.stem for p in (OUT / "mixes").glob("*.*")} if (OUT / "mixes").exists() else set()
        head = [m for m in good if m["id"] in done]
        rest = [m for m in good if m["id"] not in done]
        by = {k: [m for m in rest if score(m)[0] == k] for k in (2, 1, 0)}
        mixed = []
        while any(by.values()):
            for k in (1, 0, 2):
                if by[k]:
                    mixed.append(by[k].pop(0))
        good = head + mixed
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["# generato da djmix_sets.py dal DJ Mix Dataset (solo in locale); cue al minuto, url YouTube del brano"]
    n_tracks = set()
    for m in good:
        lines.append(f"@ {m['id']} | {m['title'].replace('|', '/')} | {m['url']} | {m['audio_url']}")
        last = -1
        for t in m["tracklist"]:
            sec, rest = cue_minutes(t["title"])
            if sec is not None and sec < last:
                sec = None  # tempi non crescenti: meglio senza
            if sec is not None:
                last = sec
            name = clean(rest)
            if " - " not in name:
                name = f"? - {name}"
            url = f"https://www.youtube.com/watch?v={t['id']}" if t["id"] else ""
            cue = f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec is not None else ""
            lines.append(f"{cue}|{name}||{url}")
            if t["id"]:
                n_tracks.add(t["id"])
    (OUT / "tracklists.txt").write_text("\n".join(lines) + "\n")
    styles = [score(m)[0] for m in good]
    print(f"{len(good)} mix (dance {styles.count(2)}, house {styles.count(1)}, altri {styles.count(0)}), "
          f"{len(n_tracks)} brani YouTube distinti, {sum(m['num_available_transitions'] for m in good)} transizioni "
          f"disponibili -> {OUT / 'tracklists.txt'}")


if __name__ == "__main__":
    main()
