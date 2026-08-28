#!/usr/bin/env python3
"""Build idempotent non-regulated QNH guide-image jobs from current live slots."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


SAFE_GUIDE_TYPES = {
    22: ("selection_guide", ["选购", "参数"]),
    23: ("usage_guide", ["使用", "说明"]),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--receipt-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--selection-output", required=True)
    parser.add_argument("--tenant-scope", required=True)
    parser.add_argument("--limit", type=int, default=50)
    return parser.parse_args()


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def accepted_keys(receipt_root: Path) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for path in receipt_root.glob("**/receipts/*.json"):
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(receipt, dict) or not text(receipt.get("provider_task_id")):
            continue
        spu_id = text(receipt.get("spu_id"))
        picture_type = text(receipt.get("picture_type"))
        if spu_id and picture_type:
            keys.add((spu_id, picture_type))
    return keys


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    receipt_root = Path(args.receipt_root).resolve()
    output_path = Path(args.output).resolve()
    selection_path = Path(args.selection_output).resolve()
    payload = json.loads(details_path.read_text(encoding="utf-8"))
    products = payload.get("products") if isinstance(payload, dict) else []
    prior_keys = accepted_keys(receipt_root)
    jobs: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []

    for product in products if isinstance(products, list) else []:
        if not isinstance(product, dict):
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = text(detail.get("spuId") or product.get("spu_id"))
        title = text(detail.get("spuName") or product.get("title"))
        main_urls = [text(url) for url in detail.get("picUrlList") or [] if text(url)]
        for slot in detail.get("mtSpecialPictureList") or []:
            if not isinstance(slot, dict):
                continue
            picture_type = int(slot.get("pictureType") or 0)
            if picture_type not in SAFE_GUIDE_TYPES:
                continue
            current_urls = [text(url) for url in slot.get("pictureUrl") or [] if text(url)]
            if int(slot.get("numMin") or 0) <= 0 or current_urls:
                continue
            picture_title = text(slot.get("pictureTitle"))
            picture_desc = text(slot.get("pictureDesc"))
            status, reason = "selected", ""
            if (spu_id, str(picture_type)) in prior_keys:
                status, reason = "skipped", "provider_task_already_accepted"
            elif not main_urls:
                status, reason = "skipped", "missing_reference_image"
            elif len(jobs) >= max(0, int(args.limit)):
                status, reason = "deferred_limit", "batch_limit"
            row = {
                "spu_id": spu_id,
                "title": title,
                "picture_type": picture_type,
                "picture_title": picture_title,
                "status": status,
                "reason": reason,
            }
            rows.append(row)
            if status != "selected":
                continue
            requirement_key, expected_tokens = SAFE_GUIDE_TYPES[picture_type]
            jobs.append(
                {
                    "tenant_scope": text(args.tenant_scope),
                    "spu_id": spu_id,
                    "picture_type": str(picture_type),
                    "picture_title": picture_title,
                    "picture_desc": picture_desc,
                    "requirement_key": requirement_key,
                    "prompt": f"商品名称：{title}\n{picture_desc or picture_title}",
                    "reference_image_url": main_urls[0],
                    "evidence": (
                        f"当前 QNH 详情要求 pictureType={picture_type} 的“{picture_title}”；"
                        "提示词逐字复用项目 qnh_goods_autofill 的非专项 fallback 合同。"
                    ),
                    "expected_text_tokens": expected_tokens,
                    "expected_old_urls": [],
                }
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps({"jobs": jobs}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    selection_path.write_text(
        json.dumps(
            {
                "details_path": str(details_path),
                "receipt_root": str(receipt_root),
                "selected_count": len(jobs),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": True,
                "selected_count": len(jobs),
                "output": str(output_path),
                "selection_output": str(selection_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
