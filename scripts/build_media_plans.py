#!/usr/bin/env python3
"""Build conservative same-product image reuse plans for QNH direct CDP writes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--media-evidence")
    parser.add_argument("--reviewed-allowlist")
    return parser.parse_args()


def normalize_url(value: Any) -> str:
    url = str(value or "").strip()
    return "https://" + url.removeprefix("http://") if url.startswith("http://") else url


def unique_urls(values: list[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if isinstance(raw, dict):
            raw = raw.get("url") or raw.get("pictureUrl") or raw.get("picUrl") or ""
        url = str(raw or "").strip()
        key = normalize_url(url)
        if not url or key in seen:
            continue
        seen.add(key)
        result.append(url)
    return result


def main() -> None:
    options = args()
    details_path = Path(options.details).resolve()
    output_dir = Path(options.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    products = json.loads(details_path.read_text(encoding="utf-8")).get("products") or []

    evidence_by_spu: dict[str, dict[str, Any]] = {}
    if options.media_evidence:
        evidence = json.loads(Path(options.media_evidence).resolve().read_text(encoding="utf-8"))
        evidence_by_spu = {
            str(row.get("spu_id") or ""): row for row in evidence.get("products") or []
        }
    reviewed: set[tuple[str, int, str]] = set()
    if options.reviewed_allowlist:
        allowlist = json.loads(
            Path(options.reviewed_allowlist).resolve().read_text(encoding="utf-8")
        )
        reviewed = {
            (
                str(row.get("spu_id") or ""),
                int(row.get("picture_type") or 0),
                normalize_url(row.get("url")),
            )
            for row in allowlist.get("approved") or []
            if isinstance(row, dict)
        }

    rows: list[dict[str, Any]] = []
    for product in products:
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = str(product.get("spu_id") or detail.get("spuId") or "")
        title = str(product.get("title") or detail.get("spuName") or "")
        raw_text = json.dumps(product, ensure_ascii=False)
        main_images = unique_urls(detail.get("picUrlList") or [])
        detail_images = unique_urls(detail.get("picContentList") or [])
        combined = unique_urls([*main_images, *detail_images])
        main_reuse: list[str] = []
        detail_reuse: list[str] = []
        decisions: list[dict[str, Any]] = []

        missing_main_issue = (
            "商品图片少于3张" in raw_text or "商品图片不足3张" in raw_text
        )
        if missing_main_issue and len(main_images) < 3 and len(combined) >= 3:
            for url in combined:
                if normalize_url(url) in {normalize_url(item) for item in main_images}:
                    continue
                main_reuse.append(url)
                if len(main_images) + len(main_reuse) >= 3:
                    break
            if main_reuse:
                decisions.append(
                    {
                        "field": "商品主图",
                        "old_value": main_images,
                        "new_value": [*main_images, *main_reuse],
                        "status": "accepted",
                        "source": "same_product_existing_detail_image",
                        "evidence": "平台明确提示商品图片少于3张；仅复用当前SPU已有详情图补足3张",
                    }
                )

        missing_detail_issue = "缺少图片详情" in raw_text
        if missing_detail_issue and not detail_images and main_images:
            detail_reuse = main_images[:5]
            decisions.append(
                {
                    "field": "商品详情图",
                    "old_value": [],
                    "new_value": detail_reuse,
                    "status": "accepted",
                    "source": "same_product_existing_main_image",
                    "evidence": "平台明确提示缺少图片详情；仅复用当前SPU已有主图，不跨商品、不生成图片",
                }
            )

        special_reuse: list[dict[str, Any]] = []
        evidence_row = evidence_by_spu.get(spu_id) or {}
        for requirement in evidence_row.get("requirements") or []:
            candidates = requirement.get("accepted_candidates") or []
            picture_type = int(requirement.get("pictureType") or 0)
            candidate = next(
                (
                    item
                    for item in candidates
                    if (
                        spu_id,
                        picture_type,
                        normalize_url(item.get("url")),
                    )
                    in reviewed
                ),
                None,
            )
            if not candidate:
                continue
            url = str(candidate.get("url") or "")
            if normalize_url(url) not in {normalize_url(item) for item in combined}:
                continue
            picture_title = str(requirement.get("pictureTitle") or "")
            special_reuse.append(
                {
                    "picture_type": picture_type,
                    "picture_title": picture_title,
                    "url": url,
                }
            )
            decisions.append(
                {
                    "field": f"资质图:{picture_title}",
                    "old_value": [],
                    "new_value": [url],
                    "status": "accepted",
                    "source": "same_product_existing_image_strict_ocr",
                    "evidence": ",".join(candidate.get("reasons") or []),
                }
            )

        if not main_reuse and not detail_reuse and not special_reuse:
            rows.append(
                {
                    "spu_id": spu_id,
                    "title": title,
                    "status": "no_safe_media_change",
                }
            )
            continue

        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "use_all_official_recommendations": False,
            "text_fields": {},
            "select_fields": {},
            "replace_select_fields": [],
            "select_context_fields": [],
            "cascader_fields": [],
            "sale_attribute_replacements": [],
            "sku_upc_fields": [],
            "main_image_reuse_urls": main_reuse,
            "detail_image_reuse_urls": detail_reuse,
            "special_picture_reuse": special_reuse,
            "audit_decisions": decisions,
        }
        plan_path = output_dir / f"{spu_id}.json"
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
                "decisions": decisions,
            }
        )

    index = {
        "details_path": str(details_path),
        "media_evidence_path": str(Path(options.media_evidence).resolve())
        if options.media_evidence
        else "",
        "reviewed_allowlist_path": str(Path(options.reviewed_allowlist).resolve())
        if options.reviewed_allowlist
        else "",
        "total": len(rows),
        "ready_count": sum(1 for row in rows if row["status"] == "ready"),
        "rows": rows,
    }
    index_path = output_dir / "index.json"
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(index_path, 0o600)
    print(
        json.dumps(
            {
                "ok": True,
                "index_path": str(index_path),
                "ready_count": index["ready_count"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
