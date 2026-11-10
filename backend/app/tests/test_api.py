import asyncio
import hashlib
import json
import time
import uuid

import asyncpg
import httpx
import pytest
import websockets

from .conftest import Api, FakeBridge, wait_for

DANGEROUS = "terraform destroy -auto-approve"


async def run_simulated(api, scenario="follower", command=DANGEROUS):
    created = await api.post("/api/gate/requests", json={"command": command})
    return await run_attempt(api, created["request_id"], scenario)


async def run_attempt(api, request_id, scenario="follower"):
    async with api.gate_socket(request_id) as ws:
        await wait_for(ws, {"snapshot"})
        started = await api.post(f"/api/gate/requests/{request_id}/attempts", json={"scenario": scenario})
        result = await wait_for(ws, {"result", "aborted"})
    assert "decoys" not in started
    return started, result


async def test_ping_and_auth_required(server):
    api = Api(server)
    assert (await api.get("/api/ping"))["ok"]
    for path in ("/api/session", "/api/receipts", "/api/rules", "/api/settings", "/api/eval/sessions"):
        await api.get(path, expect=401)
    await api.post("/api/session/login", json={"username": "DevTest", "password": "wrong"}, expect=401)
    await api.post("/api/session/login", json={"username": "owner", "password": "wrong"}, expect=401)
    await api.post("/api/session/login", json={"username": "x", "password": ""}, expect=401)
    await api.client.aclose()


async def test_forged_cookie_and_bad_token_rejected(server):
    api = Api(server, {"Cookie": "pob_session=abc.def"})
    await api.get("/api/session", expect=401)
    non_ascii = httpx.Headers({"Cookie": "pob_session=abc.d\xe9f".encode("latin-1")})
    assert (await api.client.get("/api/session", headers=non_ascii)).status_code == 401
    bad = Api(server, {"Authorization": "Bearer nope"})
    await bad.get("/api/session", expect=401)


async def test_foreign_origin_rejected(jury):
    await jury.post("/api/gate/requests", json={"command": DANGEROUS}, headers={"Origin": "https://evil.example"}, expect=403)


async def test_session_view(jury, owner):
    assert (await jury.get("/api/session"))["role"] == "jury"
    assert (await owner.get("/api/session"))["role"] == "owner"


async def test_routine_command_is_not_gated(jury):
    out = await jury.post("/api/gate/requests", json={"command": "ls -la"})
    assert out == {"request_id": None, "gated": False, "gate_url": None, "reason": None, "severity": None}
    await jury.post("/api/gate/requests", json={"command": "   "}, expect=422)


async def test_consent_required_before_any_check(server, env):
    api = Api(server)
    await api.post("/api/session/login", json={"username": "DevTest", "password": env["POB_JURY_PASSWORD"]})
    created = await api.post("/api/gate/requests", json={"command": DANGEROUS})
    out = await api.post(f"/api/gate/requests/{created['request_id']}/attempts", json={}, expect=409)
    assert out["code"] == "consent_required"
    await api.post("/api/consent", json={"scope": "gate"})
    assert (await api.get("/api/consent"))["active"] == ["gate"]
    await api.delete("/api/consent", params={"scope": "gate"})
    assert (await api.get("/api/consent"))["active"] == []
    await api.post(f"/api/gate/requests/{created['request_id']}/attempts", json={}, expect=409)


async def test_jury_sandboxes_are_isolated(server, env, jury):
    other = Api(server)
    await other.post("/api/session/login", json={"username": "DevTest", "password": env["POB_JURY_PASSWORD"]})
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    await other.get(f"/api/gate/requests/{rid}", expect=404)
    await other.post(f"/api/gate/requests/{rid}/deny", expect=404)
    await other.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=404)
    await other.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"}, expect=404)
    await other.delete("/api/data")
    assert (await jury.get(f"/api/gate/requests/{rid}"))["status"] == "pending"
    with pytest.raises(Exception):
        async with other.gate_socket(rid) as ws:
            await ws.recv()


