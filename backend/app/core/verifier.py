"""All scores and the decision (spec sections 6.3 and 6.4). Pure functions."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Mapping, Sequence

import numpy as np

from .challenge import FS_TARGET, cycle_length_bounds, pattern_length, phase_spans, render_target
from .coupling import coupling_scores, rate_from_pressure_trace
from .signal import count_peaks, fit_to_length, max_ncc, preprocess, resample
from .thresholds import DEFAULT_ENABLED_GATES, DEFAULT_THRESHOLDS

MAX_LAG_S = 2.5
MIN_MEASURED_COVERAGE = 0.5
PULSE_HOLD_S = 2.0

FAILURE_TEXT = {
    "xcorr": "Pattern not followed",
    "phase": "Inhale and exhale did not line up with the pacer",
    "cycles": "Wrong number of breaths detected",
    "live": "No live pulse detected",
    "decoy": "Breathing did not match this pattern better than other patterns",
    "coupling": "Pulse did not move with the breathing pattern",
}


@dataclass
class SensorData:
    """Everything the sensor reported, on the server clock in seconds."""

    breath_t: Sequence[float] = ()
    breath_v: Sequence[float] = ()
    pulse_t: Sequence[float] = ()
    pulse_v: Sequence[float] = ()
    pulse_conf: Sequence[float] = ()
    pressure_t: Sequence[float] = ()
    pressure_v: Sequence[float] = ()
    # (time, ok) transitions of the SDK's validation status.
    validation: Sequence[tuple[float, bool]] = ()


@dataclass
class Scores:
    s_xcorr: float = 0.0
    s_phase: float = 0.0
    s_cycles: int = 0
    target_cycles: int = 0
    s_live: float = 0.0
    s_decoy: float = 0.0
    s_coupling: float = 0.0
    s_coupling_decoy: float = 0.0
    best_lag_s: float = 0.0
    max_decoy_xcorr: float = 0.0
    coverage: float = 0.0
    passed: bool = False
    failure_reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def score_phase(b: np.ndarray, phases: Sequence[dict], lag: int, fs: float) -> float:
    """Fraction of inhale and exhale phases whose mean slope has the right sign."""
    hits, total = 0, 0
    for kind, start, end in phase_spans(phases):
        if kind not in ("inhale", "exhale"):
            continue
        i = int(round(start * fs)) + lag
        j = min(int(round(end * fs)) + lag, b.size - 1)
        total += 1
        if j <= i:
            continue
        slope = b[j] - b[i]
        if (kind == "inhale" and slope > 0) or (kind == "exhale" and slope < 0):
            hits += 1
    return hits / total if total else 0.0


def score_live(data: SensorData, t0: float, length: float, conf_min: float) -> float:
    """Fraction of 1 s bins with a confident pulse reading and an OK validation status."""
    bins = int(np.ceil(length))
    if bins <= 0:
        return 0.0
    pulse_t = np.asarray(data.pulse_t, dtype=float)
    pulse_v = np.asarray(data.pulse_v, dtype=float)
    pulse_c = np.asarray(data.pulse_conf, dtype=float)
    valid = pulse_t[(pulse_c >= conf_min) & (pulse_v > 0)] if pulse_t.size else pulse_t
    valid = np.sort(valid)
    transitions = sorted(data.validation, key=lambda x: x[0])
    good = 0
    for k in range(bins):
        t = t0 + k + 0.5
        if valid.size == 0:
            continue
        idx = int(np.searchsorted(valid, t + 0.5)) - 1
        if idx < 0 or t - valid[idx] > PULSE_HOLD_S:
            continue
        ok = False
        for when, state in transitions:
            if when > t:
                break
            ok = state
        if ok:
            good += 1
    return good / bins


def verify(
    phases: Sequence[dict],
    decoys: Sequence[Sequence[dict]],
    data: SensorData,
    t0: float,
    polarity: int = 1,
    thresholds: Mapping[str, float] | None = None,
    gates: Mapping[str, bool] | None = None,
    fs: float = FS_TARGET,
) -> Scores:
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    enabled = {**DEFAULT_ENABLED_GATES, **(gates or {})}
    length = pattern_length(phases)
    n = int(round(length * fs))
    max_lag = int(MAX_LAG_S * fs)
    scores = Scores(target_cycles=sum(1 for p in phases if p["kind"] == "inhale"))

    raw, mask = resample(data.breath_t, data.breath_v, t0, t0 + length + MAX_LAG_S, fs)
    scores.coverage = round(float(mask.mean()) if mask.size else 0.0, 6)
    scores.s_live = round(score_live(data, t0, length, th["pulse_confidence_min"]), 6)

    if scores.coverage >= MIN_MEASURED_COVERAGE:
        b = preprocess(raw * (1 if polarity >= 0 else -1), fs)
        target = preprocess(render_target(phases, fs), fs)
        s_xcorr, lag = max_ncc(b, target, max_lag)
        scores.s_xcorr = round(max(s_xcorr, 0.0), 6)
        scores.best_lag_s = round(lag / fs, 3)
        scores.s_phase = round(score_phase(b, phases, lag, fs), 6)
        aligned = b[lag:lag + n]
        shortest, _ = cycle_length_bounds(phases)
        scores.s_cycles = count_peaks(aligned, fs, min_distance_s=shortest * 0.5)
        decoy_values = [
            max_ncc(b, preprocess(fit_to_length(render_target(d, fs), n), fs), max_lag)[0] for d in decoys
        ]
        best_decoy = max(decoy_values, default=0.0)
        scores.max_decoy_xcorr = round(max(best_decoy, 0.0), 6)
        scores.s_decoy = round(s_xcorr - best_decoy, 6)

    beat_t, beat_v = rate_from_pressure_trace(data.pressure_t, data.pressure_v)
    if beat_t.size >= 8:
        scores.s_coupling, scores.s_coupling_decoy = coupling_scores(phases, decoys, beat_t, beat_v, t0)
    else:
        scores.s_coupling, scores.s_coupling_decoy = coupling_scores(phases, decoys, data.pulse_t, data.pulse_v, t0)

    checks = {
        "xcorr": scores.s_xcorr >= th["s_xcorr"],
        "phase": scores.s_phase >= th["s_phase"],
        "cycles": scores.s_cycles == scores.target_cycles,
        "live": scores.s_live >= th["s_live"],
        "decoy": scores.s_decoy >= th["s_decoy"],
        "coupling": scores.s_coupling >= th["s_coupling"],
    }
    scores.failure_reasons = [k for k, ok in checks.items() if enabled.get(k) and not ok]
    scores.passed = not scores.failure_reasons
    return scores
