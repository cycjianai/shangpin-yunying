#!/usr/bin/env python3
"""Export one canonical seven-sheet workbook from a platform-neutral payload."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

try:
    from .operations_contract import (
        EMPTY_VALUE,
        NOT_APPLICABLE,
        RESULT_VALUES,
        SCHEMA,
        ContractError,
        identifier,
        integer,
        nonempty_text,
        normalize_event,
        platform_label,
        result_value,
        task_value,
    )
except ImportError:  # Direct script execution keeps scripts/core on sys.path.
    from operations_contract import (
        EMPTY_VALUE,
        NOT_APPLICABLE,
        RESULT_VALUES,
        SCHEMA,
        ContractError,
        identifier,
        integer,
        nonempty_text,
        normalize_event,
        platform_label,
        result_value,
        task_value,
    )


SHEETS = SCHEMA["sheets"]
HEADERS = SCHEMA["headers"]
SUMMARY_METRICS = SCHEMA["summary_metrics"]
VERIFY_METRICS = SCHEMA["verify_metrics"]
PERFORMANCE_METRICS = SCHEMA["performance_metrics"]


def read(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ContractError("payload_must_be_object")
    return payload


def add_header(sheet, values: list[str]) -> None:
    sheet.append(values)
    fill = PatternFill("solid", fgColor="17365D")
    for cell in sheet[1]:
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions


def set_widths(sheet, widths: list[int]) -> None:
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = width
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)


def external_counts(metadata: dict[str, Any]) -> dict[str, int]:
    source = metadata.get("external_calls") or {}
    keys = (
        "ocr", "media_scan", "barcode_scan", "bocha", "web_search", "llm",
        "provider_submit", "provider_query", "image_upload",
    )
    return {key: integer(source.get(key, 0), f"external_calls.{key}") for key in keys}


def normalize_product(raw: dict[str, Any]) -> dict[str, str]:
    return {
        "spu_id": identifier(raw.get("spu_id"), "products.spu_id"),
        "product_name": nonempty_text(raw.get("product_name"), "products.product_name", fallback=NOT_APPLICABLE),
        "before_summary": nonempty_text(raw.get("before_summary"), "products.before_summary"),
        "outcome_summary": nonempty_text(raw.get("outcome_summary"), "products.outcome_summary"),
        "result": result_value(raw.get("result")),
    }


def normalize_missing(raw: dict[str, Any]) -> dict[str, str]:
    return {
        "spu_id": identifier(raw.get("spu_id"), "missing.spu_id"),
        "platform_result": nonempty_text(raw.get("platform_result"), "missing.platform_result"),
        "handling": nonempty_text(raw.get("handling"), "missing.handling"),
    }


def metric_rows(metrics: list[str], values: dict[str, Any]) -> list[list[Any]]:
    missing = [metric for metric in metrics if metric not in values]
    if missing:
        raise ContractError("metric_values_missing:" + ",".join(missing))
    return [[metric, values[metric]] for metric in metrics]


def export(payload: dict[str, Any], output: Path) -> dict[str, Any]:
    metadata = payload.get("metadata") or {}
    platform = platform_label(metadata.get("platform"))
    task = task_value(metadata.get("task_mode"))
    skill_version = nonempty_text(metadata.get("skill_version"), "metadata.skill_version")
    fingerprint = nonempty_text(metadata.get("contract_fingerprint_sha256"), "metadata.contract_fingerprint_sha256")
    store_name = nonempty_text(metadata.get("store_name"), "metadata.store_name")

    products = [normalize_product(item) for item in (payload.get("products") or [])]
    if not products:
        raise ContractError("products_empty")
    product_ids = [item["spu_id"] for item in products]
    if len(product_ids) != len(set(product_ids)):
        raise ContractError("products_spu_duplicate")

    audit_events = [normalize_event(item) for item in (payload.get("audit_events") or [])]
    missing = [normalize_missing(item) for item in (payload.get("missing") or [])]
    missing_ids = [item["spu_id"] for item in missing]
    if len(missing_ids) != len(set(missing_ids)):
        raise ContractError("missing_spu_duplicate")
    if not set(missing_ids).issubset(product_ids):
        raise ContractError("missing_spu_not_in_products")
    if any(item["spu_id"] not in set(product_ids) for item in audit_events):
        raise ContractError("audit_spu_not_in_products")

    product_results = {item["spu_id"]: item["result"] for item in products}
    for spu_id in missing_ids:
        if product_results[spu_id] != "missing_on_platform":
            raise ContractError(f"missing_product_result_mismatch:{spu_id}")

    source_count = len(products)
    missing_count = len(missing)
    extant_count = source_count - missing_count
    complete_states = {"verified_complete", "verified_no_change"}
    readback_pass_states = {
        "verified_complete",
        "verified_no_change",
        "waiting_platform_review",
    }
    complete_count = sum(
        1 for item in products
        if item["spu_id"] not in set(missing_ids) and item["result"] in complete_states
    )
    changed_ids = {
        item["spu_id"]
        for item in audit_events
        if item["result"] in {
            "verified_complete",
            "waiting_platform_review",
            "pending_verify",
            "failed",
        }
    }
    no_change_count = sum(1 for item in products if item["result"] == "verified_no_change")
    readback_pass_items = sum(
        1 for item in audit_events if item["result"] in readback_pass_states
    )
    final_issue_count = extant_count - complete_count
    completion_rate = (complete_count / extant_count) if extant_count else 1.0
    external = external_counts(metadata)

    summary_values = {
        "Excel Schema版本": SCHEMA["schema_version"],
        "Skill版本": skill_version,
        "执行平台": platform,
        "任务类型": task,
        "合同指纹SHA256": fingerprint,
        "门店/租户名称": store_name,
        "源清单商品数": source_count,
        "平台现存商品数": extant_count,
        "平台不存在商品数": missing_count,
        "最终合同通过商品数": complete_count,
        "完成率": f"{completion_rate:.2%}",
        "本次有操作商品数": len(changed_ids),
        "无需修改商品数": no_change_count,
        "唯一操作项数": len(audit_events),
        "最终回读通过项数": readback_pass_items,
        "最终问题数": final_issue_count,
        "OCR调用数": external["ocr"],
        "媒体扫描数": external["media_scan"],
        "条码扫描数": external["barcode_scan"],
        "博查调用数": external["bocha"],
        "Web搜索调用数": external["web_search"],
        "模型调用数": external["llm"],
        "Provider Submit数": external["provider_submit"],
        "Provider Query数": external["provider_query"],
        "图片上传数": external["image_upload"],
        "验收口径": "统一终态+独立回读+非目标保护+适用集合复扫+七表内容对账",
    }

    verification = payload.get("verification") or {}
    verify_values = {
        "最终详情分片": integer(verification.get("final_detail_partitions", 1), "verification.final_detail_partitions"),
        "源清单商品数": source_count,
        "平台现存商品数": extant_count,
        "平台不存在商品数": missing_count,
        "最终合同通过商品数": complete_count,
        "最终回读通过项数": readback_pass_items,
        "最终问题数": final_issue_count,
        "完成率": f"{completion_rate:.2%}",
    }

    performance = payload.get("performance") or {}
    wall_seconds = float(performance.get("wall_seconds", 0) or 0)
    performance_values = {
        "处理商品数": source_count,
        "唯一操作项数": len(audit_events),
        "总墙钟秒": round(wall_seconds, 3),
        "平均秒/商品": round(wall_seconds / source_count, 3) if source_count else 0,
        "实际峰值并发": integer(performance.get("peak_concurrency", 0), "performance.peak_concurrency"),
        "配置并发上限": integer(performance.get("configured_concurrency_limit", 0), "performance.configured_concurrency_limit"),
        "请求数": integer(performance.get("requests", 0), "performance.requests"),
        "请求错误数": integer(performance.get("request_errors", 0), "performance.request_errors"),
        "限流次数": integer(performance.get("rate_limits", 0), "performance.rate_limits"),
        "保存checkpoint文件数": integer(performance.get("checkpoint_files", 0), "performance.checkpoint_files"),
        "保存结果事件数（含残差）": integer(performance.get("save_events", len(audit_events)), "performance.save_events"),
        "verified事件": readback_pass_items,
        "failed响应事件（均经复读判定）": integer(performance.get("failed_response_events", 0), "performance.failed_response_events"),
        "OCR调用数": external["ocr"],
        "媒体扫描数": external["media_scan"],
        "条码扫描数": external["barcode_scan"],
        "博查调用数": external["bocha"],
        "Web搜索调用数": external["web_search"],
        "模型调用数": external["llm"],
        "Provider Submit数": external["provider_submit"],
        "Provider Query数": external["provider_query"],
        "图片上传数": external["image_upload"],
    }

    workbook = Workbook()
    workbook.remove(workbook.active)
    sheets = {name: workbook.create_sheet(name) for name in SHEETS}
    for name in SHEETS:
        add_header(sheets[name], HEADERS[name])

    for row in metric_rows(SUMMARY_METRICS, summary_values):
        sheets["执行汇总"].append(row)
    for item in products:
        sheets["SPU清单"].append([
            item["spu_id"], item["before_summary"], item["outcome_summary"]
        ])
    for item in audit_events:
        sheets["字段级审计"].append([
            item["spu_id"], item["product_name"], item["channel"], item["field_id"],
            item["field_name"], item["before"], item["planned"], item["readback"],
            item["result"], item["source_strategy"],
        ])
    for item in missing:
        sheets["平台不存在"].append([
            item["spu_id"], item["platform_result"], item["handling"]
        ])
    for row in metric_rows(VERIFY_METRICS, verify_values):
        sheets["最终结构复核"].append(row)
    for item in payload.get("feedback") or []:
        sheets["问题与策略回灌"].append([
            nonempty_text(item.get("situation"), "feedback.situation"),
            nonempty_text(item.get("rule"), "feedback.rule"),
            nonempty_text(item.get("validation"), "feedback.validation"),
        ])
    for row in metric_rows(PERFORMANCE_METRICS, performance_values):
        sheets["性能与外部调用统计"].append(row)

    widths = {
        "执行汇总": [30, 72],
        "SPU清单": [24, 64, 72],
        "字段级审计": [24, 36, 20, 42, 28, 34, 34, 34, 28, 38],
        "平台不存在": [24, 36, 56],
        "最终结构复核": [30, 28],
        "问题与策略回灌": [40, 64, 48],
        "性能与外部调用统计": [34, 28],
    }
    for name, sheet in sheets.items():
        set_widths(sheet, widths[name])
    for name, columns in {
        "SPU清单": (1,), "字段级审计": (1, 4), "平台不存在": (1,)
    }.items():
        sheet = sheets[name]
        for column in columns:
            for row in range(2, sheet.max_row + 1):
                sheet.cell(row, column).number_format = "@"

    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)
    return {
        "schema_version": SCHEMA["schema_version"],
        "workbook": str(output),
        "platform": platform,
        "task_mode": task,
        "source_product_count": source_count,
        "audit_event_count": len(audit_events),
        "missing_product_count": missing_count,
        "terminal_states": sorted(set(product_results.values())),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--input", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--summary-output")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        summary = export(read(Path(args.input).resolve()), Path(args.output).resolve())
    except (ContractError, json.JSONDecodeError, OSError, ValueError) as exc:
        print(json.dumps({"exported": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    if args.summary_output:
        path = Path(args.summary_output).resolve()
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"exported": True, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
