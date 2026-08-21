#!/usr/bin/env python3
"""Build and verify QNH copy-history retry manifests and readback mappings."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

from openpyxl import load_workbook


SKILL_ROOT = Path(__file__).resolve().parents[4]
SCRIPTS_ROOT = SKILL_ROOT / "scripts"
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from qnh_task_contract import read_ledger, verify_contract  # noqa: E402


MANIFEST_SCHEMA = "qnh-copy-history-failure-manifest-v1"
MAPPING_SCHEMA = "qnh-copy-history-mapping-v1"
READBACK_SCHEMA = "qnh-copy-platform-readback-v1"
WORKBOOK_VALIDATION_SCHEMA = "qnh-copy-mapping-workbook-validation-v1"
HANDOFF_SCHEMA = "qnh-copy-mapping-handoff-v1"
MAPPING_COLUMNS = [
    "旧SPU",
    "旧SKU ID",
    "旧商品条码",
    "旧商品名称",
    "旧商品规格",
    "目标SPU ID",
    "目标SKU ID",
    "目标商品条码",
    "处理结果",
]


class AdapterError(RuntimeError):
    """Stable, low-sensitive copy adapter failure."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_values(values: Iterable[str]) -> str:
    return hashlib.sha256("\n".join(sorted(set(values))).encode("utf-8")).hexdigest()


def id_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return re.sub(r"\.0$", "", str(value).strip())


