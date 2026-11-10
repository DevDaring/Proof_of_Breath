"""Schema from spec section 10, plus a workspace id: the hosted app isolates each jury login."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, false as sa_false
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def _workspace_fk(index: bool = True) -> Mapped[uuid.UUID]:
    return mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=index)


TS = DateTime(timezone=True)


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[uuid.UUID] = _id()
    kind: Mapped[str] = mapped_column(String(16))  # owner | jury
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)


class AppSettings(Base):
    __tablename__ = "settings"
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    thresholds: Mapped[dict] = mapped_column(JSONB)
    enabled_gates: Mapped[dict] = mapped_column(JSONB)
    thresholds_calibrated: Mapped[bool] = mapped_column(Boolean, default=False)
    breath_polarity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # False when the sign came from the simulated sensor, which a real camera check must not rely on.
    polarity_live: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa_false())
    telemetry_opt_out: Mapped[bool] = mapped_column(Boolean, default=True)
    store_command_text: Mapped[bool] = mapped_column(Boolean, default=False)
    runtime_llm_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class ConsentRecord(Base):
    __tablename__ = "consent_records"
    id: Mapped[uuid.UUID] = _id()
    workspace_id: Mapped[uuid.UUID] = _workspace_fk()
    consent_version: Mapped[str] = mapped_column(String(32))
    scope: Mapped[str] = mapped_column(String(16))  # gate | evaluation | runtime_llm
    granted_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class ProtectedRule(Base):
    __tablename__ = "protected_rules"
    id: Mapped[uuid.UUID] = _id()
    workspace_id: Mapped[uuid.UUID] = _workspace_fk()
    key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scope: Mapped[str] = mapped_column(String(8))  # shell | sql | git
    pattern: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class GateRequest(Base):
    __tablename__ = "gate_requests"
    id: Mapped[uuid.UUID] = _id()
    workspace_id: Mapped[uuid.UUID] = _workspace_fk()
    source: Mapped[str] = mapped_column(String(24))
    command_sha256: Mapped[str] = mapped_column(String(64))
    command_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    cwd: Mapped[str | None] = mapped_column(Text, nullable=True)
    matched_rule_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("protected_rules.id", ondelete="SET NULL"), nullable=True, index=True)
    matched_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    matched_severity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    purpose: Mapped[str] = mapped_column(String(12), default="command")  # command | practice | eval
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    # pending | approved | denied | expired | fallback_approved | practice_passed
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    fallback_started_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class Challenge(Base):
    __tablename__ = "challenges"
    id: Mapped[uuid.UUID] = _id()
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("gate_requests.id", ondelete="CASCADE"), index=True)
    attempt_no: Mapped[int] = mapped_column(Integer)
    nonce: Mapped[str] = mapped_column(String(32))
    phases: Mapped[list] = mapped_column(JSONB)
    decoys: Mapped[list] = mapped_column(JSONB)
    issued_at: Mapped[float] = mapped_column(Float)
    expires_at: Mapped[float] = mapped_column(Float)
    hmac: Mapped[str] = mapped_column(String(64))
    consumed_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class Attempt(Base):
    __tablename__ = "attempts"
    id: Mapped[uuid.UUID] = _id()
    challenge_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"))
    s_xcorr: Mapped[float] = mapped_column(Float)
    s_phase: Mapped[float] = mapped_column(Float)
    s_cycles: Mapped[int] = mapped_column(Integer)
    target_cycles: Mapped[int] = mapped_column(Integer)
    s_live: Mapped[float] = mapped_column(Float)
    s_decoy: Mapped[float] = mapped_column(Float)
    s_coupling: Mapped[float] = mapped_column(Float)
    s_coupling_decoy: Mapped[float] = mapped_column(Float)
    best_lag_s: Mapped[float] = mapped_column(Float)
    passed: Mapped[bool] = mapped_column(Boolean)
    failure_reasons: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("challenge_id", name="uq_attempt_challenge"),)


class ApprovalToken(Base):
    __tablename__ = "approval_tokens"
    id: Mapped[uuid.UUID] = _id()
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("gate_requests.id", ondelete="CASCADE"), index=True)
    command_sha256: Mapped[str] = mapped_column(String(64))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[float] = mapped_column(Float)
    used_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class Receipt(Base):
    __tablename__ = "receipts"
    id: Mapped[uuid.UUID] = _id()
    workspace_id: Mapped[uuid.UUID] = _workspace_fk()
    seq: Mapped[int] = mapped_column(Integer)
    request_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("gate_requests.id", ondelete="SET NULL"), nullable=True, index=True)
    command_sha256: Mapped[str] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(24))
    decision: Mapped[str] = mapped_column(String(20))
    method: Mapped[str] = mapped_column(String(16))  # breath | fallback | simulated | practice | none
    scores: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
    __table_args__ = (UniqueConstraint("workspace_id", "seq", name="uq_receipt_seq"),)


class EvalSession(Base):
    __tablename__ = "eval_sessions"
    id: Mapped[uuid.UUID] = _id()
    workspace_id: Mapped[uuid.UUID] = _workspace_fk()
    participant_code: Mapped[str] = mapped_column(String(32))
    lighting: Mapped[str] = mapped_column(String(32))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class EvalTrial(Base):
    __tablename__ = "eval_trials"
    id: Mapped[uuid.UUID] = _id()
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("eval_sessions.id", ondelete="CASCADE"), index=True)
    condition: Mapped[str] = mapped_column(String(32))
    challenge_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id", ondelete="CASCADE"), index=True)
    breath_series: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    pulse_series: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


Index("ix_trial_created", EvalTrial.created_at)
