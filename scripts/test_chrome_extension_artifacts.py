#!/usr/bin/env python3
"""Regression checks for current-tab Chrome extension artifacts."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from export_standard_channel_fill_workbook import final_files, performance, plan_audit_paths


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="qnh-extension-artifacts-") as tmp:
        run_dir = Path(tmp)
        expected = {"fixture-spu-1", "fixture-spu-2"}
        write(
            run_dir / "details-full-c001-final-1.json",
            {"products": [{"spu_id": "fixture-spu-1"}]},
        )
        complete = run_dir / "details-final-round2-fixture.json"
        write(complete, {"products": [{"spu_id": value} for value in sorted(expected)]})
        assert final_files(run_dir, expected) == [complete]
        write(
            run_dir / "details-final-round3-fixture.json",
            {"products": [{"spu_id": "fixture-spu-1"}]},
        )
        assert final_files(run_dir, expected) == [complete]

        channel_audit = run_dir / "channel-plans" / "audit.json"
        residual_audit = run_dir / "residual-round1-plans" / "audit.json"
        write(channel_audit, {"fields": []})
        write(residual_audit, {"fields": []})
        assert channel_audit in plan_audit_paths(run_dir)
        assert residual_audit in plan_audit_paths(run_dir)

        write(
            run_dir / "save-fixture-checkpoint.json",
            {"rows": [{"status": "verified", "duration_ms": 11}]},
        )
        write(
            run_dir / "residual-r1-fixture-checkpoint.json",
            {"rows": [{"status": "failed", "duration_ms": 7}]},
        )
        write(
            run_dir / "save-preview-checkpoint.json",
            {"dry_run": True, "rows": [{"status": "verified", "duration_ms": 99}]},
        )
        assert performance([run_dir]) == {
            "checkpoint_files": 2,
            "events": 2,
            "verified": 1,
            "failed_responses": 1,
            "elapsed_ms": 18,
        }

    print(json.dumps({"passed": True, "check": "chrome_extension_artifacts"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