async def test_jury_and_browser_can_never_get_a_real_request_or_token(jury, hook):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS, "source": "claude-code"})
    view = await jury.get(f"/api/gate/requests/{created['request_id']}")
    assert view["simulated"] is True and view["source"] == "demo"
    await hook.get(f"/api/gate/requests/{created['request_id']}", expect=404)
    await jury.post("/api/gate/tokens/verify", json={"token": "x", "command_sha256": "0" * 64}, expect=403)


async def test_simulated_scenarios_end_to_end(jury):
    """A simulated pass is recorded as simulated and never produces a token. Attacks fail."""
    follow, photo, replay, replay2 = await asyncio.gather(
        run_simulated(jury, "follower"), run_simulated(jury, "photo"), run_simulated(jury, "replay"), run_simulated(jury, "replay"))
    assert follow[1]["type"] == "result" and follow[1]["simulated"] is True and follow[1]["sensor"] == "sim"
    assert follow[1]["status"] == "practice_passed"
    assert photo[1]["passed"] is False and "live" in photo[1]["scores"]["failure_reasons"]
    assert photo[1]["attempts_left"] == 2 and photo[1]["status"] == "pending"
    # A synthetic replay gets through about 5% of the time (docs/evaluation-results.md), so one of two must fail.
    assert not (replay[1]["passed"] and replay2[1]["passed"])
    receipts = await jury.get("/api/receipts")
    passes = 1 + replay[1]["passed"] + replay2[1]["passed"]
    assert receipts["total"] == passes and all(i["method"] == "simulated" for i in receipts["items"])
    assert all(i["decision"] == "practice_passed" for i in receipts["items"])
    assert (await jury.get("/api/receipts/verify-chain"))["valid"] is True


async def test_three_failures_deny_with_fresh_patterns_and_no_replay(jury):
    created = await jury.post("/api/gate/requests", json={"command": "DROP TABLE users"})
    rid = created["request_id"]
    seen = []
    for attempt in (1, 2, 3):
        started, result = await run_attempt(jury, rid, "empty")
        seen.append(str(started["phases"]))
        assert started["attempt_no"] == attempt and result["passed"] is False
    assert result["status"] == "denied" and result["attempts_left"] == 0
    assert len(set(seen)) == 3
    await jury.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409)
    assert (await jury.get("/api/receipts"))["items"][0]["decision"] == "denied"


async def test_second_concurrent_attempt_is_refused_and_deny_cancels(jury):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    async with jury.gate_socket(rid) as ws:
        await jury.post(f"/api/gate/requests/{rid}/attempts", json={})
        out = await jury.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409)
        assert out["code"] == "check_running"
        out = await jury.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"}, expect=409)
        assert out["code"] == "check_running"
        assert (await jury.post(f"/api/gate/requests/{rid}/deny"))["status"] == "denied"
        assert (await wait_for(ws, {"closed"}))["status"] == "denied"
    await jury.post(f"/api/gate/requests/{rid}/deny", expect=409)


async def test_bad_scenario(jury):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    await jury.post(f"/api/gate/requests/{created['request_id']}/attempts", json={"scenario": "nope"}, expect=422)


async def test_closing_the_window_stops_the_check(jury, server):
    """With POB_VIEWER_GRACE_S small this is quick. It must not run on with no viewer."""
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    async with jury.gate_socket(rid) as ws:
        await jury.post(f"/api/gate/requests/{rid}/attempts", json={})
        await wait_for(ws, {"state"})
    await asyncio.sleep(3.5)
    assert (await jury.post(f"/api/gate/requests/{rid}/attempts", json={"scenario": "follower"}))["attempt_no"] == 2
    await jury.post(f"/api/gate/requests/{rid}/deny")


