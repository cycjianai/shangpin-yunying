#!/usr/bin/env python3
"""Build audited QNH store-category plans from a frozen detail snapshot and query receipt."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--query-receipt", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--category-name", default="未分类1")
    parser.add_argument("--label", default="store-category")
    return parser.parse_args()


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    receipt_path = Path(args.query_receipt).resolve()
    run_dir = Path(args.run_dir).resolve()
    if not args.label or any(not (char.isalnum() or char == "-") for char in args.label):
        raise SystemExit("label 只能包含字母、数字和连字符")

    details = json.loads(details_path.read_text(encoding="utf-8"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    matches = [
        row
        for row in as_list(receipt.get("categories"))
        if isinstance(row, dict)
        and str(row.get("name") or "") == args.category_name
        and str(row.get("name_path") or "") == args.category_name
        and int(row.get("enable") or 0) == 1
        and row.get("is_leaf") is True
    ]
    if len(matches) != 1:
        raise SystemExit(f"店内分类精确候选不存在或不唯一：{args.category_name}/{len(matches)}")
    category = matches[0]

    plans_dir = run_dir / f"plans-{args.label}"
    plans_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(plans_dir, 0o700)
    rows: list[dict[str, Any]] = []
    for product in as_list(details.get("products")):
        if not isinstance(product, dict):
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        store_codes = [
            str(code)
            for group in as_list(detail.get("storeFrontCategoryList"))
            if isinstance(group, dict)
            for code in as_list(group.get("allCategoryCodeList"))
            if str(code)
        ]
        jd_channel = next(
            (
                channel
                for channel in as_list(detail.get("spuChannelInfoList"))
                if isinstance(channel, dict)
                and int(channel.get("channelId") or 0) == 300
                and str(channel.get("categoryCode") or "")
            ),
            None,
        )
        if store_codes or not jd_channel:
            continue
        spu_id = str(detail.get("spuId") or product.get("spu_id") or "")
        title = str(detail.get("spuName") or product.get("title") or "")
        required_pictures = [
            picture
            for picture in as_list(detail.get("mtSpecialPictureList"))
            if isinstance(picture, dict)
            and int(picture.get("isRequired") or 0) == 1
            and picture.get("deleted") is not True
        ]
        all_required_pictures_filled = bool(required_pictures) and all(
            len([url for url in as_list(picture.get("pictureUrl")) if str(url)])
            >= max(1, int(picture.get("numMin") or 1))
            for picture in required_pictures
        )
        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "update_profile": "tenant_edit_v424",
            "store_front_category_field": {
                "category_code": str(category.get("category_code") or ""),
                "name": str(category.get("name") or ""),
                "name_path": str(category.get("name_path") or ""),
                "expected_old_category_codes": [],
                "query_receipt_path": str(receipt_path),
                "evidence": (
                    "用户允许店内分类任选；固定选择当前账号查询回执中的"
                    f"启用叶子分类“{args.category_name}”。"
                ),
            },
            "mirror_existing_special_pictures": all_required_pictures_filled,
            "audit_decisions": [
                {
                    "field": "店内分类",
                    "status": "accepted",
                    "source": "qnh_current_account_store_category_exact_query",
                    "new_value": category,
                }
            ],
        }
        plan_path = plans_dir / f"{spu_id}.json"
        plan_path.write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(plan_path, 0o600)
        rows.append(
            {
                "spu_id": spu_id,
                "title": title,
                "status": "ready",
                "plan_path": str(plan_path),
                "mirrored_special_pictures": all_required_pictures_filled,
            }
        )

    index_path = plans_dir / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "generated_from": str(details_path),
                "query_receipt": str(receipt_path),
                "category": category,
                "selected_total": len(rows),
                "ready_count": len(rows),
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
            {"ok": True, "indexPath": str(index_path), "ready": len(rows)},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
