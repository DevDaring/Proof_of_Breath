from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.risk_rules import MAX_COMMAND_LENGTH, MAX_PATTERN_LENGTH, compile_rule, rule_matches
from ..db.models import ProtectedRule
from ..db.session import get_db
from ..errors import ApiError, CleanText
from ..services.auth import Actor, get_actor, limiter, require_human

router = APIRouter(prefix="/api/rules", tags=["rules"])
SCOPE = "^(shell|sql|git)$"
SEVERITY = "^(low|medium|high|critical)$"
MAX_RULES = 200


class RuleIn(BaseModel):
    scope: str = Field(pattern=SCOPE)
    pattern: CleanText = Field(max_length=MAX_PATTERN_LENGTH + 1)
    severity: str = Field(pattern=SEVERITY)
    reason: CleanText = Field(min_length=1, max_length=300)
    enabled: bool = True


class RulePatch(BaseModel):
    scope: str | None = Field(None, pattern=SCOPE)
    pattern: CleanText | None = Field(None, max_length=MAX_PATTERN_LENGTH + 1)
    severity: str | None = Field(None, pattern=SEVERITY)
    reason: CleanText | None = Field(None, min_length=1, max_length=300)
    enabled: bool | None = None


class RuleTest(BaseModel):
    pattern: CleanText = Field(max_length=MAX_PATTERN_LENGTH + 1)
    sample: CleanText = Field(max_length=MAX_COMMAND_LENGTH)


def view(r: ProtectedRule) -> dict:
    return {"id": str(r.id), "key": r.key, "scope": r.scope, "pattern": r.pattern, "severity": r.severity, "reason": r.reason,
            "enabled": r.enabled, "is_default": r.is_default}


def check_pattern(pattern: str) -> None:
    try:
        compile_rule(pattern)
    except ValueError as exc:
        raise ApiError(422, "bad_pattern", str(exc)) from exc


async def load(db: AsyncSession, actor: Actor, rule_id: uuid.UUID) -> ProtectedRule:
    rule = await db.get(ProtectedRule, rule_id)
    if not rule or rule.workspace_id != actor.workspace_id:
        raise ApiError(404, "not_found", "That rule was not found.")
    return rule


@router.get("")
async def list_rules(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ProtectedRule).where(ProtectedRule.workspace_id == actor.workspace_id)
                             .order_by(ProtectedRule.is_default.desc(), ProtectedRule.created_at, ProtectedRule.id))).scalars().all()
    return [view(r) for r in rows]


@router.post("")
async def create_rule(body: RuleIn, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    check_pattern(body.pattern)
    count = (await db.execute(select(func.count(ProtectedRule.id)).where(ProtectedRule.workspace_id == actor.workspace_id))).scalar_one()
    if count >= MAX_RULES:
        raise ApiError(409, "too_many_rules", f"A workspace can hold up to {MAX_RULES} rules.")
    rule = ProtectedRule(workspace_id=actor.workspace_id, is_default=False, **body.model_dump())
    db.add(rule)
    await db.commit()
    return view(rule)


@router.post("/test")
async def test_rule(body: RuleTest, actor: Actor = Depends(require_human)):
    try:
        compiled = compile_rule(body.pattern)
    except ValueError as exc:
        return {"valid": False, "error": str(exc), "matches": False}
    limiter.check(f"ruletest:{actor.workspace_id}", 300, 60)
    return {"valid": True, "error": None, "matches": await asyncio.to_thread(rule_matches, compiled, body.sample)}


@router.put("/{rule_id}")
async def update_rule(rule_id: uuid.UUID, body: RulePatch, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    rule = await load(db, actor, rule_id)
    changes = body.model_dump(exclude_none=True)
    if "pattern" in changes:
        check_pattern(changes["pattern"])
    for name, value in changes.items():
        setattr(rule, name, value)
    await db.commit()
    return view(rule)


@router.delete("/{rule_id}")
async def delete_rule(rule_id: uuid.UUID, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    rule = await load(db, actor, rule_id)
    if rule.is_default:
        raise ApiError(409, "default_rule", "Built-in rules can be turned off but not deleted.")
    await db.delete(rule)
    await db.commit()
    return {"deleted": True}
