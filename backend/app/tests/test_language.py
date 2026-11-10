"""Spec section 8: no medical language in UI strings, README or docs."""
import re
from pathlib import Path

ROOT = Path(__file__).parents[3]
BANNED = re.compile(r"\b(stress\w*|anxiety|health\w*|diagnos\w*|treat\w*|medical\w*|heart condition|calm down)\b", re.I)
ALLOWED_LINE = "<!-- disclaimer -->"


def targets():
    yield from (ROOT / "docs").glob("*.md")
    readme = ROOT / "README.md"
    if readme.exists():
        yield readme
    for folder in ("frontend/src", "frontend/public"):
        for path in (ROOT / folder).rglob("*"):
            if path.suffix in {".ts", ".tsx", ".html", ".css", ".svg", ".json"}:
                yield path
    yield ROOT / "frontend" / "index.html"
    for path in (ROOT / "backend" / "app" / "core").glob("verifier.py"):
        yield path


def test_no_banned_words():
    hits = []
    for path in targets():
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if path.name == "consent-and-data.md" and ALLOWED_LINE in line:
                continue
            found = BANNED.search(line)
            if found:
                hits.append(f"{path.relative_to(ROOT)}:{number}: {found.group(0)}")
    assert not hits, "\n".join(hits)
