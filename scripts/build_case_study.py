"""Build backend/app/data/case_study.json from a raw SmartSpectra SDK capture of a video file.

Usage: python scripts/build_case_study.py capture.json [--n 200] [--seed 20261109]

The capture is what the SDK emitted for the file (timestamps in microseconds from the start of the file):
  {"sdk": ..., "breath": [[t, v]], "rate": [[t, v, conf]], "pulse": [[t, v, conf]],
   "pressure": [[t, v]], "valid": [[t, code, hint]]}
Only these numbers are kept. No frame, image or file path goes into the output.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("POB_ENV_FILE", os.devnull)

from app.services import case_study  # noqa: E402

SOURCE = {
    "title": "One recorded person, the real Presage SDK, the real verifier",
    "dataset": "rPPG Dataset by Ashfak Yeafi on Kaggle (ashfakyeafi/rppg-dataset), subject 1",
    "dataset_url": "https://www.kaggle.com/datasets/ashfakyeafi/rppg-dataset",
    "license_note": "The dataset lists no licence, so no frame or image of the person is shown or kept. Only the numbers the SDK produced are bundled.",
    "video": "First 330 s of the recording, centre-cropped to 4:3 and scaled to 640x480 at 30 fps, the same shape the browser camera sends",
    "sdk": "@smartspectra/node-sdk 3.4.0, file input, run on this server",
    "captured": "2026-11-09",
    "following": False,
}


def convert(raw: dict) -> dict:
    us = 1e6
    breath = sorted({round(t / us, 4): v for t, v in raw["breath"]}.items())
    return {
        "source": dict(SOURCE),
        "breath": [[t, round(v, 5)] for t, v in breath],
        "rate": [[round(t / us, 3), round(v, 2), round(c, 1)] for t, v, c in raw["rate"]],
        "pulse": [[round(t / us, 3), round(v, 2), round(c, 1)] for t, v, c in raw["pulse"]],
        "pressure": [[round(t / us, 4), round(v, 5)] for t, v in raw["pressure"]],
        "validation": [[round(t / us, 3), 1 if code == 0 else 0, hint] for t, code, hint in raw["valid"]],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("capture")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20261109)
    ap.add_argument("--out", default=str(case_study.DATA))
    args = ap.parse_args()
    with open(args.capture) as f:
        d = convert(json.load(f))
    d["aggregate"] = case_study.aggregate(d, args.n, args.seed)
    d["summary"] = case_study.summarise(d)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(d, f, separators=(",", ":"))
    a, s = d["aggregate"], d["summary"]
    print(f"wrote {args.out}: {s['duration_s']} s, {s['pulse_readings']} pulse readings, median {s['pulse_median_bpm']} bpm")
    print(f"{a['n']} patterns: {a['passed']} passed ({a['passed_flipped']} with the sign flipped); medians {a['median']}")
    print("failures", a["failure_counts"], "gaps", s["pulse_gaps"], "framing", s["framing_problems"][:5])


if __name__ == "__main__":
    main()
