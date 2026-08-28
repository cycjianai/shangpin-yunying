#!/usr/bin/env python3
"""Build fail-closed no-UPC plans from an explicit audit error and full same-SPU scan."""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


GTIN_LENGTHS = {8, 12, 13, 14}
BARCODE_ISSUE_RE = re.compile(r"条形码|条码|UPC", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--barcode-scan", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def gtin_valid(value: str) -> bool:
    if not value.isdigit() or len(value) not in GTIN_LENGTHS:
        return False
    digits = [int(char) for char in value]
    total = 0
    for offset, digit in enumerate(reversed(digits[:-1]), start=1):
        total += digit * (3 if offset % 2 == 1 else 1)
    return (10 - total % 10) % 10 == digits[-1]


def text(value: object) -> str:
    return str(value or "").strip()


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    manifest_path = Path(args.manifest).resolve()
    scan_path = Path(args.barcode_scan).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    details = read_json(details_path).get("products") or []
    manifest = read_json(manifest_path).get("products") or []
    scan = read_json(scan_path)
    issues = {
        text(row.get("spu_id")): " ".join(text(value) for value in row.get("issue_text") or [])
        for row in manifest
        if isinstance(row, dict)
    }
    scans_by_spu: dict[str, list[dict[str, Any]]] = {}
    for row in scan.get("scan_results") or []:
        if not isinstance(row, dict):
            continue
        for spu_id in row.get("spu_ids") or []:
            scans_by_spu.setdefault(text(spu_id), []).append(row)

    candidates: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    for product in details:
        if not isinstance(product, dict):
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = text(product.get("spu_id") or detail.get("spuId"))
        issue = issues.get(spu_id, "")
        if not BARCODE_ISSUE_RE.search(issue):
            continue
        sku_plans: list[dict[str, Any]] = []
        blocked_reason = ""
        scan_rows = scans_by_spu.get(spu_id) or []
        successful_scans = [row for row in scan_rows if row.get("ok")]
        decoded = sorted(
            {
                text(barcode.get("value"))
                for row in successful_scans
                for barcode in row.get("barcodes") or []
                if isinstance(barcode, dict) and gtin_valid(text(barcode.get("value")))
            }
        )
        if decoded:
            blocked_reason = f"same_spu_scan_found_valid_gtin:{','.join(decoded)}"
        elif len(successful_scans) < 3:
            blocked_reason = f"same_spu_scan_count_below_3:{len(successful_scans)}"
        else:
            for sku in detail.get("skus") or []:
                if not isinstance(sku, dict):
                    continue
                sku_id = text(sku.get("skuId"))
                current = [text(value) for value in sku.get("upcList") or [] if text(value)]
                if int(sku.get("customizeNoUpcCode") or 0) == 1:
                    continue
                if not current:
                    blocked_reason = "sku_upc_empty_but_no_upc_flag_not_set"
                    break
                if any(gtin_valid(value) for value in current):
                    blocked_reason = "current_sku_contains_valid_gtin"
                    break
                sku_plans.append(
                    {
                        "sku_id": sku_id,
                        "expected_old_upc_list": current,
                        "scanned_image_count": len(successful_scans),
                        "source": "user_authorized_no_upc_fallback_after_same_spu_scan",
                        "evidence": (
                            f"平台审核明示条码不合法；同SPU {len(successful_scans)} 张图片已完成"
                            "ZXing全图扫描且未发现校验位有效GTIN；当前值不符合GTIN规则；"
                            "按用户明确授权选择平台原生“此商品没有条形码”。"
                        ),
                    }
                )
        if blocked_reason or not sku_plans:
            blocked.append(
                {
                    "spu_id": spu_id,
                    "title": text(product.get("title") or detail.get("spuName")),
                    "status": "blocked",
                    "reason": blocked_reason or "no_sku_change",
                }
            )
            continue
        candidates.append(
            {
                "spu_id": spu_id,
                "title": text(product.get("title") or detail.get("spuName")),
                "sku_no_upc_fields": sku_plans,
            }
        )

    offset = max(0, int(args.offset))
    selected = candidates[offset : offset + args.limit if args.limit > 0 else None]
    rows: list[dict[str, Any]] = []
    for candidate in selected:
        spu_id = candidate["spu_id"]
        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "update_profile": "tenant_edit_v424",
            "sku_no_upc_fields": candidate["sku_no_upc_fields"],
            "audit_decisions": [
                {
                    "field": "SKU条码",
                    "status": "accepted",
                    "source": "user_authorized_no_upc_fallback_after_same_spu_scan",
                    "evidence": (
                        "审核明示非法条码；同SPU图片全量扫码未发现有效GTIN；"
                        "使用平台原生无条码选项，不生成或猜测GTIN。"
                    ),
                }
            ],
        }
        plan_path = output_dir / f"{spu_id}.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(plan_path, 0o600)
        rows.append(
            {
                "spu_id": spu_id,
                "title": candidate["title"],
                "status": "ready",
                "plan_path": str(plan_path),
            }
        )
    rows.extend(blocked)
    index_path = output_dir / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "details_path": str(details_path),
                "manifest_path": str(manifest_path),
                "barcode_scan_path": str(scan_path),
                "candidate_total": len(candidates),
                "selected_offset": offset,
                "selected_total": len(selected),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.chmod(index_path, 0o600)
    print(
        json.dumps(
            {
                "ok": True,
                "index": str(index_path),
                "candidate_total": len(candidates),
                "selected_total": len(selected),
                "blocked_total": len(blocked),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
