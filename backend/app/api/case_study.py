"""Case study: a real SDK capture of a recorded person, challenged with fresh patterns. Stores nothing."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from ..errors import ApiError
from ..services import case_study
from ..services.auth import Actor, get_actor, limiter

router = APIRouter(prefix="/api/case-study", tags=["case-study"])


def _need_data() -> None:
    if not case_study.available():
        raise ApiError(404, "not_found", "The case study data is not installed on this server.")


@router.get("")
async def view(actor: Actor = Depends(get_actor)):
    _need_data()
    return await asyncio.to_thread(case_study.view)


@router.post("/challenge")
async def challenge(actor: Actor = Depends(get_actor)):
    _need_data()
    limiter.check(f"case:{actor.workspace_id}", 30, 60)
    return await asyncio.to_thread(case_study.challenge)
