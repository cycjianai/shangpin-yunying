#!/usr/bin/env python3
"""Apply the final machine completion gate for a QNH channel-attribute run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from channel_workbook_schema import SCHEMA_VERSION
from qnh_task_contract import (
    ContractError,
    extract_spus,
    read_json,
    read_ledger,
    verify_contract,
)


TERMINAL_STATUSES = {"verified", "no_change", "missing_on_platform"}


def successful_actions(ledger: list[dict[str, Any]]) -> set[str]:
    return {
        str((row.get("payload") or {}).get("requested_action") or "")
        for row in ledger
        if row.get("action") == "task_action_terminal"
        and (row.get("payload") or {}).get("outcome") == "succeeded"
    }


def validate(args: argparse.Namespace) -> dict[str, Any]:
    contract = verify_contract(Path(args.contract).resolve())
    mode = contract["task_mode"]
    if mode not in {"channel_attributes_only", "plugin_attribute_fill"}:
        raise ContractError(f"completion_gate_mode_not_supported:{mode}")

    errors: list[str] = []
    manifest = read_json(Path(args.manifest).resolve())
    source_spus = extract_spus(manifest)
    source_set = set(source_spus)
    validation = read_json(Path(args.validation).resolve())
    summary = read_json(Path(args.summary).resolve())
    coverage = read_json(Path(args.coverage).resolve())
    workbook_validation = read_json(Path(args.workbook_validation).resolve())
    ledger = read_ledger(Path(contract["action_ledger_path"]))

    identity_path = Path(str((contract.get("session_identity") or {}).get("path") or ""))
    if not identity_path.is_file():
        identity: dict[str, Any] = {}
        errors.append("session_identity_missing")
    else:
        identity = read_json(identity_path)
        if identity.get("ok") is False or identity.get("login_state") is False:
            errors.append("session_identity_not_ready")
        if not str(identity.get("tenant_id") or "").strip():
            errors.append("session_identity_tenant_missing")
        if not str(identity.get("tenant_name") or "").strip():
            errors.append("session_identity_tenant_name_missing")
        if not str(identity.get("cdp_url") or "").strip():
            errors.append("session_identity_cdp_missing")
        if not str(identity.get("profile_dir") or "").strip():
            errors.append("session_identity_profile_missing")
        identity_run_dir = str(identity.get("run_dir") or "").strip()
        if not identity_run_dir or Path(identity_run_dir).resolve() != Path(contract["run_dir"]).resolve():
            errors.append("session_identity_run_dir_mismatch")

    if len(source_spus) != int(contract["source"]["source_unique_spu_count"]):
        errors.append("source_count_mismatch")
    if int(validation.get("products_with_issues") or 0) != 0:
        errors.append("products_with_issues_nonzero")
    if int(validation.get("issue_count") or 0) != 0:
        errors.append("issue_count_nonzero")

    rows = coverage.get("rows") or []
    coverage_ids = [str(row.get("spu_id") or "") for row in rows if isinstance(row, dict)]
    if len(coverage_ids) != len(set(coverage_ids)):
        errors.append("coverage_duplicate_spu")
    if set(coverage_ids) != source_set:
        errors.append("coverage_spu_set_mismatch")
    invalid_statuses = sorted(
        {
            str(row.get("terminal_status") or "")
            for row in rows
            if isinstance(row, dict)
            and str(row.get("terminal_status") or "") not in TERMINAL_STATUSES
        }
    )
    if invalid_statuses:
        errors.append("coverage_nonterminal_status:" + ",".join(invalid_statuses))

    missing_count = sum(
        1
        for row in rows
        if isinstance(row, dict)
        and row.get("terminal_status") == "missing_on_platform"
    )
    extant = len(source_spus) - missing_count
    if int(summary.get("source_unique_spu") if summary.get("source_unique_spu") is not None else -1) != len(source_spus):
        errors.append("summary_source_count_mismatch")
    if int(summary.get("platform_extant") if summary.get("platform_extant") is not None else -1) != extant:
        errors.append("summary_extant_count_mismatch")
    if int(summary.get("missing_on_platform") if summary.get("missing_on_platform") is not None else -1) != missing_count:
        errors.append("summary_missing_count_mismatch")
    checked = int(
        validation.get("platform_extant_checked")
        if validation.get("platform_extant_checked") is not None
        else validation.get("products_checked") or 0
    )
    if checked != extant:
        errors.append("validation_extant_count_mismatch")

    if summary.get("excel_schema_version") != SCHEMA_VERSION:
        errors.append("summary_schema_mismatch")
    if summary.get("skill_version") != contract["skill_version"]:
        errors.append("summary_skill_version_mismatch")
    if summary.get("task_mode") != mode:
        errors.append("summary_task_mode_mismatch")
    if identity and str(summary.get("tenant_name") or "").strip() != str(
        identity.get("tenant_name") or ""
    ).strip():
        errors.append("summary_tenant_identity_mismatch")
    if summary.get("contract_fingerprint_sha256") != contract[
        "contract_fingerprint_sha256"
    ]:
        errors.append("summary_contract_fingerprint_mismatch")
    if not bool(workbook_validation.get("valid")):
        errors.append("workbook_schema_validation_failed")

    completed_actions = successful_actions(ledger)
    missing_actions = sorted(
        set(contract.get("required_success_actions") or []) - completed_actions
    )
    if missing_actions:
        errors.append("required_actions_missing:" + ",".join(missing_actions))
    for row in ledger:
        payload = row.get("payload") or {}
        requested = str(payload.get("requested_action") or "")
        if requested and requested not in set(contract.get("allowed_actions") or []):
            errors.append(f"forbidden_action_attempted:{requested}")

    external = summary.get("external_calls") or {}
    for key, limit_raw in (contract.get("external_call_budgets") or {}).items():
        actual = int(external.get(key) or 0)
        limit = int(limit_raw or 0)
        if actual > limit:
            errors.append(f"external_budget_exceeded:{key}:{actual}>{limit}")
        if mode == "channel_attributes_only" and actual != 0:
            errors.append(f"channel_mode_external_call_nonzero:{key}")

    run_dir = Path(contract["run_dir"])
    artifacts: list[str] = []
    for pattern in contract.get("forbidden_artifact_globs") or []:
        for path in run_dir.glob(pattern):
            if path.exists():
                artifacts.append(str(path.relative_to(run_dir)))
    if artifacts:
        errors.append("forbidden_artifacts_present:" + ",".join(sorted(set(artifacts))[:20]))

    return {
        "schema": "qnh-completion-gate-v1",
        "complete": not errors,
        "task_mode": mode,
        "skill_version": contract["skill_version"],
        "contract_fingerprint_sha256": contract["contract_fingerprint_sha256"],
        "source_unique_spu": len(source_spus),
        "platform_extant": extant,
        "missing_on_platform": missing_count,
        "products_with_issues": int(validation.get("products_with_issues") or 0),
        "issue_count": int(validation.get("issue_count") or 0),
        "required_actions": contract.get("required_success_actions") or [],
        "successful_actions": sorted(completed_actions),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--coverage", required=True)
    parser.add_argument("--workbook-validation", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        result = validate(args)
    except Exception as exc:  # fail closed with a compact reason
        result = {
            "schema": "qnh-completion-gate-v1",
            "complete": False,
            "errors": [f"completion_gate_exception:{type(exc).__name__}:{exc}"],
        }
    Path(args.output).resolve().write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
