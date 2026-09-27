"""BPM dell'analisi classica e di Beat This! sulla musica dell'utente, contro i tag BPM dei file.

I tag (TBPM) li ha scritti un altro programma: non sono una verità assoluta, ma sono indipendenti da entrambi
i motori. Si escludono i tag fasulli di un convertitore da YouTube (sempre 90 BPM sui file "(MP3_…K)"). Metriche: entro ±0,5 BPM, entro il 4% ammettendo metà/doppio (e 2/3, 3/2 per i ritmi terzinati).

Uso:  ml/.venv/bin/python ml/eval/usb_bpm.py   (dopo ml/eval/electron/main.js --list ml/data/usb/tagged.json)
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
USB = ML_DIR / "data" / "usb"


def ok1(est, ref):
    return est is not None and abs(est - ref) <= 0.5


def ok2(est, ref):
    return est is not None and any(abs(est - ref * f) <= 0.04 * ref * f for f in (1, 2, 0.5, 2 / 3, 1.5))


def bogus(t: dict) -> bool:
    """Tag scritto da un convertitore da YouTube: sempre 90 BPM sui file "(MP3_…K)"."""
    return t["bpm"] == 90 and "(MP3_" in t["path"]


def main():
    tagged = json.loads((USB / "tagged.json").read_text())
    runs = {name: {r["file"]: r for r in json.loads((USB / f"eval-{name}.json").read_text())["results"]}
            for name in ("classic", "ai") if (USB / f"eval-{name}.json").exists()}
    summary = {}
    for name, res in runs.items():
        by_genre = defaultdict(lambda: [0, 0, 0])
        tot = [0, 0, 0]
        for i, t in enumerate(tagged):
            r = res.get(str(i))
            if not r or bogus(t):
                continue
            g = (t.get("genre") or "senza genere").split("/")[0].strip() or "senza genere"
            a, b = ok1(r.get("bpm"), t["bpm"]), ok2(r.get("bpm"), t["bpm"])
            for acc in (by_genre[g], tot):
                acc[0] += 1
                acc[1] += a
                acc[2] += b
        summary[name] = {"brani": tot[0], "bpm±0.5": tot[1], "acc2": tot[2],
                         "fallback": sum(1 for r in res.values() if name == "ai" and r.get("engine") != "ai"),
                         "sMediani": sorted(r["ms"] for r in res.values())[len(res) // 2] / 1000,
                         "generi": {g: v for g, v in sorted(by_genre.items(), key=lambda kv: -kv[1][0])[:10]}}
        print(name, json.dumps({k: v for k, v in summary[name].items() if k != "generi"}))
        for g, (n, a, b) in summary[name]["generi"].items():
            print(f"   {g[:22]:22s} {n:3d} brani  ±0,5: {a:3d}  acc2: {b:3d}")
    (USB / "bpm-summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