async def test_simulated_fallback_never_gives_a_token(jury, hook):
    created = await jury.post("/api/gate/requests", json={"command": "DROP TABLE users"})
    rid = created["request_id"]
    await jury.post(f"/api/gate/requests/{rid}/fallback", json={"action": "confirm", "typed": "users"}, expect=409)
    view = await jury.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"})
    assert view["fallback_target"] == "users"
    await asyncio.sleep(1.1)
    out = await jury.post(f"/api/gate/requests/{rid}/fallback", json={"action": "confirm", "typed": "wrong"}, expect=422)
    assert out["code"] == "fallback_mismatch"
    done = await jury.post(f"/api/gate/requests/{rid}/fallback", json={"action": "confirm", "typed": "users"})
    assert done["status"] == "practice_passed" and "token" not in done
    await jury.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409)


async def test_interceptor_token_cannot_approve_anything(hook, owner):
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "claude-code"})
    rid = created["request_id"]
    assert created["gate_url"].endswith(rid)
    view = await hook.get(f"/api/gate/requests/{rid}")
    assert view["simulated"] is False and view["source_label"] == "Claude Code" and "token" not in view
    await hook.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=403)
    await hook.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"}, expect=403)
    await hook.post(f"/api/gate/requests/{rid}/deny", expect=403)
    for method, path in (("put", "/api/settings"), ("delete", "/api/data"), ("post", "/api/consent")):
        await getattr(hook, method)(path, expect=403, **({"json": {}} if method != "delete" else {}))
    await hook.post("/api/rules", json={"scope": "sql", "pattern": "x", "severity": "low", "reason": "x"}, expect=403)
    await hook.post("/api/gate/requests", json={"practice": True}, expect=403)
    await owner.post(f"/api/gate/requests/{rid}/deny")


async def test_real_request_cannot_run_on_a_simulated_sensor(hook, owner):
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    rid = created["request_id"]
    out = await owner.post(f"/api/gate/requests/{rid}/attempts", json={"scenario": "follower"}, expect=422)
    assert out["code"] == "live_only"
    out = await owner.post(f"/api/gate/requests/{rid}/attempts", json={"sensor": "sim"}, expect=422)
    assert out["code"] == "live_only"
    out = await owner.post(f"/api/gate/requests/{rid}/attempts", json={"sensor": "bridge"}, expect=409)
    assert out["code"] == "bridge_offline"
    out = await owner.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409)
    assert out["code"] == "camera_offline", "with no desktop bridge the owner defaults to the browser camera"
    assert (await owner.get("/api/bridge/status"))["connected"] is False
    await owner.post(f"/api/gate/requests/{rid}/deny")


async def _live_attempt(owner, bridge, rid, scenario):
    async with owner.gate_socket(rid) as ws:
        await wait_for(ws, {"snapshot"})
        started = await owner.post(f"/api/gate/requests/{rid}/attempts", json={})
        state = await wait_for(ws, {"state"})
        while state["state"] != "warmup":
            state = await wait_for(ws, {"state"})
        assert state["camera_on"] is True and state["simulated"] is False
        await bridge.feed(started["challenge_id"], time.time() + state["starts_in_s"], started["phases"], scenario)
        return started, await wait_for(ws, {"result", "aborted"})


