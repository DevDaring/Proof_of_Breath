import pytest

from app.core.receipts import GENESIS, receipt_hash, verify_chain
from app.core.stats import auc, histogram, percentile, roc_curve, wilson_interval, youden_threshold
from app.core.tokens import challenge_payload, derive_token, sign, token_hash, verify_signature


def test_signature_detects_any_change():
    payload = challenge_payload("id", "n", [{"kind": "inhale", "duration": 3.0}], 1.0, 2.0, "abc")
    sig = sign("s", payload)
    assert verify_signature("s", payload, sig)
    assert not verify_signature("other", payload, sig)
    for field, value in [("nonce", "x"), ("command_sha256", "y"), ("expires_at", 9.0), ("phases", [])]:
        assert not verify_signature("s", {**payload, field: value}, sig)


def test_token_is_bound_to_inputs():
    a = derive_token("s", "t", "r", "c", 1.0)
    assert a == derive_token("s", "t", "r", "c", 1.0)
    assert a != derive_token("s", "t", "r", "d", 1.0)
    assert token_hash(a) != a and len(token_hash(a)) == 64


def _chain(n):
    rows, prev = [], GENESIS
    for i in range(n):
        fields = {"id": str(i), "decision": "approved", "scores": {"a": 0.5}}
        h = receipt_hash(fields, prev)
        rows.append({"id": str(i), "fields": fields, "prev_hash": prev, "hash": h})
        prev = h
    return rows


def test_chain_valid_and_empty():
    assert verify_chain(_chain(5))["valid"]
    assert verify_chain([]) == {"valid": True, "checked": 0, "broken_at": None, "reason": None}


def test_chain_detects_edit_delete_and_reorder():
    rows = _chain(4)
    rows[2]["fields"]["decision"] = "denied"
    assert verify_chain(rows)["broken_at"] == "2"
    rows = _chain(4)
    del rows[1]
    assert not verify_chain(rows)["valid"]
    rows = _chain(4)
    rows[1], rows[2] = rows[2], rows[1]
    assert not verify_chain(rows)["valid"]


def test_negative_zero_cannot_break_the_chain():
    import json

    from app.core.tokens import canonical_json
    from app.services.records import _no_negative_zero as clean

    scores = {"s_decoy": -0.0, "nested": [{"v": -0.0}], "n": 3, "x": 0.25}
    stored = json.loads(json.dumps(clean(scores)))
    assert canonical_json(clean(scores)) == canonical_json(stored)
    assert "-0.0" not in canonical_json(clean(scores))


def test_wilson():
    lo, hi = wilson_interval(0, 20)
    assert lo == 0 and 0.15 < hi < 0.18
    assert wilson_interval(0, 0) == (0.0, 1.0)
    lo, hi = wilson_interval(15, 30)
    assert lo == pytest.approx(0.3315, abs=1e-3) and hi == pytest.approx(0.6685, abs=1e-3)


def test_auc_and_roc():
    assert auc([1, 2, 3], [0, 0.5]) == 1.0
    assert auc([0, 0.5], [1, 2]) == 0.0
    assert auc([1], [1]) == 0.5
    assert auc([], [1]) is None
    assert roc_curve([], [1]) == []
    assert roc_curve([1], [0])[-1] == {"fpr": 1.0, "tpr": 1.0, "threshold": 0}
    assert youden_threshold([0.8, 0.9], [0.1, 0.2]) == 0.8


def test_percentile_and_histogram():
    assert percentile([1, 2, 3], 0.5) == 2
    assert percentile([], 0.5) is None
    assert histogram([-5, 0, 0.5, 5], 0, 1, 2) == [2, 2]
