#!/usr/bin/env python3
"""Validate a frozen Chrome-extension action receipt for the task ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
ENGINE = SKILL_ROOT / "scripts/qnh_chrome_extension_engine.mjs"


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=("preflight", "details", "recommendations", "apply-direct-plan", "apply-direct-batch"),
    )
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    receipt_path = Path(args.receipt).resolve()
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    run_dir = Path(str(receipt.get("run_dir") or "")).resolve()
    if receipt_path != run_dir and run_dir not in receipt_path.parents:
        raise SystemExit("extension_receipt_outside_run_dir")
    if receipt.get("schema") != "qnh-chrome-extension-receipt-v1":
        raise SystemExit("extension_receipt_schema_mismatch")
    if receipt.get("command") != args.command:
        raise SystemExit("extension_receipt_command_mismatch")
    if bool(receipt.get("dry_run")) != bool(args.dry_run):
        raise SystemExit("extension_receipt_dry_run_mismatch")
    if receipt.get("outcome") != "succeeded":
        raise SystemExit("extension_receipt_not_succeeded")
    if receipt.get("engine_sha256") != sha256_file(ENGINE):
        raise SystemExit("extension_engine_fingerprint_mismatch")
    artifacts = receipt.get("artifacts") or []
    if not artifacts:
        raise SystemExit("extension_receipt_artifacts_missing")
    for artifact in artifacts:
        artifact_path = Path(str(artifact.get("path") or "")).resolve()
        if artifact_path != run_dir and run_dir not in artifact_path.parents:
            raise SystemExit("extension_artifact_outside_run_dir")
        if not artifact_path.is_file():
            raise SystemExit("extension_artifact_missing")
        if artifact.get("sha256") != sha256_file(artifact_path):
            raise SystemExit("extension_artifact_fingerprint_mismatch")
    print(json.dumps({
        "ok": True,
        "command": args.command,
        "dry_run": args.dry_run,
        "artifact_count": len(artifacts),
        "receipt": str(receipt_path),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
