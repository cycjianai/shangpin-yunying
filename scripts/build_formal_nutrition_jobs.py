#!/usr/bin/env python3
"""Build one-time paid nutrition-picture jobs from current QNH audit evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


FORMAL_PROMPT = """为商品“{title}”生成一张用于美团审核的配料与营养成分图。
必须清晰展示：配料表、营养成分表、条码。
要求：
1. 画面正向、文字清晰可识别，不能模糊、反光、过曝或带水印。
2. 使用真实包装/标签表达，不添加营销文案、赠品或标题未提及的内容。
3. 背景干净，不要促销元素，不要夸张修饰。
4. 所有关键信息必须完整落在画面内，适合平台审核查看。"""

FORMAL_INGREDIENT_PROMPT = """为商品“{title}”生成一张用于美团审核的配料图。
必须清晰展示：配料表、条码。
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
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument(
        "--allow-gtin-fallback",
        action="store_true",
        help="允许多 SKU、缺失或无效 GTIN 进入正式提示词链路；必须配合写入审计中的用户兜底授权。",
    )
    parser.add_argument(
        "--include-ingredient-only",
        action="store_true",
        help="同时选择审核仅明确缺少配料图/配料表的商品，并使用配料图正式模板。",
    )
    return parser.parse_args()


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def gtin_valid(value: str) -> bool:
    if not value.isdigit() or len(value) not in {8, 12, 13, 14}:
        return False
    digits = [int(char) for char in value]
    body = digits[:-1]
    total = sum(
        digit * (3 if (len(body) - index) % 2 == 1 else 1)
        for index, digit in enumerate(body)
    )
    return (10 - total % 10) % 10 == digits[-1]


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


def special_slot(detail: dict[str, Any]) -> dict[str, Any] | None:
    for item in detail.get("mtSpecialPictureList") or []:
        if isinstance(item, dict) and int(item.get("pictureType") or 0) == 5:
            return item
    return None


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    receipt_root = Path(args.receipt_root).resolve()
    output_path = Path(args.output).resolve()
    selection_path = Path(args.selection_output).resolve() if args.selection_output else output_path.with_name(
        f"{output_path.stem}-selection.json"
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
        status = "selected"
        reason = ""
        gtin = ""

        full_nutrition_issue = (
            "营养成分图" in current_audit
            and ("缺少配料" in current_audit or "【配料表】" in current_audit)
            and "缺失" in current_audit
        )
        ingredient_only_issue = (
            args.include_ingredient_only
            and "配料图" in current_audit
            and "【配料表】" in current_audit
            and "缺失" in current_audit
            and "【营养成分图】" not in current_audit
        )
        if not (full_nutrition_issue or ingredient_only_issue):
            status, reason = "skipped", "audit_not_explicitly_missing_nutrition_and_ingredients"
        skus = detail.get("skus") if isinstance(detail.get("skus"), list) else []
        if status == "selected":
            if len(skus) == 1 and isinstance(skus[0], dict):
                upcs = [text(item) for item in (skus[0].get("upcList") or []) if text(item)]
                if len(upcs) == 1 and gtin_valid(upcs[0]):
                    gtin = upcs[0]
                elif not args.allow_gtin_fallback:
                    status, reason = "skipped", "missing_or_invalid_unique_gtin"
            elif not args.allow_gtin_fallback:
                status, reason = "skipped", "not_single_sku"
        if status == "selected" and (spu_id, "5") in paid_keys:
            status, reason = "skipped", "provider_task_already_accepted"
        main_urls = [text(url) for url in (detail.get("picUrlList") or []) if text(url)]
        if status == "selected" and not main_urls:
            status, reason = "skipped", "missing_reference_image"

        slot = special_slot(detail)
        picture_title = text((slot or {}).get("pictureTitle")) or "配料&营养成分图"
        current_urls = [
            text(url)
            for url in ((slot or {}).get("pictureUrl") or [])
            if text(url)
        ]
        row = {
            "spu_id": spu_id,
            "title": title,
            "status": status,
            "reason": reason,
            "gtin": gtin,
            "picture_title": picture_title,
            "current_picture_urls": current_urls,
        }
        if status != "selected" or len(jobs) >= max(0, int(args.limit)):
            if status == "selected":
                row["status"] = "deferred_limit"
                row["reason"] = "batch_limit"
            rows.append(row)
            continue

        expected_tokens = ["配料表"] if ingredient_only_issue else ["配料表", "营养成分表"]
        if gtin:
            expected_tokens.append(gtin)
        issue_evidence = (
            "牵牛花当前审核原文明示配料表缺失；"
            if ingredient_only_issue
            else "牵牛花当前审核原文明示配料表与营养成分图缺失；"
        )
        evidence = (
            issue_evidence
            + f"唯一SKU的GTIN {gtin} 校验位有效；复用项目qnh_asset_remediation正式提示词。"
            if gtin
            else
            issue_evidence
            + "当前商品没有可精确采用的唯一有效主档GTIN；"
            + "依据用户明确授权进入兜底条码链路；复用项目qnh_asset_remediation正式提示词。"
        )
        jobs.append(
            {
                "tenant_scope": text(args.tenant_scope),
                "spu_id": spu_id,
                "picture_type": "5",
                "picture_title": picture_title,
                "prompt": (
                    FORMAL_INGREDIENT_PROMPT if ingredient_only_issue else FORMAL_PROMPT
                ).format(title=title),
                "reference_image_url": main_urls[0],
                "evidence": evidence,
                "expected_text_tokens": expected_tokens,
                "expected_gtin": gtin,
                "expected_old_urls": current_urls,
            }
        )
        rows.append(row)

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
