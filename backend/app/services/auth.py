"""Sessions and roles.

owner       : signed-in owner browser. May approve real commands with a live bridge.
jury        : the public demo login. A private sandbox per sign-in. Simulated only, always.
interceptor : hook or CLI bearer token. May create, poll and verify. Can never approve.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from ..config import get_config
from ..core.risk_rules import DEFAULT_RULES
from ..core.thresholds import DEFAULT_ENABLED_GATES, DEFAULT_THRESHOLDS
from ..db.models import AppSettings, ProtectedRule, Workspace, utcnow
from ..db.session import get_db
from ..errors import ApiError

COOKIE = "pob_session"


@dataclass(frozen=True)
class Actor:
    role: str
    workspace_id: uuid.UUID
    username: str

    @property
    def human(self) -> bool:
        return self.role in ("owner", "jury")


class RateLimiter:
    def __init__(self):
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str, limit: int, window_s: float) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            raise ApiError(429, "rate_limited", "Too many requests. Please wait a moment and try again.")
        q.append(now)


limiter = RateLimiter()


def client_ip(conn: HTTPConnection) -> str:
    return conn.headers.get("x-real-ip") or (conn.client.host if conn.client else "unknown")


def _sign(body: bytes) -> str:
    return hmac.new(get_config().hmac_secret.encode(), b"session:" + body, hashlib.sha256).hexdigest()


def make_cookie(role: str, workspace_id: uuid.UUID, username: str) -> str:
    exp = int(time.time() + get_config().session_days * 86400)
    body = base64.urlsafe_b64encode(json.dumps({"r": role, "w": str(workspace_id), "u": username, "e": exp}).encode())
    return f"{body.decode()}.{_sign(body)}"


def parse_cookie(value: str | None) -> Actor | None:
    if not value or "." not in value:
        return None
    body, _, signature = value.rpartition(".")
    if not hmac.compare_digest(_sign(body.encode()).encode(), signature.encode()):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(body.encode()))
        if data["e"] < time.time() or data["r"] not in ("owner", "jury"):
            return None
        return Actor(data["r"], uuid.UUID(data["w"]), data["u"])
    except (ValueError, KeyError, TypeError):
        return None


def constant_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


async def seed_workspace(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    db.add(AppSettings(workspace_id=workspace_id, thresholds=dict(DEFAULT_THRESHOLDS), enabled_gates=dict(DEFAULT_ENABLED_GATES)))
    for rule in DEFAULT_RULES:
        db.add(ProtectedRule(workspace_id=workspace_id, key=rule["key"], scope=rule["scope"], pattern=rule["pattern"],
                             severity=rule["severity"], reason=rule["reason"], enabled=True, is_default=True))


async def owner_workspace_id(db: AsyncSession) -> uuid.UUID:
    found = (await db.execute(select(Workspace.id).where(Workspace.kind == "owner").limit(1))).scalar_one_or_none()
    if found:
        return found
    workspace = Workspace(kind="owner")
    db.add(workspace)
    await db.flush()
    await seed_workspace(db, workspace.id)
    await db.commit()
    return workspace.id


async def create_jury_workspace(db: AsyncSession) -> uuid.UUID:
    workspace = Workspace(kind="jury")
    db.add(workspace)
    await db.flush()
    await seed_workspace(db, workspace.id)
    await db.commit()
    return workspace.id


async def get_actor(request: Request, db: AsyncSession = Depends(get_db)) -> Actor:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        if constant_eq(header[7:].strip(), get_config().interceptor_token):
            return Actor("interceptor", await owner_workspace_id(db), "interceptor")
        raise ApiError(401, "bad_token", "That token is not valid.")
    actor = parse_cookie(request.cookies.get(COOKIE))
    if not actor:
        raise ApiError(401, "not_signed_in", "Please sign in.")
    workspace = await db.get(Workspace, actor.workspace_id)
    if not workspace:
        raise ApiError(401, "not_signed_in", "This session has ended. Please sign in again.")
    if (utcnow() - workspace.last_seen_at).total_seconds() > 300:
        workspace.last_seen_at = utcnow()
        await db.commit()
    return actor


async def require_human(actor: Actor = Depends(get_actor)) -> Actor:
    if not actor.human:
        raise ApiError(403, "humans_only", "This action is only available to a person signed in through the browser.")
    return actor
