"""Tamper-evident hash chain for receipts (spec section 10). Pure functions."""
from __future__ import annotations

import hashlib
from typing import Iterable, Mapping

from .tokens import canonical_json

GENESIS = "0" * 64


def receipt_hash(fields: Mapping, prev_hash: str) -> str:
    body = {**dict(fields), "prev_hash": prev_hash}
    return hashlib.sha256(canonical_json(body).encode()).hexdigest()


def verify_chain(rows: Iterable[Mapping]) -> dict:
    """Rows are in creation order: {fields, prev_hash, hash}."""
    expected = GENESIS
    count = 0
    for row in rows:
        count += 1
        if row["prev_hash"] != expected:
            return {"valid": False, "checked": count, "broken_at": row.get("id"), "reason": "Link to the previous receipt is broken"}
        if receipt_hash(row["fields"], row["prev_hash"]) != row["hash"]:
            return {"valid": False, "checked": count, "broken_at": row.get("id"), "reason": "Receipt contents do not match the stored hash"}
        expected = row["hash"]
    return {"valid": True, "checked": count, "broken_at": None, "reason": None}
