#!/usr/bin/env python3
"""Freeze and verify the deterministic execution contract for one QNH run."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


SKILL_ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = SKILL_ROOT / "VERSION"
CONTRACT_VERSION = "qnh-task-contract-v3.3.9"
EXCEL_SCHEMA_VERSION = json.loads(
    (SKILL_ROOT / "scripts" / "operations_workbook_schema.json").read_text(encoding="utf-8")
)["schema_version"]
LEDGER_NAME = "task-action-ledger.jsonl"

EXTERNAL_BUDGET_KEYS = (
    "ocr",
    "media_scan",
    "barcode_scan",
    "bocha",
    "web_search",
    "llm",
    "provider_submit",
    "provider_query",
    "image_upload",
)


def _spec(
    script: str | None,
    *required_tokens: str,
    forbidden_tokens: tuple[str, ...] = (),
    budget_key: str | None = None,
    alternate_scripts: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "script": script,
        "alternate_scripts": list(alternate_scripts),
        "required_tokens": list(required_tokens),
        "forbidden_tokens": list(forbidden_tokens),
        "budget_key": budget_key,
    }


ACTION_SPECS: dict[str, dict[str, Any]] = {
    "start_browser": _spec("scripts/start_qnh_browser.sh"),
    "session_preflight": _spec(
        "scripts/qnh_direct.mjs",
        "preflight",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "close_edit_tabs": _spec("scripts/qnh_direct.mjs", "close-edit-tabs"),
    "build_source_manifest": _spec("scripts/build_spu_manifest_from_xlsx.py"),
    "freeze_unavailable": _spec("scripts/qnh_direct.mjs", "freeze"),
    "read_details_initial": _spec(
        "scripts/qnh_direct.mjs",
        "details",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "probe_exact_editor_frames": _spec(
        "scripts/qnh_direct.mjs", "probe-exact-editor-frames"
    ),
    "read_recommendations": _spec(
        "scripts/qnh_direct.mjs",
        "recommendations",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "build_channel_plans": _spec("scripts/build_channel_contract_v2_plans.py"),
    "orchestrate_channel_task": _spec("scripts/run_channel_attributes_task.py"),
    "dry_run_plan": _spec(
        "scripts/qnh_direct.mjs",
        "apply-direct-plan",
        "--dry-run",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "apply_plan": _spec(
        "scripts/qnh_direct.mjs",
        "apply-direct-plan",
        forbidden_tokens=("--dry-run",),
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "apply_batch": _spec(
        "scripts/run_qnh_batch.sh",
        "apply-direct-batch",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "apply_prepared_barrier_batch": _spec(
        "scripts/qnh_direct.mjs", "apply-prepared-barrier-batch"
    ),
    "read_details_final": _spec(
        "scripts/qnh_direct.mjs",
        "details",
        alternate_scripts=("scripts/qnh_extension_receipt.py",),
    ),
    "validate_channel_contracts": _spec("scripts/validate_channel_contracts.py"),
    "standard_output_name": _spec("scripts/standard_output_name.py"),
    "export_workbook": _spec("scripts/export_standard_channel_fill_workbook.py"),
    "validate_workbook": _spec(
        "scripts/validate_standard_channel_fill_workbook.py"
    ),
    "completion_gate": _spec("scripts/qnh_completion_gate.py"),
    "handoff_workbook": _spec("scripts/qnh_workbook_handoff_gate.py"),
    "build_error_strategy": _spec("scripts/build_error_strategy_matrix.py"),
    "build_general_plans": _spec("scripts/build_plans.py"),
    "scan_media": _spec("scripts/scan_media.py", budget_key="media_scan"),
    "scan_barcodes": _spec(
        "scripts/scan_barcodes.py", budget_key="barcode_scan"
    ),
    "build_media_plans": _spec("scripts/build_media_plans.py"),
    "build_formal_asset_jobs": _spec("scripts/build_formal_asset_jobs.py"),
    "build_formal_nutrition_jobs": _spec(
        "scripts/build_formal_nutrition_jobs.py"
    ),
    "build_generated_picture_plans": _spec(
        "scripts/build_generated_picture_plans.py"
    ),
    "build_authentic_picture_plans": _spec(
        "scripts/build_authentic_special_picture_plans.py", budget_key="ocr"
    ),
    "provider_generation": _spec(
        "scripts/run_safe_special_picture_generation.py",
        budget_key="provider_submit",
    ),
    "image_upload": _spec(
        "scripts/qnh_direct.mjs", "upload-image", budget_key="image_upload"
    ),
    "export_unavailable_ledger": _spec("scripts/export_ledger.py"),
    # Tool/API actions have no local executable. They must be explicitly recorded
    # with `record-external`; channel_attributes_only keeps their budget at zero.
    "ocr": _spec(None, budget_key="ocr"),
    "bocha_resolve": _spec(None, budget_key="bocha"),
    "web_search": _spec(None, budget_key="web_search"),
    "llm_resolve": _spec(None, budget_key="llm"),
    "provider_submit": _spec(None, budget_key="provider_submit"),
    "provider_query": _spec(None, budget_key="provider_query"),
    "plugin_task_execute": _spec(None),
    "plugin_readback": _spec(None),
}

COMMON_ACTIONS = {
    "start_browser",
    "session_preflight",
    "close_edit_tabs",
    "build_source_manifest",
}

MODE_ALLOWED_ACTIONS: dict[str, set[str]] = {
    "channel_attributes_only": COMMON_ACTIONS
    | {
        "read_details_initial",
        "probe_exact_editor_frames",
        "read_recommendations",
        "build_channel_plans",
        "orchestrate_channel_task",
        "dry_run_plan",
        "apply_plan",
        "apply_batch",
        "apply_prepared_barrier_batch",
        "read_details_final",
        "validate_channel_contracts",
        "standard_output_name",
        "export_workbook",
        "validate_workbook",
        "completion_gate",
        "handoff_workbook",
    },
    "unavailable_one_pass": COMMON_ACTIONS
    | {
        "freeze_unavailable",
        "read_details_initial",
        "read_recommendations",
        "build_channel_plans",
        "build_error_strategy",
        "build_general_plans",
        "dry_run_plan",
        "apply_plan",
        "apply_batch",
        "scan_media",
        "scan_barcodes",
        "build_media_plans",
        "build_formal_asset_jobs",
        "build_formal_nutrition_jobs",
        "build_generated_picture_plans",
        "build_authentic_picture_plans",
        "provider_generation",
        "image_upload",
        "ocr",
        "bocha_resolve",
        "web_search",
        "llm_resolve",
        "provider_submit",
        "provider_query",
        "read_details_final",
        "validate_channel_contracts",
        "standard_output_name",
        "export_unavailable_ledger",
        "completion_gate",
        "handoff_workbook",
    },
    "qualification_images_only": COMMON_ACTIONS
    | {
        "read_details_initial",
        "scan_media",
        "scan_barcodes",
        "build_media_plans",
        "build_formal_asset_jobs",
        "build_formal_nutrition_jobs",
        "build_generated_picture_plans",
        "build_authentic_picture_plans",
        "provider_generation",
        "image_upload",
        "ocr",
        "web_search",
        "provider_submit",
        "provider_query",
        "dry_run_plan",
        "apply_plan",
        "apply_batch",
        "read_details_final",
        "standard_output_name",
        "export_unavailable_ledger",
        "completion_gate",
    },
    "plugin_attribute_fill": {
        "plugin_task_execute",
        "plugin_readback",
        "validate_channel_contracts",
        "standard_output_name",
        "export_workbook",
        "validate_workbook",
        "completion_gate",
        "handoff_workbook",
    },
}

MODE_REQUIRED_ACTIONS: dict[str, list[str]] = {
    "channel_attributes_only": [
        "session_preflight",
        "read_details_initial",
        "build_channel_plans",
        "read_details_final",
        "validate_channel_contracts",
        "export_workbook",
        "validate_workbook",
    ],
    "unavailable_one_pass": [
        "session_preflight",
        "freeze_unavailable",
        "read_details_initial",
        "build_error_strategy",
        "read_details_final",
        "export_unavailable_ledger",
    ],
    "qualification_images_only": [
        "session_preflight",
        "read_details_initial",
        "read_details_final",
        "export_unavailable_ledger",
    ],
    "plugin_attribute_fill": [
        "plugin_task_execute",
        "plugin_readback",
        "validate_channel_contracts",
        "export_workbook",
        "validate_workbook",
    ],
}

MODE_DEFAULT_BUDGETS: dict[str, dict[str, int]] = {
    "channel_attributes_only": {key: 0 for key in EXTERNAL_BUDGET_KEYS},
    "unavailable_one_pass": {key: 0 for key in EXTERNAL_BUDGET_KEYS},
    "qualification_images_only": {key: 0 for key in EXTERNAL_BUDGET_KEYS},
    "plugin_attribute_fill": {key: 0 for key in EXTERNAL_BUDGET_KEYS},
}

CHANNEL_FORBIDDEN_ARTIFACT_GLOBS = [
    "media-scan/**",
    "barcode-scan*.json",
    "authentic-special-picture-*/**",
    "safe-special-generation/**",
    "special-picture-candidates*.json",
    "formal-asset*/**",
    "formal-nutrition*/**",
    "*ocr*.json",
    "*bocha*.json",
    "*provider-task*.json",
]


class ContractError(RuntimeError):
    """Stable, low-sensitive task contract failure."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def now_iso() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def emit_error(code: str, message: str, **payload: Any) -> None:
    event = {
        "timestamp": now_iso(),
        "trace_id": payload.pop("trace_id", "qnh_contract"),
        "level": "ERROR",
        "module": "qnh_skill_contract",
        "action": code,
        "payload": payload,
        "message": message,
        "error_stack": "",
    }
    print(stable_json(event), file=sys.stderr)


