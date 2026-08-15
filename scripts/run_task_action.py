#!/usr/bin/env python3
"""Run one canonical QNH action after enforcing its frozen task contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from qnh_task_contract import (
    ContractError,
    SKILL_ROOT,
    append_ledger,
    emit_error,
    guard_action,
    verify_contract,
)


def command_script(command: list[str], expected: Path) -> Path | None:
    for token in command:
        if token.startswith("-"):
            continue
        raw = Path(token)
        candidates = [raw] if raw.is_absolute() else [Path.cwd() / raw, SKILL_ROOT / raw]
        for candidate in candidates:
            try:
                if candidate.resolve() == expected:
                    return expected
            except OSError:
                continue
    return None


def command_digest(command: list[str]) -> str:
    # Persist only a hash; command arguments can contain tenant/run paths.
    payload = json.dumps(command, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--contract", required=True)
    value.add_argument("--action", required=True)
    value.add_argument("--units", type=int, default=0)
    value.add_argument("--cwd")
    value.add_argument("command", nargs=argparse.REMAINDER)
    return value


def main() -> int:
    args = parser().parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    contract_path = Path(args.contract).resolve()
    contract = None
    try:
        contract = verify_contract(contract_path)
        executor = (contract.get("canonical_executors") or {}).get(args.action) or {}
        relative_script = executor.get("script")
        accepted_scripts = [
            item
            for item in [relative_script, *(executor.get("alternate_scripts") or [])]
            if item
        ]
        if not accepted_scripts:
            raise ContractError(f"local_command_not_allowed_for_external_action:{args.action}")
        if not command:
            raise ContractError("canonical_command_required")
        matched_relative_script = None
        resolved_script = None
        for candidate_script in accepted_scripts:
            expected_script = (SKILL_ROOT / candidate_script).resolve()
            resolved_script = command_script(command, expected_script)
            if resolved_script:
                matched_relative_script = candidate_script
                break
        guard = guard_action(
            contract,
            args.action,
            script=resolved_script,
            command_tokens=command,
            units=args.units,
        )
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as exc:
        if contract is not None:
            append_ledger(
                contract,
                {
                    "task_mode": contract.get("task_mode"),
                    "requested_action": args.action,
                    "outcome": "blocked",
                    "reason_code": str(exc).split(":", 1)[0],
                    "units": max(args.units, 0),
                },
            )
        emit_error("qnh_task_action_blocked", str(exc), requested_action=args.action)
        return 2

    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=str(Path(args.cwd).resolve()) if args.cwd else str(SKILL_ROOT),
            env=os.environ.copy(),
            check=False,
        )
        exit_code = int(completed.returncode)
        outcome = "succeeded" if exit_code == 0 else "failed"
    except OSError as exc:
        exit_code = 127
        outcome = "failed"
        emit_error("qnh_task_action_exec_failed", str(exc), requested_action=args.action)

    elapsed_ms = round((time.monotonic() - started) * 1000)
    append_ledger(
        contract,
        {
            "task_mode": contract["task_mode"],
            "requested_action": args.action,
            "outcome": outcome,
            "exit_code": exit_code,
            "elapsed_ms": elapsed_ms,
            "budget_key": guard.get("budget_key"),
            "units": args.units,
            "canonical_script": matched_relative_script,
            "canonical_script_sha256": (
                executor["script_sha256"]
                if matched_relative_script == executor.get("script")
                else (executor.get("alternate_script_sha256") or {}).get(
                    matched_relative_script
                )
            ),
            "command_sha256": command_digest(command),
        },
    )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
