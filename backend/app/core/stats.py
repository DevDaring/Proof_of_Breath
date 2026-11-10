"""Evaluation statistics (spec section 13). Pure functions."""
from __future__ import annotations

import math
from typing import Sequence


def wilson_interval(successes: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def roc_curve(positives: Sequence[float], negatives: Sequence[float]) -> list[dict]:
    """Points from a descending threshold sweep, starting at (0, 0)."""
    if not positives or not negatives:
        return []
    points = [{"fpr": 0.0, "tpr": 0.0, "threshold": None}]
    for th in sorted(set(positives) | set(negatives), reverse=True):
        points.append({
            "fpr": sum(v >= th for v in negatives) / len(negatives),
            "tpr": sum(v >= th for v in positives) / len(positives),
            "threshold": th,
        })
    return points


def auc(positives: Sequence[float], negatives: Sequence[float]) -> float | None:
    """Mann-Whitney AUC, with ties counted as half."""
    if not positives or not negatives:
        return None
    wins = 0.0
    for p in positives:
        for n in negatives:
            wins += 1.0 if p > n else 0.5 if p == n else 0.0
    return wins / (len(positives) * len(negatives))


def youden_threshold(positives: Sequence[float], negatives: Sequence[float]) -> float | None:
    """Threshold with the best TPR minus FPR, as used on the calibration split."""
    best, best_j = None, -2.0
    for point in roc_curve(positives, negatives):
        if point["threshold"] is None:
            continue
        j = point["tpr"] - point["fpr"]
        if j > best_j:
            best, best_j = point["threshold"], j
    return best


def percentile(values: Sequence[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def histogram(values: Sequence[float], low: float, high: float, bins: int) -> list[int]:
    counts = [0] * bins
    width = (high - low) / bins
    for v in values:
        counts[min(bins - 1, max(0, int((v - low) / width)))] += 1
    return counts
