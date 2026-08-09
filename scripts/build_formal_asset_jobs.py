#!/usr/bin/env python3
"""Build one-time paid QNH asset jobs from current audit text and live upload slots."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ASSET_POLICIES: dict[str, dict[str, Any]] = {
    "back_label": {
        "audit_tokens": ("缺少背签图",),
        "exclude_tokens": ("化妆品备案",),
        "slot_tokens": ("背签",),
        "default_type": 8,
        "label": "背签图",
        "required_fields": ["执行标准号", "生产企业信息", "主要原材料或背签信息"],
    },
    "package_label": {
        "audit_tokens": ("缺少包装标签图",),
        "exclude_tokens": (),
        "slot_tokens": ("包装标签",),
        "default_type": 3,
        "label": "包装标签图",
        "required_fields": ["包装标签", "关键说明文字", "规格或条码"],
    },
    "textile_label": {
        "audit_tokens": ("吊牌", "洗唛"),
        "exclude_tokens": (),
        "slot_tokens": ("吊牌", "洗唛"),
        "default_type": 7,
        "label": "吊牌洗唛图",
        "required_fields": ["执行标准号", "安全类别", "面料成分含量", "面料成分"],
    },
    "size_picture": {
        "audit_tokens": ("缺少尺寸图",),
        "exclude_tokens": (),
        "slot_tokens": ("尺寸图",),
        "default_type": 13,
        "label": "尺寸图",
        "required_fields": ["商品主体", "完整尺寸标注", "尺寸单位", "型号或规格"],
    },
}

PROMPT = """为商品“{title}”生成一张用于美团审核的{label}。
必须清晰展示：{required_fields}。
要求：
1. 画面正向、文字清晰可识别，不能模糊、反光、过曝或带水印。
2. 使用真实包装/标签表达，不添加营销文案、赠品或标题未提及的内容。
3. 背景干净，不要促销元素，不要夸张修饰。
4. 所有关键信息必须完整落在画面内，适合平台审核查看。"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--receipt-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--selection-output")
    parser.add_argument("--tenant-scope", required=True)
    parser.add_argument("--asset-type", choices=sorted(ASSET_POLICIES), required=True)
    parser.add_argument("--limit", type=int, default=50)
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
