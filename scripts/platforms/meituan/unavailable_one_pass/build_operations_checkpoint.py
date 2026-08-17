#!/usr/bin/env python3
"""Build a platform-neutral Meituan operations checkpoint from auditable run artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def issue_text(issue: dict) -> str:
    return "：".join(filter(None, [str(issue.get("field_name") or ""), str(issue.get("comment") or "")]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--execution", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--field-plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rescan-manifest")
    args = parser.parse_args()
    manifest, execution, evidence, field_plan = map(load, (args.manifest, args.execution, args.evidence, args.field_plan))
    rescan_ids = None
    if args.rescan_manifest and Path(args.rescan_manifest).is_file():
        rescan_ids = {str(row["spu_id"]) for row in load(args.rescan_manifest).get("products", [])}
    executed = execution.get("items", {})
    field_by_id = {str(row["spu_id"]): row for row in field_plan.get("items", [])}
    evidence_by_id: dict[str, list[dict]] = {}
    for row in evidence.get("jobs", []):
        evidence_by_id.setdefault(str(row["spu_id"]), []).append(row)
    items = {}
    for product in manifest.get("products", []):
        spu_id = str(product["spu_id"])
        result = executed.get(spu_id, {})
        changes = result.get("successful_changes", [])
        changed_fields = {str(change.get("field") or "") for change in changes}
        blockers = []
        for event in result.get("events", []):
            if event.get("ok"):
                continue
            status = str(event.get("status") or "")
            if status == "validation_blocked_before_save":
                blockers.append("美团官方字段校验未通过，未发送最终保存")
            elif status == "activity_protected_before_save":
                blockers.append("修改会使商品退出当前活动，保护门已阻止保存")
            elif status:
                blockers.append(f"执行阻塞：{status}")
        field_item = field_by_id.get(spu_id)
        if field_item and not field_item.get("plan"):
            blockers.extend(field_item.get("blocked") or [])
        evidence_jobs = evidence_by_id.get(spu_id, [])
        for job in evidence_jobs:
            if not job.get("matched") and f"专项图:{job.get('img_type')}" not in changed_fields:
                blockers.append(f"缺少可核验的同商品原图：专项图类型{job.get('img_type')}")
        for issue in product.get("issues", []):
            field = str(issue.get("field_name") or "")
            comment = str(issue.get("comment") or "")
            addressed = field in changed_fields
            if field == "商品图片":
                explicit = int(issue.get("qua_pic_type") or 0)
                addressed = explicit > 0 and f"专项图:{explicit}" in changed_fields
                if explicit == 0 and evidence_jobs:
                    addressed = any(f"专项图:{job.get('img_type')}" in changed_fields for job in evidence_jobs)
            if field == "条形码" and "条形码" in changed_fields:
                addressed = True
            if field == "图片详情" and "图片详情" in changed_fields:
                addressed = True
            if not addressed and field not in {"商品图片"}:
                if field == "条形码" and "与实际商品不符" in comment and "不合法" not in comment:
                    blockers.append("需要商品真实正确条码，不能用清空代替")
                elif field == "商品类目":
                    blockers.append("商品类目修改需按官方建议人工确认")
                elif field not in {""}:
                    blockers.append(f"未安全解决：{issue_text(issue)}")
        blockers = list(dict.fromkeys(str(value) for value in blockers if str(value).strip()))
        still_in_scope = None if rescan_ids is None else spu_id in rescan_ids
        if blockers and changes:
            state = "readback_verified_with_blockers"
        elif blockers:
            state = "blocked_manual_or_real_evidence"
        elif changes:
            state = "readback_verified_waiting_review" if still_in_scope is not False else "exited_target_set"
        else:
            state = "classified_no_safe_automatic_action"
        items[spu_id] = {
            "spu_id": spu_id,
            "name": product.get("name", ""),
            "issues": product.get("issues", []),
            "changes": changes,
            "events": result.get("events", []),
            "blockers": blockers,
            "state": state,
            "still_in_target_set": still_in_scope,
        }
    values = list(items.values())
    summary = {
        "platform_record_count": manifest.get("platform_record_count"),
        "unique_spu_count": manifest.get("unique_spu_count"),
        "duplicate_record_count": manifest.get("duplicate_record_count"),
        "modified_unique_spu": sum(bool(row["changes"]) for row in values),
        "with_blockers": sum(bool(row["blockers"]) for row in values),
        "readback_verified_without_known_blocker": sum(bool(row["changes"]) and not row["blockers"] for row in values),
        "rescan_stable": rescan_ids is not None,
        "report_ready": len(items) == int(manifest.get("unique_spu_count") or 0),
        "completion_ready": rescan_ids is not None and not rescan_ids and not any(row["blockers"] for row in values),
    }
    output = {"schema": "meituan-operations-checkpoint-v1", "summary": summary, "items": items}
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
