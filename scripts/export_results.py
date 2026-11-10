#!/usr/bin/env python3
"""Turn a JSON export from the Evaluation Lab into docs/evaluation-results.md and PNG charts."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import report  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: export_results.py pob-evaluation.json", file=sys.stderr)
        return 2
    data = json.loads(Path(sys.argv[1]).read_text())
    note = f"Exported {data['exported_at']}. Thresholds were {'calibrated' if data['live']['results'].get('thresholds_calibrated') else 'provisional'} at export."
    print(report.write(data["live"]["results"], data["simulated"]["results"], note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
