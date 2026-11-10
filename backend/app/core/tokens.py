"""HMAC signing and single-use approval tokens (spec section 7.5). Pure functions."""
from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)


def sign(secret: str, payload: Any) -> str:
    return hmac.new(secret.encode(), canonical_json(payload).encode(), hashlib.sha256).hexdigest()


def verify_signature(secret: str, payload: Any, signature: str) -> bool:
    return hmac.compare_digest(sign(secret, payload), signature or "")


def challenge_payload(challenge_id: str, nonce: str, phases: Any, issued_at: float, expires_at: float, command_sha256: str) -> dict:
    return {
        "id": str(challenge_id),
        "nonce": nonce,
        "phases": phases,
        "issued_at": round(issued_at, 6),
        "expires_at": round(expires_at, 6),
        "command_sha256": command_sha256,
    }


def derive_token(secret: str, token_id: str, request_id: str, command_sha256: str, expires_at: float) -> str:
    """The raw token is derived on demand, so only its hash ever reaches the database."""
    mac = sign(secret, {"t": str(token_id), "r": str(request_id), "c": command_sha256, "e": round(expires_at, 6)})
    return f"{token_id}.{mac}"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
