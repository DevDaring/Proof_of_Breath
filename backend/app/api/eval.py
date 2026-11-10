"""Evaluation lab (spec section 13). Live and simulated results are never mixed."""
from __future__ import annotations

import asyncio
import random
import re
import time
import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_config
from ..core.challenge import distinct_decoys, generate_pattern, pattern_length
from ..core.risk_rules import command_sha256
from ..core.simulate import simulate
from ..core.stats import auc, histogram, percentile, roc_curve, wilson_interval, youden_threshold
from ..core.tokens import challenge_payload, sign
from ..core.verifier import verify
from ..db.models import AppSettings, Attempt, Challenge, EvalSession, EvalTrial, GateRequest, Receipt, utcnow
from ..db.session import get_db
from ..errors import ApiError, CleanText
from ..services.auth import Actor, get_actor, limiter, require_human
from ..services.records import new_nonce
from ..services.runtime import EvalContext, active_consent, hub
from ..services.workflow import start_attempt

router = APIRouter(prefix="/api/eval", tags=["eval"])

CONDITIONS = [
    {"id": "genuine_normal", "label": "Genuine, following the pacer (normal light)", "genuine": True, "scenario": "follower", "instruction": "Sit still and follow the pacer."},
    {"id": "genuine_dim", "label": "Genuine, following the pacer (dim light)", "genuine": True, "scenario": "follower", "instruction": "Dim the room, sit still and follow the pacer."},
    {"id": "ignore_pacer", "label": "Ignoring the pacer (natural breathing)", "genuine": False, "scenario": "natural", "instruction": "Look at the screen and breathe normally. Do not follow the pacer."},
    {"id": "slow_steady", "label": "Steady slow breathing near 6 per minute", "genuine": False, "scenario": "slow_steady", "instruction": "Breathe slowly and steadily at about 6 per minute. Do not follow the pacer."},
    {"id": "photo", "label": "Printed or phone photo held to the camera", "genuine": False, "scenario": "photo", "instruction": "Hold a photo of a face in front of the camera."},
    {"id": "screen_replay", "label": "Screen replay of an earlier session", "genuine": False, "scenario": "replay", "instruction": "Hold a phone or monitor playing an earlier session up to the camera."},
    {"id": "virtual_replay", "label": "Virtual camera replay of an earlier session", "genuine": False, "scenario": "replay", "instruction": "Route an earlier recording through a virtual camera, if the SDK accepts it."},
    {"id": "empty_chair", "label": "Empty chair", "genuine": False, "scenario": "empty", "instruction": "Leave the chair empty."},
]
BY_ID = {c["id"]: c for c in CONDITIONS}
SCORES = ["s_xcorr", "s_phase", "s_live", "s_decoy", "s_coupling"]
MAX_TRIALS = 3000
MIN_CALIBRATION = 10


class SessionIn(BaseModel):
    participant_code: CleanText = Field(min_length=1, max_length=32)
    lighting: CleanText = Field("normal", max_length=32)
    notes: CleanText | None = Field(None, max_length=500)
    live: bool = False


class TrialIn(BaseModel):
    session_id: uuid.UUID
    condition: str
    sensor: str | None = Field(None, pattern="^(camera|bridge)$")


class SyntheticIn(BaseModel):
    per_condition: int = Field(30, ge=1, le=50)


async def _session(db: AsyncSession, actor: Actor, session_id: uuid.UUID) -> EvalSession:
    session = await db.get(EvalSession, session_id)
    if not session or session.workspace_id != actor.workspace_id:
        raise ApiError(404, "not_found", "That evaluation session was not found.")
    return session


async def _require_consent(db: AsyncSession, actor: Actor) -> None:
    if not await active_consent(db, actor.workspace_id, "evaluation"):
        raise ApiError(409, "consent_required", "Evaluation mode needs its own opt-in. Please opt in first.")


