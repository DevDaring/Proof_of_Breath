from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_config
from ..core.thresholds import DEFAULT_ENABLED_GATES, DEFAULT_THRESHOLDS
from ..db.models import AppSettings
from ..db.session import get_db
from ..errors import ApiError
from ..services.auth import Actor, get_actor, require_human
from ..services.runtime import CalibrationRun, active_consent, hub

router = APIRouter(prefix="/api", tags=["settings"])
RANGES = {"s_xcorr": (0, 1), "s_phase": (0, 1), "s_live": (0, 1), "s_decoy": (-1, 1), "s_coupling": (0, 1), "pulse_confidence_min": (0, 100)}


class SettingsPatch(BaseModel):
    thresholds: dict[str, float] | None = None
    enabled_gates: dict[str, bool] | None = None
    breath_polarity: int | None = Field(None, ge=-1, le=1)
    telemetry_opt_out: bool | None = None
    store_command_text: bool | None = None
    runtime_llm_enabled: bool | None = None


def view(s: AppSettings) -> dict:
    cfg = get_config()
    return {
        "thresholds": s.thresholds, "enabled_gates": s.enabled_gates, "thresholds_calibrated": s.thresholds_calibrated,
        "breath_polarity": s.breath_polarity, "polarity_live": bool(s.polarity_live), "telemetry_opt_out": s.telemetry_opt_out, "store_command_text": s.store_command_text,
        "runtime_llm_enabled": s.runtime_llm_enabled, "runtime_llm_available": bool(cfg.nanogpt_api_key and cfg.nanogpt_model),
        "updated_at": s.updated_at.isoformat(),
    }


@router.get("/settings")
async def get_settings(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    return view(await db.get(AppSettings, actor.workspace_id))


@router.put("/settings")
async def put_settings(body: SettingsPatch, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    s = await db.get(AppSettings, actor.workspace_id)
    if body.thresholds is not None:
        merged = dict(s.thresholds)
        for key, value in body.thresholds.items():
            if key not in RANGES:
                raise ApiError(422, "bad_threshold", f"Unknown threshold: {key}")
            low, high = RANGES[key]
            if not low <= value <= high:
                raise ApiError(422, "bad_threshold", f"{key} must be between {low} and {high}.")
            merged[key] = value
        if merged != s.thresholds:
            s.thresholds, s.thresholds_calibrated = merged, False
    if body.enabled_gates is not None:
        unknown = set(body.enabled_gates) - set(DEFAULT_ENABLED_GATES)
        if unknown:
            raise ApiError(422, "bad_gate", f"Unknown gate: {sorted(unknown)[0]}")
        s.enabled_gates = {**s.enabled_gates, **body.enabled_gates}
    if body.breath_polarity is not None:
        if body.breath_polarity == 0:
            raise ApiError(422, "bad_polarity", "Polarity must be +1 or -1.")
        s.breath_polarity = body.breath_polarity
        # A sign chosen by hand is a deliberate setting, so real checks may use it.
        s.polarity_live = True
    if body.telemetry_opt_out is not None:
        s.telemetry_opt_out = body.telemetry_opt_out
    if body.store_command_text is not None:
        s.store_command_text = body.store_command_text
    if body.runtime_llm_enabled is not None:
        if body.runtime_llm_enabled and not await active_consent(db, actor.workspace_id, "runtime_llm"):
            raise ApiError(409, "consent_required", "Please accept the consent notice for this feature first.")
        s.runtime_llm_enabled = body.runtime_llm_enabled
    await db.commit()
    return view(s)


@router.post("/settings/reset-thresholds")
async def reset_thresholds(actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    s = await db.get(AppSettings, actor.workspace_id)
    s.thresholds, s.enabled_gates, s.thresholds_calibrated = dict(DEFAULT_THRESHOLDS), dict(DEFAULT_ENABLED_GATES), False
    await db.commit()
    return view(s)


class CalibrationIn(BaseModel):
    sensor: str | None = Field(None, pattern="^(sim|camera|bridge)$")


@router.post("/calibration/polarity")
async def start_calibration(body: CalibrationIn | None = None, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    if not await active_consent(db, actor.workspace_id, "gate"):
        raise ApiError(409, "consent_required", "Please accept the consent notice first.")
    for run in hub.calibrations.values():
        if run.workspace_id == actor.workspace_id and run.task and not run.task.done():
            return run.view()
    s = await db.get(AppSettings, actor.workspace_id)
    sensor = body.sensor if body and body.sensor else ("sim" if actor.role == "jury" else "bridge" if hub.bridge.connected else "camera")
    # The owner's sign is what real commands depend on, so it can never come from the simulated sensor.
    if sensor == "sim" and actor.role != "jury":
        raise ApiError(422, "live_only", "The owner calibrates with a real camera.")
    if sensor == "bridge" and actor.role != "owner":
        raise ApiError(403, "owner_only", "Only the owner can use the desktop sensor bridge.")
    if sensor == "camera" and not get_config().relay_token:
        raise ApiError(409, "camera_offline", "The browser camera is not set up on this server.")
    if sensor != "sim":
        hub.links.check(sensor)
    run = CalibrationRun(hub, actor.workspace_id, sensor, not s.telemetry_opt_out)
    hub.calibrations[run.id] = run
    run.task = asyncio.create_task(run.run())
    return run.view()


@router.get("/calibration/polarity/{run_id}")
async def get_calibration(run_id: str, actor: Actor = Depends(require_human)):
    for run in hub.calibrations.values():
        if str(run.id) == run_id and run.workspace_id == actor.workspace_id:
            run.last_polled = time.time()
            return run.view()
    raise ApiError(404, "not_found", "That calibration was not found.")
