"""The shipped hook scripts, run as subprocesses against the real backend."""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from .conftest import FakeBridge

ROOT = Path(__file__).parents[3]
HOOK = ROOT / "interceptors" / "claude-code" / "pob_pre_tool_use.py"
CLI = ROOT / "interceptors" / "cli" / "pob"
PRE_PUSH = ROOT / "interceptors" / "git" / "pre-push"
sys.path.insert(0, str(ROOT / "interceptors" / "common"))
import pob_client  # noqa: E402

from app.core.risk_rules import DEFAULT_RULES, classify  # noqa: E402
from .test_risk_rules import NEGATIVE, POSITIVE  # noqa: E402


def child_env(server, env):
    return {**os.environ, "POB_URL": server, "POB_INTERCEPTOR_TOKEN": env["POB_INTERCEPTOR_TOKEN"], "BROWSER": "true", "HOME": "/nonexistent-home"}


async def run_process(args, stdin, environ, cwd=None):
    proc = await asyncio.create_subprocess_exec(*args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environ, cwd=cwd)
    out, err = await proc.communicate(stdin.encode() if stdin else b"")
    return proc.returncode, out.decode(), err.decode()


def hook_input(command, tool="Bash"):
    return json.dumps({"session_id": "s", "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {"command": command}, "tool_use_id": "t"})


async def test_hook_lets_routine_commands_and_other_tools_through(server, env):
    environ = child_env(server, env)
    assert await run_process([sys.executable, str(HOOK)], hook_input("ls -la"), environ) == (0, "", "")
    assert await run_process([sys.executable, str(HOOK)], hook_input("rm -rf /", tool="Read"), environ) == (0, "", "")


async def test_hook_fails_closed_when_the_backend_is_down(env):
    environ = child_env("http://127.0.0.1:9", env)
    code, out, _ = await run_process([sys.executable, str(HOOK)], hook_input("terraform destroy"), environ)
    decision = json.loads(out)["hookSpecificOutput"]
    assert code == 0 and decision["permissionDecision"] == "deny" and "could not be reached" in decision["permissionDecisionReason"]
    code, out, err = await run_process([sys.executable, str(HOOK)], hook_input("ls"), environ)
    assert (code, out) == (0, "") and "unreachable" in err


async def test_hook_blocks_when_the_service_refuses_even_if_no_bundled_rule_matches(server, env):
    environ = child_env(server, env)
    long_harmless = "echo " + "x" * 20100
    code, out, _ = await run_process([sys.executable, str(HOOK)], hook_input(long_harmless), environ)
    assert code == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "refused" in json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]


async def test_hook_abandons_the_request_when_its_wait_ends(server, env, owner):
    before = await _pending(owner)
    environ = {**child_env(server, env), "POB_WAIT_SECONDS": "3"}
    task = asyncio.create_task(run_process([sys.executable, str(HOOK)], hook_input("terraform destroy"), environ))
    rid = await _gated_id(owner, before, "hook")
    _, out, _ = await task
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"
    view = await owner.get(f"/api/gate/requests/{rid}")
    assert view["status"] == "expired", "a later pass must not look like an approval"


async def test_hook_blocks_on_unreadable_input_and_bad_token(server, env):
    code, out, _ = await run_process([sys.executable, str(HOOK)], "not json", child_env(server, env))
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"
    environ = {**child_env(server, env), "POB_INTERCEPTOR_TOKEN": "wrong"}
    code, out, _ = await run_process([sys.executable, str(HOOK)], hook_input("terraform destroy"), environ)
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


async def _gated_id(owner, before, source):
    for _ in range(60):
        await asyncio.sleep(0.25)
        for rid in await _pending(owner):
            if rid not in before:
                return rid
    raise AssertionError(f"no gate request from {source}")


async def _pending(owner):
    import asyncpg
    conn = await asyncpg.connect(os.environ["TEST_DSN"])
    rows = await conn.fetch("SELECT id FROM gate_requests WHERE status='pending' AND purpose='command'")
    await conn.close()
    return {str(r["id"]) for r in rows}


@pytest.fixture(autouse=True)
def dsn(env):
    os.environ["TEST_DSN"] = env["DATABASE_URL"].replace("+asyncpg", "")


async def test_hook_denies_when_the_person_denies(server, env, owner):
    before = await _pending(owner)
    task = asyncio.create_task(run_process([sys.executable, str(HOOK)], hook_input("terraform destroy"), child_env(server, env)))
    rid = await _gated_id(owner, before, "hook")
    await owner.post(f"/api/gate/requests/{rid}/deny")
    code, out, _ = await task
    decision = json.loads(out)["hookSpecificOutput"]
    assert code == 0 and decision["permissionDecision"] == "deny"
    assert "must not" in decision["permissionDecisionReason"].lower() or "do not retry" in decision["permissionDecisionReason"].lower()


async def test_hook_allows_after_the_typed_fallback(server, env, owner):
    before = await _pending(owner)
    task = asyncio.create_task(run_process([sys.executable, str(HOOK)], hook_input("DROP TABLE hooked"), child_env(server, env)))
    rid = await _gated_id(owner, before, "hook")
    await owner.post(f"/api/gate/requests/{rid}/fallback", json={"action": "start"})
    await asyncio.sleep(1.1)
    await owner.post(f"/api/gate/requests/{rid}/fallback", json={"action": "confirm", "typed": "hooked"})
    _, out, _ = await task
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "allow"


async def test_hook_allows_after_a_live_breath_check(server, env, owner):
    """The demo path: Claude Code blocked on terraform destroy until the check passes."""
    before = await _pending(owner)
    async with FakeBridge(server, env["POB_BRIDGE_TOKEN"]) as bridge:
        task = asyncio.create_task(run_process([sys.executable, str(HOOK)], hook_input("terraform destroy"), child_env(server, env)))
        rid = await _gated_id(owner, before, "hook")
        from .test_api import _live_attempt
        _, result = await _live_attempt(owner, bridge, rid, "follower")
        assert result["status"] == "approved", result
        _, out, _ = await task
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "allow"


async def test_cli_run_status_receipts_chain(server, env, owner):
    environ = child_env(server, env)
    code, out, _ = await run_process([sys.executable, str(CLI), "run", "--", "echo", "hello there"], "", environ)
    assert code == 0 and out.strip() == "hello there"
    code, out, _ = await run_process([sys.executable, str(CLI), "run", "--", "echo piped | tr a-z A-Z"], "", environ)
    assert code == 0 and out.strip() == "PIPED"
    code, out, _ = await run_process([sys.executable, str(CLI), "run", "--", "false"], "", environ)
    assert code == 1
    before = await _pending(owner)
    task = asyncio.create_task(run_process([sys.executable, str(CLI), "run", "--", "kubectl delete ns prod"], "", environ))
    rid = await _gated_id(owner, before, "cli")
    await owner.post(f"/api/gate/requests/{rid}/deny")
    code, _, err = await task
    assert code == 1 and "Blocked" in err
    code, out, _ = await run_process([sys.executable, str(CLI), "status"], "", environ)
    assert code == 0 and "reachable" in out and "not connected" in out
    code, out, _ = await run_process([sys.executable, str(CLI), "receipts"], "", environ)
    assert code == 0 and "denied" in out
    code, out, _ = await run_process([sys.executable, str(CLI), "verify-chain"], "", environ)
    assert code == 0 and "Chain verified" in out
    code, _, err = await run_process([sys.executable, str(CLI), "run", "--"], "", environ)
    assert code == 2 and "Usage" in err


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", *args], cwd=cwd, check=True, capture_output=True)


async def test_git_pre_push_gates_only_forced_pushes_to_protected_branches(server, env, owner, tmp_path):
    environ = child_env(server, env)
    remote = tmp_path / "remote.git"
    work = tmp_path / "work"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(work)], check=True, capture_output=True)
    _git(work, "commit", "--allow-empty", "-m", "one")
    _git(work, "remote", "add", "origin", str(remote))
    _git(work, "commit", "--allow-empty", "-m", "two")
    subprocess.run(["cp", str(PRE_PUSH), str(work / ".git" / "hooks" / "pre-push")], check=True)
    hook_src = (work / ".git" / "hooks" / "pre-push")
    hook_src.write_text(hook_src.read_text().replace('real = Path(__file__).resolve()', f'real = Path({str(PRE_PUSH)!r})'))
    hook_src.chmod(0o755)

    def push(*args):
        return subprocess.run(["git", "push", *args], cwd=work, env=environ, capture_output=True, text=True)

    assert push("origin", "main").returncode == 0, "a first push is not forced"
    _git(work, "commit", "--allow-empty", "-m", "three")
    assert push("origin", "main").returncode == 0, "fast-forward passes"
    _git(work, "reset", "--soft", "HEAD~1")
    _git(work, "commit", "--allow-empty", "-m", "rewritten")
    _git(work, "branch", "feature")
    assert push("--force", "origin", "feature").returncode == 0, "feature branches are not protected"

    before = await _pending(owner)
    task = asyncio.create_task(asyncio.to_thread(push, "--force", "origin", "main"))
    rid = await _gated_id(owner, before, "git")
    await owner.post(f"/api/gate/requests/{rid}/deny")
    denied = await task
    assert denied.returncode != 0 and "blocked" in denied.stderr.lower()


@pytest.mark.parametrize("command", [c for v in POSITIVE.values() for c in v] + NEGATIVE)
def test_offline_rule_copy_agrees_with_the_backend(command):
    assert bool(pob_client.looks_dangerous_offline(command)) == bool(classify(command, DEFAULT_RULES)), command
