#!/usr/bin/env python3
"""Decode generated picture barcodes and compare them with the selected SKU GTIN."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image
import zxingcpp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    jobs_payload = json.loads(Path(args.jobs).resolve().read_text(encoding="utf-8"))
    summary = json.loads(Path(args.summary).resolve().read_text(encoding="utf-8"))
    jobs = {
        str(job.get("spu_id") or ""): job
        for job in jobs_payload.get("jobs") or []
        if isinstance(job, dict)
    }
    rows: list[dict[str, object]] = []
    for result in summary.get("results") or []:
        if not isinstance(result, dict):
            continue
        spu_id = str(result.get("spu_id") or "")
        job = jobs.get(spu_id) or {}
        expected = str(job.get("expected_gtin") or "")
        artifact_path = Path(str(result.get("artifact_path") or "")).resolve()
        decoded: list[str] = []
        if artifact_path.is_file():
            image = Image.open(artifact_path).convert("RGB")
            for rotation in (0, 90, 180, 270):
                candidate = image if rotation == 0 else image.rotate(rotation, expand=True)
                decoded.extend(item.text for item in zxingcpp.read_barcodes(candidate))
        decoded = list(dict.fromkeys(value for value in decoded if value))
        rows.append(
            {
                "spu_id": spu_id,
                "expected_gtin": expected,
                "decoded": decoded,
                "status": "exact" if expected and expected in decoded else (
                    "unreadable" if not decoded else "mismatch"
                ),
                "artifact_path": str(artifact_path),
            }
        )
    counts: dict[str, int] = {}
    for row in rows:
        status = str(row["status"])
        counts[status] = counts.get(status, 0) + 1
    output = {
        "total": len(rows),
        "status_counts": counts,
        "rows": rows,
    }
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(output_path), **output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
