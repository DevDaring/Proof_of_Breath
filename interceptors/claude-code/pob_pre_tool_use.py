#!/usr/bin/env python3
"""Claude Code PreToolUse hook. See docs/sdk-notes.md for the documented contract."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
import pob_client  # noqa: E402

BLOCK_NOTE = (" A human declined or did not complete the Proof of Breath check. "
              "Do not retry this command in a modified form. Ask the person what they want to do.")


def decide(decision: str, reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason}}))


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except ValueError:
        decide("deny", "Proof of Breath could not read the tool call.")
        return 0
    if event.get("tool_name") != "Bash":
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    if not command.strip():
        return 0
    try:
        allowed, message = pob_client.gate_command(command, "claude-code", event.get("cwd"))
    except Exception as exc:  # Any failure must block, never wave the command through.
        decide("deny", f"Proof of Breath failed while checking this command ({type(exc).__name__}).{BLOCK_NOTE}")
        return 0
    if not allowed:
        decide("deny", f"{message}{BLOCK_NOTE}")
    elif message:
        decide("allow", message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
