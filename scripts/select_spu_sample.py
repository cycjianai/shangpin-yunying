#!/usr/bin/env python3
"""Select a deterministic unique SPU sample from a frozen read-only manifest."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


def products(document: dict) -> list[dict]:
    output: list[dict] = []
    seen: set[str] = set()
    for item in document.get("products") or []:
        spu_id = str(item.get("spu_id") or item.get("spuId") or "").strip()
        if not spu_id or spu_id in seen:
            continue
        seen.add(spu_id)
        output.append(
            {
                "spu_id": spu_id,
                "title": str(item.get("title") or item.get("spu_name") or ""),
            }
        )
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--exclude-manifest", action="append", default=[])
    args = parser.parse_args()
    if args.count <= 0 or args.offset < 0:
        raise SystemExit("count must be positive and offset must be non-negative")

    input_path = Path(args.input).resolve()
    excluded: set[str] = set()
    for raw_path in args.exclude_manifest:
        excluded.update(
            item["spu_id"]
            for item in products(
                json.loads(Path(raw_path).resolve().read_text(encoding="utf-8"))
            )
        )
    candidates = [
        item
        for item in products(json.loads(input_path.read_text(encoding="utf-8")))
        if item["spu_id"] not in excluded
    ]
    selected = candidates[args.offset : args.offset + args.count]
    if len(selected) != args.count:
        raise SystemExit(
            f"insufficient unique candidates: requested={args.count} selected={len(selected)}"
        )
    output = Path(args.output).resolve()
    payload = {
        "generated_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(
            timespec="seconds"
        ),
        "source_type": "frozen_platform_manifest_sample",
        "source_manifest": str(input_path),
        "requested_count": args.count,
        "offset": args.offset,
        "excluded_count": len(excluded),
        "expected_total": len(selected),
        "unique_total": len(selected),
        "products": selected,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)
    print(json.dumps({"output": str(output), "selected": len(selected)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