async def test_live_path_approves_then_token_is_single_use_and_command_bound(server, env, hook, owner):
    command = "DROP TABLE accounts"
    digest = hashlib.sha256(command.encode()).hexdigest()
    async with FakeBridge(server, env["POB_BRIDGE_TOKEN"]) as bridge:
        assert (await owner.get("/api/bridge/status"))["sdk_version"] == "test-double"
        created = await hook.post("/api/gate/requests", json={"command": command, "source": "claude-code"})
        rid = created["request_id"]
        started, result = await _live_attempt(owner, bridge, rid, "follower")
        assert result["type"] == "result" and result["passed"] is True, result
        assert result["status"] == "approved"
        await asyncio.sleep(0.2)
        kinds = [e["type"] for e in bridge.events]
        assert kinds == ["start_capture", "stop_capture"], "camera must stop right after the window"
        assert bridge.events[0]["enable_telemetry"] is False, "telemetry stays off unless the person turns it on"

        browser_view = await owner.get(f"/api/gate/requests/{rid}")
        assert "token" not in browser_view
        view = await hook.get(f"/api/gate/requests/{rid}")
        token = view["token"]
        assert token
        assert (await hook.post("/api/gate/tokens/verify", json={"token": token, "command_sha256": "0" * 64}))["valid"] is False
        assert (await hook.post("/api/gate/tokens/verify", json={"token": "bad.bad", "command_sha256": digest}))["valid"] is False
        results = await asyncio.gather(*[hook.post("/api/gate/tokens/verify", json={"token": token, "command_sha256": digest}) for _ in range(5)])
        assert sum(r["valid"] for r in results) == 1, "single use under concurrency"
        assert (await hook.get(f"/api/gate/requests/{rid}")).get("token") is None
        receipt = (await owner.get("/api/receipts"))["items"][0]
        assert receipt["method"] == "breath" and receipt["decision"] == "approved" and receipt["command_sha256"] == digest
        assert "DROP" not in str(receipt), "command text is not stored by default"

        # An attack through the live path is rejected, and the session is left pending for retry.
        created = await hook.post("/api/gate/requests", json={"command": command, "source": "claude-code"})
        _, result = await _live_attempt(owner, bridge, created["request_id"], "natural")
        assert result["passed"] is False and result["status"] == "pending"
        assert (await hook.get(f"/api/gate/requests/{created['request_id']}")).get("token") is None
        await owner.post(f"/api/gate/requests/{created['request_id']}/deny")


async def test_expired_token_is_refused(server, env, hook, owner):
    command = "DROP TABLE expired"
    digest = hashlib.sha256(command.encode()).hexdigest()
    created = await hook.post("/api/gate/requests", json={"command": command, "source": "cli"})
    rid = created["request_id"]
    await owner.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"})
    await asyncio.sleep(1.1)
    view = await owner.post(f"/api/gate/requests/{rid}/fallback", json={"action": "confirm", "typed": "expired"})
    assert view["status"] == "fallback_approved" and "token" not in view
    token = (await hook.get(f"/api/gate/requests/{rid}"))["token"]
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    await conn.execute("UPDATE approval_tokens SET expires_at = 1 WHERE request_id = $1", uuid.UUID(rid))
    await conn.close()
    assert (await hook.get(f"/api/gate/requests/{rid}")).get("token") is None
    assert (await hook.post("/api/gate/tokens/verify", json={"token": token, "command_sha256": digest}))["valid"] is False
    assert (await owner.get("/api/receipts"))["items"][0]["method"] == "fallback"


async def test_request_expiry_writes_a_receipt(env, hook, owner):
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    rid = created["request_id"]
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    await conn.execute("UPDATE gate_requests SET created_at = now() - interval '1 day' WHERE id = $1", uuid.UUID(rid))
    await conn.close()
    assert (await hook.get(f"/api/gate/requests/{rid}"))["status"] == "expired"
    assert (await owner.get("/api/receipts"))["items"][0]["decision"] == "expired"
    assert (await owner.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409))["code"] == "request_closed"


async def test_bridge_auth_and_loss_during_capture(server, env, hook, owner):
    with pytest.raises(Exception):
        async with websockets.connect(server.replace("http://", "ws://") + "/ws/bridge", additional_headers={"Authorization": "Bearer wrong"}) as ws:
            await ws.recv()
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    rid = created["request_id"]
    bridge = FakeBridge(server, env["POB_BRIDGE_TOKEN"])
    await bridge.__aenter__()
    async with owner.gate_socket(rid) as ws:
        await wait_for(ws, {"snapshot"})
        await owner.post(f"/api/gate/requests/{rid}/attempts", json={})
        await wait_for(ws, {"state"})
        await bridge.__aexit__()
        out = await wait_for(ws, {"aborted", "result"})
    assert out["type"] == "aborted" and "disconnected" in out["reason"]
    assert (await owner.get(f"/api/gate/requests/{rid}"))["attempts_used"] == 0, "sensor loss does not use up an attempt"
    await owner.post(f"/api/gate/requests/{rid}/deny")


