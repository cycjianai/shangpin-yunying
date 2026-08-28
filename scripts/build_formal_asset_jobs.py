#!/usr/bin/env python3
"""Build one-time paid QNH asset jobs from current audit text and live upload slots."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from qualification_image_policy import load_qualification_image_policy

QUALIFICATION_IMAGE_POLICY = load_qualification_image_policy()
ASSET_POLICIES: dict[str, dict[str, Any]] = QUALIFICATION_IMAGE_POLICY["asset_builders"][
    "formal_assets"
]
DEFAULT_BATCH_LIMIT = int(QUALIFICATION_IMAGE_POLICY["generation"]["default_batch_limit"])
PROMPT = str(QUALIFICATION_IMAGE_POLICY["asset_builders"]["formal_asset_prompt_template"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--receipt-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--selection-output")
    parser.add_argument("--tenant-scope", required=True)
    parser.add_argument("--asset-type", choices=sorted(ASSET_POLICIES), required=True)
    parser.add_argument("--limit", type=int, default=DEFAULT_BATCH_LIMIT)
    return parser.parse_args()


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def audit_text(detail: dict[str, Any]) -> str:
    messages: list[str] = []
    for channel in detail.get("noSaleChannelInfoList") or []:
        if not isinstance(channel, dict):
            continue
        for issue in channel.get("noSaleAbnormalInfoList") or []:
            if isinstance(issue, dict):
                messages.append(text(issue.get("abnormalInfo")))
    return " | ".join(message for message in messages if message)


def prior_paid_keys(receipt_root: Path) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for path in receipt_root.glob("**/receipts/*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(payload, dict) or not text(payload.get("provider_task_id")):
            continue
        spu_id = text(payload.get("spu_id"))
        picture_type = text(payload.get("picture_type"))
        if spu_id and picture_type:
            keys.add((spu_id, picture_type))
    return keys


def resolve_slot(detail: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    slots = [item for item in (detail.get("mtSpecialPictureList") or []) if isinstance(item, dict)]
    for slot in slots:
        title = text(slot.get("pictureTitle"))
        if any(token in title for token in policy["slot_tokens"]):
            return slot
    return {
        "pictureType": int(policy["default_type"]),
        "pictureTitle": str(policy["label"]),
        "pictureUrl": [],
    }


def main() -> None:
    args = parse_args()
    policy = ASSET_POLICIES[args.asset_type]
    details_path = Path(args.details).resolve()
    receipt_root = Path(args.receipt_root).resolve()
    output_path = Path(args.output).resolve()
    selection_path = (
        Path(args.selection_output).resolve()
        if args.selection_output
        else output_path.with_name(f"{output_path.stem}-selection.json")
    )
    payload = json.loads(details_path.read_text(encoding="utf-8"))
    products = payload.get("products") if isinstance(payload, dict) else []
    paid_keys = prior_paid_keys(receipt_root)
    jobs: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []

    for product in products if isinstance(products, list) else []:
        if not isinstance(product, dict):
            continue
        spu_id = text(product.get("spu_id"))
        title = text(product.get("title"))
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        current_audit = audit_text(detail)
        status, reason = "selected", ""
        if not any(token in current_audit for token in policy["audit_tokens"]):
            status, reason = "skipped", "audit_not_matching_asset"
        elif any(token in current_audit for token in policy["exclude_tokens"]):
            status, reason = "skipped", "regulated_asset_excluded"
        slot = resolve_slot(detail, policy)
        picture_type = int(slot.get("pictureType") or policy["default_type"])
        picture_title = text(slot.get("pictureTitle")) or str(policy["label"])
        current_urls = [text(url) for url in (slot.get("pictureUrl") or []) if text(url)]
        if status == "selected" and (spu_id, str(picture_type)) in paid_keys:
            status, reason = "skipped", "provider_task_already_accepted"
        main_urls = [text(url) for url in (detail.get("picUrlList") or []) if text(url)]
        if status == "selected" and not main_urls:
            status, reason = "skipped", "missing_reference_image"
        row = {
            "spu_id": spu_id,
            "title": title,
            "status": status,
            "reason": reason,
            "asset_type": args.asset_type,
            "picture_type": picture_type,
            "picture_title": picture_title,
            "current_picture_urls": current_urls,
        }
        if status != "selected" or len(jobs) >= max(0, int(args.limit)):
            if status == "selected":
                row["status"] = "deferred_limit"
                row["reason"] = "batch_limit"
            rows.append(row)
            continue
        required_fields = [str(item) for item in policy["required_fields"]]
        jobs.append(
            {
                "tenant_scope": text(args.tenant_scope),
                "spu_id": spu_id,
                "picture_type": str(picture_type),
                "picture_title": picture_title,
                "prompt": PROMPT.format(
                    title=title,
                    label=policy["label"],
                    required_fields="、".join(required_fields),
                ),
                "reference_image_url": main_urls[0],
                "evidence": (
                    f"牵牛花当前审核原文明示缺少{policy['label']}；"
                    f"上传槽位来自当前商品详情pictureType={picture_type}；"
                    "复用项目qnh_asset_remediation正式提示词结构。"
                ),
                "expected_text_tokens": required_fields,
                "expected_old_urls": current_urls,
            }
        )
        rows.append(row)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({"jobs": jobs}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    selection_path.write_text(
        json.dumps(
            {
                "details_path": str(details_path),
                "receipt_root": str(receipt_root),
                "asset_type": args.asset_type,
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
                "asset_type": args.asset_type,
                "selected_count": len(jobs),
                "output": str(output_path),
                "selection_output": str(selection_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
