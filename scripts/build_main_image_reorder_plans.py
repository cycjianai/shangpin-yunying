#!/usr/bin/env python3
"""Build same-SPU main-image reorder plans from a manually reviewed selection."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    details_path = Path(args.details).resolve()
    selection_path = Path(args.selection).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    details = {
        str(row.get("spu_id") or ""): row
        for row in read_json(details_path).get("products") or []
        if isinstance(row, dict)
    }
    rows: list[dict[str, Any]] = []
    for selected in read_json(selection_path).get("rows") or []:
        spu_id = str(selected.get("spu_id") or "")
        product = details.get(spu_id)
        if not product:
            rows.append({"spu_id": spu_id, "status": "blocked", "reason": "detail_missing"})
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        current = [str(url) for url in detail.get("picUrlList") or [] if str(url)]
        first_index = int(selected.get("first_index") or 0)
        if first_index < 1 or first_index > len(current):
            rows.append({"spu_id": spu_id, "status": "blocked", "reason": "first_index_invalid"})
            continue
        reordered = [current[first_index - 1], *current[: first_index - 1], *current[first_index:]]
        if reordered == current:
            rows.append({"spu_id": spu_id, "status": "blocked", "reason": "already_first"})
            continue
        evidence = str(selected.get("evidence") or "").strip()
        if not evidence:
            rows.append({"spu_id": spu_id, "status": "blocked", "reason": "evidence_missing"})
            continue
        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "update_profile": "tenant_edit_v424",
            "expected_old_main_image_urls": current,
            "main_image_order_urls": reordered,
            "main_image_order_evidence": evidence,
            "audit_decisions": [
                {
                    "field": "主图首图",
                    "status": "accepted",
                    "source": "same_spu_reviewed_main_image_reorder",
                    "evidence": evidence,
                }
            ],
        }
        plan_path = output_dir / f"{spu_id}.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(plan_path, 0o600)
        rows.append(
            {
                "spu_id": spu_id,
                "title": str(product.get("title") or ""),
                "status": "ready",
                "plan_path": str(plan_path),
            }
        )
    index_path = output_dir / "index.json"
    index_path.write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(index_path, 0o600)
    print(json.dumps({"ok": True, "index": str(index_path), "ready": sum(row["status"] == "ready" for row in rows)}))


if __name__ == "__main__":
    main()
