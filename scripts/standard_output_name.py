#!/usr/bin/env python3
"""Build the canonical delivery workbook name for a QNH fill task."""

from __future__ import annotations

import argparse
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


def sanitize_tenant_name(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "", value.strip())
    if not cleaned:
        raise ValueError("tenant name is empty after filename sanitization")
    return cleaned


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant-name", required=True)
    parser.add_argument("--spu-count", required=True, type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--date", help="YYYY-MM-DD; defaults to Asia/Shanghai today")
    args = parser.parse_args()

    if args.spu_count < 0:
        parser.error("--spu-count must be non-negative")
    if args.date:
        task_date = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        task_date = datetime.now(ZoneInfo("Asia/Shanghai"))
    name = f"{task_date:%m%d}{sanitize_tenant_name(args.tenant_name)}{args.spu_count}.xlsx"
    print(Path(args.output_dir).resolve() / name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
