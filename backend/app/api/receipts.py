from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.receipts import verify_chain
from ..db.models import AppSettings, ConsentRecord, EvalSession, GateRequest, ProtectedRule, Receipt, utcnow
from ..db.session import get_db
from ..services.auth import Actor, get_actor, require_human, seed_workspace
from ..services.records import receipt_fields
from ..services.runtime import hub

router = APIRouter(prefix="/api", tags=["receipts"])


def view(r: Receipt) -> dict:
    return {**receipt_fields(r), "prev_hash": r.prev_hash, "hash": r.hash}


@router.get("/receipts")
async def list_receipts(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0, le=1_000_000), actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    total = (await db.execute(select(func.count(Receipt.id)).where(Receipt.workspace_id == actor.workspace_id))).scalar_one()
    rows = (await db.execute(select(Receipt).where(Receipt.workspace_id == actor.workspace_id).order_by(Receipt.seq.desc()).limit(limit).offset(offset))).scalars().all()
    return {"total": total, "items": [view(r) for r in rows]}


async def _all(db: AsyncSession, workspace_id: uuid.UUID) -> list[Receipt]:
    return (await db.execute(select(Receipt).where(Receipt.workspace_id == workspace_id).order_by(Receipt.seq))).scalars().all()


@router.get("/receipts/verify-chain")
async def verify(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = await _all(db, actor.workspace_id)
    return verify_chain({"id": str(r.id), "fields": receipt_fields(r), "prev_hash": r.prev_hash, "hash": r.hash} for r in rows)


@router.get("/receipts/export")
async def export(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = await _all(db, actor.workspace_id)
    payload = {"exported_at": utcnow().isoformat(), "count": len(rows), "receipts": [view(r) for r in rows]}
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="pob-receipts.json"'})


@router.delete("/data")
async def delete_all(actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    """Delete everything for this workspace and go back to first-run defaults."""
    await hub.cancel_workspace(actor.workspace_id)
    for model in (Receipt, EvalSession, GateRequest, ConsentRecord, ProtectedRule, AppSettings):
        await db.execute(delete(model).where(model.workspace_id == actor.workspace_id))
    await seed_workspace(db, actor.workspace_id)
    await db.commit()
    return {"deleted": True}
