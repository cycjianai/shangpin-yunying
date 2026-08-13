#!/usr/bin/env python3
"""【业务说明书：牵牛花 Skill - 内存压力并发上限粘滞回归】

核心红线：一次真实窗口在峰值 4 路触发浏览器内存压力后，本任务后续窗口必须固定在 2 路；
若 2 路仍触发进程回收，则继续固定为 1 个长驻热页，不能反复支付多页冷启动和内存峰值。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from qnh_adaptive_concurrency import decide, observe


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
        assert decide(state)["concurrency"] == 10
        summary.write_text(
            json.dumps(
                {
                    "selectedTotal": 50,
                    "verified": 6,
                    "failed": 0,
                    "runtimePeakConcurrency": 4,
                    "runtimePeakCombinedRssBytes": 1700 * 1024**2,
                    "runtimeMemoryPressureStop": False,
                    "runtimePressureObserved": True,
                }
            ),
            encoding="utf-8",
        )
        observe(state, summary, 0, "window-1")
        second = decide(state)
        assert second["concurrency"] == 2
        assert second["pressure_ceiling"] == 2
        summary.write_text(
            json.dumps(
                {
                    "selectedTotal": 50,
                    "verified": 5,
                    "failed": 0,
                    "runtimePeakConcurrency": 2,
                    "runtimePeakCombinedRssBytes": 1600 * 1024**2,
                    "runtimeMemoryPressureStop": True,
                    "runtimePressureObserved": True,
                }
            ),
            encoding="utf-8",
        )
        observe(state, summary, 0, "window-2")
        third = decide(state)
        assert third["concurrency"] == 1
        assert third["pressure_ceiling"] == 1
        summary.write_text(
            json.dumps(
                {
                    "selectedTotal": 50,
                    "verified": 50,
                    "failed": 0,
                    "runtimePeakConcurrency": 1,
                    "runtimePeakCombinedRssBytes": 1100 * 1024**2,
                    "runtimeMemoryPressureStop": False,
                    "runtimePressureObserved": False,
                }
            ),
            encoding="utf-8",
        )
        observe(state, summary, 0, "window-3")
        fourth = decide(state)
        assert fourth["concurrency"] == 1
        assert fourth["pressure_ceiling"] == 1

        hard_state = Path(directory) / "hard-state.json"
        hard_summary = Path(directory) / "hard-summary.json"
        assert decide(hard_state)["concurrency"] == 10
        hard_summary.write_text(
            json.dumps(
                {
                    "selectedTotal": 50,
                    "verified": 6,
                    "failed": 0,
                    "runtimePeakConcurrency": 4,
                    "runtimePeakCombinedRssBytes": 3 * 1024**3,
                    "runtimeMemoryPressureStop": True,
                    "runtimePressureObserved": True,
                }
            ),
            encoding="utf-8",
        )
        observe(hard_state, hard_summary, 0, "hard-window")
        hard_next = decide(hard_state)
        assert hard_next["concurrency"] == 2
        assert hard_next["pressure_ceiling"] == 2

        batch_wrapper = (Path(__file__).parent / "run_qnh_batch.sh").read_text(
            encoding="utf-8"
        )
        assert "desired_concurrency" in batch_wrapper
        assert "QNH_DIRECT_MAX_CONCURRENCY=2" in batch_wrapper
        assert "'.last_decision.concurrency'" in batch_wrapper
    print("qnh adaptive concurrency sticky ceiling: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
