#!/usr/bin/env python3
"""Build same-SPU detail-image refresh plans for explicit QNH missing-detail audits."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--limit", type=int, default=10)
    return parser.parse_args()


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def audit_text(detail: dict[str, Any]) -> str:
    return " | ".join(
        text(issue.get("abnormalInfo"))
        for channel in detail.get("noSaleChannelInfoList") or []
        if isinstance(channel, dict)
        for issue in channel.get("noSaleAbnormalInfoList") or []
        if isinstance(issue, dict) and text(issue.get("abnormalInfo"))
    )


def normalized(url: str) -> str:
    return url.replace("http://", "https://").split("?", 1)[0]


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = json.loads(details_path.read_text(encoding="utf-8"))
    rows: list[dict[str, Any]] = []
    ready = 0
    for product in payload.get("products") or []:
        if not isinstance(product, dict):
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = text(product.get("spu_id") or detail.get("spuId"))
        title = text(product.get("title") or detail.get("spuName"))
        status, reason = "blocked", ""
        selected_url = ""
        if "缺少图片详情" not in audit_text(detail):
            reason = "audit_not_missing_detail"
        else:
            main_urls = [text(url) for url in (detail.get("picUrlList") or []) if text(url)]
            detail_urls = [text(url) for url in (detail.get("picContentList") or []) if text(url)]
            existing = {normalized(url) for url in detail_urls}
            selected_url = next((url for url in main_urls if normalized(url) not in existing), "")
            if not selected_url:
                reason = "no_unused_same_spu_main_image"
            elif ready >= max(0, int(args.limit)):
                status, reason = "deferred", "batch_limit"
            else:
                status = "ready"
                ready += 1
                plan_path = output_dir / f"{spu_id}.json"
                plan_path.write_text(
                    json.dumps(
                        {
                            "spu_id": spu_id,
                            "activity_conflict_policy": "update_product",
                            "coverage_scope": "all_stores",
                            "detail_image_reuse_urls": [selected_url],
                            "audit_decisions": [
                                {
                                    "field": "商品详情图",
                                    "status": "accepted",
                                    "source": "same_spu_existing_main_image_refresh",
                                    "evidence": (
                                        "平台当前审核明确提示缺少图片详情；"
                                        "详情顶层已有图片但审核未消费，新增复用一张当前SPU现有主图，"
                                        "触发全部门店图片覆盖刷新；不跨SPU、不生成图片。"
                                    ),
                                }
                            ],
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                )
        rows.append(
            {
                "spu_id": spu_id,
                "title": title,
                "status": status,
                "reason": reason,
                "selected_url": selected_url,
                "plan_path": str(output_dir / f"{spu_id}.json") if status == "ready" else "",
            }
        )
    index_path = output_dir / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    print(json.dumps({"ok": True, "index": str(index_path), "status_counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
