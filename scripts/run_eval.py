#!/usr/bin/env python3
"""Run every simulated condition through the real verifier, with no database or server.

Live trials happen in the Evaluation Lab. This produces only the simulated section.
"""
import argparse
import os
import random
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(Path(__file__).resolve().parent)]
os.environ["POB_ENV_FILE"] = os.devnull
for name, value in (("POB_HMAC_SECRET", "x" * 32), ("POB_BRIDGE_TOKEN", "x" * 16), ("POB_INTERCEPTOR_TOKEN", "x" * 16), ("POB_OWNER_PASSWORD", "x" * 8)):
    os.environ.setdefault(name, value)

import report  # noqa: E402
from app.api.eval import CONDITIONS, compute_results  # noqa: E402
from app.core.challenge import distinct_decoys, generate_pattern, pattern_length  # noqa: E402
from app.core.simulate import simulate  # noqa: E402
from app.core.verifier import verify  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-condition", type=int, default=150)
    parser.add_argument("--seed", type=int, default=20261107)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    session = SimpleNamespace(participant_code="synthetic")
    rows = []
    for c in CONDITIONS:
        for _ in range(args.per_condition):
            phases = generate_pattern(rng)
            decoys = distinct_decoys(phases, rng)
            s = verify(phases, decoys, simulate(c["scenario"], phases, seed=rng.randint(0, 2**31 - 1), rsa=2.0), 0.0)
            trial = SimpleNamespace(condition=c["id"], duration_s=pattern_length(phases) + 12 + 3.5)
            rows.append((trial, s, session))
    simulated = compute_results(rows, False)
    empty = compute_results([], True)
    note = f"Thresholds were the provisional defaults. Seed {args.seed}, {args.per_condition} synthetic trials per condition."
    print(report.write(empty, simulated, note))
    print(f"simulated FAR {report.pct(simulated['far']['rate'])}, FRR {report.pct(simulated['frr']['rate'])}, S_decoy AUC {report.num(simulated['auc']['s_decoy'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
