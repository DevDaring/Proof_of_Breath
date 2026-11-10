"""Sensor links. The desktop bridge lives on the owner's machine with the webcam. Relay slots run on this
server and take frames from a person's browser camera, one capture per slot."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
from typing import Protocol

from fastapi import WebSocket

from ..errors import ApiError


class CaptureListener(Protocol):
    def on_ready(self) -> None: ...
    def on_samples(self, msg: dict, offset_s: float) -> None: ...
    def on_validation(self, ok: bool, hint: str, at: float) -> None: ...
    def on_lost(self, reason: str) -> None: ...


def camera_ticket(secret: str, capture_id: str, slot: int, ttl_s: float) -> str:
    """Matches bridge/src/relay-core.mjs. Lets one browser socket join one capture on one slot."""
    payload = f"{capture_id}.{slot}.{int(time.time() + ttl_s)}"
    return f"{payload}.{hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()}"


class BridgeHub:
    def __init__(self, kind: str = "bridge", slot: int | None = None):
        self.kind, self.slot = kind, slot
        self.ws: WebSocket | None = None
        self.info: dict = {}
        self.listener: CaptureListener | None = None
        self.capture_id: str | None = None
        self.offset_s = 0.0
        self._sent_at = 0.0
        self._send_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self.ws is not None

    @property
    def busy(self) -> bool:
        return self.listener is not None

    async def attach(self, ws: WebSocket, info: dict) -> None:
        if self.ws is not None:
            try:
                await self.ws.close(code=4001, reason="replaced")
            except Exception:
                pass
            self.detach(self.ws)
        self.ws, self.info = ws, info

    def detach(self, ws: WebSocket) -> None:
        if self.ws is ws:
            self.ws, self.info = None, {}
            listener, self.listener, self.capture_id = self.listener, None, None
            if listener:
                listener.on_lost("The sensor bridge disconnected.")

    async def _send(self, payload: dict) -> None:
        if self.ws:
            async with self._send_lock:
                await self.ws.send_json(payload)

    async def start(self, capture_id: str, listener: CaptureListener, telemetry: bool) -> None:
        if not self.ws:
            if self.kind == "relay":
                raise ApiError(409, "camera_offline", "The browser camera service is not running. Please try again shortly.")
            raise ApiError(409, "bridge_offline", "The sensor bridge is not connected. Start it on the machine with the webcam.")
        if self.listener:
            raise ApiError(409, "camera_busy", "The camera is already in use for another check.")
        self.listener, self.capture_id = listener, capture_id
        self._sent_at = time.time()
        try:
            await self._send({"type": "start_capture", "capture_id": capture_id, "enable_telemetry": telemetry})
        except Exception as exc:
            self.listener, self.capture_id = None, None
            raise ApiError(409, "bridge_offline", "The sensor bridge did not accept the request.") from exc

    async def stop(self, capture_id: str) -> None:
        if self.capture_id == capture_id:
            self.listener, self.capture_id = None, None
        try:
            await self._send({"type": "stop_capture", "capture_id": capture_id})
        except Exception:
            pass

    def handle(self, msg: dict) -> None:
        """Route a bridge message. Messages for a capture that already ended are dropped."""
        kind = msg.get("type")
        if msg.get("capture_id") != self.capture_id or not self.listener:
            return
        if kind == "clock_ack":
            now = time.time()
            self.offset_s = (self._sent_at + now) / 2.0 - float(msg["bridge_now_us"]) / 1e6
        elif kind == "capture_ready":
            self.listener.on_ready()
        elif kind == "metrics":
            self.listener.on_samples(msg, self.offset_s)
        elif kind == "validation":
            at = float(msg.get("bridge_ts_us", 0)) / 1e6 + self.offset_s
            self.listener.on_validation(int(msg.get("code", 1)) == 0, str(msg.get("hint", ""))[:200], at)
        elif kind == "capture_error":
            listener, self.listener, self.capture_id = self.listener, None, None
            listener.on_lost(str(msg.get("message", "The sensor reported an error."))[:300])


SENSORS = ("sim", "camera", "bridge")


class Links:
    """The desktop bridge plus the relay slots for browser cameras."""

    MAX_SLOTS = 8

    def __init__(self):
        self.bridge = BridgeHub("bridge")
        self.relays: dict[int, BridgeHub] = {}

    def relay(self, slot: int) -> BridgeHub | None:
        """Slots appear when a relay process says hello."""
        if not isinstance(slot, int) or isinstance(slot, bool) or not 0 <= slot < self.MAX_SLOTS:
            return None
        return self.relays.setdefault(slot, BridgeHub("relay", slot))

    @property
    def camera_online(self) -> bool:
        return any(r.connected for r in self.relays.values())

    @property
    def camera_free(self) -> bool:
        return any(r.connected and not r.busy for r in self.relays.values())

    def check(self, sensor: str) -> None:
        """Friendly errors before a check is created. The slot itself is taken in `take`."""
        if sensor == "camera":
            if not self.camera_online:
                raise ApiError(409, "camera_offline", "The browser camera service is not running. Please try again shortly.")
            if not self.camera_free:
                raise ApiError(409, "camera_busy", "Every camera slot is in use right now. Please try again in a minute.")
        elif sensor == "bridge":
            if not self.bridge.connected:
                raise ApiError(409, "bridge_offline", "The sensor bridge is not connected. Start it on the machine with the webcam, or use the fallback.")
            if self.bridge.busy:
                raise ApiError(409, "camera_busy", "The camera is already in use for another check.")

    def take(self, sensor: str) -> BridgeHub:
        """Picks the link for a capture. Synchronous, so the caller can start it before anyone else picks."""
        self.check(sensor)
        if sensor == "bridge":
            return self.bridge
        return next(r for r in self.relays.values() if r.connected and not r.busy)
