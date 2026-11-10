"""Synthetic sensor signals for unit tests and the labelled simulated mode.

Nothing here is a human recording. Simulated output can never approve a real command.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Sequence

import numpy as np

from .challenge import generate_pattern, pattern_length, render_target
from .verifier import MAX_LAG_S, SensorData

FS = 10.0
TAIL_S = MAX_LAG_S + 1.0
BUNDLE = Path(__file__).parent / "data" / "sample_metrics.json"

SCENARIOS = {
    "follower": "Follows the pacer closely",
    "lagged": "Follows the pacer with a long reaction lag",
    "natural": "Ignores the pacer, natural breathing at 12 to 16 per minute",
    "slow_steady": "Ignores the pacer, steady breathing at about 6 per minute",
    "replay": "Replays a recorded session from an older pattern",
    "photo": "A photo in front of the camera: no movement and no pulse",
    "empty": "An empty chair: sensor noise, no face and no pulse",
    "flipped": "Follows the pacer but with the trace sign reversed",
}

LIVE_SCENARIOS = {"follower", "lagged", "natural", "slow_steady", "flipped"}


def _pulse(t: np.ndarray, breath: np.ndarray, rng: np.random.Generator, rsa: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pt = t[:: int(FS)]
    level = float(rng.uniform(60, 85))
    idx = np.searchsorted(t, pt).clip(0, t.size - 1)
    pv = level + rsa * breath[idx] + rng.normal(0, 0.3, pt.size)
    pc = np.clip(rng.normal(80, 5, pt.size), 0, 100)
    return pt, pv, pc


def _waveform(scenario: str, phases: Sequence[dict], rng: np.random.Generator, py: random.Random, n: int) -> np.ndarray:
    t = np.arange(n) / FS
    target = render_target(phases, FS)
    if scenario in ("follower", "flipped"):
        lag = int(rng.uniform(0.3, 1.5) * FS)
    elif scenario == "lagged":
        lag = int(rng.uniform(1.5, 2.4) * FS)
    if scenario in ("follower", "lagged", "flipped"):
        wave = np.zeros(n)
        m = min(target.size, n - lag)
        wave[lag:lag + m] = target[:m]
        wave = wave * float(rng.uniform(0.7, 1.3))
        wave += rng.normal(0, 0.05, n) + np.cumsum(rng.normal(0, 0.002, n))
        return -wave if scenario == "flipped" else wave
    if scenario == "natural":
        rate = float(rng.uniform(12, 16)) / 60.0
        return np.sin(2 * np.pi * rate * t + rng.uniform(0, 2 * np.pi)) + rng.normal(0, 0.05, n)
    if scenario == "slow_steady":
        rate = float(rng.uniform(5.5, 6.5)) / 60.0
        return np.sin(2 * np.pi * rate * t + rng.uniform(0, 2 * np.pi)) + rng.normal(0, 0.05, n)
    if scenario == "photo":
        return np.full(n, 0.5) + rng.normal(0, 1e-3, n)
    if scenario == "empty":
        return rng.normal(0, 1.0, n)
    raise ValueError(f"unknown scenario {scenario}")


def _bundled_replay(n: int) -> np.ndarray:
    """A stored trace for an older pattern, repeated if the new window is longer."""
    stored = np.asarray(json.loads(BUNDLE.read_text())["breath"], dtype=float)
    return np.resize(stored, n)


def simulate(
    scenario: str,
    phases: Sequence[dict],
    t0: float = 0.0,
    seed: int | None = None,
    rsa: float = 0.0,
) -> SensorData:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario}")
    rng = np.random.default_rng(seed)
    py = random.Random(seed)
    n = int(round((pattern_length(phases) + TAIL_S) * FS))
    t = np.arange(n) / FS
    if scenario == "replay":
        wave = _bundled_replay(n) + rng.normal(0, 0.03, n)
    else:
        wave = _waveform(scenario, phases, rng, py, n)
    data = SensorData(breath_t=(t + t0).tolist(), breath_v=wave.tolist())
    if scenario in LIVE_SCENARIOS or scenario == "replay":
        # A replayed face on a screen can still produce a plausible pulse: that is the point
        # of the attack, so it must be rejected by the pattern scores rather than by S_live.
        pt, pv, pc = _pulse(t, wave, rng, rsa)
        data.pulse_t, data.pulse_v, data.pulse_conf = (pt + t0).tolist(), pv.tolist(), pc.tolist()
        data.validation = [(t0 - 5.0, True)]
    elif scenario == "photo":
        pt = t[:: int(FS)]
        data.pulse_t = (pt + t0).tolist()
        data.pulse_v = np.full(pt.size, 72.0).tolist()
        data.pulse_conf = np.zeros(pt.size).tolist()
        data.validation = [(t0 - 5.0, True)]
    else:
        data.validation = [(t0 - 5.0, False)]
    return data


def make_bundle(path: Path = BUNDLE, seed: int = 20261107) -> dict:
    """Write the bundled replay file. It is synthetic, and the file says so."""
    rng = random.Random(seed)
    phases = generate_pattern(rng)
    data = simulate("follower", phases, seed=seed)
    payload = {
        "note": "Synthetic trace for the simulated replay scenario. Not a human recording.",
        "fs": FS,
        "phases": phases,
        "breath": [round(v, 5) for v in data.breath_v],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))
    return payload
