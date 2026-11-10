from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator


def clean_text(value):
    """PostgreSQL cannot store NUL, and lone surrogates cannot be encoded or hashed."""
    if value is None:
        return value
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("is not valid text") from exc
    return value


class ApiError(Exception):
    """Rendered as {"code": ..., "detail": ...}. `detail` is shown to the person as written."""

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


CleanText = Annotated[str, AfterValidator(clean_text)]
