"""Deterministic command classification (spec section 7.1). No LLM ever decides this."""
from __future__ import annotations

import hashlib
import json
import re as stdlib_re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import regex

DEFAULT_RULES: list[dict] = json.loads((Path(__file__).parent / "default_rules.json").read_text())
MATCH_TIMEOUT_S = 0.05
MAX_PATTERN_LENGTH = 500
MAX_COMMAND_LENGTH = 20_000
_KEEP_BACKSLASH = stdlib_re.compile(r"^(?:[A-Za-z]:\\|\.\\|\\\\|\$env:)", stdlib_re.I)


@dataclass(frozen=True)
class RuleMatch:
    rule_id: str | None
    key: str | None
    scope: str
    severity: str
    reason: str


def command_sha256(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()


def _strip_token(token: str) -> str:
    token = token.replace('"', "").replace("'", "").replace("`", "")
    return token if _KEEP_BACKSLASH.match(token) else token.replace("\\", "")


def normalise(command: str) -> str:
    """Lower-case, collapse whitespace, remove quoting and backslash obfuscation."""
    text = " ".join(_strip_token(t) for t in command.split())
    return text.lower()


def variants(command: str) -> list[str]:
    """The whitespace-collapsed original and the fully normalised form."""
    raw = " ".join(command.split()).lower()
    norm = normalise(command)
    return [raw] if raw == norm else [raw, norm]


def compile_rule(pattern: str) -> "regex.Pattern[str]":
    """Compile a rule pattern. Raises ValueError with a readable message when invalid."""
    if not pattern or not pattern.strip():
        raise ValueError("Pattern is empty")
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise ValueError(f"Pattern is longer than {MAX_PATTERN_LENGTH} characters")
    try:
        return regex.compile(pattern, regex.IGNORECASE)
    except regex.error as exc:
        raise ValueError(f"Invalid pattern: {exc}") from exc
    except (RuntimeError, OverflowError, RecursionError, MemoryError) as exc:
        raise ValueError("Invalid pattern: it is too complex to compile") from exc


def rule_matches(compiled: "regex.Pattern[str]", command: str) -> bool:
    """A pattern that exhausts its time budget counts as a match, so the gate fails closed."""
    for text in variants(command[:MAX_COMMAND_LENGTH]):
        try:
            if compiled.search(text, timeout=MATCH_TIMEOUT_S, concurrent=True):
                return True
        except TimeoutError:
            return True
    return False


def classify(command: str, rules: Iterable[dict] | None = None) -> RuleMatch | None:
    """First enabled rule that matches, or None."""
    for rule in DEFAULT_RULES if rules is None else rules:
        if rule.get("enabled", True) is False:
            continue
        try:
            compiled = compile_rule(rule["pattern"])
        except ValueError:
            continue
        if rule_matches(compiled, command):
            return RuleMatch(
                rule_id=str(rule["id"]) if rule.get("id") else None,
                key=rule.get("key"),
                scope=rule["scope"],
                severity=rule["severity"],
                reason=rule["reason"],
            )
    return None


_TARGET_PATTERNS: Sequence[str] = (
    r"\bdrop\s+(?:table|database|schema)\s+(?:if\s+exists\s+)?([^\s;]+)",
    r"\btruncate\s+(?:table\s+)?([^\s;]+)",
    r"\bdelete\s+from\s+([^\s;]+)",
    r"\bpush\b.*?\s\+?(?:\S+:)?(?:refs/heads/)?(main|master|prod|production|release|trunk|develop)(?:\s|$)",
    r"\b(?:ns|namespaces?)[\s/]+([^\s;]+)",
)


def extract_target(command: str) -> str:
    """The name a person retypes in the accessible fallback (database, branch, namespace)."""
    text = " ".join(_strip_token(t) for t in command.split())
    for pattern in _TARGET_PATTERNS:
        found = stdlib_re.search(pattern, text, stdlib_re.I)
        if found:
            return found.group(1)
    tokens = [t for t in text.split() if not t.startswith("-")]
    if len(tokens) >= 2 and tokens[0].lower() in {"rm", "remove-item", "ri", "del", "rd", "rmdir"}:
        return tokens[-1]
    return text
