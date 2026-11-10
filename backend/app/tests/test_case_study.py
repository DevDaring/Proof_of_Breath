"""Case study: the bundled real SDK capture, challenged with fresh patterns by the real verifier."""
import random

import pytest

from ..core.challenge import FS_TARGET
from ..core.verifier import MAX_LAG_S
from ..services import case_study
from .conftest import Api

pytestmark = pytest.mark.skipif(not case_study.available(), reason="case study data not built")


def test_bundle_holds_numbers_only():
    d = case_study.load()
    assert set(d) >= {"source", "breath", "pulse", "rate", "pressure", "validation", "aggregate"}
    assert d["source"]["following"] is False
    assert not any(k in d for k in ("frames", "images", "video", "path"))
    times = [t for t, _ in d["breath"]]
    assert times == sorted(times) and len(set(times)) == len(times)
    assert all(40 <= v <= 160 for _, v, _ in d["pulse"])


def test_challenge_is_scored_like_a_check():
    out = case_study.challenge(random.Random(3))
    assert out["t0"] >= case_study.WARMUP_S
    end = case_study.load()["breath"][-1][0]
    assert out["t0"] + out["length_s"] + MAX_LAG_S <= end
    assert len(out["measured"]) == pytest.approx((out["length_s"] + MAX_LAG_S) * FS_TARGET, abs=1)
    assert len(out["target"]) == pytest.approx(out["length_s"] * FS_TARGET, abs=1)
    s = out["scores"]
    assert s["passed"] == (not s["failure_reasons"])
    assert len(out["failures"]) == len(s["failure_reasons"])
    # Same seed, same pattern and scores: nothing hidden or random in the scoring itself.
    again = case_study.challenge(random.Random(3))
    assert again["phases"] == out["phases"] and again["scores"] == s


def test_person_not_following_is_rejected():
    agg = case_study.load()["aggregate"]
    assert agg["n"] >= 100
    # This person never saw a pacer. A handful of chance passes would be a false accept, not a success.
    assert agg["passed"] <= agg["n"] * 0.05
    assert agg["median"]["s_live"] >= 0.7, "a live person was present, so the pulse check should mostly pass"


async def test_endpoints(server, jury):
    anon = Api(server)
    await anon.get("/api/case-study", expect=401)
    await anon.post("/api/case-study/challenge", expect=401)
    await anon.client.aclose()
    view = await jury.get("/api/case-study")
    assert "pressure" not in view and view["breath"] and view["pulse"]
    assert view["summary"]["pulse_readings"] == len(case_study.load()["pulse"])
    assert view["aggregate"]["n"] >= 100
    first = await jury.post("/api/case-study/challenge")
    second = await jury.post("/api/case-study/challenge")
    assert first["phases"] != second["phases"] or first["t0"] != second["t0"]
    assert {"scores", "measured", "target", "spans", "failures"} <= set(first)
