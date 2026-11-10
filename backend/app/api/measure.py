"""Free reading: what the SDK sees right now. Display only. It approves nothing and stores nothing."""
from __future__ import annotations

import asyncio
import time
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_config
from ..db.models import AppSettings
from ..db.session import get_db
from ..errors import ApiError
from ..services.auth import Actor, limiter, require_human
from ..services.runtime import MeasureRun, active_consent, hub

router = APIRouter(prefix="/api/measure", tags=["measure"])


class MeasureIn(BaseModel):
    sensor: str | None = Field(None, pattern="^(camera|bridge)$")


def _find(actor: Actor, run_id: uuid.UUID) -> MeasureRun:
    run = hub.measures.get(run_id)
    if not run or run.workspace_id != actor.workspace_id:
        raise ApiError(404, "not_found", "That reading was not found.")
    return run


@router.post("")
async def start(body: MeasureIn | None = None, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    limiter.check(f"measure:{actor.workspace_id}", 10, 60)
    if not await active_consent(db, actor.workspace_id, "gate"):
        raise ApiError(409, "consent_required", "Please accept the consent notice first.")
    for run in hub.measures.values():
        if run.workspace_id == actor.workspace_id and run.task and not run.task.done():
            return run.view()
    sensor = body.sensor if body and body.sensor else ("bridge" if actor.role == "owner" and hub.bridge.connected else "camera")
    if sensor == "bridge" and actor.role != "owner":
        raise ApiError(403, "owner_only", "Only the owner can use the desktop sensor bridge.")
    if sensor == "camera" and not get_config().relay_token:
        raise ApiError(409, "camera_offline", "The browser camera is not set up on this server.")
    hub.links.check(sensor)
    settings = await db.get(AppSettings, actor.workspace_id)
    polarity = settings.breath_polarity if settings and settings.polarity_live else None
    run = MeasureRun(hub, actor.workspace_id, sensor, not settings.telemetry_opt_out, polarity)
    hub.measures[run.id] = run
    run.task = asyncio.create_task(run.run())
    return run.view()


@router.get("/{run_id}")
async def poll(run_id: uuid.UUID, since: float | None = Query(None, ge=0, le=3600), actor: Actor = Depends(require_human)):
    run = _find(actor, run_id)
    run.last_polled = time.time()
    return run.view(since)


@router.post("/{run_id}/stop")
async def stop(run_id: uuid.UUID, actor: Actor = Depends(require_human)):
    run = _find(actor, run_id)
    run.stop()
    if run.task and not run.task.done():
        try:
            await asyncio.wait_for(asyncio.shield(run.task), timeout=5)
        except (asyncio.TimeoutError, Exception):
            pass
    return run.view()
