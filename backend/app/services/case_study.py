"""The case study: one real SmartSpectra SDK capture of a recorded person, scored by the real verifier.

The capture is bundled as numbers only (``app/data/case_study.json``, built by ``scripts/build_case_study.py``).
No frame or image of the person is stored or served. The person was not following any pacer, so a correct
verifier rejects every pattern drawn against this trace. Each challenge here uses the same pattern generator,
decoys, thresholds and ``verify()`` as a real check.
"""
from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path
from statistics import median

import numpy as np

from ..core.challenge import FS_TARGET, distinct_decoys, generate_pattern, pattern_length, phase_spans, render_target
from ..core.signal import preprocess, resample
from ..core.thresholds import DEFAULT_ENABLED_GATES, DEFAULT_THRESHOLDS
from ..core.verifier import FAILURE_TEXT, MAX_LAG_S, SensorData, verify

DATA = Path(__file__).resolve().parent.parent / "data" / "case_study.json"
# Challenges start after the SDK's documented 12 s pulse warm-up, as a live check does.
WARMUP_S = 12.0
GAP_S = 3.0
MERGE_S = 2.0


@lru_cache(maxsize=1)
def load() -> dict:
    with DATA.open() as f:
        return json.load(f)


def available() -> bool:
    return DATA.exists()


def sensor_data(d: dict) -> SensorData:
    return SensorData(
        breath_t=[r[0] for r in d["breath"]], breath_v=[r[1] for r in d["breath"]],
        pulse_t=[r[0] for r in d["pulse"]], pulse_v=[r[1] for r in d["pulse"]], pulse_conf=[r[2] for r in d["pulse"]],
        pressure_t=[r[0] for r in d["pressure"]], pressure_v=[r[1] for r in d["pressure"]],
        validation=[(r[0], bool(r[1])) for r in d["validation"]],
    )


@lru_cache(maxsize=1)
def _data() -> SensorData:
    return sensor_data(load())


def _spans(points: list[float], end: float, gap: float) -> list[list[float]]:
    """Stretches longer than ``gap`` with no sample, including before the first and after the last."""
    out, prev = [], 0.0
    for t in points + [end]:
        if t - prev > gap:
            out.append([round(prev, 1), round(t, 1)])
        prev = t
    return out


def summarise(d: dict) -> dict:
    floor = DEFAULT_THRESHOLDS["pulse_confidence_min"]
    end = d["breath"][-1][0]
    pulse = d["pulse"]
    confident = [p for p in pulse if p[2] >= floor]
    rates = [r[1] for r in d["rate"] if r[2] >= floor] or [r[1] for r in d["rate"]]
    bad: list[dict] = []
    for i, (t, ok, hint) in enumerate(d["validation"]):
        if ok:
            continue
        stop = d["validation"][i + 1][0] if i + 1 < len(d["validation"]) else end
        # The status flickers frame to frame, so warnings close together read as one stretch.
        if bad and t - bad[-1]["end"] < MERGE_S and bad[-1]["hint"] == hint:
            bad[-1]["end"] = round(stop, 1)
            bad[-1]["flags"] += 1
        else:
            bad.append({"start": round(t, 1), "end": round(stop, 1), "hint": hint, "flags": 1})
    return {
        "duration_s": round(end, 1),
        "breath_samples": len(d["breath"]),
        "breath_first_s": round(d["breath"][0][0], 1),
        "pulse_readings": len(pulse),
        "pulse_first_s": round(pulse[0][0], 1) if pulse else None,
        "pulse_median_bpm": round(median(p[1] for p in confident), 1) if confident else None,
        "pulse_confident_share": round(len(confident) / len(pulse), 3) if pulse else 0.0,
        "breath_rate_median": round(median(rates), 1) if rates else None,
        "pulse_gaps": _spans([p[0] for p in confident], end, GAP_S),
        "framing_problems": bad,
        "confidence_floor": floor,
    }


def _round(xs, nd=3):
    return [round(float(x), nd) for x in xs]


def challenge(rng: random.Random | None = None, polarity: int = 1, d: dict | None = None, data: SensorData | None = None) -> dict:
    """Draw a fresh pattern at a random point of the real trace and score it exactly as a check is scored."""
    rng = rng or random.SystemRandom()
    if d is None:
        d, data = load(), _data()
    data = data or sensor_data(d)
    phases = generate_pattern(rng)
    decoys = distinct_decoys(phases, rng)
    length = pattern_length(phases)
    end = d["breath"][-1][0]
    t0 = round(rng.uniform(WARMUP_S, end - length - MAX_LAG_S - 0.5), 1)
    scores = verify(phases, decoys, data, t0, polarity, DEFAULT_THRESHOLDS, DEFAULT_ENABLED_GATES)
    # What the verifier compared: both preprocessed the same way, on the 10 Hz grid, aligned at the best lag.
    raw, _ = resample(data.breath_t, data.breath_v, t0, t0 + length + MAX_LAG_S, FS_TARGET)
    measured = preprocess(raw * (1 if polarity >= 0 else -1), FS_TARGET)
    target = preprocess(render_target(phases, FS_TARGET), FS_TARGET)
    return {
        "t0": t0,
        "length_s": round(length, 1),
        "phases": phases,
        "spans": [[k, round(a, 2), round(b, 2)] for k, a, b in phase_spans(phases)],
        "fs": FS_TARGET,
        "measured": _round(measured),
        "target": _round(target),
        "scores": scores.as_dict(),
        "failures": [FAILURE_TEXT[k] for k in scores.failure_reasons],
        "thresholds": DEFAULT_THRESHOLDS,
        "gates": DEFAULT_ENABLED_GATES,
        "polarity": polarity,
    }


def aggregate(d: dict, n: int, seed: int) -> dict:
    """``n`` random patterns at random points, scored with both signs of the trace."""
    rng = random.Random(seed)
    data = sensor_data(d)
    rows = []
    for _ in range(n):
        state = rng.getstate()
        a = challenge(rng, 1, d, data)["scores"]
        rng.setstate(state)
        b = challenge(rng, -1, d, data)["scores"]
        rows.append((a, b))
    keys = ("s_xcorr", "s_decoy", "s_live", "s_phase")
    reasons: dict[str, int] = {}
    for a, _ in rows:
        for r in a["failure_reasons"]:
            reasons[r] = reasons.get(r, 0) + 1
    return {
        "n": n,
        "seed": seed,
        "passed": sum(a["passed"] for a, _ in rows),
        "passed_flipped": sum(b["passed"] for _, b in rows),
        "values": {k: _round([a[k] for a, _ in rows]) for k in keys},
        "median": {k: round(float(np.median([a[k] for a, _ in rows])), 3) for k in keys},
        "failure_counts": reasons,
        "cycles_matched": sum(a["s_cycles"] == a["target_cycles"] for a, _ in rows),
    }


def view() -> dict:
    """Everything the page draws. The arterial pressure trace stays on the server."""
    d = load()
    step = max(1, round(len(d["breath"]) / max(d["breath"][-1][0], 1) / FS_TARGET))
    return {
        "source": d["source"],
        "summary": summarise(d),
        "aggregate": d.get("aggregate"),
        "breath": [[round(t, 2), round(v, 3)] for t, v in d["breath"][::step]],
        "pulse": [[round(t, 2), round(v, 1), round(c, 1)] for t, v, c in d["pulse"]],
        "rate": [[round(t, 2), round(v, 1), round(c, 1)] for t, v, c in d["rate"]],
        "thresholds": DEFAULT_THRESHOLDS,
    }
