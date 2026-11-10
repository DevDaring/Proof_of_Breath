"""API tests run against a real uvicorn process and PostgreSQL. Set POB_TEST_ENV_FILE to use them."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import websockets

ENV_FILE = os.environ.get("POB_TEST_ENV_FILE")
BACKEND = Path(__file__).parents[2]


def env_values() -> dict:
    out = {}
    for line in Path(ENV_FILE).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


@pytest.fixture(scope="session")
def env():
    if not ENV_FILE:
        pytest.skip("POB_TEST_ENV_FILE is not set")
    return env_values()


@pytest.fixture(scope="session")
def server(env):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    child_env = {**os.environ, "POB_ENV_FILE": ENV_FILE}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=child_env, check=True, capture_output=True)
    code = ("import asyncio,asyncpg,os\n"
            "async def m():\n"
            " c=await asyncpg.connect(os.environ['U']);await c.execute('TRUNCATE workspaces CASCADE');await c.close()\n"
            "asyncio.run(m())")
    subprocess.run([sys.executable, "-c", code], check=True, env={**os.environ, "U": env["DATABASE_URL"].replace("+asyncpg", "")})
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"], cwd=BACKEND, env=child_env)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{base}/api/ping", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield base
    proc.terminate()
    proc.wait(10)


class Api:
    def __init__(self, base, headers=None):
        self.base = base
        self.client = httpx.AsyncClient(base_url=base, headers=headers or {}, timeout=60)

    async def req(self, method, path, expect=200, **kw):
        r = await self.client.request(method, path, **kw)
        assert r.status_code == expect, f"{method} {path}: {r.status_code} {r.text}"
        return r.json()

    get = lambda self, p, expect=200, **k: self.req("GET", p, expect, **k)
    post = lambda self, p, expect=200, **k: self.req("POST", p, expect, **k)
    put = lambda self, p, expect=200, **k: self.req("PUT", p, expect, **k)
    delete = lambda self, p, expect=200, **k: self.req("DELETE", p, expect, **k)

    @property
    def ws_base(self):
        return self.base.replace("http://", "ws://")

    def cookie_header(self):
        return "; ".join(f"{k}={v}" for k, v in self.client.cookies.items())

    def gate_socket(self, request_id):
        return websockets.connect(f"{self.ws_base}/ws/gate/{request_id}", additional_headers={"Cookie": self.cookie_header()})


@pytest_asyncio.fixture
async def jury(server, env):
    api = Api(server)
    await api.post("/api/session/login", json={"username": "DevTest", "password": env["POB_JURY_PASSWORD"]})
    await api.post("/api/consent", json={"scope": "gate"})
    yield api
    await api.client.aclose()


@pytest_asyncio.fixture
async def owner(server, env):
    api = Api(server)
    await api.post("/api/session/login", json={"username": "owner", "password": env["POB_OWNER_PASSWORD"]})
    await api.delete("/api/data")
    await api.post("/api/consent", json={"scope": "gate"})
    await api.put("/api/settings", json={"breath_polarity": 1})
    yield api
    await api.client.aclose()


@pytest_asyncio.fixture
async def hook(server, env):
    api = Api(server, {"Authorization": f"Bearer {env['POB_INTERCEPTOR_TOKEN']}"})
    yield api
    await api.client.aclose()


async def wait_for(ws, kinds, timeout=70):
    deadline = time.time() + timeout
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), max(0.1, deadline - time.time())))
        if msg["type"] in kinds:
            return msg


class FakeBridge:
    """Test double for the sensor bridge. Never shipped: real use requires the live SDK."""

    def __init__(self, base, token, hello=None):
        self.url = base.replace("http://", "ws://") + "/ws/bridge"
        self.token = token
        self.hello = hello or {}
        self.scenario = "follower"
        self.phases = None
        self.events = []
        self.task = None
        self.ws = None
        self.ready = True
        self.t0_getter = None

    async def __aenter__(self):
        self.ws = await websockets.connect(self.url, additional_headers={"Authorization": f"Bearer {self.token}"})
        await self.ws.send(json.dumps({"type": "hello", "sdk_version": "test-double", **self.hello}))
        assert json.loads(await self.ws.recv())["type"] == "welcome"
        self.task = asyncio.create_task(self._loop())
        return self

    async def __aexit__(self, *exc):
        self.task.cancel()
        await self.ws.close()

    async def _loop(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            self.events.append(msg)
            if msg["type"] == "start_capture":
                cid = msg["capture_id"]
                await self.ws.send(json.dumps({"type": "clock_ack", "capture_id": cid, "bridge_now_us": time.time() * 1e6}))
                if self.ready:
                    await self.ws.send(json.dumps({"type": "capture_ready", "capture_id": cid}))
                    await self.ws.send(json.dumps({"type": "validation", "capture_id": cid, "code": 0, "hint": "ok", "bridge_ts_us": time.time() * 1e6}))

    async def feed(self, capture_id, t0, phases, scenario="follower", seed=1):
        from app.core.simulate import simulate
        data = simulate(scenario, phases, t0=t0, seed=seed)
        await self.ws.send(json.dumps({
            "type": "metrics", "capture_id": capture_id,
            "breath": [[t * 1e6, v] for t, v in zip(data.breath_t, data.breath_v)],
            "pulse": [[t * 1e6, v, c] for t, v, c in zip(data.pulse_t, data.pulse_v, data.pulse_conf)],
            "pressure": [],
            "rate": [[t * 1e6, 14.0, 60.0] for t in data.pulse_t],
        }))
