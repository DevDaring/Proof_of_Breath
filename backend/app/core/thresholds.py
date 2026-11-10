"""Default gate thresholds. All are provisional until calibrated (spec section 13)."""
from __future__ import annotations

DEFAULT_THRESHOLDS: dict[str, float] = {
    "s_xcorr": 0.60,
    "s_phase": 0.80,
    "s_live": 0.70,
    "s_decoy": 0.0,  # The spec draft said 0.15. See docs/sdk-notes.md.
    "s_coupling": 0.30,
    "pulse_confidence_min": 45.0,
}

DEFAULT_ENABLED_GATES: dict[str, bool] = {
    "xcorr": True,
    "phase": True,
    "cycles": True,
    "live": True,
    "decoy": True,
    "coupling": False,
}

# A decoy this similar to the target is not a different pattern, and an honest follower can
# lose to it by chance. Measured results are in docs/sdk-notes.md.
DECOY_MAX_SIMILARITY = 0.97
