"""Live gate sessions: drive the sensor, stream to the browser, then verify on the server."""
from __future__ import annotations

import asyncio
import logging
import statistics
import time
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

import numpy as np
from fastapi import WebSocket
from sqlalchemy import delete, select

from ..config import CONSENT_VERSION, get_config
from ..core.challenge import FS_TARGET, pattern_length, render_target
from ..core.signal import polarity_from_trace, resample
from ..core.simulate import simulate
from ..core.tokens import challenge_payload, verify_signature
from ..core.verifier import FAILURE_TEXT, MAX_LAG_S, SensorData, verify
from ..db.models import Attempt, Challenge, ConsentRecord, EvalTrial, GateRequest, Workspace, AppSettings, utcnow
from ..db.session import SessionLocal
from ..errors import ApiError
from . import records
from .bridge import BridgeHub, Links, camera_ticket

log = logging.getLogger("pob.runtime")
SIM_HINT = "Simulated sensor. No camera is in use."


class Aborted(Exception):
    pass


class Readout:
    """Pulse and breathing rate as the SDK reports them, for display only. They never decide anything."""

    def __init__(self):
        self.pulse: list[tuple[float, float, float]] = []
        self.rate: list[tuple[float, float, float]] = []

    def add(self, msg: dict, offset_s: float) -> None:
        for ts, value, conf in msg.get("pulse", []):
            self.pulse.append((ts / 1e6 + offset_s, float(value), float(conf)))
        for ts, value, conf in msg.get("rate", []):
            self.rate.append((ts / 1e6 + offset_s, float(value), float(conf)))

    @staticmethod
    def _latest(series, now: float, max_age: float):
        for t, v, c in reversed(series):
            if now - t > max_age:
                break
            if t <= now + 1.0 and v > 0:
                return round(v, 1), round(c, 1)
        return None, None

    def view(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        pulse, pulse_conf = self._latest(self.pulse, now, 6.0)
        rate, rate_conf = self._latest(self.rate, now, 15.0)
        return {"pulse_bpm": pulse, "pulse_conf": pulse_conf, "breath_rpm": rate, "breath_conf": rate_conf}

    def summary(self, start: float, end: float, min_conf: float) -> dict:
        pulses = [v for t, v, c in self.pulse if start <= t <= end and c >= min_conf and v > 0]
        rates = [v for t, v, c in self.rate if start <= t <= end and v > 0]
        return {"pulse_bpm": round(statistics.median(pulses), 1) if pulses else None, "pulse_samples": len(pulses),
                "breath_rpm": round(statistics.median(rates), 1) if rates else None}

    def history(self, since: float) -> dict:
        return {"pulse": [[round(t, 2), round(v, 1), round(c, 1)] for t, v, c in self.pulse if t >= since],
                "rate": [[round(t, 2), round(v, 1), round(c, 1)] for t, v, c in self.rate if t >= since]}


@dataclass
class EvalContext:
    session_id: uuid.UUID
    condition: str
    store_series: bool


@dataclass
class SessionConfig:
    request_id: uuid.UUID
    workspace_id: uuid.UUID
    challenge_id: uuid.UUID
    attempt_no: int
    phases: list
    decoys: list
    simulated: bool
    scenario: str | None
    thresholds: dict
    gates: dict
    polarity: int
    telemetry: bool
    command_sha256: str
    eval_ctx: EvalContext | None = None
    # Where the signal comes from: sim, camera (browser, through a relay slot) or bridge (the owner's desktop).
    sensor: str = "sim"


class GateSession:
    def __init__(self, hub: "Hub", cfg: SessionConfig):
        self.hub, self.cfg = hub, cfg
        self.state = "arming"
        self.t0: float | None = None
        self.length = pattern_length(cfg.phases)
        self.target = render_target(cfg.phases, FS_TARGET)
        self.started_at = time.time()
        self.data = SensorData(breath_t=[], breath_v=[], pulse_t=[], pulse_v=[], pulse_conf=[], pressure_t=[], pressure_v=[], validation=[])
        self.hint = ""
        self.trace: list[list[float]] = []
        self._published = 0
        self._next_point = 0.0
        self._ready = asyncio.Event()
        self._lost: str | None = None
        self._capture_on = False
        self.task: asyncio.Task | None = None
        self.capture_id = str(cfg.challenge_id)
        self.warmup_s = 0.0
        self.link: BridgeHub | None = None
        self.camera: dict | None = None
        self.readout = Readout()

    # Bridge listener interface.
    def on_ready(self) -> None:
        self._ready.set()

    def on_samples(self, msg: dict, offset_s: float) -> None:
        self.readout.add(msg, offset_s)
        for ts, value in msg.get("breath", []):
            self.data.breath_t.append(ts / 1e6 + offset_s)
            self.data.breath_v.append(value)
        for ts, value, conf in msg.get("pulse", []):
            self.data.pulse_t.append(ts / 1e6 + offset_s)
            self.data.pulse_v.append(value)
            self.data.pulse_conf.append(conf)
        for ts, value in msg.get("pressure", []):
            self.data.pressure_t.append(ts / 1e6 + offset_s)
            self.data.pressure_v.append(value)

    def on_validation(self, ok: bool, hint: str, at: float) -> None:
        self.data.validation.append((at, ok))
        self.hint = hint

    def on_lost(self, reason: str) -> None:
        self._lost = reason
        self._ready.set()

    # Lifecycle.
    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    def _state_msg(self) -> dict:
        now = time.time()
        return {
            "type": "state", "state": self.state, "simulated": self.cfg.simulated,
            "camera_on": self._capture_on, "starts_in_s": (self.t0 - now) if self.t0 else None,
            "attempt_no": self.cfg.attempt_no, "warmup_s": self.warmup_s, "sensor": self.cfg.sensor,
            "camera": self.camera if self._capture_on else None,
        }

    def snapshot(self) -> dict:
        return {
            **self._state_msg(),
            "challenge_id": str(self.cfg.challenge_id),
            "phases": self.cfg.phases,
            "target": [round(float(v), 4) for v in self.target],
            "length_s": self.length,
            "trace": self.trace,
            "hint": self.hint,
            "pulse_present": self._pulse_present(),
            "readout": self.readout.view(),
        }

    def _publish(self, msg: dict) -> None:
        self.hub.publish(self.cfg.request_id, msg)

    def _set_state(self, state: str) -> None:
        self.state = state
        self._publish(self._state_msg())

    def _pulse_present(self) -> bool:
        if not self.data.pulse_t:
            return False
        now = time.time()
        minimum = self.cfg.thresholds.get("pulse_confidence_min", 45.0)
        for t, v, c in zip(reversed(self.data.pulse_t), reversed(self.data.pulse_v), reversed(self.data.pulse_conf)):
            if now - t > 3.0:
                return False
            if t <= now and c >= minimum and v > 0:
                return True
        return False

    def _check_alive(self) -> None:
        if self._lost:
            raise Aborted(self._lost)
        if self.hub.viewer_gone_for(self.cfg.request_id) > get_config().viewer_grace_s:
            raise Aborted("The gate window was closed, so the check stopped.")

    def _publish_progress(self) -> None:
        """Send new trace points on the challenge clock, plus presence and quality hints."""
        if self.t0 is None:
            return
        sign = 1 if self.cfg.polarity >= 0 else -1
        now = time.time()
        new = []
        # The SDK sends 30 samples a second. The live chart only needs about 10.
        for t, v in zip(self.data.breath_t[self._published:], self.data.breath_v[self._published:]):
            if self.t0 <= t <= now and t >= self._next_point:
                new.append([round(t - self.t0, 3), round(sign * v, 5)])
                self._next_point = t + 0.09
        self._published = len(self.data.breath_t)
        self.trace.extend(new)
        self._publish({"type": "progress", "points": new, "pulse_present": self._pulse_present(), "hint": self.hint,
                       "t": round(now - self.t0, 3), "readout": self.readout.view(now)})

    async def _arm(self) -> None:
        cfg = get_config()
        if self.cfg.simulated:
            self.warmup_s = cfg.sim_warmup_s
            self.hint = SIM_HINT
            return
        self.warmup_s = cfg.live_warmup_s
        # Picked and started with no await in between, so two checks cannot take the same slot.
        self.link = self.hub.links.take(self.cfg.sensor)
        # Marked first, so a cancel during the send still tells the bridge to stop.
        self._capture_on = True
        await self.link.start(self.capture_id, self, self.cfg.telemetry)
        self.camera = self.hub.camera_offer(self.link, self.capture_id)
        self._set_state("arming")
        deadline = time.time() + cfg.arming_timeout_s
        while not self._ready.is_set():
            self._check_alive()
            if time.time() > deadline:
                raise Aborted("The camera did not start in time.")
            await asyncio.sleep(0.1)
        if self._lost:
            raise Aborted(self._lost)

    async def _stop_capture(self) -> None:
        if self._capture_on:
            self._capture_on = False
            self.camera = None
            if self.link:
                await self.link.stop(self.capture_id)

    def _feed_simulated(self, sim: SensorData, cursors: dict, now: float) -> None:
        for name, targets in (("breath", (("breath_t", "breath_v"))), ("pulse", ("pulse_t", "pulse_v", "pulse_conf"))):
            times = getattr(sim, targets[0])
            i = cursors[name]
            while i < len(times) and times[i] <= now:
                for attr in targets:
                    getattr(self.data, attr).append(getattr(sim, attr)[i])
                if name == "pulse":
                    self.readout.pulse.append((sim.pulse_t[i], sim.pulse_v[i], sim.pulse_conf[i]))
                i += 1
            cursors[name] = i

    async def run(self) -> None:
        cfg = get_config()
        try:
            await self._arm()
            self.t0 = time.time() + self.warmup_s
            sim = None
            if self.cfg.simulated:
                sim = simulate(self.cfg.scenario or "follower", self.cfg.phases, t0=self.t0, rsa=2.0)
                self.data.validation = list(sim.validation)
            self._set_state("warmup")
            while time.time() < self.t0:
                self._check_alive()
                await asyncio.sleep(0.1)
            self._set_state("running")
            end = self.t0 + self.length + cfg.sensor_tail_s
            cursors = {"breath": 0, "pulse": 0}
            while time.time() < end:
                self._check_alive()
                if sim:
                    self._feed_simulated(sim, cursors, time.time())
                self._publish_progress()
                await asyncio.sleep(0.25)
            await self._stop_capture()
            self._set_state("verifying")
            await self._finish()
        except Aborted as exc:
            await self._abort(str(exc))
        except ApiError as exc:
            await self._abort(exc.detail)
        except asyncio.CancelledError:
            await self._stop_capture()
            await self._mark_consumed()
            raise
        except Exception:
            log.exception("gate session failed")
            await self._abort("Something went wrong during the check. Please try again.")
        finally:
            await self._stop_capture()
            if self.hub.sessions.get(self.cfg.request_id) is self:
                del self.hub.sessions[self.cfg.request_id]

    async def _mark_consumed(self) -> None:
        try:
            async with SessionLocal() as db:
                challenge = await db.get(Challenge, self.cfg.challenge_id)
                if challenge and challenge.consumed_at is None:
                    challenge.consumed_at = utcnow()
                    await db.commit()
        except Exception:
            log.exception("could not mark a challenge as used")

    async def _abort(self, reason: str) -> None:
        await self._stop_capture()
        await self._mark_consumed()
        self.state = "idle"
        self._publish({"type": "aborted", "reason": reason})

    async def _finish(self) -> None:
        cfg = get_config()
        scores = await asyncio.to_thread(
            verify, self.cfg.phases, self.cfg.decoys, self.data, self.t0, self.cfg.polarity, self.cfg.thresholds, self.cfg.gates
        )
        async with SessionLocal() as db:
            request = await db.get(GateRequest, self.cfg.request_id, with_for_update=True)
            challenge = await db.get(Challenge, self.cfg.challenge_id, with_for_update=True)
            payload = challenge_payload(challenge.id, challenge.nonce, challenge.phases, challenge.issued_at, challenge.expires_at, request.command_sha256)
            if await records.expire_if_due(db, request):
                request = await db.get(GateRequest, self.cfg.request_id, with_for_update=True, populate_existing=True)
                challenge = await db.get(Challenge, self.cfg.challenge_id, with_for_update=True, populate_existing=True)
            problem = None
            if not verify_signature(cfg.hmac_secret, payload, challenge.hmac):
                problem = "The challenge signature did not match."
            elif challenge.consumed_at is not None:
                problem = "This challenge has already been used."
            elif time.time() > challenge.expires_at:
                problem = "This challenge expired."
            elif request.status != "pending":
                problem = "This request has already been decided."
            if problem:
                challenge.consumed_at = challenge.consumed_at or utcnow()
                await db.commit()
                self.state = "idle"
                self._publish({"type": "aborted", "reason": problem})
                if request.status != "pending":
                    self._publish({"type": "closed", "status": request.status})
                return
            challenge.consumed_at = utcnow()
            attempt = Attempt(
                challenge_id=challenge.id, s_xcorr=scores.s_xcorr, s_phase=scores.s_phase, s_cycles=scores.s_cycles,
                target_cycles=scores.target_cycles, s_live=scores.s_live, s_decoy=scores.s_decoy, s_coupling=scores.s_coupling,
                s_coupling_decoy=scores.s_coupling_decoy, best_lag_s=scores.best_lag_s, passed=scores.passed,
                failure_reasons=scores.failure_reasons,
            )
            db.add(attempt)
            await db.flush()
            used = await records.attempts_used(db, request.id)
            summary = {**scores.as_dict(), "attempts": used}
            trial_id = None
            if request.purpose == "eval":
                request.status, request.decided_at = ("practice_passed" if scores.passed else "denied"), utcnow()
                trial_id = await self._store_trial(db, attempt)
            elif scores.passed:
                if request.simulated or request.purpose == "practice":
                    await records.decide(db, request, "practice_passed", "simulated" if self.cfg.simulated else "practice", summary)
                else:
                    await records.decide(db, request, "approved", "breath", summary)
                    await records.issue_token(db, request)
            elif used >= cfg.max_attempts:
                await records.decide(db, request, "denied", "simulated" if self.cfg.simulated else "breath", summary)
            await db.commit()
            status = request.status
        self.state = "done"
        readout = self.readout.summary(self.t0 - self.warmup_s, self.t0 + self.length + cfg.sensor_tail_s,
                                       self.cfg.thresholds.get("pulse_confidence_min", 45.0))
        self._publish({
            "type": "result", "scores": scores.as_dict(), "passed": scores.passed, "status": status,
            "sensor": self.cfg.sensor, "readout": readout,
            "failures": [FAILURE_TEXT.get(f, f) for f in scores.failure_reasons], "attempts_used": used,
            "attempts_left": max(0, cfg.max_attempts - used) if status == "pending" else 0,
            "thresholds": self.cfg.thresholds, "gates": self.cfg.gates, "simulated": self.cfg.simulated,
            "trial_id": str(trial_id) if trial_id else None,
        })

    async def _store_trial(self, db, attempt: Attempt):
        ctx = self.cfg.eval_ctx
        breath, pulse = None, None
        if ctx.store_series:
            b, _ = resample(self.data.breath_t, self.data.breath_v, self.t0, self.t0 + self.length + MAX_LAG_S, FS_TARGET)
            p, _ = resample(self.data.pulse_t, self.data.pulse_v, self.t0, self.t0 + self.length, 1.0)
            breath, pulse = [round(float(v), 4) for v in b], [round(float(v), 2) for v in p]
        trial = EvalTrial(session_id=ctx.session_id, condition=ctx.condition, challenge_id=self.cfg.challenge_id, attempt_id=attempt.id,
                          breath_series=breath, pulse_series=pulse, duration_s=round(time.time() - self.started_at, 2))
        db.add(trial)
        await db.flush()
        return trial.id


class CalibrationRun:
    """One slow inhale to fix the trace sign convention (spec section 6.2)."""

    def __init__(self, hub: "Hub", workspace_id: uuid.UUID, sensor: str, telemetry: bool):
        self.id = uuid.uuid4()
        self.hub, self.workspace_id, self.sensor, self.telemetry = hub, workspace_id, sensor, telemetry
        self.simulated = sensor == "sim"
        self.link: BridgeHub | None = None
        self.camera: dict | None = None
        self.state = "arming"
        self.message = ""
        self.polarity: int | None = None
        self.seconds_left = 0.0
        self.t: list[float] = []
        self.v: list[float] = []
        self.offset = 0.0
        self._ready = asyncio.Event()
        self._lost: str | None = None
        self.capture_id = str(self.id)
        self.task: asyncio.Task | None = None
        self.last_polled = time.time()

    def on_ready(self) -> None:
        self._ready.set()

    def on_samples(self, msg: dict, offset_s: float) -> None:
        for ts, value in msg.get("breath", []):
            self.t.append(ts / 1e6 + offset_s)
            self.v.append(value)

    def on_validation(self, ok: bool, hint: str, at: float) -> None:
        self.message = hint

    def on_lost(self, reason: str) -> None:
        self._lost = reason
        self._ready.set()

    def view(self) -> dict:
        return {"id": str(self.id), "state": self.state, "message": self.message, "polarity": self.polarity,
                "simulated": self.simulated, "sensor": self.sensor, "seconds_left": round(max(self.seconds_left, 0.0), 1),
                "camera": self.camera}

    async def _count(self, state: str, seconds: float) -> None:
        self.state = state
        end = time.time() + seconds
        while time.time() < end:
            self._check_alive()
            self.seconds_left = end - time.time()
            await asyncio.sleep(0.1)
        self.seconds_left = 0.0

    def _check_alive(self) -> None:
        if self._lost:
            raise Aborted(self._lost)
        # The page polls while it is open. If it stops, the person has left: stop the camera.
        if time.time() - self.last_polled > get_config().viewer_grace_s:
            raise Aborted("The page was closed, so calibration stopped.")

    async def run(self) -> None:
        cfg = get_config()
        started = False
        try:
            if self.simulated:
                await self._count("warmup", 1.0)
                await self._count("inhale", min(cfg.calibration_seconds, 3.0))
                self.polarity = 1
                self.message = "Simulated sensor: the sign is set to the default."
            else:
                self.link = self.hub.links.take(self.sensor)
                started = True
                await self.link.start(self.capture_id, self, self.telemetry)
                self.camera = self.hub.camera_offer(self.link, self.capture_id)
                deadline = time.time() + cfg.arming_timeout_s
                while not self._ready.is_set():
                    self._check_alive()
                    if time.time() > deadline:
                        raise Aborted("The camera did not start in time.")
                    await asyncio.sleep(0.1)
                if self._lost:
                    raise Aborted(self._lost)
                await self._count("warmup", cfg.calibration_warmup_s)
                begin = time.time()
                await self._count("inhale", cfg.calibration_seconds)
                await self._count("settling", 2.0)
                pairs = [(t, v) for t, v in zip(self.t, self.v) if begin <= t <= begin + cfg.calibration_seconds]
                polarity, _ = polarity_from_trace([p[0] for p in pairs], [p[1] for p in pairs])
                if polarity == 0:
                    raise Aborted("No clear breathing movement was seen. Check your framing and try again.")
                self.polarity = polarity
                self.message = "Done."
            async with SessionLocal() as db:
                settings = await db.get(AppSettings, self.workspace_id)
                if settings:
                    settings.breath_polarity = self.polarity
                    settings.polarity_live = not self.simulated
                    await db.commit()
            self.state = "done"
        except (Aborted, ApiError) as exc:
            self.state, self.message = "failed", getattr(exc, "detail", str(exc))
        except asyncio.CancelledError:
            self.state, self.message = "failed", "Calibration was cancelled."
            raise
        except Exception:
            log.exception("calibration failed")
            self.state, self.message = "failed", "Something went wrong. Please try again."
        finally:
            self.camera = None
            if started and self.link:
                await self.link.stop(self.capture_id)


class MeasureRun:
    """A free reading: the SDK's own pulse, breathing rate and breathing trace, with no gate and no decision."""

    def __init__(self, hub: "Hub", workspace_id: uuid.UUID, sensor: str, telemetry: bool, polarity: int | None):
        self.id = uuid.uuid4()
        self.hub, self.workspace_id, self.sensor, self.telemetry = hub, workspace_id, sensor, telemetry
        self.sign = -1 if (polarity or 1) < 0 else 1
        self.state = "arming"
        self.message = ""
        self.t: list[float] = []
        self.v: list[float] = []
        self.readout = Readout()
        self.ok_frames = 0
        self.checked_frames = 0
        self.started_at: float | None = None
        self.ends_at: float | None = None
        self.link: BridgeHub | None = None
        self.camera: dict | None = None
        self.capture_id = str(self.id)
        self.task: asyncio.Task | None = None
        self.last_polled = time.time()
        self._ready = asyncio.Event()
        self._lost: str | None = None
        self._stop = False

    def on_ready(self) -> None:
        self._ready.set()

    def on_samples(self, msg: dict, offset_s: float) -> None:
        self.readout.add(msg, offset_s)
        for ts, value in msg.get("breath", []):
            self.t.append(ts / 1e6 + offset_s)
            self.v.append(float(value))

    def on_validation(self, ok: bool, hint: str, at: float) -> None:
        self.message = hint
        self.checked_frames += 1
        self.ok_frames += 1 if ok else 0

    def on_lost(self, reason: str) -> None:
        self._lost = reason
        self._ready.set()

    def stop(self) -> None:
        self._stop = True

    def view(self, since: float | None = None) -> dict:
        now = time.time()
        origin = self.started_at or now
        cut = max(now - 30.0, origin) if since is None else max(origin + since, now - 30.0)
        points, last = [], -1.0
        for t, v in zip(self.t, self.v):
            if t >= cut and t - last >= 0.09:
                points.append([round(t - origin, 2), round(self.sign * v, 4)])
                last = t
        return {
            "id": str(self.id), "state": self.state, "message": self.message, "sensor": self.sensor,
            "camera": self.camera, "elapsed_s": round(now - origin, 1) if self.started_at else 0.0,
            "seconds_left": round(max(0.0, self.ends_at - now), 1) if self.ends_at else None,
            "readout": self.readout.view(now), "history": {k: [[round(p[0] - origin, 1), p[1], p[2]] for p in v]
                                                            for k, v in self.readout.history(origin).items()},
            "trace": points,
        }

    def _check_alive(self) -> None:
        if self._lost:
            raise Aborted(self._lost)
        if time.time() - self.last_polled > get_config().viewer_grace_s:
            raise Aborted("The page was closed, so the reading stopped.")

    async def run(self) -> None:
        cfg = get_config()
        started = False
        try:
            self.link = self.hub.links.take(self.sensor)
            started = True
            await self.link.start(self.capture_id, self, self.telemetry)
            self.camera = self.hub.camera_offer(self.link, self.capture_id)
            deadline = time.time() + cfg.arming_timeout_s
            while not self._ready.is_set():
                self._check_alive()
                if self._stop:
                    raise Aborted("Stopped.")
                if time.time() > deadline:
                    raise Aborted("The camera did not start in time.")
                await asyncio.sleep(0.1)
            self._check_alive()
            self.state = "running"
            self.started_at = time.time()
            self.ends_at = self.started_at + cfg.measure_seconds
            while time.time() < self.ends_at and not self._stop:
                self._check_alive()
                await asyncio.sleep(0.2)
            self.state, self.message = "done", "Finished."
        except (Aborted, ApiError) as exc:
            self.state, self.message = ("done", "Stopped.") if self._stop else ("failed", getattr(exc, "detail", str(exc)))
        except asyncio.CancelledError:
            self.state, self.message = "failed", "The reading was cancelled."
            raise
        except Exception:
            log.exception("reading failed")
            self.state, self.message = "failed", "Something went wrong. Please try again."
        finally:
            self.camera = None
            if started and self.link:
                await self.link.stop(self.capture_id)


@dataclass
class Hub:
    links: Links = field(default_factory=Links)
    sessions: dict = field(default_factory=dict)
    measures: dict = field(default_factory=dict)
    subscribers: dict = field(default_factory=dict)
    left_at: dict = field(default_factory=dict)
    commands: dict = field(default_factory=dict)
    calibrations: dict = field(default_factory=dict)
    # Requests between passing the checks and registering a session. Guards a double start.
    starting: set = field(default_factory=set)

    @property
    def bridge(self) -> BridgeHub:
        return self.links.bridge

    def camera_offer(self, link: BridgeHub, capture_id: str) -> dict | None:
        """What the browser needs to join a relay capture. None for the desktop bridge."""
        if link.kind != "relay":
            return None
        cfg = get_config()
        return {"path": f"/ws/camera/{link.slot}",
                "ticket": camera_ticket(cfg.relay_token, capture_id, link.slot, cfg.camera_ticket_ttl_s)}

    def remember_command(self, request_id: uuid.UUID, command: str) -> None:
        self.commands[request_id] = (command, time.time() + get_config().request_ttl_s + 60)

    def command(self, request_id: uuid.UUID) -> str | None:
        entry = self.commands.get(request_id)
        return entry[0] if entry else None

    def subscribe(self, request_id: uuid.UUID, ws: WebSocket) -> None:
        self.subscribers.setdefault(request_id, set()).add(ws)
        self.left_at.pop(request_id, None)

    def unsubscribe(self, request_id: uuid.UUID, ws: WebSocket) -> None:
        group = self.subscribers.get(request_id)
        if group is None:
            return
        group.discard(ws)
        if not group:
            del self.subscribers[request_id]
            self.left_at[request_id] = time.time()

    def viewer_gone_for(self, request_id: uuid.UUID) -> float:
        if self.subscribers.get(request_id):
            return 0.0
        left = self.left_at.get(request_id)
        if left is None:
            session = self.sessions.get(request_id)
            left = session.started_at if session else time.time()
        return time.time() - left

    def publish(self, request_id: uuid.UUID, msg: dict) -> None:
        for ws in list(self.subscribers.get(request_id, ())):
            asyncio.create_task(self._send(request_id, ws, msg))

    async def _send(self, request_id: uuid.UUID, ws: WebSocket, msg: dict) -> None:
        try:
            await ws.send_json(msg)
        except Exception:
            self.unsubscribe(request_id, ws)

    def start_session(self, cfg: SessionConfig) -> GateSession:
        session = GateSession(self, cfg)
        self.sessions[cfg.request_id] = session
        session.start()
        return session

    async def cancel(self, request_id: uuid.UUID, reason: str | None = None) -> None:
        session = self.sessions.get(request_id)
        if session and session.task:
            session.task.cancel()
            try:
                await session.task
            except asyncio.CancelledError:
                pass
            self.sessions.pop(request_id, None)
            if reason:
                self.publish(request_id, {"type": "aborted", "reason": reason})

    def simulated_count(self) -> int:
        return sum(1 for s in self.sessions.values() if s.cfg.simulated)

    async def cancel_workspace(self, workspace_id: uuid.UUID) -> None:
        for request_id, session in list(self.sessions.items()):
            if session.cfg.workspace_id == workspace_id:
                await self.cancel(request_id, "This check was stopped from another window.")
        for run in [*self.calibrations.values(), *self.measures.values()]:
            if run.workspace_id == workspace_id and run.task and not run.task.done():
                run.task.cancel()


hub = Hub()


async def sweep_once() -> None:
    """Expire stale requests, drop stale in-memory text, purge old jury sandboxes."""
    cfg = get_config()
    now = time.time()
    for key, (_, expires) in list(hub.commands.items()):
        if expires < now:
            del hub.commands[key]
    for key, when in list(hub.left_at.items()):
        if now - when > 3600:
            del hub.left_at[key]
    for key, run in list(hub.calibrations.items()):
        if run.task and run.task.done() and run.state in ("done", "failed") and len(hub.calibrations) > 200:
            del hub.calibrations[key]
    for key, run in list(hub.measures.items()):
        if run.task and run.task.done() and now - run.last_polled > 600:
            del hub.measures[key]
    cutoff = utcnow() - timedelta(seconds=min(cfg.request_ttl_s, cfg.real_request_ttl_s))
    async with SessionLocal() as db:
        due = (await db.execute(select(GateRequest).where(GateRequest.status == "pending", GateRequest.created_at < cutoff))).scalars().all()
        for request in due:
            if await records.expire_if_due(db, request):
                await hub.cancel(request.id, "This request timed out.")
                hub.publish(request.id, {"type": "closed", "status": request.status})
        retention = utcnow() - timedelta(days=cfg.sandbox_retention_days)
        await db.execute(delete(Workspace).where(Workspace.kind == "jury", Workspace.last_seen_at < retention))
        await db.commit()


async def sweeper() -> None:
    while True:
        try:
            await sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("sweep failed")
        await asyncio.sleep(30)


async def active_consent(db, workspace_id: uuid.UUID, scope: str) -> ConsentRecord | None:
    # Only the current notice counts: the browser camera changed what happens to video, so older consent is not enough.
    return (await db.execute(
        select(ConsentRecord).where(ConsentRecord.workspace_id == workspace_id, ConsentRecord.scope == scope, ConsentRecord.revoked_at.is_(None),
                                    ConsentRecord.consent_version == CONSENT_VERSION)
        .order_by(ConsentRecord.granted_at.desc()).limit(1)
    )).scalar_one_or_none()
