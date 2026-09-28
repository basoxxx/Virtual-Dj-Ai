"""Transizioni sintetiche tra brani Jamendo per gruppo di genere (jamendo_features.py): modelli a confronto sulle
misure di evaluate() di train.py, soprattutto lo scontro dei bassi fuori dai generi da club.

Dalla v6 si usano solo i brani con split "test" della selezione, che il generatore non usa: misura su brani mai visti.
(Per la v5 i brani erano anche nel generatore: era solo un controllo di comportamento.)

Uso:  ml/.venv/bin/python ml/eval/genre_eval.py ml/data/runs/planner-v4.pt ml/data/runs/planner-v5.pt
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import N_IN  # noqa: E402
from model import TransitionPlanner  # noqa: E402
from synth import JAMENDO_FEAT, LONG_LENGTHS, Synth  # noqa: E402
from train import evaluate  # noqa: E402


def main():
    sel = json.loads((ML_DIR / "data" / "jamendo" / "selection.json").read_text())
    models = {}
    for path in sys.argv[1:]:
        net = TransitionPlanner(N_IN)
        net.load_state_dict(torch.load(path, map_location="cpu"))
        models[Path(path).stem] = net.eval()
    out = {}
    for club in (False, True):
        # dalla v6 solo i brani tenuti fuori dal generatore (split "test"), se la selezione li distingue
        test_only = any(r.get("split") == "test" for r in sel)
        files = [JAMENDO_FEAT / f"jam-{r['id']}.npz" for r in sel if r["club"] == club and (not test_only or r.get("split") == "test")]
        files = [f for f in files if f.exists()]
        # stile "umano" escluso: si guardano le decisioni del modello, non le curve del maestro
        data = Synth(seed=7, files=files, lengths=LONG_LENGTHS).batch(96)
        res = {"brani": len(files)}
        for name, net in models.items():
            ev = evaluate(net, data, np.arange(96))
            res[name] = {k: ev["modello"][k] for k in ("scontroBassi", "buchiVolume", "maeCrossfader", "maeEq", "mixErrDb")}
        res["regole_bassswap"] = {k: ev["regole_bassswap"][k] for k in ("scontroBassi", "buchiVolume")}
        res["regole_fade"] = {k: ev["regole_fade"][k] for k in ("scontroBassi", "buchiVolume")}
        out["club" if club else "nonClub"] = res
    print(json.dumps(out, indent=1, ensure_ascii=False))
    (ML_DIR / "data" / "runs" / "genre-eval.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
