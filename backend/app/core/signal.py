"""Signal preprocessing (spec section 6.2). Pure functions."""
from __future__ import annotations

from typing import Sequence

import numpy as np
from scipy.signal import butter, detrend, find_peaks, sosfiltfilt

FLAT_EPSILON = 1e-6


def dedupe_samples(ts: Sequence[float], values: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    """Sort by time. The SDK may resend samples; the latest value for a timestamp wins."""
    merged: dict[float, float] = {}
    for t, v in zip(ts, values):
        if v is None:
            continue
        value = float(v)
        if np.isfinite(value) and np.isfinite(t):
            merged[float(t)] = value
    if not merged:
        return np.array([]), np.array([])
    keys = np.array(sorted(merged))
    return keys, np.array([merged[k] for k in keys])


def resample(
    ts: Sequence[float], values: Sequence[float], t_start: float, t_end: float, fs: float
) -> tuple[np.ndarray, np.ndarray]:
    """Linear interpolation onto a uniform grid. Returns (values, coverage mask)."""
    n = int(round((t_end - t_start) * fs))
    grid = t_start + np.arange(n) / fs
    t, v = dedupe_samples(ts, values)
    if t.size < 2:
        return np.zeros(n), np.zeros(n, dtype=bool)
    out = np.interp(grid, t, v)
    return out, (grid >= t[0]) & (grid <= t[-1])


def zscore(x: np.ndarray) -> np.ndarray:
    sd = float(np.std(x))
    if sd < FLAT_EPSILON:
        return np.zeros_like(x)
    return (x - float(np.mean(x))) / sd


def bandpass(x: np.ndarray, fs: float, low: float, high: float, order: int = 2) -> np.ndarray:
    """Zero-phase Butterworth band-pass. Too-short input comes back as zeros."""
    nyquist = fs / 2.0
    high = min(high, nyquist * 0.99)
    sos = butter(order, [low / nyquist, high / nyquist], btype="bandpass", output="sos")
    padlen = 3 * (2 * len(sos) + 1)
    if x.size <= padlen:
        return np.zeros_like(x)
    return sosfiltfilt(sos, x, padlen=min(padlen * 4, x.size - 1))


def preprocess(x: np.ndarray, fs: float, low: float = 0.05, high: float = 0.7) -> np.ndarray:
    """Detrend, band-pass, z-normalise. A flat input stays all zeros."""
    if x.size == 0 or float(np.std(x)) < FLAT_EPSILON:
        return np.zeros_like(x)
    return zscore(bandpass(detrend(x), fs, low, high))


def fit_to_length(x: np.ndarray, n: int) -> np.ndarray:
    """Truncate, or hold the final level, so every template has the same length."""
    if x.size >= n:
        return x[:n]
    fill = x[-1] if x.size else 0.0
    return np.concatenate([x, np.full(n - x.size, fill)])


def max_ncc(
    measured: np.ndarray, template: np.ndarray, max_lag_samples: int, min_overlap: float = 0.7
) -> tuple[float, int]:
    """Best Pearson correlation with `measured` lagging `template` by 0..max_lag samples."""
    n = template.size
    best, best_lag = 0.0, 0
    found = False
    for lag in range(max_lag_samples + 1):
        seg = measured[lag:lag + n]
        m = seg.size
        if n == 0 or m < min_overlap * n:
            break
        a = seg - seg.mean()
        b = template[:m] - template[:m].mean()
        denom = float(np.sqrt(np.dot(a, a) * np.dot(b, b)))
        if denom < FLAT_EPSILON:
            continue
        r = float(np.dot(a, b) / denom)
        if not found or r > best:
            best, best_lag, found = r, lag, True
    return best, best_lag


def count_peaks(x: np.ndarray, fs: float, min_distance_s: float, prominence: float = 0.5) -> int:
    if x.size == 0 or float(np.std(x)) < FLAT_EPSILON:
        return 0
    peaks, _ = find_peaks(x, distance=max(1, int(min_distance_s * fs)), prominence=prominence)
    return int(peaks.size)


def polarity_from_trace(ts: Sequence[float], values: Sequence[float]) -> tuple[int, float]:
    """Sign convention from one slow inhale: +1 if the trace rises, -1 if it falls."""
    t, v = dedupe_samples(ts, values)
    if t.size < 5:
        return 0, 0.0
    spread = float(np.std(v))
    if spread < FLAT_EPSILON or float(np.ptp(t)) <= 0:
        return 0, 0.0
    slope = float(np.polyfit(t - t[0], (v - v.mean()) / spread, 1)[0])
    return (1 if slope >= 0 else -1), abs(slope)
