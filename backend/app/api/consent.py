from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import CONSENT_VERSION
from ..db.models import AppSettings, ConsentRecord, utcnow
from ..db.session import get_db
from ..services.auth import Actor, get_actor, require_human
from ..services.runtime import active_consent, hub

router = APIRouter(prefix="/api/consent", tags=["consent"])
SCOPES = "^(gate|evaluation|runtime_llm)$"


class Grant(BaseModel):
    scope: str = Field(pattern=SCOPES)


def view(r: ConsentRecord) -> dict:
    return {"id": str(r.id), "scope": r.scope, "consent_version": r.consent_version, "granted_at": r.granted_at.isoformat(),
            "revoked_at": r.revoked_at.isoformat() if r.revoked_at else None}


@router.get("")
async def list_consent(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ConsentRecord).where(ConsentRecord.workspace_id == actor.workspace_id).order_by(ConsentRecord.granted_at.desc()))).scalars().all()
    return {"version": CONSENT_VERSION, "active": sorted({r.scope for r in rows if not r.revoked_at and r.consent_version == CONSENT_VERSION}), "records": [view(r) for r in rows]}


@router.post("")
async def grant(body: Grant, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    existing = await active_consent(db, actor.workspace_id, body.scope)
    if existing:
        return view(existing)
    record = ConsentRecord(workspace_id=actor.workspace_id, consent_version=CONSENT_VERSION, scope=body.scope)
    db.add(record)
    await db.commit()
    return view(record)


@router.delete("")
async def revoke(scope: str = Query(pattern=SCOPES), actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    if scope in ("gate", "evaluation"):
        await hub.cancel_workspace(actor.workspace_id)
    await db.execute(update(ConsentRecord).where(ConsentRecord.workspace_id == actor.workspace_id, ConsentRecord.scope == scope,
                                                 ConsentRecord.revoked_at.is_(None)).values(revoked_at=utcnow()))
    if scope == "runtime_llm":
        settings = await db.get(AppSettings, actor.workspace_id)
        settings.runtime_llm_enabled = False
    await db.commit()
    return {"revoked": scope}