async def test_calibration(jury, owner):
    run = await jury.post("/api/calibration/polarity")
    assert run["simulated"] is True
    for _ in range(100):
        run = await jury.get(f"/api/calibration/polarity/{run['id']}")
        if run["state"] == "done":
            break
        await asyncio.sleep(0.1)
    assert run["polarity"] == 1 and (await jury.get("/api/settings"))["breath_polarity"] == 1
    await owner.get(f"/api/calibration/polarity/{run['id']}", expect=404)
    await jury.get("/api/calibration/polarity/nope", expect=404)


async def test_rules_crud_and_live_test(jury):
    rules = await jury.get("/api/rules")
    assert len(rules) == 16 and all(r["is_default"] for r in rules)
    await jury.delete(f"/api/rules/{rules[0]['id']}", expect=409)
    await jury.post("/api/rules", json={"scope": "shell", "pattern": "(", "severity": "high", "reason": "x"}, expect=422)
    await jury.post("/api/rules", json={"scope": "bad", "pattern": "x", "severity": "high", "reason": "x"}, expect=422)
    rule = await jury.post("/api/rules", json={"scope": "shell", "pattern": r"\bmake\s+nuke\b", "severity": "high", "reason": "Custom"})
    assert (await jury.post("/api/gate/requests", json={"command": "make  nuke"}))["gated"] is True
    await jury.put(f"/api/rules/{rule['id']}", json={"enabled": False})
    assert (await jury.post("/api/gate/requests", json={"command": "make nuke"}))["gated"] is False
    await jury.put(f"/api/rules/{rule['id']}", json={"pattern": "("}, expect=422)
    await jury.put(f"/api/rules/{rule['id']}", json={"enabled": True, "reason": "Edited"})
    assert (await jury.post("/api/gate/requests", json={"command": "make nuke"}))["reason"] == "Edited"
    assert (await jury.delete(f"/api/rules/{rule['id']}"))["deleted"]
    await jury.delete(f"/api/rules/{rule['id']}", expect=404)
    assert (await jury.post("/api/rules/test", json={"pattern": "drop", "sample": "DROP x"}))["matches"] is True
    assert (await jury.post("/api/rules/test", json={"pattern": "drop", "sample": "nope"}))["matches"] is False
    assert (await jury.post("/api/rules/test", json={"pattern": "(", "sample": "x"}))["valid"] is False
    started = time.time()
    assert (await jury.post("/api/rules/test", json={"pattern": "(a+)+$", "sample": "a" * 5000 + "!"}))["matches"] is True
    assert time.time() - started < 1


async def test_settings_validation_and_reset(jury):
    s = await jury.get("/api/settings")
    assert s["telemetry_opt_out"] is True and s["store_command_text"] is False and s["runtime_llm_enabled"] is False
    assert s["thresholds_calibrated"] is False
    await jury.put("/api/settings", json={"thresholds": {"s_xcorr": 5}}, expect=422)
    await jury.put("/api/settings", json={"thresholds": {"nope": 1}}, expect=422)
    await jury.put("/api/settings", json={"enabled_gates": {"nope": True}}, expect=422)
    await jury.put("/api/settings", json={"breath_polarity": 0}, expect=422)
    await jury.put("/api/settings", json={"breath_polarity": 5}, expect=422)
    assert (await jury.put("/api/settings", json={"thresholds": {"s_xcorr": 0.7}}))["thresholds"]["s_xcorr"] == 0.7
    assert (await jury.put("/api/settings", json={"enabled_gates": {"coupling": True}}))["enabled_gates"]["coupling"] is True
    out = await jury.post("/api/settings/reset-thresholds")
    assert out["thresholds"]["s_xcorr"] == 0.6 and out["enabled_gates"]["coupling"] is False
    assert (await jury.put("/api/settings", json={"runtime_llm_enabled": True}, expect=409))["code"] == "consent_required"
    await jury.post("/api/consent", json={"scope": "runtime_llm"})
    assert (await jury.put("/api/settings", json={"runtime_llm_enabled": True}))["runtime_llm_enabled"] is True
    await jury.delete("/api/consent", params={"scope": "runtime_llm"})
    assert (await jury.get("/api/settings"))["runtime_llm_enabled"] is False


