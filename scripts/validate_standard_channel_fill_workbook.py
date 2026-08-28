#!/usr/bin/env python3
"""Validate the exact QNH channel-fill workbook schema and reconciled counts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from openpyxl import load_workbook

from channel_workbook_schema import (
    AUDIT_SHEET,
    FEEDBACK_SHEET,
    GENERATED_SOURCE_SHEET,
    HEADERS,
    MISSING_SHEET,
    PERFORMANCE_METRICS,
    PERFORMANCE_SHEET,
    SCHEMA_VERSION,
    SUMMARY_METRICS,
    SUMMARY_SHEET,
    VERIFY_METRICS,
    VERIFY_SHEET,
)
from core.validate_operations_workbook import validate as validate_operations_contract
from qnh_task_contract import extract_spus, read_json, verify_contract
from standard_output_name import sanitize_tenant_name


def row_values(sheet, row: int, width: int) -> list[str]:
    return [str(sheet.cell(row, col).value or "").strip() for col in range(1, width + 1)]


def metric_map(sheet) -> dict[str, Any]:
    return {
        str(sheet.cell(row, 1).value or "").strip(): sheet.cell(row, 2).value
        for row in range(2, sheet.max_row + 1)
        if str(sheet.cell(row, 1).value or "").strip()
    }


def source_spus(sheet) -> tuple[list[str], list[str]]:
    output: list[str] = []
    empty_bc: list[str] = []
    seen: set[str] = set()
    for row in range(2, sheet.max_row + 1):
        raw = sheet.cell(row, 1).value
        if raw is None:
            continue
        spu_id = re.sub(r"\.0$", "", str(raw).strip())
        if not spu_id:
            continue
        if spu_id in seen:
            output.append(f"duplicate:{spu_id}")
            continue
        seen.add(spu_id)
        output.append(spu_id)
        if not str(sheet.cell(row, 2).value or "").strip() or not str(
            sheet.cell(row, 3).value or ""
        ).strip():
            empty_bc.append(spu_id)
    return output, empty_bc


def validate(args: argparse.Namespace) -> dict[str, Any]:
    errors: list[str] = []
    contract = verify_contract(Path(args.contract).resolve())
    manifest = read_json(Path(args.manifest).resolve())
    expected_spus = extract_spus(manifest)
    summary_payload = read_json(Path(args.summary).resolve())
    workbook_path = Path(args.workbook).resolve()
    workbook = load_workbook(workbook_path, data_only=False)

    if contract.get("excel_schema_version") != SCHEMA_VERSION:
        errors.append("contract_excel_schema_version_mismatch")
    if summary_payload.get("excel_schema_version") != SCHEMA_VERSION:
        errors.append("summary_excel_schema_version_mismatch")
    if summary_payload.get("contract_fingerprint_sha256") != contract.get(
        "contract_fingerprint_sha256"
    ):
        errors.append("summary_contract_fingerprint_mismatch")

    frozen_source = contract.get("source") or {}
    if frozen_source.get("type") == "xlsx":
        if not args.source_xlsx:
            errors.append("frozen_source_xlsx_argument_missing")
        elif Path(args.source_xlsx).resolve() != Path(frozen_source["source_path"]).resolve():
            errors.append("frozen_source_xlsx_path_mismatch")
    elif args.source_xlsx:
        errors.append("unexpected_source_xlsx_argument")

    expected_sheets = [
        SUMMARY_SHEET,
        GENERATED_SOURCE_SHEET,
        AUDIT_SHEET,
        MISSING_SHEET,
        VERIFY_SHEET,
        FEEDBACK_SHEET,
        PERFORMANCE_SHEET,
    ]
    if workbook.sheetnames != expected_sheets:
        errors.append(
            "sheet_order_mismatch:expected="
            + "|".join(expected_sheets)
            + ":actual="
            + "|".join(workbook.sheetnames)
        )

    for name in (SUMMARY_SHEET, AUDIT_SHEET, MISSING_SHEET, VERIFY_SHEET, FEEDBACK_SHEET, PERFORMANCE_SHEET):
        if name not in workbook.sheetnames:
            continue
        actual = row_values(workbook[name], 1, len(HEADERS[name]))
        if actual != HEADERS[name]:
            errors.append(f"header_mismatch:{name}")

    if GENERATED_SOURCE_SHEET not in workbook.sheetnames:
        errors.append("source_sheet_missing")
        source = None
    else:
        source = workbook[GENERATED_SOURCE_SHEET]
        if row_values(source, 1, 3) != HEADERS[GENERATED_SOURCE_SHEET]:
            errors.append("generated_source_header_mismatch")

    if source is not None:
        actual_spus, empty_bc = source_spus(source)
        if any(value.startswith("duplicate:") for value in actual_spus):
            errors.append("source_sheet_duplicate_spu")
        actual_clean = [value for value in actual_spus if not value.startswith("duplicate:")]
        if set(actual_clean) != set(expected_spus) or len(actual_clean) != len(expected_spus):
            errors.append("source_sheet_spu_set_mismatch")
        if empty_bc:
            errors.append(f"source_bc_incomplete:{len(empty_bc)}")

    if SUMMARY_SHEET in workbook.sheetnames:
        summary_sheet = workbook[SUMMARY_SHEET]
        actual_metrics = [
            str(summary_sheet.cell(row, 1).value or "").strip()
            for row in range(2, summary_sheet.max_row + 1)
        ]
        if actual_metrics != list(SUMMARY_METRICS):
            errors.append("summary_metric_order_mismatch")
        summary_metrics = metric_map(summary_sheet)
        expected_pairs = {
            "Excel Schema版本": SCHEMA_VERSION,
            "Skill版本": contract["skill_version"],
            "执行平台": "牵牛花",
            "任务类型": contract["task_mode"],
            "合同指纹SHA256": contract["contract_fingerprint_sha256"],
            "源清单商品数": len(expected_spus),
            "平台现存商品数": int(summary_payload.get("platform_extant") or 0),
            "平台不存在商品数": int(summary_payload.get("missing_on_platform") or 0),
            "最终合同通过商品数": int(summary_payload.get("platform_extant") or 0),
            "完成率": "100.00%",
            "唯一操作项数": int(summary_payload.get("unique_changed_fields") or 0),
            "最终回读通过项数": int(summary_payload.get("verified_changed_fields") or 0),
            "最终问题数": 0,
        }
        for metric, expected in expected_pairs.items():
            if summary_metrics.get(metric) != expected:
                errors.append(f"summary_value_mismatch:{metric}")
        if contract["task_mode"] == "channel_attributes_only":
            for metric in (
                "OCR调用数",
                "媒体扫描数",
                "条码扫描数",
                "博查调用数",
                "Web搜索调用数",
                "模型调用数",
                "Provider Submit数",
                "Provider Query数",
                "图片上传数",
            ):
                if int(summary_metrics.get(metric) or 0) != 0:
                    errors.append(f"channel_mode_external_call_nonzero:{metric}")

    if VERIFY_SHEET in workbook.sheetnames:
        verify_sheet = workbook[VERIFY_SHEET]
        actual_metrics = [
            str(verify_sheet.cell(row, 1).value or "").strip()
            for row in range(2, verify_sheet.max_row + 1)
        ]
        if actual_metrics != list(VERIFY_METRICS):
            errors.append("verify_metric_order_mismatch")
        values = metric_map(verify_sheet)
        if int(values.get("最终问题数") or 0) != 0:
            errors.append("verify_issue_count_nonzero")
        if values.get("完成率") != "100.00%":
            errors.append("verify_fill_rate_not_100")

    if PERFORMANCE_SHEET in workbook.sheetnames:
        performance_sheet = workbook[PERFORMANCE_SHEET]
        actual_metrics = [
            str(performance_sheet.cell(row, 1).value or "").strip()
            for row in range(2, performance_sheet.max_row + 1)
        ]
        if actual_metrics != list(PERFORMANCE_METRICS):
            errors.append("performance_metric_order_mismatch")

    if AUDIT_SHEET in workbook.sheetnames:
        audit_count = max(workbook[AUDIT_SHEET].max_row - 1, 0)
        if audit_count != int(summary_payload.get("unique_changed_fields") or 0):
            errors.append("audit_row_count_mismatch")
    if MISSING_SHEET in workbook.sheetnames:
        missing_count = max(workbook[MISSING_SHEET].max_row - 1, 0)
        if missing_count != int(summary_payload.get("missing_on_platform") or 0):
            errors.append("missing_row_count_mismatch")

    tenant = sanitize_tenant_name(str(summary_payload.get("tenant_name") or ""))
    expected_suffix = f"{tenant}{len(expected_spus)}.xlsx"
    if not re.fullmatch(r"\d{4}" + re.escape(expected_suffix), workbook_path.name):
        errors.append("standard_filename_mismatch")

    sheet_names = list(workbook.sheetnames)
    workbook.close()
    shared_validation = validate_operations_contract(workbook_path)
    if not shared_validation["valid"]:
        errors.extend(
            f"shared_operations_contract:{error}"
            for error in shared_validation["errors"]
        )

    return {
        "schema": "qnh-channel-fill-workbook-validation-v1",
        "valid": not errors,
        "excel_schema_version": SCHEMA_VERSION,
        "workbook": str(workbook_path),
        "source_unique_spu": len(expected_spus),
        "sheet_names": sheet_names,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--source-xlsx")
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        result = validate(args)
    except Exception as exc:  # fail closed with a stable, low-sensitive summary
        result = {
            "schema": "qnh-channel-fill-workbook-validation-v1",
            "valid": False,
            "errors": [f"validator_exception:{type(exc).__name__}:{exc}"],
        }
    if args.output:
        Path(args.output).resolve().write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
