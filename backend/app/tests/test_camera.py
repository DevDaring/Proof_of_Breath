"""Browser camera path: relay slots on the server, signed tickets, who may use which sensor, and the free reading.

The relay here is a test double that speaks the bridge protocol. The real relay is bridge/src/relay.mjs."""
import asyncio
import hashlib
import hmac
import time

import pytest
import websockets

from .conftest import Api, FakeBridge, wait_for

DANGEROUS = "terraform destroy -auto-approve"


def relay(server, env, slot=0):
    return FakeBridge(server, env["POB_RELAY_TOKEN"], hello={"kind": "relay", "slot": slot})


def check_ticket(env, offer, capture_id, slot=0):
    assert offer["path"] == f"/ws/camera/{slot}"
    cid, s, exp, mac = offer["ticket"].split(".")
    assert cid == capture_id and int(s) == slot and int(exp) > time.time()
    expected = hmac.new(env["POB_RELAY_TOKEN"].encode(), f"{cid}.{s}.{exp}".encode(), hashlib.sha256).hexdigest()
    assert hmac.compare_digest(mac, expected)


async def test_relay_token_only_registers_relay_slots(server, env):
    url = server.replace("http://", "ws://") + "/ws/bridge"
    headers = {"Authorization": f"Bearer {env['POB_RELAY_TOKEN']}"}
    for hello in ({"type": "hello"}, {"type": "hello", "kind": "relay", "slot": 99}, {"type": "hello", "kind": "relay", "slot": True}):
        async with websockets.connect(url, additional_headers=headers) as ws:
            await ws.send(__import__("json").dumps(hello))
            with pytest.raises(websockets.ConnectionClosed) as closed:
                await ws.recv()
            assert closed.value.rcvd.code == 4400
    # The relay token never stands in for the desktop bridge.
    async with relay(server, env):
        owner = Api(server)
        await owner.post("/api/session/login", json={"username": "owner", "password": env["POB_OWNER_PASSWORD"]})
        status = await owner.get("/api/bridge/status")
        assert status["connected"] is False and status["camera"]["available"] is True and status["camera"]["slots"] == 1
        await owner.client.aclose()


async def test_jury_uses_the_browser_camera_but_never_the_desktop_bridge(server, env, jury):
    status = await jury.get("/api/bridge/status")
    assert status["camera"] == {"available": False, "free": False, "slots": 0, "sdk_version": None}
    practice = (await jury.post("/api/gate/requests", json={"practice": True}))["request_id"]
    out = await jury.post(f"/api/gate/requests/{practice}/attempts", json={"sensor": "camera"}, expect=409)
    assert out["code"] == "camera_offline"
    out = await jury.post(f"/api/gate/requests/{practice}/attempts", json={"sensor": "bridge"}, expect=403)
    assert out["code"] == "owner_only"
    async with FakeBridge(server, env["POB_BRIDGE_TOKEN"]) as desk, relay(server, env) as cam:
        status = await jury.get("/api/bridge/status")
        assert status["connected"] is False, "the jury never learns about the owner's desktop bridge"
        await jury.post(f"/api/gate/requests/{practice}/attempts", json={"sensor": "bridge"}, expect=403)
        # A simulated calibration sign is not enough for a camera check.
        run = await jury.post("/api/calibration/polarity")
        while run["state"] not in ("done", "failed"):
            await asyncio.sleep(0.3)
            run = await jury.get(f"/api/calibration/polarity/{run['id']}")
        assert run["state"] == "done" and run["sensor"] == "sim"
        out = await jury.post(f"/api/gate/requests/{practice}/attempts", json={"sensor": "camera"}, expect=409)
        assert out["code"] == "calibration_required"
        assert not desk.events and not cam.events


async def test_camera_check_on_a_sandbox_request(server, env, jury):
    await jury.put("/api/settings", json={"breath_polarity": 1})
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    async with relay(server, env) as cam:
        async with jury.gate_socket(rid) as ws:
            snap = await wait_for(ws, {"snapshot"})
            assert snap["camera_available"] is True
            started = await jury.post(f"/api/gate/requests/{rid}/attempts", json={"sensor": "camera"})
            assert started["sensor"] == "camera" and started["simulated"] is False
            state = await wait_for(ws, {"state"})
            while state["state"] != "warmup":
                state = await wait_for(ws, {"state"})
            assert state["sensor"] == "camera" and state["camera_on"] is True
            check_ticket(env, state["camera"], started["challenge_id"])
            await cam.feed(started["challenge_id"], time.time() + state["starts_in_s"], started["phases"])
            progress = await wait_for(ws, {"progress"})
            assert set(progress["readout"]) == {"pulse_bpm", "pulse_conf", "breath_rpm", "breath_conf"}
            result = await wait_for(ws, {"result", "aborted"})
        assert result["type"] == "result" and result["sensor"] == "camera", result
        assert result["readout"]["breath_rpm"] == 14.0 and result["readout"]["pulse_bpm"] is not None
        if result["passed"]:
            assert result["status"] == "practice_passed", "a sandbox request never approves, even with a real sensor"
        await asyncio.sleep(0.2)
        assert [e["type"] for e in cam.events] == ["start_capture", "stop_capture"]
    receipts = await jury.get("/api/receipts")
    if receipts["total"]:
        assert receipts["items"][0]["method"] == "practice"