async def _trial_count(db: AsyncSession, actor: Actor) -> int:
    return (await db.execute(select(func.count(EvalTrial.id)).join(EvalSession, EvalTrial.session_id == EvalSession.id)
                             .where(EvalSession.workspace_id == actor.workspace_id))).scalar_one()


@router.get("/conditions")
async def conditions(actor: Actor = Depends(get_actor)):
    return CONDITIONS


@router.post("/sessions")
async def create_session(body: SessionIn, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    await _require_consent(db, actor)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", body.participant_code):
        raise ApiError(422, "bad_code", "Use a participant code with letters, digits, dashes or underscores only, never a name.")
    # Live trials need a real sensor: the browser camera, or the owner's desktop bridge.
    if body.live and not (hub.links.camera_online or (actor.role == "owner" and hub.bridge.connected)):
        raise ApiError(409, "camera_offline", "No real sensor is available right now.")
    session = EvalSession(workspace_id=actor.workspace_id, participant_code=body.participant_code, lighting=body.lighting, notes=body.notes, simulated=not body.live)
    db.add(session)
    await db.commit()
    return _session_view(session, 0)


def _session_view(s: EvalSession, trials: int) -> dict:
    return {"id": str(s.id), "participant_code": s.participant_code, "lighting": s.lighting, "notes": s.notes, "simulated": s.simulated,
            "created_at": s.created_at.isoformat(), "trials": trials}


@router.get("/sessions")
async def list_sessions(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(EvalSession, func.count(EvalTrial.id)).outerjoin(EvalTrial, EvalTrial.session_id == EvalSession.id)
        .where(EvalSession.workspace_id == actor.workspace_id).group_by(EvalSession.id).order_by(EvalSession.created_at.desc())
    )).all()
    return [_session_view(s, n) for s, n in rows]


@router.post("/trials")
async def create_trial(body: TrialIn, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    await _require_consent(db, actor)
    limiter.check(f"attempt:{actor.workspace_id}", 20, 60)
    session = await _session(db, actor, body.session_id)
    condition = BY_ID.get(body.condition)
    if not condition:
        raise ApiError(422, "bad_condition", "Unknown evaluation condition.")
    if await _trial_count(db, actor) >= MAX_TRIALS:
        raise ApiError(409, "too_many_trials", "This workspace has reached its trial limit.")
    label = f"evaluation trial: {condition['id']}"
    request = GateRequest(workspace_id=actor.workspace_id, source="demo" if session.simulated else "practice", command_sha256=command_sha256(f"{label}:{uuid.uuid4()}"),
                          command_text=label, matched_reason=condition["label"], purpose="eval", simulated=session.simulated)
    db.add(request)
    await db.flush()
    if session.simulated and body.sensor:
        raise ApiError(422, "simulated_session", "A simulated session cannot use a real sensor.")
    started = await start_attempt(db, request, condition["scenario"] if session.simulated else None,
                                  EvalContext(session.id, condition["id"], store_series=True), sensor=body.sensor, role=actor.role)
    return {"request_id": str(request.id), "condition": condition, **started}


@router.get("/trials")
async def list_trials(limit: int = Query(200, ge=1, le=1000), actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(EvalTrial, Attempt, EvalSession).join(Attempt, EvalTrial.attempt_id == Attempt.id).join(EvalSession, EvalTrial.session_id == EvalSession.id)
        .where(EvalSession.workspace_id == actor.workspace_id).order_by(EvalTrial.created_at.desc()).limit(limit)
    )).all()
    return [_trial_view(t, a, s) for t, a, s in rows]


def _trial_view(t: EvalTrial, a: Attempt, s: EvalSession) -> dict:
    return {"id": str(t.id), "session_id": str(t.session_id), "participant_code": s.participant_code, "simulated": s.simulated, "condition": t.condition,
            "condition_label": BY_ID.get(t.condition, {}).get("label", t.condition), "passed": a.passed, "s_xcorr": a.s_xcorr, "s_phase": a.s_phase,
            "s_cycles": a.s_cycles, "target_cycles": a.target_cycles, "s_live": a.s_live, "s_decoy": a.s_decoy, "s_coupling": a.s_coupling,
            "s_coupling_decoy": a.s_coupling_decoy, "duration_s": t.duration_s, "stored_series": t.breath_series is not None, "created_at": t.created_at.isoformat()}


