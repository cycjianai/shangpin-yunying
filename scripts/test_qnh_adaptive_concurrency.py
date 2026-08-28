#!/usr/bin/env python3
"""Regression for the shared 1→2→4 ceiling and sticky pressure downshift."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from qnh_adaptive_concurrency import decide, observe


def write_summary(path: Path, *, selected: int, verified: int, peak: int, pressure: bool) -> None:
    path.write_text(
        json.dumps(
            {
                "selectedTotal": selected,
                "verified": verified,
                "failed": 0,
                "itemP95Ms": 1000,
                "runtimePeakConcurrency": peak,
                "runtimePeakCombinedRssBytes": 1100 * 1024**2,
                "runtimeMemoryPressureStop": pressure,
                "runtimePressureObserved": pressure,
            }
        ),
        encoding="utf-8",
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as directory:
        state = Path(directory) / "state.json"
        summary = Path(directory) / "summary.json"
        os.environ.update(
            {
                "QNH_ADAPTIVE_TEST_MEM_AVAILABLE_KIB": str(10 * 1024 * 1024),
                "QNH_ADAPTIVE_TEST_SLICE_MEMORY_BYTES": str(128 * 1024 * 1024),
                "QNH_ADAPTIVE_TEST_SWAP_IN_KIB_S": "0",
            }
        )

        first = decide(state)
        assert first["concurrency"] == 1
        write_summary(summary, selected=1, verified=1, peak=1, pressure=False)
        observe(state, summary, 0, "window-1")
        second = decide(state)
        assert second["concurrency"] == 2

        write_summary(summary, selected=2, verified=2, peak=2, pressure=False)
        observe(state, summary, 0, "window-2")
        third = decide(state)
        assert third["concurrency"] == 4

        write_summary(summary, selected=4, verified=4, peak=4, pressure=True)
        observe(state, summary, 0, "window-3")
        fourth = decide(state)
        assert fourth["concurrency"] == 2
        assert fourth["pressure_ceiling"] == 2

        write_summary(summary, selected=2, verified=2, peak=2, pressure=True)
        observe(state, summary, 0, "window-4")
        fifth = decide(state)
        assert fifth["concurrency"] == 1
        assert fifth["pressure_ceiling"] == 1

        write_summary(summary, selected=1, verified=1, peak=1, pressure=False)
        observe(state, summary, 0, "window-5")
        sixth = decide(state)
        assert sixth["concurrency"] == 1
        assert sixth["pressure_ceiling"] == 1

        wrapper = (Path(__file__).parent / "run_qnh_batch.sh").read_text(encoding="utf-8")
        assert '^(1|2|4)$' in wrapper
        assert "QNH_DIRECT_MAX_CONCURRENCY=1" in wrapper
        assert 'script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"' in wrapper
        assert "qnh-fill-channel-unavailable" not in wrapper

    print("qnh adaptive concurrency 1-2-4 sticky ceiling: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
