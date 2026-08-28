#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
ENGINE = Path(__file__).with_name("engine.mjs")
TRANSPORT = Path(__file__).with_name("browser_transport.mjs")
EVIDENCE_DISCOVERY = Path(__file__).with_name("evidence_discovery.py")
FIELD_PLANNER = Path(__file__).with_name("deepseek_field_planner.py")
CHECKPOINT_BUILDER = Path(__file__).with_name("build_operations_checkpoint.py")
WORKBOOK_EXPORTER = Path(__file__).with_name("export_operations_workbook.mjs")
WORKBOOK_VALIDATOR = ROOT / "scripts" / "core" / "validate_operations_workbook.py"
QUALIFICATION_PREPARER = Path(__file__).parents[1] / "qualification_images" / "prepare_manifest.py"
QUALIFICATION_IMPORTER = Path(__file__).parents[1] / "qualification_images" / "import_batch.mjs"
PLATFORM_REFERENCE = ROOT / "references" / "platform-meituan.md"
QUALIFICATION_REFERENCE = ROOT / "references" / "meituan-qualification-import.md"
SKILL = ROOT / "SKILL.md"
VERSION = ROOT / "VERSION"
ALLOWED_ACTIONS = (
    "session_preflight",
    "freeze_cohort",
    "read_audit_details",
    "plan_one_pass",
    "prepare_qualification_manifest",
    "qualification_batch",
    "save_canary",
    "save_batch",
    "independent_readback",
    "rescan_scopes",
    "export_workbook",
    "validate_workbook",
    "completion_gate",
    "workbook_handoff",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def contract_sources() -> dict[str, str]:
    return {
        str(path.resolve()): sha256_file(path)
        for path in (
            SKILL,
            VERSION,
            PLATFORM_REFERENCE,
            QUALIFICATION_REFERENCE,
            ENGINE,
            TRANSPORT,
            EVIDENCE_DISCOVERY,
            FIELD_PLANNER,
            CHECKPOINT_BUILDER,
            WORKBOOK_EXPORTER,
            WORKBOOK_VALIDATOR,
            QUALIFICATION_PREPARER,
            QUALIFICATION_IMPORTER,
            Path(__file__),
        )
    }


def fingerprint(payload: dict[str, Any]) -> str:
    body = {key: value for key, value in payload.items() if key != "contract_fingerprint_sha256"}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def create(args: argparse.Namespace) -> dict[str, Any]:
    run_dir = Path(args.run_dir).resolve()
    manifest_path = Path(args.manifest).resolve()
    identity_path = Path(args.identity).resolve()
    manifest = read_json(manifest_path)
    identity = read_json(identity_path)
    if manifest.get("platform_adapter") != "meituan" or manifest.get("task_mode") != "unavailable_one_pass":
        raise ValueError("manifest_mode_mismatch")
    if identity.get("platform_adapter") != "meituan":
        raise ValueError("identity_platform_mismatch")
    if str(identity.get("wm_poi_id")) != str(manifest.get("wm_poi_id")):
        raise ValueError("identity_store_mismatch")
    if identity.get("browser_transport") not in {"chrome_extension_current_tab", "managed_cdp"}:
        raise ValueError("browser_transport_not_allowed")
    payload = {
        "schema": "meituan-unavailable-task-contract-v1",
        "task_role": "execution",
        "platform_adapter": "meituan",
        "task_mode": "unavailable_one_pass",
        "run_dir": str(run_dir),
        "manifest": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "session_identity": str(identity_path),
        "session_identity_sha256": sha256_file(identity_path),
        "source_unique_spu": int(manifest.get("unique_spu_count") or 0),
        "platform_record_count": int(manifest.get("platform_record_count") or 0),
        "spu_set_sha256": manifest.get("spu_set_sha256"),
        "browser_transport": identity.get("browser_transport"),
        "allowed_actions": list(ALLOWED_ACTIONS),
        "canonical_sources": contract_sources(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    payload["contract_fingerprint_sha256"] = fingerprint(payload)
    output = run_dir / "task-contract.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def verify(path: Path) -> dict[str, Any]:
    payload = read_json(path)
    errors: list[str] = []
    if payload.get("schema") != "meituan-unavailable-task-contract-v1":
        errors.append("schema_mismatch")
    if payload.get("contract_fingerprint_sha256") != fingerprint(payload):
        errors.append("contract_fingerprint_mismatch")
    for name, expected in (payload.get("canonical_sources") or {}).items():
        source = Path(name)
        if not source.is_file() or sha256_file(source) != expected:
            errors.append(f"canonical_source_changed:{source.name}")
    for key, hash_key in (("manifest", "manifest_sha256"), ("session_identity", "session_identity_sha256")):
        target = Path(str(payload.get(key) or ""))
        if not target.is_file() or sha256_file(target) != payload.get(hash_key):
            errors.append(f"{key}_changed")
    if errors:
        raise ValueError(";".join(errors))
    return payload


def record(args: argparse.Namespace) -> dict[str, Any]:
    contract_path = Path(args.contract).resolve()
    contract = verify(contract_path)
    if args.action not in contract["allowed_actions"]:
        raise ValueError("action_not_allowed")
    receipt = Path(args.receipt).resolve()
    run_dir = Path(contract["run_dir"]).resolve()
    if run_dir not in receipt.parents or not receipt.is_file():
        raise ValueError("receipt_not_in_run_dir")
    entry = {
        "at": datetime.now(timezone.utc).isoformat(),
        "action": args.action,
        "outcome": args.outcome,
        "receipt": str(receipt),
        "receipt_sha256": sha256_file(receipt),
        "contract_fingerprint_sha256": contract["contract_fingerprint_sha256"],
    }
    with (run_dir / "task-action-ledger.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create_parser = sub.add_parser("create")
    create_parser.add_argument("--run-dir", required=True)
    create_parser.add_argument("--manifest", required=True)
    create_parser.add_argument("--identity", required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--contract", required=True)
    record_parser = sub.add_parser("record")
    record_parser.add_argument("--contract", required=True)
    record_parser.add_argument("--action", required=True)
    record_parser.add_argument("--outcome", choices=("succeeded", "failed", "unknown"), required=True)
    record_parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            result = create(args)
        elif args.command == "verify":
            result = verify(Path(args.contract).resolve())
        else:
            result = record(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}:{exc}"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
