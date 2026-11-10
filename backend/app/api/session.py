from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import CONSENT_VERSION, get_config
from ..db.models import AppSettings, ConsentRecord
from ..db.session import get_db
from ..errors import ApiError
from ..services.auth import COOKIE, Actor, client_ip, constant_eq, create_jury_workspace, get_actor, limiter, make_cookie, owner_workspace_id
from ..services.runtime import hub

router = APIRouter(prefix="/api", tags=["session"])


class Login(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


@router.post("/session/login")
async def login(body: Login, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    cfg = get_config()
    limiter.check(f"login:{client_ip(request)}", cfg.login_rate_per_min, 60)
    if constant_eq(body.username, cfg.owner_user) and constant_eq(body.password, cfg.owner_password):
        role, workspace_id = "owner", await owner_workspace_id(db)
    elif cfg.jury_password and constant_eq(body.username, cfg.jury_user) and constant_eq(body.password, cfg.jury_password):
        role, workspace_id = "jury", await create_jury_workspace(db)
    else:
        raise ApiError(401, "bad_credentials", "That username or password is not right.")
    response.set_cookie(COOKIE, make_cookie(role, workspace_id, body.username), httponly=True, secure=cfg.secure_cookies,
                        samesite="lax", max_age=cfg.session_days * 86400, path="/")
    return {"role": role, "username": body.username}


@router.post("/session/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/session")
async def session(actor: Actor = Depends(get_actor), db: AsyncSession = Depends(get_db)):
    settings = await db.get(AppSettings, actor.workspace_id)
    consents = (await db.execute(
        select(ConsentRecord.scope).where(ConsentRecord.workspace_id == actor.workspace_id, ConsentRecord.revoked_at.is_(None),
                                          ConsentRecord.consent_version == CONSENT_VERSION)
    )).scalars().all()
    return {
        "role": actor.role, "username": actor.username, "consents": sorted(set(consents)), "consent_version": CONSENT_VERSION,
        "polarity": settings.breath_polarity if settings else None,
        "runtime_llm_enabled": bool(settings and settings.runtime_llm_enabled),
        "live_available": actor.role == "owner",
        "polarity_live": bool(settings and settings.polarity_live),
    }


@router.get("/bridge/status")
async def bridge_status(actor: Actor = Depends(get_actor)):
    cfg = get_config()
    relays = [r for r in hub.links.relays.values() if r.connected]
    camera = {"available": bool(cfg.relay_token) and bool(relays), "free": bool(cfg.relay_token) and hub.links.camera_free,
              "slots": len(relays), "sdk_version": relays[0].info.get("sdk_version") if relays else None}
    if actor.role != "owner":
        # The desktop bridge belongs to the owner. Other sign-ins only learn about the browser camera.
        return {"connected": False, "busy": False, "mode": "simulated", "sdk_version": None, "camera": camera}
    return {"connected": hub.bridge.connected, "busy": hub.bridge.busy, "mode": "live" if hub.bridge.connected else "offline",
            "sdk_version": hub.bridge.info.get("sdk_version"), "camera": camera}
