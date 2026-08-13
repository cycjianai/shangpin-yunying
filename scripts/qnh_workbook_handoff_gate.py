#!/usr/bin/env python3
"""Authorize exactly one canonical execution workbook for user handoff."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from qnh_task_contract import verify_contract


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_name_pattern(tenant_name: str, count: int) -> str:
    safe_tenant = re.sub(r"[\\/:*?\"<>|\r\n]+", "", tenant_name).strip()
    suffix = re.escape(f"{safe_tenant or '牵牛花租户'}{count}.xlsx")
    return rf"\d{{4}}{suffix}"


def validate(args: argparse.Namespace) -> dict[str, Any]:
    contract_path = Path(args.contract).resolve()
    contract = verify_contract(contract_path)
    run_dir = Path(contract["run_dir"]).resolve()
    workbook = Path(args.workbook).resolve()
    summary_path = Path(args.summary).resolve()
    completion_path = Path(args.completion).resolve()
    workbook_validation_path = Path(args.workbook_validation).resolve()
    errors: list[str] = []

    for path, code in (
        (workbook, "workbook_missing"),
        (summary_path, "summary_missing"),
        (completion_path, "completion_missing"),
        (workbook_validation_path, "workbook_validation_missing"),
    ):
        if not path.is_file():
            errors.append(code)
        if path != run_dir and run_dir not in path.parents:
            errors.append(code.replace("missing", "outside_run_dir"))

    summary = read_json(summary_path) if summary_path.is_file() else {}
    completion = read_json(completion_path) if completion_path.is_file() else {}
    workbook_validation = (
        read_json(workbook_validation_path) if workbook_validation_path.is_file() else {}
    )
    task_role = str(contract.get("task_role") or "execution")
    if task_role != "execution":
        errors.append("validation_only_workbook_not_delivery_eligible")
    if summary.get("task_role") != task_role:
        errors.append("summary_task_role_mismatch")
    if summary.get("delivery_eligible") is not True:
        errors.append("summary_not_delivery_eligible")
    if completion.get("complete") is not True:
        errors.append("completion_gate_not_complete")
    if workbook_validation.get("valid") is not True:
        errors.append("workbook_validation_not_valid")
    if Path(str(summary.get("output_xlsx") or "")).resolve() != workbook:
        errors.append("summary_workbook_path_mismatch")
    if Path(str(workbook_validation.get("workbook") or "")).resolve() != workbook:
        errors.append("validation_workbook_path_mismatch")
    expected_name = canonical_name_pattern(
        str(summary.get("tenant_name") or ""),
        int(summary.get("source_unique_spu") or 0),
    )
    if not re.fullmatch(expected_name, workbook.name):
        errors.append("workbook_name_not_canonical")

    changed = int(summary.get("changed_products") or 0)
    fields = int(summary.get("unique_changed_fields") or 0)
    if changed > 0 and fields <= 0:
        errors.append("changed_execution_missing_field_audit")
    verified_raw = summary.get("verified_changed_fields")
    verified_fields = int(verified_raw) if verified_raw is not None else -1
    if fields != verified_fields:
        errors.append("field_audit_not_fully_verified")

    return {
        "schema": "qnh-workbook-handoff-v1",
        "ready": not errors,
        "delivery_eligible": not errors,
        "task_role": task_role,
        "task_mode": contract.get("task_mode"),
        "contract_fingerprint_sha256": contract.get("contract_fingerprint_sha256"),
        "workbook": str(workbook),
        "workbook_sha256": sha256_file(workbook) if workbook.is_file() else None,
        "summary_sha256": sha256_file(summary_path) if summary_path.is_file() else None,
        "completion_sha256": sha256_file(completion_path) if completion_path.is_file() else None,
        "workbook_validation_sha256": (
            sha256_file(workbook_validation_path)
            if workbook_validation_path.is_file()
            else None
        ),
        "changed_products": changed,
        "verified_changed_fields": max(verified_fields, 0),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True)
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--completion", required=True)
    parser.add_argument("--workbook-validation", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        result = validate(args)
    except Exception as exc:  # fail closed at the user-facing boundary
        result = {
            "schema": "qnh-workbook-handoff-v1",
            "ready": False,
            "delivery_eligible": False,
            "errors": [f"handoff_gate_exception:{type(exc).__name__}:{exc}"],
        }
    Path(args.output).resolve().write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
