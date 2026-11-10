from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import case_study, consent, eval as eval_api, gate, measure, receipts, rules, session, settings, ws
from .config import get_config
from .db.session import SessionLocal
from .errors import ApiError
from .services.auth import owner_workspace_id
from .services.runtime import hub, sweeper

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with SessionLocal() as db:
        await owner_workspace_id(db)
    task = asyncio.create_task(sweeper())
    yield
    task.cancel()
    for request_id in list(hub.sessions):
        await hub.cancel(request_id)


app = FastAPI(title="Proof of Breath", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[get_config().public_url.rstrip("/")], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def reject_foreign_origins(request: Request, call_next):
    """Cookie sessions must not be usable by another site, even if SameSite is bypassed."""
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin.rstrip("/") != get_config().public_url.rstrip("/"):
        return JSONResponse({"code": "bad_origin", "detail": "This request came from another site."}, status_code=403)
    return await call_next(request)


@app.exception_handler(ApiError)
async def on_api_error(_: Request, exc: ApiError):
    return JSONResponse({"code": exc.code, "detail": exc.detail}, status_code=exc.status)


@app.exception_handler(RequestValidationError)
async def on_validation_error(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    return JSONResponse({"code": "invalid_input", "detail": f"Please check {field or 'your input'}: {first.get('msg', 'invalid value')}."}, status_code=422)


@app.get("/api/ping")
async def ping():
    return {"ok": True, "service": "proof-of-breath"}


for module in (session, gate, receipts, rules, consent, settings, eval_api, measure, case_study):
    app.include_router(module.router)
app.include_router(ws.router)
