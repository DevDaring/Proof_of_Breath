"""Shared interceptor client. Standard library only, so hooks need no install."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

CONFIG_FILE = Path.home() / ".pob" / "config.json"
RULES_FILE = Path(__file__).with_name("default_rules.json")
DEFAULT_URL = "https://pob.koushikdeb.com"
POLL_SECONDS = 2.0
WAIT_SECONDS = float(os.environ.get("POB_WAIT_SECONDS", "120"))


class GateUnreachable(Exception):
    """The service could not be reached at all."""


class GateRefused(Exception):
    """The service answered with an error. Nothing is known about the command, so it is blocked."""


def load_config() -> dict:
    data = {}
    if CONFIG_FILE.exists():
        data = json.loads(CONFIG_FILE.read_text())
    return {
        "url": (os.environ.get("POB_URL") or data.get("url") or DEFAULT_URL).rstrip("/"),
        "token": os.environ.get("POB_INTERCEPTOR_TOKEN") or data.get("token") or "",
    }


def command_sha256(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()


def _call(method: str, path: str, body: dict | None = None, timeout: float = 10.0) -> dict:
    cfg = load_config()
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        cfg["url"] + path, data=data, method=method,
        headers={"Authorization": f"Bearer {cfg['token']}", "Content-Type": "application/json", "User-Agent": "pob-interceptor"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as reply:
            return json.loads(reply.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode()).get("detail", str(exc))
        except ValueError:
            detail = str(exc)
        if exc.code in (502, 503, 504):
            raise GateUnreachable(f"{exc.code}: {detail}") from exc
        raise GateRefused(f"{exc.code}: {detail}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise GateUnreachable(str(exc)) from exc


get = lambda path: _call("GET", path)
post = lambda path, body: _call("POST", path, body)


def _strip(token: str) -> str:
    token = token.replace('"', "").replace("'", "").replace("`", "")
    return token if re.match(r"^(?:[A-Za-z]:\\|\.\\|\\\\|\$env:)", token, re.I) else token.replace("\\", "")


def looks_dangerous_offline(command: str) -> str | None:
    """Used only when the backend cannot be reached, so an outage fails closed."""
    raw = " ".join(command.split()).lower()
    norm = " ".join(_strip(t) for t in command.split()).lower()
    for rule in json.loads(RULES_FILE.read_text()):
        pattern = re.compile(rule["pattern"], re.I)
        if pattern.search(raw) or pattern.search(norm):
            return rule["reason"]
    return None


def request_gate(command: str, source: str, cwd: str | None) -> dict:
    return post("/api/gate/requests", {"command": command, "source": source, "cwd": cwd})


def open_gate_window(url: str) -> None:
    print(f"Proof of Breath: complete the check at {url}", file=sys.stderr)
    try:
        webbrowser.open(url)
    except webbrowser.Error:
        pass


def wait_for_decision(request_id: str, command: str, wait_seconds: float = WAIT_SECONDS) -> tuple[bool, str]:
    """Poll until decided. The token is spent here, against this exact command's hash."""
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        try:
            view = get(f"/api/gate/requests/{request_id}")
        except GateUnreachable:
            time.sleep(POLL_SECONDS)
            continue
        except GateRefused as exc:
            return False, f"The Proof of Breath service refused the check ({exc})."
        status = view["status"]
        if status in ("approved", "fallback_approved"):
            token = view.get("token")
            if not token:
                return False, "The approval token had already expired."
            try:
                result = post("/api/gate/tokens/verify", {"token": token, "command_sha256": command_sha256(command)})
            except (GateUnreachable, GateRefused) as exc:
                return False, f"The approval could not be confirmed ({exc})."
            if result.get("valid"):
                return True, "Approved by a live check." if status == "approved" else "Approved through the typed fallback."
            return False, "The approval token was not valid for this exact command."
        if status in ("denied", "expired"):
            return False, f"The check ended as: {status}."
        time.sleep(POLL_SECONDS)
    # Nothing is waiting any more, so a later pass must not read as approval of this command.
    try:
        post(f"/api/gate/requests/{request_id}/abandon", {})
    except (GateUnreachable, GateRefused):
        pass
    return False, "No one completed the check in time."


def gate_command(command: str, source: str, cwd: str | None) -> tuple[bool, str]:
    """(allowed, message). Routine commands return immediately."""
    try:
        created = request_gate(command, source, cwd)
    except GateUnreachable as exc:
        reason = looks_dangerous_offline(command)
        if reason:
            return False, f"The Proof of Breath service could not be reached, so this was blocked. {reason}."
        print(f"Proof of Breath: service unreachable ({exc}). Routine command allowed.", file=sys.stderr)
        return True, ""
    except GateRefused as exc:
        return False, f"The Proof of Breath service refused this command, so it was blocked ({exc})."
    if not created.get("gated"):
        return True, ""
    open_gate_window(created["gate_url"])
    return wait_for_decision(created["request_id"], command)
