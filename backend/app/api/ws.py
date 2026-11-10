from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..api.gate import request_view
from ..config import get_config
from ..db.models import GateRequest
from ..db.session import SessionLocal
from ..services.auth import COOKIE, constant_eq, parse_cookie
from ..services.runtime import hub

router = APIRouter()
log = logging.getLogger("pob.ws")
MAX_BRIDGE_MESSAGE = 2_000_000


@router.websocket("/ws/bridge")
async def bridge_socket(ws: WebSocket):
    header = ws.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    await ws.accept()
    cfg = get_config()
    # The relay token only reaches relay slots, and the desktop bridge token only reaches the bridge.
    is_relay = bool(cfg.relay_token) and bool(token) and constant_eq(token, cfg.relay_token)
    if not token or not (is_relay or constant_eq(token, cfg.bridge_token)):
        await ws.close(code=4401)
        return
    link = None if is_relay else hub.bridge
    registered = False
    try:
        while True:
            text = await ws.receive_text()
            if len(text) > MAX_BRIDGE_MESSAGE:
                continue
            msg = json.loads(text)
            if msg.get("type") == "hello":
                if is_relay:
                    link = hub.links.relay(msg.get("slot"))
                    if link is None or msg.get("kind") != "relay":
                        await ws.close(code=4400)
                        return
                await link.attach(ws, {"sdk_version": str(msg.get("sdk_version", ""))[:32]})
                registered = True
                await ws.send_json({"type": "welcome"})
            elif msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})
            elif registered:
                try:
                    link.handle(msg)
                except (KeyError, TypeError, ValueError):
                    log.warning("ignored a malformed bridge message")
    except WebSocketDisconnect:
        pass
    except (json.JSONDecodeError, RuntimeError):
        log.warning("bridge socket closed after a bad message")
    finally:
        if link is not None:
            link.detach(ws)


@router.websocket("/ws/gate/{request_id}")
async def gate_socket(ws: WebSocket, request_id: uuid.UUID):
    origin = ws.headers.get("origin")
    # Accept first: a close before accepting reaches a browser as code 1006, with no reason.
    await ws.accept()
    if origin and origin.rstrip("/") != get_config().public_url.rstrip("/"):
        await ws.close(code=4403)
        return
    actor = parse_cookie(ws.cookies.get(COOKIE))
    if not actor:
        await ws.close(code=4401)
        return
    async with SessionLocal() as db:
        request = await db.get(GateRequest, request_id)
        if not request or request.workspace_id != actor.workspace_id:
            await ws.close(code=4404)
            return
        view = await request_view(db, request)
    hub.subscribe(request_id, ws)
    try:
        session = hub.sessions.get(request_id)
        await ws.send_json({"type": "snapshot", "request": view, "session": session.snapshot() if session else None,
                            "bridge_connected": hub.bridge.connected if actor.role == "owner" else False,
                            "camera_available": bool(get_config().relay_token) and hub.links.camera_online})
        while True:
            if await ws.receive_text() == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(request_id, ws)