def load_rows(path: Path, sheet_name: str) -> tuple[list[str], list[dict[str, Any]]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        if sheet_name not in workbook.sheetnames:
            raise AdapterError(f"sheet_missing:{sheet_name}")
        sheet = workbook[sheet_name]
        iterator = sheet.iter_rows(values_only=True)
        try:
            header = [str(value or "").strip() for value in next(iterator)]
        except StopIteration as exc:
            raise AdapterError(f"sheet_empty:{sheet_name}") from exc
        rows = [dict(zip(header, values, strict=False)) for values in iterator]
        return header, rows
    finally:
        workbook.close()


def manifest_from_error_rows(
    header: list[str], rows: list[dict[str, Any]], *, source_path: Path
) -> dict[str, Any]:
    required = {"复制SPU", "错误类型", "错误信息", "重试次数"}
    missing = sorted(required - set(header))
    if missing:
        raise AdapterError("error_sheet_header_missing:" + ",".join(missing))
    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        old_spu = id_text(row.get("复制SPU"))
        error_type = str(row.get("错误类型") or "").strip()
        if not old_spu or "新增失败" not in error_type or old_spu in seen:
            continue
        seen.add(old_spu)
        products.append(
            {
                "spu_id": old_spu,
                "failure_type": error_type,
                "diagnostic_type": str(row.get("诊断类型") or "").strip(),
                "error": str(row.get("错误信息") or "").strip(),
                "retry_count": int(row.get("重试次数") or 0),
            }
        )
    if not products:
        raise AdapterError("no_failed_copy_spu")
    return {
        "schema": MANIFEST_SCHEMA,
        "source_path": str(source_path.resolve()),
        "source_sha256": sha256_file(source_path),
        "source_failed_count": len(products),
        "source_spu_set_sha256": sha256_values(item["spu_id"] for item in products),
        "products": products,
    }


def mapping_from_result_rows(
    header: list[str], rows: list[dict[str, Any]], *, manifest: dict[str, Any], source_path: Path
) -> dict[str, Any]:
    missing = [column for column in MAPPING_COLUMNS if column not in header]
    if missing:
        raise AdapterError("mapping_header_missing:" + ",".join(missing))
    allowed = {id_text(item.get("spu_id")) for item in manifest.get("products") or []}
    output: list[dict[str, str]] = []
    outside: set[str] = set()
    for row in rows:
        old_spu = id_text(row.get("旧SPU"))
        if not old_spu:
            continue
        if old_spu not in allowed:
            outside.add(old_spu)
            continue
        item = {
            "old_spu": old_spu,
            "old_sku_id": id_text(row.get("旧SKU ID")),
            "old_barcode": id_text(row.get("旧商品条码")),
            "old_product_name": str(row.get("旧商品名称") or "").strip(),
            "old_product_spec": str(row.get("旧商品规格") or "").strip(),
            "target_spu_id": id_text(row.get("目标SPU ID")),
            "target_sku_id": id_text(row.get("目标SKU ID")),
            "target_barcode": id_text(row.get("目标商品条码")),
            "result": str(row.get("处理结果") or "").strip(),
        }
        output.append(item)
    if outside:
        raise AdapterError("mapping_contains_non_manifest_spu:" + ",".join(sorted(outside)))
    if not output:
        raise AdapterError("mapping_has_no_rows")
    return {
        "schema": MAPPING_SCHEMA,
        "source_result_path": str(source_path.resolve()),
        "source_result_sha256": sha256_file(source_path),
        "manifest_sha256": hashlib.sha256(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
        "product_count": len({row["old_spu"] for row in output}),
        "sku_count": len(output),
        "rows": output,
    }


def validate_mapping(
    manifest: dict[str, Any], mapping: dict[str, Any], *, allow_subset: bool
) -> dict[str, Any]:
    issues: list[str] = []
    if manifest.get("schema") != MANIFEST_SCHEMA:
        issues.append("manifest_schema_mismatch")
    if mapping.get("schema") != MAPPING_SCHEMA:
        issues.append("mapping_schema_mismatch")
    source_spus = {id_text(item.get("spu_id")) for item in manifest.get("products") or []}
    rows = mapping.get("rows") or []
    mapped_spus = {id_text(row.get("old_spu")) for row in rows}
    outside = sorted(mapped_spus - source_spus)
    missing = sorted(source_spus - mapped_spus)
    if outside:
        issues.append("non_manifest_spu:" + ",".join(outside))
    if missing and not allow_subset:
        issues.append("missing_spu:" + ",".join(missing))
    target_by_old: dict[str, set[str]] = {}
    old_by_target: dict[str, set[str]] = {}
    seen_skus: set[tuple[str, str]] = set()
    for index, row in enumerate(rows, start=1):
        old_spu = id_text(row.get("old_spu"))
        target_spu = id_text(row.get("target_spu_id"))
        target_sku = id_text(row.get("target_sku_id"))
        target_barcode = id_text(row.get("target_barcode"))
        result = str(row.get("result") or "")
        if not all((old_spu, target_spu, target_sku, target_barcode)):
            issues.append(f"row_{index}_required_id_missing")
        if "失败" in result:
            issues.append(f"row_{index}_result_failed")
        target_by_old.setdefault(old_spu, set()).add(target_spu)
        old_by_target.setdefault(target_spu, set()).add(old_spu)
        sku_key = (target_spu, target_sku)
        if sku_key in seen_skus:
            issues.append(f"row_{index}_duplicate_target_sku")
        seen_skus.add(sku_key)
    for old_spu, targets in sorted(target_by_old.items()):
        if len(targets - {""}) != 1:
            issues.append(f"old_spu_has_multiple_targets:{old_spu}")
    for target_spu, old_spus in sorted(old_by_target.items()):
        if target_spu and len(old_spus) != 1:
            issues.append(f"target_spu_reused:{target_spu}")
    return {
        "valid": not issues,
        "allow_subset": allow_subset,
        "source_spu_count": len(source_spus),
        "mapped_spu_count": len(mapped_spus),
        "mapped_sku_count": len(rows),
        "missing_spus": missing,
        "outside_spus": outside,
        "issues": issues,
    }


def succeeded_actions(contract: dict[str, Any]) -> set[str]:
    actions: set[str] = set()
    for event in read_ledger(Path(contract["action_ledger_path"])):
        if event.get("action") != "task_action_terminal":
            continue
        payload = event.get("payload") or {}
        if payload.get("outcome") == "succeeded":
            actions.add(str(payload.get("requested_action") or ""))
    return actions


def completion_result(
    contract: dict[str, Any], manifest: dict[str, Any], mapping: dict[str, Any], readback: dict[str, Any]
) -> dict[str, Any]:
    validation = validate_mapping(manifest, mapping, allow_subset=False)
    issues = list(validation["issues"])
    if contract.get("task_mode") != "copy_history_retry":
        issues.append("task_mode_mismatch")
    if contract.get("task_role") != "execution":
        issues.append("task_role_not_execution")
    if readback.get("schema") != READBACK_SCHEMA:
        issues.append("readback_schema_mismatch")
    readback_rows = readback.get("rows") or []
    readback_by_key = {
        (id_text(row.get("target_spu_id")), id_text(row.get("target_sku_id"))): row
        for row in readback_rows
    }
    for index, row in enumerate(mapping.get("rows") or [], start=1):
        key = (id_text(row.get("target_spu_id")), id_text(row.get("target_sku_id")))
        verified = readback_by_key.get(key)
        if not verified or not verified.get("verified"):
            issues.append(f"row_{index}_platform_readback_missing")
            continue
        if id_text(verified.get("target_barcode")) != id_text(row.get("target_barcode")):
            issues.append(f"row_{index}_platform_barcode_mismatch")
    required = set(contract.get("required_success_actions") or [])
    missing_actions = sorted(required - succeeded_actions(contract))
    if missing_actions:
        issues.append("required_actions_missing:" + ",".join(missing_actions))
    return {
        "schema": "qnh-copy-history-completion-gate-v1",
        "complete": not issues,
        "source_spu_count": validation["source_spu_count"],
        "mapped_spu_count": validation["mapped_spu_count"],
        "mapped_sku_count": validation["mapped_sku_count"],
        "platform_readback_count": len(readback_rows),
        "issues": issues,
        "contract_fingerprint_sha256": contract.get("contract_fingerprint_sha256"),
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def command_manifest(args: argparse.Namespace) -> int:
    source = Path(args.source_xlsx).resolve()
    header, rows = load_rows(source, "错误明细")
    payload = manifest_from_error_rows(header, rows, source_path=source)
    if args.expected_count is not None and payload["source_failed_count"] != args.expected_count:
        raise AdapterError(
            f"failed_count_mismatch:{payload['source_failed_count']}!={args.expected_count}"
        )
    write_json(Path(args.output).resolve(), payload)
    print(json.dumps({"ok": True, "failed_spu_count": payload["source_failed_count"]}, ensure_ascii=False))
    return 0


def command_extract_result(args: argparse.Namespace) -> int:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    source = Path(args.result_xlsx).resolve()
    header, rows = load_rows(source, "SKU明细")
    payload = mapping_from_result_rows(header, rows, manifest=manifest, source_path=source)
    write_json(Path(args.output).resolve(), payload)
    print(json.dumps({"ok": True, "product_count": payload["product_count"], "sku_count": payload["sku_count"]}, ensure_ascii=False))
    return 0


def command_validate(args: argparse.Namespace) -> int:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    payload = validate_mapping(manifest, mapping, allow_subset=args.allow_subset)
    write_json(Path(args.output).resolve(), payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["valid"] else 1


def command_completion(args: argparse.Namespace) -> int:
    contract = verify_contract(Path(args.contract).resolve())
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    readback = json.loads(Path(args.readback).read_text(encoding="utf-8"))
    payload = completion_result(contract, manifest, mapping, readback)
    write_json(Path(args.output).resolve(), payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["complete"] else 1


def command_handoff(args: argparse.Namespace) -> int:
    contract = verify_contract(Path(args.contract).resolve())
    workbook = Path(args.workbook).resolve()
    completion = json.loads(Path(args.completion).read_text(encoding="utf-8"))
    validation = json.loads(Path(args.workbook_validation).read_text(encoding="utf-8"))
    issues: list[str] = []
    if contract.get("task_role") != "execution":
        issues.append("task_role_not_execution")
    if not completion.get("complete"):
        issues.append("completion_not_complete")
    if validation.get("schema") != WORKBOOK_VALIDATION_SCHEMA or not validation.get("valid"):
        issues.append("workbook_validation_failed")
    if not workbook.is_file():
        issues.append("workbook_missing")
    else:
        if validation.get("workbook_path") != str(workbook):
            issues.append("workbook_path_mismatch")
        if validation.get("workbook_sha256") != sha256_file(workbook):
            issues.append("workbook_sha256_mismatch")
    if validation.get("columns") != MAPPING_COLUMNS:
        issues.append("workbook_columns_mismatch")
    if int(validation.get("product_count") or 0) != int(completion.get("source_spu_count") or -1):
        issues.append("workbook_product_count_mismatch")
    if not validation.get("visual_verified"):
        issues.append("workbook_visual_not_verified")
    payload = {
        "schema": HANDOFF_SCHEMA,
        "ready": not issues,
        "workbook_path": str(workbook),
        "workbook_sha256": sha256_file(workbook) if workbook.is_file() else None,
        "issues": issues,
    }
    write_json(Path(args.output).resolve(), payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["ready"] else 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    manifest = sub.add_parser("manifest")
    manifest.add_argument("--source-xlsx", required=True)
    manifest.add_argument("--expected-count", type=int)
    manifest.add_argument("--output", required=True)
    extract = sub.add_parser("extract-result")
    extract.add_argument("--result-xlsx", required=True)
    extract.add_argument("--manifest", required=True)
    extract.add_argument("--output", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--manifest", required=True)
    validate.add_argument("--mapping", required=True)
    validate.add_argument("--allow-subset", action="store_true")
    validate.add_argument("--output", required=True)
    completion = sub.add_parser("completion")
    completion.add_argument("--contract", required=True)
    completion.add_argument("--manifest", required=True)
    completion.add_argument("--mapping", required=True)
    completion.add_argument("--readback", required=True)
    completion.add_argument("--output", required=True)
    handoff = sub.add_parser("handoff")
    handoff.add_argument("--contract", required=True)
    handoff.add_argument("--completion", required=True)
    handoff.add_argument("--workbook", required=True)
    handoff.add_argument("--workbook-validation", required=True)
    handoff.add_argument("--output", required=True)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "manifest":
            return command_manifest(args)
        if args.command == "extract-result":
            return command_extract_result(args)
        if args.command == "validate":
            return command_validate(args)
        if args.command == "completion":
            return command_completion(args)
        if args.command == "handoff":
            return command_handoff(args)
        raise AdapterError("unknown_command")
    except (AdapterError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
