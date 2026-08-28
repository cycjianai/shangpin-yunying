#!/usr/bin/env python3
"""Validate exact workbook structure, canonical content, and row reconciliation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from openpyxl import load_workbook

try:
    from .operations_contract import (
        ContractError,
        PLATFORM_LABELS,
        READBACK_PASS_RESULT_VALUES,
        SCHEMA,
        TASK_VALUES,
        normalize_event,
    )
except ImportError:  # Direct script execution keeps scripts/core on sys.path.
    from operations_contract import (
        ContractError,
        PLATFORM_LABELS,
        READBACK_PASS_RESULT_VALUES,
        SCHEMA,
        TASK_VALUES,
        normalize_event,
    )


FORMULA_ERRORS = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def row_values(sheet, row: int, width: int) -> list[Any]:
    return [sheet.cell(row, column).value for column in range(1, width + 1)]


def metric_rows(sheet) -> list[str]:
    return [str(sheet.cell(row, 1).value or "") for row in range(2, sheet.max_row + 1)]


def metric_map(sheet) -> dict[str, Any]:
    return {
        str(sheet.cell(row, 1).value or ""): sheet.cell(row, 2).value
        for row in range(2, sheet.max_row + 1)
    }


def as_int(value: Any, field: str, errors: list[str]) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        errors.append(f"metric_not_integer:{field}:{value}")
        return 0
    if parsed < 0:
        errors.append(f"metric_negative:{field}:{parsed}")
    return parsed


def as_rate(value: Any, field: str, errors: list[str]) -> float:
    text = str(value or "").strip()
    try:
        parsed = float(text[:-1]) / 100 if text.endswith("%") else float(value)
    except (TypeError, ValueError):
        errors.append(f"metric_not_rate:{field}:{value}")
        return 0.0
    if not 0 <= parsed <= 1:
        errors.append(f"metric_rate_out_of_range:{field}:{value}")
    return parsed


def validate(path: Path) -> dict[str, Any]:
    workbook = load_workbook(path, data_only=False)
    errors: list[str] = []
    expected_sheets = SCHEMA["sheets"]
    if workbook.sheetnames != expected_sheets:
        errors.append("sheet_order_mismatch")

    for name in expected_sheets:
        if name not in workbook.sheetnames:
            errors.append(f"sheet_missing:{name}")
            continue
        expected = SCHEMA["headers"][name]
        actual = row_values(workbook[name], 1, len(expected))
        if actual != expected:
            errors.append(f"header_mismatch:{name}")

    if any(name not in workbook.sheetnames for name in expected_sheets):
        workbook.close()
        return {
            "schema": "operations-workbook-validation-v1",
            "valid": False,
            "errors": errors,
            "workbook": str(path),
            "workbook_sha256": sha256_file(path),
        }

    if metric_rows(workbook["执行汇总"]) != SCHEMA["summary_metrics"]:
        errors.append("summary_metric_order_mismatch")
    if metric_rows(workbook["最终结构复核"]) != SCHEMA["verify_metrics"]:
        errors.append("verify_metric_order_mismatch")
    if metric_rows(workbook["性能与外部调用统计"]) != SCHEMA["performance_metrics"]:
        errors.append("performance_metric_order_mismatch")

    summary = metric_map(workbook["执行汇总"])
    if summary.get("Excel Schema版本") != SCHEMA["schema_version"]:
        errors.append("schema_version_mismatch")
    if summary.get("执行平台") not in PLATFORM_LABELS:
        errors.append("platform_value_invalid")
    if summary.get("任务类型") not in TASK_VALUES:
        errors.append("task_value_invalid")

    products_sheet = workbook["SPU清单"]
    product_ids: list[str] = []
    for row in range(2, products_sheet.max_row + 1):
        cell = products_sheet.cell(row, 1)
        if not isinstance(cell.value, str) or not cell.value.strip():
            errors.append(f"spu_id_not_text:SPU清单:{row}")
            continue
        product_ids.append(cell.value.strip())
        if not str(products_sheet.cell(row, 2).value or "").strip():
            errors.append(f"product_before_empty:{row}")
        if not str(products_sheet.cell(row, 3).value or "").strip():
            errors.append(f"product_outcome_empty:{row}")
    if len(product_ids) != len(set(product_ids)):
        errors.append("product_spu_duplicate")

    missing_sheet = workbook["平台不存在"]
    missing_ids: list[str] = []
    for row in range(2, missing_sheet.max_row + 1):
        cell = missing_sheet.cell(row, 1)
        if not isinstance(cell.value, str) or not cell.value.strip():
            errors.append(f"spu_id_not_text:平台不存在:{row}")
            continue
        missing_ids.append(cell.value.strip())
        if not str(missing_sheet.cell(row, 2).value or "").strip():
            errors.append(f"missing_platform_result_empty:{row}")
        if not str(missing_sheet.cell(row, 3).value or "").strip():
            errors.append(f"missing_handling_empty:{row}")
    if len(missing_ids) != len(set(missing_ids)):
        errors.append("missing_spu_duplicate")
    if not set(missing_ids).issubset(product_ids):
        errors.append("missing_spu_not_in_products")

    audit_sheet = workbook["字段级审计"]
    audit_count = 0
    readback_pass_count = 0
    for row in range(2, audit_sheet.max_row + 1):
        values = row_values(audit_sheet, row, len(SCHEMA["headers"]["字段级审计"]))
        if all(value is None for value in values):
            continue
        audit_count += 1
        spu_id, product_name, channel, field_id, field_name, before, planned, readback, result, source = values
        if not isinstance(spu_id, str) or not spu_id.strip():
            errors.append(f"spu_id_not_text:字段级审计:{row}")
        elif spu_id.strip() not in set(product_ids):
            errors.append(f"audit_spu_not_in_products:{row}")
        if not str(product_name or "").strip():
            errors.append(f"audit_product_name_empty:{row}")
        if not str(field_name or "").strip():
            errors.append(f"audit_field_name_empty:{row}")
        try:
            normalize_event({
                "spu_id": spu_id,
                "product_name": product_name,
                "channel": channel,
                "field_id": field_id,
                "field_name": field_name,
                "before": before,
                "planned": planned,
                "readback": readback,
                "result": result,
                "source_strategy": source,
            })
        except ContractError as exc:
            errors.append(f"audit_contract_invalid:{row}:{exc}")
        if result in READBACK_PASS_RESULT_VALUES:
            readback_pass_count += 1

    source_count = as_int(summary.get("源清单商品数"), "源清单商品数", errors)
    extant_count = as_int(summary.get("平台现存商品数"), "平台现存商品数", errors)
    missing_count = as_int(summary.get("平台不存在商品数"), "平台不存在商品数", errors)
    passed_count = as_int(summary.get("最终合同通过商品数"), "最终合同通过商品数", errors)
    changed_product_count = as_int(summary.get("本次有操作商品数"), "本次有操作商品数", errors)
    no_change_count = as_int(summary.get("无需修改商品数"), "无需修改商品数", errors)
    operation_count = as_int(summary.get("唯一操作项数"), "唯一操作项数", errors)
    readback_count = as_int(summary.get("最终回读通过项数"), "最终回读通过项数", errors)
    final_issue_count = as_int(summary.get("最终问题数"), "最终问题数", errors)
    completion_rate = as_rate(summary.get("完成率"), "完成率", errors)
    if source_count != len(product_ids):
        errors.append("source_product_count_mismatch")
    if missing_count != len(missing_ids):
        errors.append("missing_product_count_mismatch")
    if extant_count + missing_count != source_count:
        errors.append("platform_population_reconciliation_mismatch")
    if operation_count != audit_count:
        errors.append("audit_operation_count_mismatch")
    if readback_count != readback_pass_count:
        errors.append("audit_readback_count_mismatch")
    if passed_count + final_issue_count != extant_count:
        errors.append("terminal_population_reconciliation_mismatch")
    if changed_product_count > extant_count:
        errors.append("changed_product_count_exceeds_extant")
    if no_change_count > passed_count:
        errors.append("no_change_count_exceeds_passed")
    expected_rate = passed_count / extant_count if extant_count else 1.0
    if abs(completion_rate - expected_rate) > 0.0001:
        errors.append("completion_rate_mismatch")

    verify = metric_map(workbook["最终结构复核"])
    for metric in (
        "源清单商品数",
        "平台现存商品数",
        "平台不存在商品数",
        "最终合同通过商品数",
        "最终回读通过项数",
        "最终问题数",
    ):
        if as_int(verify.get(metric), f"最终结构复核.{metric}", errors) != as_int(
            summary.get(metric), f"执行汇总.{metric}", errors
        ):
            errors.append(f"verify_summary_metric_mismatch:{metric}")
    verify_rate = as_rate(verify.get("完成率"), "最终结构复核.完成率", errors)
    if abs(verify_rate - completion_rate) > 0.0001:
        errors.append("verify_summary_metric_mismatch:完成率")

    performance = metric_map(workbook["性能与外部调用统计"])
    if as_int(performance.get("唯一操作项数"), "性能与外部调用统计.唯一操作项数", errors) != audit_count:
        errors.append("performance_operation_count_mismatch")

    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                text = str(cell.value or "")
                if any(marker in text for marker in FORMULA_ERRORS):
                    errors.append(f"formula_error:{sheet.title}:{cell.coordinate}")

    workbook.close()
    return {
        "schema": "operations-workbook-validation-v1",
        "valid": not errors,
        "errors": errors,
        "workbook": str(path),
        "workbook_sha256": sha256_file(path),
        "schema_version": SCHEMA["schema_version"],
        "source_product_count": len(product_ids),
        "audit_event_count": audit_count,
        "missing_product_count": len(missing_ids),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--workbook", required=True)
    result.add_argument("--output")
    return result


def main() -> int:
    args = parser().parse_args()
    payload = validate(Path(args.workbook).resolve())
    if args.output:
        Path(args.output).resolve().write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
