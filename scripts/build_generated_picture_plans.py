#!/usr/bin/env python3
"""Bind generated artifacts to upload receipts and produce fail-closed QNH save plans."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--upload-receipt-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--barcode-validation")
    parser.add_argument("--allow-barcode-fallback", action="store_true")
    parser.add_argument("--visual-validation")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def main() -> None:
    args = parse_args()
    jobs_payload = read_json(Path(args.jobs).resolve())
    summary = read_json(Path(args.summary).resolve())
    receipt_root = Path(args.upload_receipt_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    barcode_rows: dict[str, dict[str, Any]] = {}
    if args.barcode_validation:
        validation = read_json(Path(args.barcode_validation).resolve())
        barcode_rows = {
            str(row.get("spu_id") or ""): row
            for row in validation.get("rows") or []
            if isinstance(row, dict)
        }
    visual_rows: dict[str, dict[str, Any]] = {}
    if args.visual_validation:
        validation = read_json(Path(args.visual_validation).resolve())
        visual_rows = {
            str(row.get("spu_id") or ""): row
            for row in validation.get("rows") or []
            if isinstance(row, dict)
        }
    jobs = {
        str(job.get("spu_id") or ""): job
        for job in jobs_payload.get("jobs") or []
        if isinstance(job, dict)
    }
    rows: list[dict[str, Any]] = []
    for result in summary.get("results") or []:
        if not isinstance(result, dict):
            continue
        spu_id = str(result.get("spu_id") or "")
        job = jobs.get(spu_id)
        artifact_path = Path(str(result.get("artifact_path") or "")).resolve()
        status = "ready"
        reason = ""
        if not job:
            status, reason = "blocked", "job_missing"
        elif str(result.get("status") or "") != "ready" or not artifact_path.is_file():
            status, reason = "blocked", "artifact_not_ready"
        source_sha256 = ""
        receipt_path = Path()
        upload_receipt: dict[str, Any] = {}
        if status == "ready":
            source_sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
            receipt_path = receipt_root / f"image-upload-{source_sha256}.json"
            if not receipt_path.is_file():
                status, reason = "blocked", "upload_receipt_missing"
            else:
                upload_receipt = read_json(receipt_path)
                if (
                    str(upload_receipt.get("source_sha256") or upload_receipt.get("sourceSha256") or "")
                    != source_sha256
                    or not str(upload_receipt.get("image_url") or upload_receipt.get("imageUrl") or "")
                ):
                    status, reason = "blocked", "upload_receipt_invalid"
        barcode = barcode_rows.get(spu_id) or {}
        barcode_status = str(barcode.get("status") or "not_checked")
        visual = visual_rows.get(spu_id) or {}
        visual_status = str(visual.get("status") or "not_checked")
        visual_evidence = str(visual.get("evidence") or "")
        if status == "ready" and args.visual_validation and visual_status != "accepted":
            status, reason = "blocked", f"visual_{visual_status}"
        if status == "ready" and barcode_status not in {"exact", "not_checked"} and not args.allow_barcode_fallback:
            status, reason = "blocked", f"barcode_{barcode_status}"
        plan_path = output_dir / f"{spu_id}.json"
        if status == "ready" and job:
            image_url = str(upload_receipt.get("image_url") or upload_receipt.get("imageUrl") or "")
            provider_task_id = str(result.get("provider_task_id") or "")
            picture_title = str(job.get("picture_title") or "资质图")
            expected_gtin = str(job.get("expected_gtin") or "")
            fallback_note = (
                "用户明确允许无法精确检索时使用兜底条码值；"
                if int(job.get("picture_type") or 0) == 5 and barcode_status not in {"exact", "not_checked"}
                else ""
            )
            plan = {
                "spu_id": spu_id,
                "activity_conflict_policy": "update_product",
                "coverage_scope": "all_stores",
                "special_picture_uploaded": [
                    {
                        "picture_type": int(job.get("picture_type") or 0),
                        "picture_title": str(job.get("picture_title") or ""),
                        "url": image_url,
                        "upload_receipt_path": str(receipt_path),
                        "expected_old_urls": list(job.get("expected_old_urls") or []),
                        "evidence": (
                            "复用项目qnh_asset_remediation正式提示词；"
                            f"provider_task_id={provider_task_id}；"
                            f"条码机器核验={barcode_status}；"
                            f"目视核验={visual_status}：{visual_evidence}；"
                            f"{fallback_note}"
                            f"任务证据={str(job.get('evidence') or '')}；"
                            "未重复付费生成。"
                        ),
                    }
                ],
                "audit_decisions": [
                    {
                        "field": picture_title,
                        "status": "accepted",
                        "source": "formal_asset_remediation_single_provider_task",
                        "evidence": (
                            f"当前审核明确缺少{picture_title}；provider_task_id={provider_task_id}；"
                            f"expected_gtin={expected_gtin}；barcode_status={barcode_status}；"
                            f"visual_status={visual_status}；visual_evidence={visual_evidence}；"
                            f"任务证据={str(job.get('evidence') or '')}；未重复submit。"
                        ),
                    }
                ],
            }
            plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        rows.append(
            {
                "spu_id": spu_id,
                "status": status,
                "reason": reason,
                "barcode_status": barcode_status,
                "visual_status": visual_status,
                "plan_path": str(plan_path) if status == "ready" else "",
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
        status = str(row["status"])
        counts[status] = counts.get(status, 0) + 1
    print(
        json.dumps(
            {
                "ok": True,
                "index": str(index_path),
                "status_counts": counts,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