async def test_command_text_only_stored_when_enabled(env, jury):
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    a = await jury.post("/api/gate/requests", json={"command": "DROP TABLE one", "cwd": "/secret/path"})
    assert await conn.fetchval("SELECT command_text FROM gate_requests WHERE id=$1", uuid.UUID(a["request_id"])) is None
    assert await conn.fetchval("SELECT cwd FROM gate_requests WHERE id=$1", uuid.UUID(a["request_id"])) is None
    assert (await jury.get(f"/api/gate/requests/{a['request_id']}"))["command"] == "DROP TABLE one", "kept in memory while pending"
    await jury.put("/api/settings", json={"store_command_text": True})
    b = await jury.post("/api/gate/requests", json={"command": "DROP TABLE two"})
    assert await conn.fetchval("SELECT command_text FROM gate_requests WHERE id=$1", uuid.UUID(b["request_id"])) == "DROP TABLE two"
    await conn.close()


async def test_explain_gating_never_affects_status(jury):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    assert (await jury.post(f"/api/gate/requests/{rid}/explain", expect=409))["code"] == "llm_off"
    await jury.post("/api/consent", json={"scope": "runtime_llm"})
    await jury.put("/api/settings", json={"runtime_llm_enabled": True})
    out = await jury.post(f"/api/gate/requests/{rid}/explain", expect=503)
    assert out["code"] == "llm_unavailable"
    assert (await jury.get(f"/api/gate/requests/{rid}"))["status"] == "pending"


async def test_bad_input_is_refused_and_never_a_server_error(jury):
    for command in ("DROP TABLE a\x00b", "DROP TABLE \ud800x"):
        out = await jury.client.post("/api/gate/requests", content=json.dumps({"command": command}), headers={"Content-Type": "application/json"})
        assert out.status_code == 422, command
    await jury.post("/api/gate/requests", json={"command": "x" * 20001}, expect=422)
    await jury.post("/api/gate/requests", json={"command": "DROP TABLE a", "cwd": "x\x00"}, expect=422)
    await jury.post("/api/rules", json={"scope": "sql", "pattern": "x", "severity": "low", "reason": "a\x00b"}, expect=422)
    out = await jury.post("/api/rules", json={"scope": "sql", "pattern": "(?:a){e<=99999999999}", "severity": "low", "reason": "x"}, expect=422)
    assert out["code"] == "bad_pattern"
    assert (await jury.post("/api/rules/test", json={"pattern": "(?:a){e<=99999999999}", "sample": "a"}))["valid"] is False
    await jury.get("/api/receipts", params={"offset": 3000000000}, expect=422)
    await jury.post("/api/consent", json={"scope": "evaluation"})
    await jury.post("/api/eval/sessions", json={"participant_code": "P1", "notes": "a\x00"}, expect=422)
    await jury.post("/api/eval/sessions", json={"participant_code": "P1", "lighting": "a\x00"}, expect=422)
    await jury.get("/api/gate/requests/not-a-uuid", expect=422)


async def test_websocket_refusals_carry_a_readable_code(jury, server):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    base = server.replace("http://", "ws://")
    async def code_for(path, headers):
        async with websockets.connect(base + path, additional_headers=headers) as ws:
            with pytest.raises(Exception):
                await ws.recv()
            return ws.close_code
    assert await code_for(f"/ws/gate/{created['request_id']}", {}) == 4401
    assert await code_for(f"/ws/gate/{uuid.uuid4()}", {"Cookie": jury.cookie_header()}) == 4404
    assert await code_for(f"/ws/gate/{created['request_id']}", {"Cookie": jury.cookie_header(), "Origin": "https://evil.example"}) == 4403
    assert await code_for("/ws/bridge", {"Authorization": "Bearer wrong"}) == 4401


