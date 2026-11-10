"""Cardiorespiratory coupling score (spec section 6.5). Reported only by default."""
from __future__ import annotations

from typing import Sequence

import numpy as np
from scipy.signal import detrend, find_peaks

from .challenge import cycle_length_bounds, pattern_length, render_target
from .signal import FLAT_EPSILON, bandpass, dedupe_samples, fit_to_length, max_ncc, resample, zscore

FS_COUPLING = 4.0
MAX_LAG_S = 4.0
MIN_SAMPLES = 8


def rate_from_pressure_trace(ts: Sequence[float], values: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    """Beat-to-beat rate from the arterial pressure trace, finer than the 12 s pulse rate."""
    t, v = dedupe_samples(ts, values)
    if t.size < 10:
        return np.array([]), np.array([])
    fs = (t.size - 1) / max(float(t[-1] - t[0]), 1e-6)
    peaks, _ = find_peaks(v, distance=max(1, int(fs * 0.33)), prominence=max(float(np.std(v)) * 0.3, 1e-9))
    if peaks.size < 3:
        return np.array([]), np.array([])
    beat_t = t[peaks]
    intervals = np.diff(beat_t)
    keep = (intervals > 0.33) & (intervals < 1.5)
    return beat_t[1:][keep], 60.0 / intervals[keep]


def _band(phases: Sequence[dict]) -> tuple[float, float]:
    shortest, longest = cycle_length_bounds(phases)
    return (1.0 / (longest * 1.3), 1.0 / (shortest * 0.7))


def _prepared(x: np.ndarray, low: float, high: float) -> np.ndarray:
    if x.size == 0 or float(np.std(x)) < FLAT_EPSILON:
        return np.zeros_like(x)
    return zscore(bandpass(detrend(x), FS_COUPLING, low, high))


def coupling_scores(
    phases: Sequence[dict],
    decoys: Sequence[Sequence[dict]],
    pulse_t: Sequence[float],
    pulse_v: Sequence[float],
    t0: float,
) -> tuple[float, float]:
    """Return (S_coupling, S_coupling_decoy). Times are absolute; t0 starts the pattern."""
    length = pattern_length(phases)
    series, mask = resample(pulse_t, pulse_v, t0, t0 + length + MAX_LAG_S, FS_COUPLING)
    if int(mask.sum()) < MIN_SAMPLES:
        return 0.0, 0.0
    low, high = _band(phases)
    measured = _prepared(series, low, high)
    n = int(round(length * FS_COUPLING))
    lag = int(MAX_LAG_S * FS_COUPLING)

    def score(pattern: Sequence[dict]) -> float:
        target = fit_to_length(render_target(pattern, FS_COUPLING), n)
        return max_ncc(measured, _prepared(target, low, high), lag)[0]

    s = score(phases)
    s_decoy = max((score(d) for d in decoys), default=0.0)
    return round(max(s, 0.0), 6), round(max(s_decoy, 0.0), 6)