def _run_synthetic(per_condition: int, thresholds: dict, gates: dict) -> list[dict]:
    rng = random.Random()
    out = []
    for condition in CONDITIONS:
        for _ in range(per_condition):
            phases = generate_pattern(rng)
            decoys = distinct_decoys(phases, rng)
            seed = rng.randint(0, 2**31 - 1)
            scores = verify(phases, decoys, simulate(condition["scenario"], phases, seed=seed, rsa=2.0), 0.0, 1, thresholds, gates)
            out.append({"condition": condition["id"], "phases": phases, "decoys": decoys, "scores": scores})
    return out


@router.post("/synthetic")
async def synthetic(body: SyntheticIn, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    """Instant batch through the real verifier with synthetic signals. Always labelled simulated."""
    await _require_consent(db, actor)
    limiter.check(f"synthetic:{actor.workspace_id}", 6, 60)
    if await _trial_count(db, actor) + body.per_condition * len(CONDITIONS) > MAX_TRIALS:
        raise ApiError(409, "too_many_trials", "This workspace has reached its trial limit.")
    settings = await db.get(AppSettings, actor.workspace_id)
    results = await asyncio.to_thread(_run_synthetic, body.per_condition, dict(settings.thresholds), dict(settings.enabled_gates))
    cfg = get_config()
    session = EvalSession(workspace_id=actor.workspace_id, participant_code="synthetic", lighting="none", notes="Synthetic signals, no person involved.", simulated=True)
    db.add(session)
    await db.flush()
    now = time.time()
    for item in results:
        digest = command_sha256(f"synthetic:{uuid.uuid4()}")
        request = GateRequest(workspace_id=actor.workspace_id, source="demo", command_sha256=digest, purpose="eval", simulated=True,
                              status="practice_passed" if item["scores"].passed else "denied", decided_at=utcnow())
        db.add(request)
        await db.flush()
        challenge = Challenge(id=uuid.uuid4(), request_id=request.id, attempt_no=1, nonce=new_nonce(), phases=item["phases"], decoys=item["decoys"],
                              issued_at=now, expires_at=now, hmac="", consumed_at=utcnow())
        challenge.hmac = sign(cfg.hmac_secret, challenge_payload(challenge.id, challenge.nonce, challenge.phases, now, now, digest))
        db.add(challenge)
        await db.flush()
        s = item["scores"]
        attempt = Attempt(id=uuid.uuid4(), challenge_id=challenge.id, s_xcorr=s.s_xcorr, s_phase=s.s_phase, s_cycles=s.s_cycles, target_cycles=s.target_cycles, s_live=s.s_live,
                          s_decoy=s.s_decoy, s_coupling=s.s_coupling, s_coupling_decoy=s.s_coupling_decoy, best_lag_s=s.best_lag_s, passed=s.passed, failure_reasons=s.failure_reasons)
        db.add(attempt)
        await db.flush()
        db.add(EvalTrial(session_id=session.id, condition=item["condition"], challenge_id=challenge.id, attempt_id=attempt.id,
                         duration_s=round(pattern_length(item["phases"]) + cfg.live_warmup_s + cfg.sensor_tail_s, 2)))
    await db.commit()
    return {"session_id": str(session.id), "trials": len(results), "simulated": True}


async def _rows(db: AsyncSession, actor: Actor, live: bool) -> list[tuple]:
    return (await db.execute(
        select(EvalTrial, Attempt, EvalSession).join(Attempt, EvalTrial.attempt_id == Attempt.id).join(EvalSession, EvalTrial.session_id == EvalSession.id)
        .where(EvalSession.workspace_id == actor.workspace_id, EvalSession.simulated.is_(not live)).order_by(EvalTrial.created_at)
    )).all()


def _rate(k: int, n: int) -> dict:
    low, high = wilson_interval(k, n)
    return {"k": k, "n": n, "rate": (k / n) if n else None, "ci_low": low, "ci_high": high}


def _spread(values: list[float]) -> dict:
    return {"n": len(values), "low": percentile(values, 0.1), "median": percentile(values, 0.5), "high": percentile(values, 0.9)}


def compute_results(rows: list[tuple], live: bool) -> dict:
    per = []
    genuine = [(t, a) for t, a, _ in rows if BY_ID.get(t.condition, {}).get("genuine")]
    attacks = [(t, a) for t, a, _ in rows if not BY_ID.get(t.condition, {}).get("genuine", True)]
    for c in CONDITIONS:
        group = [a for t, a, _ in rows if t.condition == c["id"]]
        passed = sum(a.passed for a in group)
        per.append({"id": c["id"], "label": c["label"], "genuine": c["genuine"], "metric": "FRR" if c["genuine"] else "FAR",
                    **_rate(len(group) - passed if c["genuine"] else passed, len(group)),
                    "s_decoy_median": percentile([a.s_decoy for a in group], 0.5), "s_xcorr_median": percentile([a.s_xcorr for a in group], 0.5)})
    frr = _rate(sum(not a.passed for _, a in genuine), len(genuine))
    far = _rate(sum(a.passed for _, a in attacks), len(attacks))
    auc_values = {}
    for score in SCORES:
        pos = [getattr(a, score) for _, a in genuine]
        neg = [getattr(a, score) for _, a in attacks]
        auc_values[score] = auc(pos, neg)
    pos = [a.s_decoy for _, a in genuine]
    neg = [a.s_decoy for _, a in attacks]
    low, high, bins = -1.5, 0.5, 20
    width = (high - low) / bins
    hist = [{"bin": round(low + i * width, 2), "genuine": g, "attack": b} for i, (g, b) in
            enumerate(zip(histogram(pos, low, high, bins), histogram(neg, low, high, bins)))]
    times = [t.duration_s for t, a in genuine if a.passed and t.duration_s is not None]
    ranges = {score: [{"id": c["id"], "label": c["label"], "genuine": c["genuine"], **_spread([getattr(a, score) for t, a, _ in rows if t.condition == c["id"]])}
                      for c in CONDITIONS] for score in SCORES}
    return {
        "data_class": "live" if live else "simulated",
        "label": "Live trials with the SDK" if live else "Simulated signals. These are not measurements of a person.",
        "n_trials": len(rows), "n_participants": len({s.participant_code for _, _, s in rows}), "conditions": per, "frr": frr, "far": far,
        "auc": auc_values, "coupling_auc": auc_values["s_coupling"], "s_decoy_histogram": hist, "score_ranges": ranges,
        "roc": [p for p in roc_curve(pos, neg)][:: max(1, len(roc_curve(pos, neg)) // 100)] if pos and neg else [],
        "time_to_approve": {"median_s": percentile(times, 0.5), "p90_s": percentile(times, 0.9), "n": len(times),
                            "note": "Nominal from pattern length, warm-up and tail" if not live else "Measured"},
    }


@router.get("/results")
async def results(data: str = Query("simulated", pattern="^(simulated|live)$"), actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    live = data == "live"
    rows = await _rows(db, actor, live)
    out = await asyncio.to_thread(compute_results, rows, live)
    approved = (await db.execute(select(Receipt.scores).where(Receipt.workspace_id == actor.workspace_id, Receipt.decision == "approved"))).scalars().all()
    tries = [s.get("attempts", 1) for s in approved]
    out["retries_per_approval"] = (sum(tries) / len(tries) - 1) if tries else None
    settings = await db.get(AppSettings, actor.workspace_id)
    out["thresholds_calibrated"] = settings.thresholds_calibrated
    return out


@router.get("/export")
async def export(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    payload = {"exported_at": utcnow().isoformat()}
    for name, live in (("live", True), ("simulated", False)):
        rows = await _rows(db, actor, live)
        payload[name] = {"results": await asyncio.to_thread(compute_results, rows, live), "trials": [_trial_view(t, a, s) for t, a, s in rows]}
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="pob-evaluation.json"'})


@router.post("/calibrate")
async def calibrate(actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    """Fit on the first half of live trials, report on the second. Simulated data cannot calibrate."""
    rows = await _rows(db, actor, True)
    half = len(rows) // 2
    fit, hold = rows[:half], rows[half:]
    def split(group):
        return ([a for t, a, _ in group if BY_ID.get(t.condition, {}).get("genuine")], [a for t, a, _ in group if not BY_ID.get(t.condition, {}).get("genuine", True)])
    pos, neg = split(fit)
    if len(pos) < MIN_CALIBRATION or len(neg) < MIN_CALIBRATION:
        raise ApiError(409, "not_enough_live_trials",
                       f"Calibration needs at least {MIN_CALIBRATION} genuine and {MIN_CALIBRATION} attack live trials in its first half. "
                       f"So far it has {len(pos)} and {len(neg)}. Simulated trials never count.")
    settings = await db.get(AppSettings, actor.workspace_id)
    merged = dict(settings.thresholds)
    chosen = {}
    for score in ("s_xcorr", "s_phase", "s_live", "s_decoy"):
        value = youden_threshold([getattr(a, score) for a in pos], [getattr(a, score) for a in neg])
        if value is not None:
            merged[score] = chosen[score] = round(value, 4)
    hold_pos, hold_neg = split(hold)
    def passes(a):
        return all(getattr(a, k) >= merged[k] for k in ("s_xcorr", "s_phase", "s_live", "s_decoy")) and a.s_cycles == a.target_cycles
    settings.thresholds, settings.thresholds_calibrated = merged, True
    await db.commit()
    return {"thresholds": chosen, "fit_trials": len(fit), "holdout_trials": len(hold),
            "holdout_frr": _rate(sum(not passes(a) for a in hold_pos), len(hold_pos)), "holdout_far": _rate(sum(passes(a) for a in hold_neg), len(hold_neg))}


async def _delete_trial_rows(db: AsyncSession, request_ids) -> None:
    await db.execute(delete(GateRequest).where(GateRequest.id.in_(request_ids)))


@router.delete("/trials/{trial_id}")
async def delete_trial(trial_id: uuid.UUID, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    trial = await db.get(EvalTrial, trial_id)
    if not trial or (await _session(db, actor, trial.session_id)) is None:
        raise ApiError(404, "not_found", "That trial was not found.")
    challenge = await db.get(Challenge, trial.challenge_id)
    await db.delete(trial)
    if challenge:
        await _delete_trial_rows(db, [challenge.request_id])
    await db.commit()
    return {"deleted": True}


async def _request_ids_for(db: AsyncSession, session_ids) -> list:
    return (await db.execute(select(Challenge.request_id).join(EvalTrial, EvalTrial.challenge_id == Challenge.id).where(EvalTrial.session_id.in_(session_ids)))).scalars().all()


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: uuid.UUID, actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    await _session(db, actor, session_id)
    ids = await _request_ids_for(db, [session_id])
    await db.execute(delete(EvalSession).where(EvalSession.id == session_id))
    await _delete_trial_rows(db, ids)
    await db.commit()
    return {"deleted": True}


@router.delete("/data")
async def delete_all_eval(actor: Actor = Depends(require_human), db: AsyncSession = Depends(get_db)):
    session_ids = (await db.execute(select(EvalSession.id).where(EvalSession.workspace_id == actor.workspace_id))).scalars().all()
    ids = await _request_ids_for(db, session_ids) if session_ids else []
    await db.execute(delete(EvalSession).where(EvalSession.workspace_id == actor.workspace_id))
    await _delete_trial_rows(db, ids)
    await db.execute(delete(GateRequest).where(GateRequest.workspace_id == actor.workspace_id, GateRequest.purpose == "eval"))
    await db.commit()
    return {"deleted": True}
