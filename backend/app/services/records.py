"""Database steps shared by the API and the runtime: receipts, decisions and tokens."""
from __future__ import annotations

import secrets
import time
import uuid
from datetime import timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_config
from ..core.receipts import GENESIS, receipt_hash
from ..core.tokens import derive_token, token_hash
from ..db.models import ApprovalToken, Attempt, Challenge, GateRequest, Receipt, Workspace, utcnow


def receipt_fields(r: Receipt) -> dict:
    return {
        "id": str(r.id),
        "seq": r.seq,
        "request_id": str(r.request_id) if r.request_id else None,
        "command_sha256": r.command_sha256,
        "source": r.source,
        "decision": r.decision,
        "method": r.method,
        "scores": r.scores,
        "created_at": r.created_at.astimezone(timezone.utc).isoformat(),
    }


def _no_negative_zero(value):
    """JSONB drops the sign of -0.0, which would make a valid receipt fail verification."""
    if isinstance(value, float) and value == 0:
        return 0.0
    if isinstance(value, dict):
        return {k: _no_negative_zero(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_no_negative_zero(v) for v in value]
    return value


async def append_receipt(db: AsyncSession, request: GateRequest, decision: str, method: str, scores: dict) -> Receipt:
    """Append under a workspace row lock so that concurrent decisions cannot fork the chain."""
    await db.execute(select(Workspace.id).where(Workspace.id == request.workspace_id).with_for_update())
    last = (await db.execute(
        select(Receipt).where(Receipt.workspace_id == request.workspace_id).order_by(Receipt.seq.desc()).limit(1)
    )).scalar_one_or_none()
    receipt = Receipt(
        id=uuid.uuid4(), workspace_id=request.workspace_id, seq=(last.seq + 1) if last else 1, request_id=request.id,
        command_sha256=request.command_sha256, source=request.source, decision=decision, method=method,
        scores=_no_negative_zero(scores), created_at=utcnow(), prev_hash=last.hash if last else GENESIS, hash="",
    )
    receipt.hash = receipt_hash(receipt_fields(receipt), receipt.prev_hash)
    db.add(receipt)
    return receipt


async def issue_token(db: AsyncSession, request: GateRequest) -> None:
    """Refuses anything other than a real, non-simulated command request."""
    if request.simulated or request.purpose != "command":
        raise RuntimeError("tokens are only for real commands")
    cfg = get_config()
    token_id = uuid.uuid4()
    expires_at = time.time() + cfg.token_ttl_s
    raw = derive_token(cfg.hmac_secret, str(token_id), str(request.id), request.command_sha256, expires_at)
    db.add(ApprovalToken(id=token_id, request_id=request.id, command_sha256=request.command_sha256,
                         token_hash=token_hash(raw), expires_at=expires_at))


async def current_token(db: AsyncSession, request: GateRequest) -> str | None:
    token = (await db.execute(select(ApprovalToken).where(ApprovalToken.request_id == request.id))).scalars().first()
    if not token or token.used_at is not None or token.expires_at < time.time():
        return None
    return derive_token(get_config().hmac_secret, str(token.id), str(token.request_id), token.command_sha256, token.expires_at)


async def consume_token(db: AsyncSession, raw: str, command_sha256: str) -> bool:
    """Atomic: of two concurrent verifications, exactly one succeeds."""
    result = await db.execute(
        update(ApprovalToken)
        .where(ApprovalToken.token_hash == token_hash(raw), ApprovalToken.command_sha256 == command_sha256,
               ApprovalToken.used_at.is_(None), ApprovalToken.expires_at >= time.time())
        .values(used_at=utcnow())
    )
    await db.commit()
    return result.rowcount == 1


async def attempts_used(db: AsyncSession, request_id: uuid.UUID) -> int:
    return (await db.execute(
        select(func.count(Attempt.id)).join(Challenge, Attempt.challenge_id == Challenge.id).where(Challenge.request_id == request_id)
    )).scalar_one()


async def latest_attempt(db: AsyncSession, request_id: uuid.UUID) -> Attempt | None:
    return (await db.execute(
        select(Attempt).join(Challenge, Attempt.challenge_id == Challenge.id)
        .where(Challenge.request_id == request_id).order_by(Attempt.created_at.desc()).limit(1)
    )).scalar_one_or_none()


async def next_attempt_no(db: AsyncSession, request_id: uuid.UUID) -> int:
    return (await db.execute(select(func.count(Challenge.id)).where(Challenge.request_id == request_id))).scalar_one() + 1


def new_nonce() -> str:
    return secrets.token_hex(16)


async def expire_if_due(db: AsyncSession, request: GateRequest) -> bool:
    """Close a pending request whose time ran out, with a receipt."""
    if request.status != "pending":
        return False
    cfg = get_config()
    real = not request.simulated and request.purpose == "command"
    if (utcnow() - request.created_at).total_seconds() < (cfg.real_request_ttl_s if real else cfg.request_ttl_s):
        return False
    await decide(db, request, "expired", "none", {})
    await db.commit()
    return True


async def decide(db: AsyncSession, request: GateRequest, status: str, method: str, scores: dict) -> None:
    """Record the final status. Evaluation trials keep no receipt: they decide nothing."""
    request.status, request.decided_at = status, utcnow()
    if request.purpose != "eval":
        await append_receipt(db, request, status, method, scores)
