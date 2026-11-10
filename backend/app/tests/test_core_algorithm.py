"""Synthetic tests from spec section 6.7. Ensembles, because the verifier is statistical."""
import random

import numpy as np
import pytest

from app.core.challenge import (DECOY_COUNT, breathing_rate, distinct_decoys, generate_decoys, generate_pattern, is_valid_pattern,
                                pattern_length, render_target)
from app.core.coupling import coupling_scores
from app.core.signal import polarity_from_trace, preprocess, resample
from app.core.simulate import SCENARIOS, simulate
from app.core.verifier import SensorData, verify

N = 60


def run(scenario, seed, polarity=1, n=N, rsa=0.0):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        phases = generate_pattern(rng)
        out.append(verify(phases, distinct_decoys(phases, rng), simulate(scenario, phases, seed=rng.randint(0, 2**31), rsa=rsa), 0.0, polarity=polarity))
    return out


@pytest.mark.parametrize("seed", range(5))
def test_pattern_respects_comfort_constraints(seed):
    rng = random.Random(seed)
    for _ in range(200):
        phases = generate_pattern(rng)
        assert is_valid_pattern(phases)
        assert pattern_length(phases) <= 35
        assert 4 <= breathing_rate(phases) <= 8
        assert sum(p["kind"] == "inhale" for p in phases) == 3
        for p in phases:
            assert p["duration"] * 2 == int(p["duration"] * 2), "quantised to 0.5 s"
            if p["kind"] == "pause":
                assert 1 <= p["duration"] <= 2
            if p["kind"] == "inhale":
                assert 3 <= p["duration"] <= 5
            if p["kind"] == "exhale":
                assert 4 <= p["duration"] <= 7


def test_patterns_differ_every_time():
    assert len({str(generate_pattern()) for _ in range(30)}) >= 29


def test_decoy_count():
    assert len(generate_decoys()) == DECOY_COUNT == 20
    assert len(distinct_decoys(generate_pattern())) == 20


def test_distinct_decoys_exclude_near_duplicates_of_the_target():
    rng = random.Random(8)
    phases = generate_pattern(rng)
    n = pattern_length(phases)
    assert phases not in distinct_decoys(phases, rng, k=200)
    # A perfect follower always beats a decoy pool screened this way.
    for _ in range(40):
        phases = generate_pattern(rng)
        wave = np.concatenate([render_target(phases, 10), np.zeros(35)])
        clean = SensorData(breath_t=(np.arange(wave.size) / 10).tolist(), breath_v=wave.tolist(), validation=[(-1.0, True)])
        assert verify(phases, distinct_decoys(phases, rng), clean, 0.0).s_decoy > 0
    assert n > 0


def test_target_shape():
    phases = [{"kind": "delay", "duration": 1.0}, {"kind": "inhale", "duration": 3.0}, {"kind": "pause", "duration": 1.0},
              {"kind": "exhale", "duration": 4.0}]
    r = render_target(phases, 10)
    assert r.size == 90
    assert np.all(r[:10] == 0)
    assert np.all(np.diff(r[10:40]) > 0)
    assert r[39] == pytest.approx(1.0)
    assert np.all(r[40:50] == 1.0), "flat during the pause"
    assert np.all(np.diff(r[50:90]) < 0)
    assert r[89] == pytest.approx(0.0)


@pytest.mark.parametrize("scenario,seed", [("follower", 11), ("lagged", 12)])
def test_followers_pass(scenario, seed):
    assert np.mean([s.passed for s in run(scenario, seed)]) >= 0.9


@pytest.mark.parametrize("scenario,seed,limit", [
    ("natural", 21, 0.0), ("slow_steady", 22, 0.08), ("replay", 23, 0.08), ("photo", 24, 0.0), ("empty", 25, 0.0), ("flipped", 26, 0.0),
])
def test_negatives_fail(scenario, seed, limit):
    assert np.mean([s.passed for s in run(scenario, seed)]) <= limit


def test_decoy_score_separates_followers_from_every_negative():
    followers = [s.s_decoy for s in run("follower", 31)]
    for scenario in ("natural", "slow_steady", "replay", "photo", "empty", "flipped"):
        negatives = [s.s_decoy for s in run(scenario, 32)]
        assert np.median(followers) > np.median(negatives)
        assert np.mean([f >= 0 for f in followers]) > 0.85
        assert np.mean([v >= 0 for v in negatives]) < 0.25, scenario


def test_flipped_passes_after_polarity_correction():
    assert np.mean([s.passed for s in run("flipped", 41, polarity=-1)]) >= 0.85


def test_photo_fails_on_liveness_and_empty_chair_too():
    assert all(s.s_live == 0 for s in run("photo", 51, n=10))
    assert all("live" in s.failure_reasons for s in run("empty", 52, n=10))


def test_no_sensor_data_is_a_clean_failure():
    phases = generate_pattern(random.Random(1))
    s = verify(phases, generate_decoys(random.Random(2)), SensorData(), 0.0)
    assert not s.passed and s.coverage == 0 and s.s_xcorr == 0


def test_partial_coverage_fails():
    rng = random.Random(3)
    phases = generate_pattern(rng)
    data = simulate("follower", phases, seed=1)
    cut = len(data.breath_t) // 4
    data.breath_t, data.breath_v = data.breath_t[:cut], data.breath_v[:cut]
    assert not verify(phases, generate_decoys(rng), data, 0.0).passed


def test_late_timestamps_do_not_count_as_window():
    """A trace recorded before the window (an old session) has no overlap, so it fails."""
    rng = random.Random(4)
    phases = generate_pattern(rng)
    data = simulate("follower", phases, t0=-100.0, seed=2)
    assert not verify(phases, generate_decoys(rng), data, 0.0).passed


def test_resample_handles_duplicates_and_disorder():
    out, mask = resample([2.0, 0.0, 1.0, 1.0], [2.0, 0.0, 5.0, 1.0], 0.0, 2.0, 2.0)
    assert out.tolist() == [0.0, 0.5, 1.0, 1.5]
    assert mask.all()


def test_preprocess_flat_is_zero():
    assert np.all(preprocess(np.full(100, 3.0), 10) == 0)


def test_polarity_detection():
    t = np.arange(0, 8, 0.1)
    assert polarity_from_trace(t, t * 0.2)[0] == 1
    assert polarity_from_trace(t, -t * 0.2)[0] == -1
    assert polarity_from_trace([0, 1], [0, 1])[0] == 0
    assert polarity_from_trace(t, np.zeros_like(t))[0] == 0


def test_coupling_high_when_pulse_follows_pattern_and_low_for_flat():
    rng = random.Random(5)
    phases = generate_pattern(rng)
    decoys = generate_decoys(rng)
    t = np.arange(0, pattern_length(phases) + 4, 1.0)
    grid = np.arange(0, pattern_length(phases)) / 1.0
    r = np.interp(t, np.arange(render_target(phases, 10).size) / 10, render_target(phases, 10))
    s, _ = coupling_scores(phases, decoys, t, 70 + 4 * r, 0.0)
    assert s > 0.7
    assert coupling_scores(phases, decoys, t, np.full(t.size, 70.0), 0.0)[0] == 0
    assert coupling_scores(phases, decoys, [], [], 0.0) == (0.0, 0.0)
    assert grid.size > 0


def test_all_scenarios_are_known():
    assert {"follower", "natural", "slow_steady", "replay", "photo", "empty", "flipped"} <= set(SCENARIOS)
    with pytest.raises(ValueError):
        simulate("nope", generate_pattern())
