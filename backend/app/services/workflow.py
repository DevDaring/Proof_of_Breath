"""Starting a check. Shared by the gate API and the evaluation runner."""
from __future__ import annotations

import asyncio
import random
import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_config
from .bridge import SENSORS
from ..core.challenge import distinct_decoys, generate_pattern, pattern_length
from ..core.simulate import SCENARIOS
from ..core.tokens import challenge_payload, sign
from ..db.models import AppSettings, Challenge, GateRequest
from ..errors import ApiError
from . import records
from .runtime import EvalContext, SessionConfig, active_consent, hub


def default_sensor(request: GateRequest, role: str) -> str:
    if request.simulated:
        return "sim"
    return "bridge" if role == "owner" and hub.bridge.connected else "camera"


def check_sensor(sensor: str, request: GateRequest, role: str) -> None:
    """Who may use which sensor. Only the owner may switch on the owner's desktop camera."""
    if sensor not in SENSORS:
        raise ApiError(422, "bad_sensor", "Unknown sensor.")
    if sensor == "sim" and not request.simulated:
        raise ApiError(422, "live_only", "A real check cannot use a simulated sensor.")
    if sensor == "bridge" and role != "owner":
        raise ApiError(403, "owner_only", "Only the owner can use the desktop sensor bridge.")
    if sensor == "camera" and not get_config().relay_token:
        raise ApiError(409, "camera_offline", "The browser camera is not set up on this server.")


async def start_attempt(db: AsyncSession, request: GateRequest, scenario: str | None, eval_ctx: EvalContext | None = None,
                        sensor: str | None = None, role: str = "owner") -> dict:
    if request.status != "pending":
        raise ApiError(409, "request_closed", "This request has already been decided.")
    # Checked and reserved with no await in between, so a double start cannot get through.
    if request.id in hub.sessions or request.id in hub.starting:
        raise ApiError(409, "check_running", "A check is already running for this request.")
    hub.starting.add(request.id)
    try:
        sensor = sensor or default_sensor(request, role)
        check_sensor(sensor, request, role)
        return await _begin(db, request, scenario, eval_ctx, sensor)
    finally:
        hub.starting.discard(request.id)


async def _begin(db: AsyncSession, request: GateRequest, scenario: str | None, eval_ctx: EvalContext | None, sensor: str) -> dict:
    cfg = get_config()
    if await records.attempts_used(db, request.id) >= cfg.max_attempts:
        raise ApiError(409, "no_attempts_left", "No attempts are left for this request.")
    if not await active_consent(db, request.workspace_id, "gate"):
        raise ApiError(409, "consent_required", "Please review and accept the consent notice before the first check.")

    settings = await db.get(AppSettings, request.workspace_id)
    simulated = sensor == "sim"
    if simulated:
        if scenario is not None and scenario not in SCENARIOS:
            raise ApiError(422, "bad_scenario", "Unknown simulated scenario.")
        if hub.simulated_count() >= cfg.max_sim_sessions:
            raise ApiError(429, "busy", "Too many simulated checks are running. Please try again shortly.")
        polarity = 1
    else:
        if scenario is not None:
            raise ApiError(422, "live_only", "A real sensor cannot run a simulated scenario.")
        hub.links.check(sensor)
        if settings.breath_polarity is None or not settings.polarity_live:
            raise ApiError(409, "calibration_required", "Please do the one-breath calibration with your camera first.")
        polarity = settings.breath_polarity

    rng = random.SystemRandom()
    phases = generate_pattern(rng)
    decoys = await asyncio.to_thread(distinct_decoys, phases, rng)
    warmup = cfg.sim_warmup_s if simulated else cfg.live_warmup_s
    issued = time.time()
    expires = issued + cfg.arming_timeout_s + warmup + pattern_length(phases) + 15.0
    challenge = Challenge(id=uuid.uuid4(), request_id=request.id, attempt_no=await records.next_attempt_no(db, request.id),
                          nonce=records.new_nonce(), phases=phases, decoys=decoys, issued_at=issued, expires_at=expires, hmac="")
    challenge.hmac = sign(cfg.hmac_secret, challenge_payload(challenge.id, challenge.nonce, phases, issued, expires, request.command_sha256))
    db.add(challenge)
    await db.commit()

    hub.start_session(SessionConfig(
        request_id=request.id, workspace_id=request.workspace_id, challenge_id=challenge.id, attempt_no=challenge.attempt_no,
        phases=phases, decoys=decoys, simulated=simulated, scenario=scenario if simulated else None, sensor=sensor,
        thresholds=dict(settings.thresholds), gates=dict(settings.enabled_gates), polarity=polarity,
        telemetry=not settings.telemetry_opt_out, command_sha256=request.command_sha256, eval_ctx=eval_ctx,
    ))
    return {
        "challenge_id": str(challenge.id), "attempt_no": challenge.attempt_no, "phases": phases, "warmup_s": warmup,
        "simulated": simulated, "sensor": sensor, "expires_at": expires,
        "max_attempts": cfg.max_attempts,
    }