async def test_concurrent_starts_produce_one_check(jury):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    async with jury.gate_socket(rid):
        replies = await asyncio.gather(*[jury.client.post(f"/api/gate/requests/{rid}/attempts", json={}) for _ in range(6)])
        assert sorted(r.status_code for r in replies) == [200, 409, 409, 409, 409, 409]
        await jury.post(f"/api/gate/requests/{rid}/deny")


async def test_stopping_from_another_window_tells_the_gate(jury):
    created = await jury.post("/api/gate/requests", json={"command": DANGEROUS})
    rid = created["request_id"]
    async with jury.gate_socket(rid) as ws:
        await jury.post(f"/api/gate/requests/{rid}/attempts", json={})
        await wait_for(ws, {"state"})
        await jury.delete("/api/consent", params={"scope": "gate"})
        assert "another window" in (await wait_for(ws, {"aborted"}))["reason"]


async def test_expiry_and_abandon_tell_the_gate_and_cannot_approve(env, hook, owner):
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    rid = created["request_id"]
    async with owner.gate_socket(rid) as ws:
        await wait_for(ws, {"snapshot"})
        assert (await hook.post(f"/api/gate/requests/{rid}/abandon"))["status"] == "expired"
        assert (await wait_for(ws, {"closed"}))["status"] == "expired"
    assert (await hook.post(f"/api/gate/requests/{rid}/abandon"))["status"] == "expired"
    assert (await owner.get("/api/receipts"))["items"][0]["decision"] == "expired"
    assert (await hook.get(f"/api/gate/requests/{rid}")).get("token") is None
    await owner.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"}, expect=409)

    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    rid = created["request_id"]
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    await conn.execute("UPDATE gate_requests SET created_at = now() - interval '140 seconds' WHERE id = $1", uuid.UUID(rid))
    await conn.close()
    assert (await hook.get(f"/api/gate/requests/{rid}"))["status"] == "expired", "real requests end soon after the hook stops waiting"


async def test_owner_calibration_needs_a_real_sensor_and_stops_when_abandoned(server, env, owner):
    out = await owner.post("/api/calibration/polarity", json={"sensor": "bridge"}, expect=409)
    assert out["code"] == "bridge_offline"
    out = await owner.post("/api/calibration/polarity", json={"sensor": "sim"}, expect=422)
    assert out["code"] == "live_only"
    out = await owner.post("/api/calibration/polarity", expect=409)
    assert out["code"] == "camera_offline"
    async with FakeBridge(server, env["POB_BRIDGE_TOKEN"]) as bridge:
        run = await owner.post("/api/calibration/polarity")
        assert run["simulated"] is False
        await asyncio.sleep(0.5)
        assert [e["type"] for e in bridge.events] == ["start_capture"]
        await asyncio.sleep(2.6)
        assert [e["type"] for e in bridge.events] == ["start_capture", "stop_capture"], "camera stops once the page stops polling"
        assert (await owner.get("/api/bridge/status"))["busy"] is False
        assert "closed" in (await owner.get(f"/api/calibration/polarity/{run['id']}"))["message"]


async def test_tampered_receipt_is_detected(env, owner, hook):
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    await owner.post(f"/api/gate/requests/{created['request_id']}/deny")
    created = await hook.post("/api/gate/requests", json={"command": DANGEROUS, "source": "cli"})
    await owner.post(f"/api/gate/requests/{created['request_id']}/deny")
    assert (await owner.get("/api/receipts/verify-chain")) == {"valid": True, "checked": 2, "broken_at": None, "reason": None}
    assert (await hook.get("/api/receipts/verify-chain"))["valid"] is True
    conn = await asyncpg.connect(env["DATABASE_URL"].replace("+asyncpg", ""))
    rid = (await owner.get("/api/receipts"))["items"][1]["id"]
    await conn.execute("UPDATE receipts SET decision='approved' WHERE id=$1", uuid.UUID(rid))
    await conn.close()
    out = await owner.get("/api/receipts/verify-chain")
    assert out["valid"] is False and out["broken_at"] == rid
    exported = await owner.get("/api/receipts/export")
    assert exported["count"] == 2
    await owner.delete("/api/data")
    assert (await owner.get("/api/receipts/verify-chain"))["checked"] == 0
    assert (await owner.get("/api/session"))["consents"] == []
    assert len(await owner.get("/api/rules")) == 16


