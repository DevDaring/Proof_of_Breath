"""Randomised breathing challenges (spec section 6.1). Pure functions."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .signal import fit_to_length, max_ncc, preprocess
from .thresholds import DECOY_MAX_SIMILARITY

FS_TARGET = 10.0
DECOY_COUNT = 20
SIMILARITY_LAG_S = 2.5


@dataclass(frozen=True)
class PatternConfig:
    cycles: int = 3
    delay_min: float = 1.5
    delay_max: float = 3.0
    inhale_min: float = 3.0
    inhale_max: float = 5.0
    exhale_min: float = 4.0
    exhale_max: float = 7.0
    pause_min: float = 1.0
    pause_max: float = 2.0
    pause_probability: float = 0.5
    quantum: float = 0.5
    max_hold: float = 2.0
    max_total: float = 35.0
    rate_min: float = 4.0
    rate_max: float = 8.0


DEFAULT_PATTERN = PatternConfig()


def _quantised(rng: random.Random, lo: float, hi: float, q: float) -> float:
    steps = int(round((hi - lo) / q))
    return lo + q * rng.randint(0, steps)


def pattern_length(phases: Sequence[dict]) -> float:
    return float(sum(p["duration"] for p in phases))


def breathing_rate(phases: Sequence[dict]) -> float:
    """Breaths per minute over the active part of the pattern (start delay excluded)."""
    active = sum(p["duration"] for p in phases if p["kind"] != "delay")
    cycles = sum(1 for p in phases if p["kind"] == "inhale")
    return 60.0 * cycles / active if active > 0 else 0.0


def is_valid_pattern(phases: Sequence[dict], cfg: PatternConfig = DEFAULT_PATTERN) -> bool:
    if pattern_length(phases) > cfg.max_total:
        return False
    if any(p["kind"] == "pause" and p["duration"] > cfg.max_hold for p in phases):
        return False
    return cfg.rate_min <= breathing_rate(phases) <= cfg.rate_max


def _draw_pattern(rng: random.Random, cfg: PatternConfig) -> list[dict]:
    phases: list[dict] = [
        {"kind": "delay", "duration": _quantised(rng, cfg.delay_min, cfg.delay_max, cfg.quantum)}
    ]
    pause_after = None
    if cfg.cycles > 1 and rng.random() < cfg.pause_probability:
        pause_after = rng.randint(0, cfg.cycles - 2)
    for i in range(cfg.cycles):
        phases.append({"kind": "inhale", "duration": _quantised(rng, cfg.inhale_min, cfg.inhale_max, cfg.quantum)})
        phases.append({"kind": "exhale", "duration": _quantised(rng, cfg.exhale_min, cfg.exhale_max, cfg.quantum)})
        if pause_after == i:
            phases.append({"kind": "pause", "duration": _quantised(rng, cfg.pause_min, cfg.pause_max, cfg.quantum)})
    return phases


def generate_pattern(rng: random.Random | None = None, cfg: PatternConfig = DEFAULT_PATTERN) -> list[dict]:
    """Draw until the comfort constraints hold. Redraws are the specified behaviour."""
    rng = rng or random.SystemRandom()
    for _ in range(10_000):
        phases = _draw_pattern(rng, cfg)
        if is_valid_pattern(phases, cfg):
            return phases
    raise RuntimeError("pattern constraints are unsatisfiable")


def generate_decoys(
    rng: random.Random | None = None, k: int = DECOY_COUNT, cfg: PatternConfig = DEFAULT_PATTERN
) -> list[list[dict]]:
    rng = rng or random.SystemRandom()
    return [generate_pattern(rng, cfg) for _ in range(k)]


def distinct_decoys(
    phases: Sequence[dict],
    rng: random.Random | None = None,
    k: int = DECOY_COUNT,
    max_similarity: float = DECOY_MAX_SIMILARITY,
    cfg: PatternConfig = DEFAULT_PATTERN,
) -> list[list[dict]]:
    """Decoys from the same distribution, minus near-duplicates of the target.

    Similarity is what a perfect follower of `phases` would score against the decoy.
    """
    rng = rng or random.SystemRandom()
    raw = render_target(phases, FS_TARGET)
    n, lag = raw.size, int(SIMILARITY_LAG_S * FS_TARGET)
    measured = preprocess(fit_to_length(raw, n + lag), FS_TARGET)
    out: list[list[dict]] = []
    for _ in range(10_000):
        candidate = generate_pattern(rng, cfg)
        template = preprocess(fit_to_length(render_target(candidate, FS_TARGET), n), FS_TARGET)
        if max_ncc(measured, template, lag)[0] <= max_similarity:
            out.append(candidate)
            if len(out) == k:
                return out
    raise RuntimeError("could not draw enough distinct decoys")


def render_target(phases: Sequence[dict], fs: float = FS_TARGET) -> np.ndarray:
    """Target r(t): half-cosine up on inhale, down on exhale, flat on pause and delay."""
    total = int(round(pattern_length(phases) * fs))
    out = np.zeros(total, dtype=float)
    level = 0.0
    start = 0
    elapsed = 0.0
    for phase in phases:
        elapsed += phase["duration"]
        end = int(round(elapsed * fs))
        n = end - start
        if n <= 0:
            continue
        if phase["kind"] == "inhale":
            x = (np.arange(n) + 1) / n
            out[start:end] = 0.5 * (1.0 - np.cos(math.pi * x))
            level = 1.0
        elif phase["kind"] == "exhale":
            x = (np.arange(n) + 1) / n
            out[start:end] = 0.5 * (1.0 + np.cos(math.pi * x))
            level = 0.0
        else:
            out[start:end] = level
        start = end
    return out


def phase_spans(phases: Sequence[dict]) -> list[tuple[str, float, float]]:
    spans = []
    t = 0.0
    for p in phases:
        spans.append((p["kind"], t, t + p["duration"]))
        t += p["duration"]
    return spans


def cycle_length_bounds(phases: Sequence[dict]) -> tuple[float, float]:
    """Shortest and longest inhale+exhale cycle in the pattern, in seconds."""
    lengths = []
    inhale = None
    for p in phases:
        if p["kind"] == "inhale":
            inhale = p["duration"]
        elif p["kind"] == "exhale" and inhale is not None:
            lengths.append(inhale + p["duration"])
            inhale = None
    return (min(lengths), max(lengths))