async def test_two_checks_take_two_slots_and_a_third_waits(server, env, jury):
    await jury.put("/api/settings", json={"breath_polarity": 1})
    async with relay(server, env, 0) as a, relay(server, env, 1) as b:
        a.ready = b.ready = False
        rids = [(await jury.post("/api/gate/requests", json={"practice": True}))["request_id"] for _ in range(3)]
        sockets = [jury.gate_socket(r) for r in rids]
        opened = [await s.__aenter__() for s in sockets]
        try:
            for ws in opened:
                await wait_for(ws, {"snapshot"})
            await jury.post(f"/api/gate/requests/{rids[0]}/attempts", json={"sensor": "camera"})
            await jury.post(f"/api/gate/requests/{rids[1]}/attempts", json={"sensor": "camera"})
            await asyncio.sleep(0.3)
            assert len(a.events) == 1 and len(b.events) == 1, "each check got its own slot"
            out = await jury.post(f"/api/gate/requests/{rids[2]}/attempts", json={"sensor": "camera"}, expect=409)
            assert out["code"] == "camera_busy"
            assert (await jury.get("/api/bridge/status"))["camera"]["free"] is False
        finally:
            for s in sockets:
                await s.__aexit__(None, None, None)


async def test_free_reading_shows_sdk_values_and_stops_the_camera(server, env, jury):
    out = await jury.post("/api/measure", json={"sensor": "bridge"}, expect=403)
    assert out["code"] == "owner_only"
    await jury.post("/api/measure", expect=409)
    async with relay(server, env) as cam:
        run = await jury.post("/api/measure")
        assert run["sensor"] == "camera"
        assert (await jury.post("/api/measure"))["id"] == run["id"], "one reading per sign-in"
        await asyncio.sleep(0.3)
        cid = cam.events[0]["capture_id"]
        check_ticket(env, (await jury.get(f"/api/measure/{run['id']}"))["camera"], cid)
        now = time.time()
        await cam.ws.send(__import__("json").dumps({
            "type": "metrics", "capture_id": cid,
            "breath": [[(now + i / 30) * 1e6, i / 30] for i in range(30)],
            "pulse": [[now * 1e6, 71.5, 92.0]], "pressure": [], "rate": [[now * 1e6, 13.2, 55.0]],
        }))
        await asyncio.sleep(0.3)
        view = await jury.get(f"/api/measure/{run['id']}")
        assert view["state"] == "running"
        assert view["readout"] == {"pulse_bpm": 71.5, "pulse_conf": 92.0, "breath_rpm": 13.2, "breath_conf": 55.0}
        assert view["history"]["pulse"][0][1:] == [71.5, 92.0] and len(view["trace"]) >= 5
        other = Api(server)
        await other.post("/api/session/login", json={"username": "DevTest", "password": env["POB_JURY_PASSWORD"]})
        await other.get(f"/api/measure/{run['id']}", expect=404)
        await other.post(f"/api/measure/{run['id']}/stop", expect=404)
        await other.client.aclose()
        done = await jury.post(f"/api/measure/{run['id']}/stop")
        assert done["state"] == "done" and done["camera"] is None
        for _ in range(100):  # up to 10 s; under a loaded full run the stop can lag
            if len(cam.events) >= 2:
                break
            await asyncio.sleep(0.1)
        assert [e["type"] for e in cam.events] == ["start_capture", "stop_capture"]


async def test_free_reading_stops_when_the_page_goes_away(server, env, jury):
    async with relay(server, env) as cam:
        run = await jury.post("/api/measure")
        await asyncio.sleep(3.2)
        assert [e["type"] for e in cam.events] == ["start_capture", "stop_capture"]
        assert (await jury.get(f"/api/measure/{run['id']}"))["state"] == "failed"


async def test_old_consent_does_not_cover_the_browser_camera(server, env, jury):
    import asyncpg
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    await conn.execute("UPDATE consent_records SET consent_version = '2026-11-07'")
    await conn.close()
    assert "gate" not in (await jury.get("/api/session"))["consents"]
    await jury.post("/api/measure", expect=409)