async def test_evaluation_flow(jury, env):
    out = await jury.post("/api/eval/sessions", json={"participant_code": "P1"}, expect=409)
    assert out["code"] == "consent_required"
    await jury.post("/api/eval/synthetic", json={"per_condition": 2}, expect=409)
    await jury.post("/api/consent", json={"scope": "evaluation"})
    await jury.post("/api/eval/sessions", json={"participant_code": "Jane Doe"}, expect=422)
    out = await jury.post("/api/eval/sessions", json={"participant_code": "P1", "live": True}, expect=409)
    assert out["code"] == "camera_offline"
    assert len(await jury.get("/api/eval/conditions")) == 8

    session = await jury.post("/api/eval/sessions", json={"participant_code": "P1", "lighting": "dim"})
    assert session["simulated"] is True
    await jury.post("/api/eval/trials", json={"session_id": session["id"], "condition": "nope"}, expect=422)
    await jury.post("/api/eval/trials", json={"session_id": str(uuid.uuid4()), "condition": "photo"}, expect=404)

    # A real-time trial through the same pipeline, with its series stored.
    rid = None
    trial = await jury.post("/api/eval/trials", json={"session_id": session["id"], "condition": "photo"})
    rid = trial["request_id"]
    async with jury.gate_socket(rid) as ws:
        result = await wait_for(ws, {"result", "aborted"})
    assert result["type"] == "result" and result["trial_id"]
    assert (await jury.post(f"/api/gate/requests/{rid}/attempts", json={}, expect=409))["code"] in ("eval_trial", "request_closed")

    synth = await jury.post("/api/eval/synthetic", json={"per_condition": 3})
    assert synth["trials"] == 24 and synth["simulated"] is True
    await jury.post("/api/eval/synthetic", json={"per_condition": 500}, expect=422)

    res = await jury.get("/api/eval/results")
    assert res["data_class"] == "simulated" and res["n_trials"] == 25
    assert "not measurements" in res["label"]
    assert res["frr"]["n"] == 6 and res["far"]["n"] == 19
    assert len(res["conditions"]) == 8 and len(res["s_decoy_histogram"]) == 20
    live = await jury.get("/api/eval/results", params={"data": "live"})
    assert live["n_trials"] == 0 and live["frr"]["rate"] is None
    await jury.get("/api/eval/results", params={"data": "bad"}, expect=422)

    out = await jury.post("/api/eval/calibrate", expect=409)
    assert out["code"] == "not_enough_live_trials", "simulated data can never calibrate"
    assert (await jury.get("/api/settings"))["thresholds_calibrated"] is False

    trials = await jury.get("/api/eval/trials")
    assert len(trials) == 25
    real_time = next(t for t in trials if t["id"] == result["trial_id"])
    assert real_time["stored_series"] is True
    assert (await jury.delete(f"/api/eval/trials/{real_time['id']}"))["deleted"]
    await jury.delete(f"/api/eval/trials/{real_time['id']}", expect=404)
    assert (await jury.get("/api/eval/results"))["n_trials"] == 24
    exported = await jury.get("/api/eval/export")
    assert len(exported["simulated"]["trials"]) == 24 and exported["live"]["trials"] == []
    sessions = await jury.get("/api/eval/sessions")
    assert len(sessions) == 2
    await jury.delete(f"/api/eval/sessions/{synth['session_id']}")
    assert (await jury.get("/api/eval/results"))["n_trials"] == 0
    await jury.post("/api/eval/synthetic", json={"per_condition": 1})
    await jury.delete("/api/eval/data")
    assert await jury.get("/api/eval/sessions") == []
    await jury.delete(f"/api/eval/sessions/{session['id']}", expect=404)
