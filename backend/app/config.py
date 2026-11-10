"""Runtime configuration. Thresholds live in core/thresholds.py and the settings table."""
from __future__ import annotations

import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

CONSENT_VERSION = "2026-11-09"


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_file=os.environ.get("POB_ENV_FILE", ".env"), extra="ignore", populate_by_name=True)

    database_url: str = Field("postgresql+asyncpg://pob:pob@localhost:5432/proof_of_breath", alias="DATABASE_URL")
    hmac_secret: str = Field(..., alias="POB_HMAC_SECRET", min_length=32)
    bridge_token: str = Field(..., alias="POB_BRIDGE_TOKEN", min_length=16)
    # The server-side relay for browser cameras. Empty turns the browser camera off.
    relay_token: str = Field("", alias="POB_RELAY_TOKEN")
    camera_ticket_ttl_s: float = Field(60.0, alias="POB_CAMERA_TICKET_TTL_S")
    measure_seconds: float = Field(60.0, alias="POB_MEASURE_S")
    interceptor_token: str = Field(..., alias="POB_INTERCEPTOR_TOKEN", min_length=16)
    owner_user: str = Field("owner", alias="POB_OWNER_USER")
    owner_password: str = Field(..., alias="POB_OWNER_PASSWORD", min_length=8)
    jury_user: str = Field("DevTest", alias="POB_JURY_USER")
    jury_password: str = Field("", alias="POB_JURY_PASSWORD")
    public_url: str = Field("http://127.0.0.1:5173", alias="POB_PUBLIC_URL")
    host: str = Field("127.0.0.1", alias="POB_HOST")
    backend_port: int = Field(8765, alias="POB_BACKEND_PORT")

    runtime_llm: bool = Field(False, alias="POB_RUNTIME_LLM")
    nanogpt_api_key: str = Field("", alias="NANOGPT_API_KEY")
    nanogpt_model: str = Field("", alias="NANOGPT_MODEL")
    nanogpt_base_url: str = Field("https://api.nano-gpt.com/api/v1", alias="NANOGPT_BASE_URL")

    # Timing. Live warm-up follows the SDK's documented 12 s pulse window (docs/sdk-notes.md).
    live_warmup_s: float = Field(12.0, alias="POB_LIVE_WARMUP_S")
    sim_warmup_s: float = Field(2.0, alias="POB_SIM_WARMUP_S")
    arming_timeout_s: float = Field(30.0, alias="POB_ARMING_TIMEOUT_S")
    sensor_tail_s: float = Field(3.5, alias="POB_SENSOR_TAIL_S")
    token_ttl_s: float = Field(30.0, alias="POB_TOKEN_TTL_S")
    request_ttl_s: float = Field(600.0, alias="POB_REQUEST_TTL_S")
    # A hook waits 120 s. After that nothing is waiting, so a pass must not look like an approval.
    real_request_ttl_s: float = Field(135.0, alias="POB_REAL_REQUEST_TTL_S")
    fallback_delay_s: float = Field(20.0, alias="POB_FALLBACK_DELAY_S")
    max_attempts: int = Field(3, alias="POB_MAX_ATTEMPTS")
    viewer_grace_s: float = Field(8.0, alias="POB_VIEWER_GRACE_S")
    calibration_seconds: float = Field(8.0, alias="POB_CALIBRATION_S")
    calibration_warmup_s: float = Field(5.0, alias="POB_CALIBRATION_WARMUP_S")

    # Limits for the public jury sandbox.
    session_days: int = Field(7, alias="POB_SESSION_DAYS")
    sandbox_retention_days: int = Field(7, alias="POB_SANDBOX_RETENTION_DAYS")
    login_rate_per_min: int = Field(30, alias="POB_LOGIN_RATE_PER_MIN")
    max_sim_sessions: int = Field(40, alias="POB_MAX_SIM_SESSIONS")
    llm_rate_per_hour: int = Field(30, alias="POB_LLM_RATE_PER_HOUR")

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")


@lru_cache
def get_config() -> Config:
    return Config()