def skill_version() -> str:
    value = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ContractError("invalid_skill_version")
    return value


def skill_files() -> list[Path]:
    output: list[Path] = []
    for path in SKILL_ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(SKILL_ROOT)
        if "__pycache__" in relative.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.name.startswith("."):
            continue
        output.append(path)
    return sorted(output, key=lambda item: item.relative_to(SKILL_ROOT).as_posix())


def build_file_fingerprints() -> dict[str, str]:
    return {
        path.relative_to(SKILL_ROOT).as_posix(): sha256_file(path)
        for path in skill_files()
    }


def _contains(pattern: str, text: str) -> bool:
    return bool(re.search(pattern, text, re.IGNORECASE))


def route_request(request_text: str) -> dict[str, Any]:
    text = re.sub(r"\s+", "", request_text or "")
    request_sha = sha256_bytes(request_text.encode("utf-8"))
    explicit_channel_only = _contains(
        r"(?:只|仅|只需要|仅需要).{0,18}(?:渠道类目属性|渠道属性).{0,12}(?:填|补|维护)",
        text,
    ) or _contains(r"(?:渠道类目属性|渠道属性).{0,12}(?:只|仅).{0,8}(?:填|补)", text)
    plugin = _contains(
        r"插件.*(?:商品属性全平台填充|商品属性填充.?资质图|属性填充)|(?:商品属性全平台填充|商品属性填充.?资质图).*插件",
        text,
    )
    unavailable = _contains(r"渠道不可售|不可售|下架|审核报错|退出不可售|变成可售", text)
    qualification = _contains(
        r"资质图|专项图|配料.{0,4}图|营养.{0,6}图|背签|包装标签|尺寸图|吊牌|洗唛",
        text,
    )
    attributes = _contains(
        r"渠道类目属性|渠道属性|属性填充|SPU清单|指定SPU|填充率",
        text,
    )
    spu_table_information_fill = _contains(
        r"(?:(?:表|表格|Excel|XLSX|CSV).{0,24}SPU|SPU.{0,24}(?:表|表格|Excel|XLSX|CSV))"
        r".{0,24}(?:信息填充|填充信息|进行填充|补齐信息)",
        text,
    ) or _contains(r"SPU.{0,24}(?:信息填充|填充信息|进行填充|补齐信息)", text)
    attributes = attributes or spu_table_information_fill
    validation_only = _contains(
        r"(?:只读|不写入|不保存|仅复核|只复核|仅验证|只验证|审计不写入)",
        text,
    )

    signals = []
    if plugin:
        signals.append("plugin_attribute_fill")
    if unavailable:
        signals.append("unavailable_one_pass")
    if qualification:
        signals.append("qualification_images_only")
    if attributes:
        signals.append("channel_attributes_only")

    if explicit_channel_only and not plugin:
        mode = "channel_attributes_only"
        reason = "explicit_channel_only_scope"
    elif plugin:
        mode = "plugin_attribute_fill"
        reason = "explicit_plugin_execution_or_optimization"
    elif unavailable:
        mode = "unavailable_one_pass"
        reason = "unavailable_or_review_exit_goal"
    elif qualification and not attributes:
        mode = "qualification_images_only"
        reason = "qualification_only_goal"
    elif attributes and not qualification:
        mode = "channel_attributes_only"
        reason = (
            "spu_table_information_fill_goal"
            if spu_table_information_fill
            else "attribute_list_goal"
        )
    else:
        mode = "ambiguous_mode"
        reason = "multiple_or_missing_mode_signals"

    return {
        "route_version": CONTRACT_VERSION,
        "task_mode": mode,
        "reason": reason,
        "signals": sorted(set(signals)),
        "request_sha256": request_sha,
        "raw_request_persisted": False,
        "task_role": "validation_only" if validation_only else "execution",
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def extract_spus(payload: Any) -> list[str]:
    candidates: Any
    if isinstance(payload, dict):
        candidates = (
            payload.get("products")
            or payload.get("items")
            or payload.get("spu_ids")
            or payload.get("spus")
            or []
        )
    elif isinstance(payload, list):
        candidates = payload
    else:
        candidates = []
    output: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        if isinstance(item, dict):
            raw = item.get("spu_id") or item.get("spuId") or item.get("spu")
        else:
            raw = item
        value = re.sub(r"\.0$", "", str(raw or "").strip())
        if value and value not in seen:
            seen.add(value)
            output.append(value)
    if not output:
        raise ContractError("source_manifest_has_no_spu")
    return output


def parse_budgets(values: list[str]) -> dict[str, int]:
    output: dict[str, int] = {}
    for value in values:
        if "=" not in value:
            raise ContractError(f"invalid_budget:{value}")
        key, raw = value.split("=", 1)
        key = key.strip()
        if key not in EXTERNAL_BUDGET_KEYS:
            raise ContractError(f"unknown_budget:{key}")
        amount = int(raw)
        if amount < 0:
            raise ContractError(f"negative_budget:{key}")
        output[key] = amount
    return output


def contract_digest(contract: dict[str, Any]) -> str:
    payload = dict(contract)
    payload.pop("contract_fingerprint_sha256", None)
    return sha256_bytes(stable_json(payload).encode("utf-8"))


def create_contract(args: argparse.Namespace) -> dict[str, Any]:
    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    output = run_dir / "task-contract.json"
    if output.exists():
        raise ContractError("task_contract_already_exists")

    request_text = args.request_text or ""
    if args.request_file:
        request_text = Path(args.request_file).resolve().read_text(encoding="utf-8")
    route = route_request(request_text)
    if args.mode:
        if not args.explicit_user_mode:
            raise ContractError("mode_override_requires_explicit_user_mode")
        route["task_mode"] = args.mode
        route["reason"] = "explicit_user_mode_override"
    mode = route["task_mode"]
    if mode not in MODE_ALLOWED_ACTIONS:
        raise ContractError("ambiguous_mode")
    task_role = args.task_role or str(route.get("task_role") or "execution")

    source_manifest = Path(args.source_manifest).resolve()
    spus = extract_spus(read_json(source_manifest))
    source_xlsx = Path(args.source_xlsx).resolve() if args.source_xlsx else None
    session_identity = (
        Path(args.session_identity).resolve()
        if args.session_identity
        else (run_dir / "session_identity.json").resolve()
    )
    budgets = dict(MODE_DEFAULT_BUDGETS[mode])
    overrides = parse_budgets(args.budget or [])
    if mode == "channel_attributes_only" and any(overrides.values()):
        raise ContractError("channel_mode_external_budget_must_be_zero")
    budgets.update(overrides)

    files = build_file_fingerprints()
    allowed = sorted(MODE_ALLOWED_ACTIONS[mode])
    forbidden = sorted(set(ACTION_SPECS) - set(allowed))
    executors: dict[str, Any] = {}
    for action in allowed:
        spec = ACTION_SPECS[action]
        script = spec.get("script")
        alternate_scripts = spec.get("alternate_scripts") or []
        executors[action] = {
            **spec,
            "script_sha256": files.get(script) if script else None,
            "alternate_script_sha256": {
                item: files.get(item) for item in alternate_scripts
            },
        }

    source_file = source_xlsx or source_manifest
    contract: dict[str, Any] = {
        "schema": CONTRACT_VERSION,
        "contract_version": CONTRACT_VERSION,
        "skill_version": skill_version(),
        "excel_schema_version": EXCEL_SCHEMA_VERSION,
        "created_at": now_iso(),
        "task_mode": mode,
        "task_role": task_role,
        "scope_lock": "immutable",
        "route": route,
        "run_dir": str(run_dir),
        "source": {
            "type": "xlsx" if source_xlsx else "manifest",
            "manifest_path": str(source_manifest),
            "manifest_sha256": sha256_file(source_manifest),
            "source_path": str(source_file),
            "source_sha256": sha256_file(source_file),
            "source_unique_spu_count": len(spus),
            "source_spu_set_sha256": sha256_bytes(
                "\n".join(sorted(spus)).encode("utf-8")
            ),
        },
        "session_identity": {
            "path": str(session_identity),
            "initial_sha256": sha256_file(session_identity) if session_identity.is_file() else None,
            "required_before_platform_read": True,
        },
        "allowed_actions": allowed,
        "forbidden_actions": forbidden,
        "required_success_actions": MODE_REQUIRED_ACTIONS[mode],
        "external_call_budgets": budgets,
        "canonical_executors": executors,
        "forbidden_artifact_globs": (
            CHANNEL_FORBIDDEN_ARTIFACT_GLOBS
            if mode == "channel_attributes_only"
            else []
        ),
        "action_ledger_path": str(run_dir / LEDGER_NAME),
        "skill_file_sha256": files,
    }
    contract["contract_fingerprint_sha256"] = contract_digest(contract)
    output.write_text(
        json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return contract


def verify_contract(path: Path) -> dict[str, Any]:
    contract = read_json(path)
    if contract.get("contract_version") != CONTRACT_VERSION:
        raise ContractError("contract_version_mismatch")
    if contract.get("skill_version") != skill_version():
        raise ContractError("skill_version_mismatch")
    if contract.get("task_mode") not in MODE_ALLOWED_ACTIONS:
        raise ContractError("unknown_task_mode")
    if contract.get("contract_fingerprint_sha256") != contract_digest(contract):
        raise ContractError("contract_fingerprint_mismatch")

    current_files = build_file_fingerprints()
    expected_files = contract.get("skill_file_sha256") or {}
    if current_files != expected_files:
        changed = sorted(
            key
            for key in set(current_files) | set(expected_files)
            if current_files.get(key) != expected_files.get(key)
        )
        raise ContractError(
            "skill_fingerprint_mismatch:" + ",".join(changed[:10])
        )

    source = contract.get("source") or {}
    manifest_path = Path(str(source.get("manifest_path") or ""))
    source_path = Path(str(source.get("source_path") or ""))
    if not manifest_path.is_file() or sha256_file(manifest_path) != source.get(
        "manifest_sha256"
    ):
        raise ContractError("source_manifest_fingerprint_mismatch")
    if not source_path.is_file() or sha256_file(source_path) != source.get(
        "source_sha256"
    ):
        raise ContractError("source_file_fingerprint_mismatch")
    spus = extract_spus(read_json(manifest_path))
    if len(spus) != int(source.get("source_unique_spu_count") or -1):
        raise ContractError("source_spu_count_mismatch")
    if sha256_bytes("\n".join(sorted(spus)).encode("utf-8")) != source.get(
        "source_spu_set_sha256"
    ):
        raise ContractError("source_spu_set_mismatch")
    return contract


def read_ledger(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ContractError("invalid_action_ledger_json") from exc
        if isinstance(value, dict):
            rows.append(value)
    return rows


def consumed_units(contract: dict[str, Any], budget_key: str) -> int:
    ledger = read_ledger(Path(contract["action_ledger_path"]))
    total = 0
    for row in ledger:
        payload = row.get("payload") or {}
        if row.get("action") != "task_action_terminal":
            continue
        if payload.get("outcome") != "succeeded":
            continue
        if payload.get("budget_key") == budget_key:
            total += int(payload.get("units") or 0)
    return total


def guard_action(
    contract: dict[str, Any],
    action: str,
    *,
    script: Path | None = None,
    command_tokens: list[str] | None = None,
    units: int = 0,
) -> dict[str, Any]:
    mode = str(contract["task_mode"])
    if action not in contract.get("allowed_actions", []):
        raise ContractError(f"scope_violation:{mode}:{action}")
    executor = (contract.get("canonical_executors") or {}).get(action)
    if not executor:
        raise ContractError(f"executor_not_frozen:{action}")
    expected_script = executor.get("script")
    alternate_scripts = executor.get("alternate_scripts") or []
    accepted_scripts = [item for item in [expected_script, *alternate_scripts] if item]
    if accepted_scripts:
        if script is None:
            raise ContractError(f"canonical_script_required:{action}")
        matched_relative = next(
            (
                item
                for item in accepted_scripts
                if script.resolve() == (SKILL_ROOT / item).resolve()
            ),
            None,
        )
        if matched_relative is None:
            raise ContractError(f"noncanonical_script:{action}")
        expected_path = (SKILL_ROOT / matched_relative).resolve()
        expected_sha = (
            executor.get("script_sha256")
            if matched_relative == expected_script
            else (executor.get("alternate_script_sha256") or {}).get(matched_relative)
        )
        if not expected_sha or sha256_file(expected_path) != expected_sha:
            raise ContractError(f"canonical_script_hash_mismatch:{action}")
    elif script is not None:
        raise ContractError(f"external_action_must_not_supply_script:{action}")

    tokens = command_tokens or []
    for token in executor.get("required_tokens") or []:
        if token not in tokens:
            raise ContractError(f"required_command_token_missing:{action}:{token}")
    for token in executor.get("forbidden_tokens") or []:
        if token in tokens:
            raise ContractError(f"forbidden_command_token:{action}:{token}")

    budget_key = executor.get("budget_key")
    if units < 0:
        raise ContractError("negative_action_units")
    if budget_key:
        if units <= 0:
            raise ContractError(f"positive_budget_units_required:{budget_key}")
        limit = int((contract.get("external_call_budgets") or {}).get(budget_key, 0))
        used = consumed_units(contract, budget_key)
        if used + units > limit:
            raise ContractError(
                f"external_budget_exceeded:{budget_key}:{used}+{units}>{limit}"
            )
    return {
        "allowed": True,
        "task_mode": mode,
        "action": action,
        "budget_key": budget_key,
        "units": units,
    }


def append_ledger(contract: dict[str, Any], payload: dict[str, Any]) -> None:
    path = Path(contract["action_ledger_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "timestamp": now_iso(),
        "trace_id": payload.pop("trace_id", "qnh_task_action"),
        "level": "INFO" if payload.get("outcome") == "succeeded" else "WARN",
        "module": "qnh_skill_contract",
        "action": "task_action_terminal",
        "payload": payload,
        "message": "任务动作已完成" if payload.get("outcome") == "succeeded" else "任务动作未完成",
        "error_stack": "",
    }
    with path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.write(stable_json(event) + "\n")
        handle.flush()
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def request_text_from_args(args: argparse.Namespace) -> str:
    if args.request_file:
        return Path(args.request_file).resolve().read_text(encoding="utf-8")
    return args.request_text or ""


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)

    route = sub.add_parser("route")
    route.add_argument("--request-text")
    route.add_argument("--request-file")

    create = sub.add_parser("create")
    create.add_argument("--run-dir", required=True)
    create.add_argument("--source-manifest", required=True)
    create.add_argument("--source-xlsx")
    create.add_argument("--session-identity")
    create.add_argument("--request-text")
    create.add_argument("--request-file")
    create.add_argument("--mode", choices=sorted(MODE_ALLOWED_ACTIONS))
    create.add_argument("--explicit-user-mode", action="store_true")
    create.add_argument("--budget", action="append", default=[])
    create.add_argument(
        "--task-role",
        choices=("execution", "validation_only"),
        help="交付角色；默认从用户原话判定，普通任务为 execution",
    )

    verify = sub.add_parser("verify")
    verify.add_argument("--contract", required=True)

    guard = sub.add_parser("guard")
    guard.add_argument("--contract", required=True)
    guard.add_argument("--action", required=True)
    guard.add_argument("--script")
    guard.add_argument("--token", action="append", default=[])
    guard.add_argument("--units", type=int, default=0)

    external = sub.add_parser("record-external")
    external.add_argument("--contract", required=True)
    external.add_argument("--action", required=True)
    external.add_argument("--receipt", required=True)
    external.add_argument("--units", type=int, default=0)
    external.add_argument("--outcome", choices=("succeeded", "failed"), required=True)

    inspect = sub.add_parser("inspect")
    inspect.add_argument("--contract", required=True)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "route":
            result = route_request(request_text_from_args(args))
        elif args.command == "create":
            result = create_contract(args)
        elif args.command == "verify":
            contract = verify_contract(Path(args.contract).resolve())
            result = {
                "verified": True,
                "task_mode": contract["task_mode"],
                "task_role": contract.get("task_role", "execution"),
                "skill_version": contract["skill_version"],
                "contract_fingerprint_sha256": contract[
                    "contract_fingerprint_sha256"
                ],
            }
        elif args.command == "guard":
            contract = verify_contract(Path(args.contract).resolve())
            result = guard_action(
                contract,
                args.action,
                script=Path(args.script).resolve() if args.script else None,
                command_tokens=args.token,
                units=args.units,
            )
        elif args.command == "record-external":
            contract = verify_contract(Path(args.contract).resolve())
            receipt = Path(args.receipt).resolve()
            if not receipt.is_file():
                raise ContractError("external_action_receipt_missing")
            run_dir = Path(contract["run_dir"]).resolve()
            if receipt != run_dir and run_dir not in receipt.parents:
                raise ContractError("external_action_receipt_outside_run_dir")
            result = guard_action(
                contract,
                args.action,
                script=None,
                command_tokens=[],
                units=args.units,
            )
            append_ledger(
                contract,
                {
                    "task_mode": contract["task_mode"],
                    "requested_action": args.action,
                    "outcome": args.outcome,
                    "exit_code": 0 if args.outcome == "succeeded" else 1,
                    "elapsed_ms": 0,
                    "budget_key": result.get("budget_key"),
                    "units": args.units,
                    "receipt_path": str(receipt),
                    "receipt_sha256": sha256_file(receipt),
                },
            )
        else:
            contract = verify_contract(Path(args.contract).resolve())
            result = {
                "task_mode": contract["task_mode"],
                "task_role": contract.get("task_role", "execution"),
                "skill_version": contract["skill_version"],
                "source_unique_spu_count": contract["source"][
                    "source_unique_spu_count"
                ],
                "allowed_actions": contract["allowed_actions"],
                "forbidden_actions": contract["forbidden_actions"],
                "external_call_budgets": contract["external_call_budgets"],
                "contract_fingerprint_sha256": contract[
                    "contract_fingerprint_sha256"
                ],
            }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as exc:
        emit_error("qnh_task_contract_rejected", str(exc), command=args.command)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
