#!/usr/bin/env python3
"""Continuously orchestrate one frozen QNH channel-attribute task."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
PYTHON = sys.executable
MAX_MUTATION_WINDOW = 50
MAX_RESIDUAL_ROUNDS = 3
MAX_STAGNANT_ATTEMPTS = 2
MAX_RESOURCE_DEFERRALS = 240
RESOURCE_DEFERRAL_SECONDS = 15
MAX_PREFLIGHT_ATTEMPTS = 3


def now_iso() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def emit(action: str, trace_id: str, payload: dict[str, Any], level: str = "INFO") -> None:
    print(
        json.dumps(
            {
                "timestamp": now_iso(),
                "trace_id": trace_id,
                "level": level,
                "module": "qnh_channel_task_orchestrator",
                "action": action,
                "payload": payload,
                "message": "牵牛花渠道属性连续编排事件",
                "error_stack": "",
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def manifest_spus(document: dict[str, Any]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for item in document.get("products") or []:
        spu_id = str(item.get("spu_id") or item.get("spuId") or "").strip()
        if spu_id and spu_id not in seen:
            seen.add(spu_id)
            output.append(spu_id)
    return output


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) * fraction) + 0.999999) - 1))
    return ordered[index]


class Orchestrator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.contract_path = Path(args.contract).resolve()
        self.contract = read_json(self.contract_path)
        self.run_dir = Path(self.contract["run_dir"]).resolve()
        self.manifest_path = Path(args.manifest).resolve()
        self.manifest = read_json(self.manifest_path)
        self.spus = manifest_spus(self.manifest)
        self.trace_id = f"qnh_channel_orchestrator_{int(time.time())}"
        self.started = time.monotonic()
        self.stages: list[dict[str, Any]] = []
        self.output_workbook: Path | None = None

    def run_action(
        self,
        stage: str,
        action: str,
        command: list[str],
        *,
        env: dict[str, str] | None = None,
        allowed_exit_codes: tuple[int, ...] = (0,),
    ) -> subprocess.CompletedProcess[str]:
        started = time.monotonic()
        emit("stage_started", self.trace_id, {"stage": stage, "action_id": action})
        action_env = {**os.environ, **(env or {})}
        if (
            action == "apply_batch"
            and self.args.concurrency > 2
            and any(Path(token).name == "run_qnh_batch.sh" for token in command)
        ):
            action_env.update({
                "QNH_DIRECT_ADAPTIVE_APPROVED": "1",
                "QNH_DIRECT_MAX_CONCURRENCY": str(self.args.concurrency),
                "QNH_ADAPTIVE_STATE_FILE": str(self.run_dir / "qnh-adaptive-state.json"),
            })
        completed = subprocess.run(
            [
                PYTHON,
                str(SCRIPTS / "run_task_action.py"),
                "--contract",
                str(self.contract_path),
                "--action",
                action,
                "--cwd",
                str(ROOT),
                "--",
                *command,
            ],
            cwd=ROOT,
            env=action_env,
            text=True,
            capture_output=True,
            check=False,
        )
        elapsed_ms = round((time.monotonic() - started) * 1000)
        stage_row = {
            "stage": stage,
            "action_id": action,
            "elapsed_ms": elapsed_ms,
            "exit_code": int(completed.returncode),
        }
        self.stages.append(stage_row)
        emit(
            "stage_finished",
            self.trace_id,
            stage_row,
            "INFO" if completed.returncode in allowed_exit_codes else "ERROR",
        )
        if completed.returncode not in allowed_exit_codes:
            tail = (completed.stderr or completed.stdout)[-1600:]
            raise RuntimeError(f"stage_failed:{stage}:{completed.returncode}:{tail}")
        return completed

    def qnh_command(self, command: str, *extra: str) -> list[str]:
        return [
            "/usr/bin/node",
            str(SCRIPTS / "qnh_direct.mjs"),
            command,
            "--cdp",
            self.args.cdp,
            "--run-dir",
            str(self.run_dir),
            *extra,
        ]

    def batch_command(
        self,
        index_path: Path,
        batch_name: str,
        offset: int,
        limit: int,
        *,
        dry_run: bool,
    ) -> list[str]:
        command = [
            "/usr/bin/bash",
            str(SCRIPTS / "run_qnh_batch.sh"),
            "apply-direct-batch",
            "--cdp",
            self.args.cdp,
            "--run-dir",
            str(self.run_dir),
            "--index",
            str(index_path),
            "--offset",
            str(offset),
            "--limit",
            str(limit),
            "--batch-name",
            batch_name,
            "--concurrency",
            str(self.args.concurrency),
        ]
        if dry_run:
            command.append("--dry-run")
        return command

    @staticmethod
    def ready_plan_rows(index_path: Path) -> list[dict[str, Any]]:
        return [
            row
            for row in (read_json(index_path).get("rows") or [])
            if row.get("status") == "ready" and row.get("plan_path")
        ]

    def run_plan_window(
        self,
        *,
        stage_prefix: str,
        index_path: Path,
        batch_name: str,
        offset: int,
        limit: int,
        dry_run: bool,
    ) -> dict[str, Any]:
        if limit < 1 or limit > MAX_MUTATION_WINDOW:
            raise RuntimeError("mutation_window_limit_exceeded")
        ready_rows = self.ready_plan_rows(index_path)
        selected = ready_rows[offset : offset + limit]
        selected_ids = {str(row.get("spu_id") or "") for row in selected}
        if not selected_ids:
            return {"complete": True, "selected": 0, "terminal": 0, "failed": 0}
        checkpoint_path = self.run_dir / f"{batch_name}-checkpoint.json"
        terminal_statuses = {"previewed", "no_change"} if dry_run else {"verified", "no_change"}
        if checkpoint_path.is_file():
            checkpoint = read_json(checkpoint_path)
            by_spu = {
                str(row.get("spu_id") or ""): row
                for row in (checkpoint.get("rows") or [])
                if str(row.get("spu_id") or "") in selected_ids
            }
            terminal = sum(
                1 for spu_id in selected_ids
                if by_spu.get(spu_id, {}).get("status") in terminal_statuses
            )
            failed = sum(
                1 for spu_id in selected_ids
                if by_spu.get(spu_id, {}).get("status") == "failed"
            )
            if terminal == len(selected_ids):
                emit(
                    "mutation_window_checkpoint_reused",
                    self.trace_id,
                    {
                        "batch_name": batch_name,
                        "offset": offset,
                        "limit": len(selected_ids),
                        "terminal": terminal,
                        "failed": failed,
                        "dry_run": dry_run,
                    },
                )
                return {
                    "complete": True,
                    "selected": len(selected_ids),
                    "terminal": terminal,
                    "failed": failed,
                    "attempts": 0,
                    "resource_deferrals": 0,
                    "checkpoint_reused": True,
                }
        previous_terminal = -1
        stagnant_attempts = 0
        attempts = 0
        resource_deferrals = 0
        launches = 0
        while attempts < len(selected_ids) + MAX_STAGNANT_ATTEMPTS + 1:
            launches += 1
            completed = self.run_action(
                f"{stage_prefix}-a{attempts + 1:02d}-l{launches:03d}",
                "apply_batch",
                self.batch_command(
                    index_path,
                    batch_name,
                    offset,
                    len(selected_ids),
                    dry_run=dry_run,
                ),
                allowed_exit_codes=(0, 75, 76, 77, 143),
            )
            if completed.returncode in {75, 76, 77}:
                resource_deferrals += 1
                emit(
                    "mutation_window_resource_deferred",
                    self.trace_id,
                    {
                        "batch_name": batch_name,
                        "offset": offset,
                        "limit": len(selected_ids),
                        "resource_exit_code": int(completed.returncode),
                        "resource_deferrals": resource_deferrals,
                        "retry_after_seconds": RESOURCE_DEFERRAL_SECONDS,
                    },
                )
                if resource_deferrals >= MAX_RESOURCE_DEFERRALS:
                    break
                time.sleep(RESOURCE_DEFERRAL_SECONDS)
                continue
            attempts += 1
            checkpoint = read_json(checkpoint_path) if checkpoint_path.is_file() else {}
            by_spu = {
                str(row.get("spu_id") or ""): row
                for row in (checkpoint.get("rows") or [])
                if str(row.get("spu_id") or "") in selected_ids
            }
            terminal = sum(
                1 for spu_id in selected_ids
                if by_spu.get(spu_id, {}).get("status") in terminal_statuses
            )
            failed = sum(
                1 for spu_id in selected_ids
                if by_spu.get(spu_id, {}).get("status") == "failed"
            )
            emit(
                "mutation_window_progress",
                self.trace_id,
                {
                    "batch_name": batch_name,
                    "offset": offset,
                    "limit": len(selected_ids),
                    "attempt": attempts,
                    "terminal": terminal,
                    "failed": failed,
                    "dry_run": dry_run,
                },
            )
            if terminal == len(selected_ids):
                return {
                    "complete": True,
                    "selected": len(selected_ids),
                    "terminal": terminal,
                    "failed": failed,
                    "attempts": attempts,
                    "resource_deferrals": resource_deferrals,
                }
            if terminal <= previous_terminal:
                stagnant_attempts += 1
            else:
                stagnant_attempts = 0
            previous_terminal = terminal
            if stagnant_attempts >= MAX_STAGNANT_ATTEMPTS:
                break
        return {
            "complete": False,
            "selected": len(selected_ids),
            "terminal": previous_terminal,
            "failed": sum(
                1 for row in (
                    read_json(checkpoint_path).get("rows")
                    if checkpoint_path.is_file()
                    else []
                ) or []
                if str(row.get("spu_id") or "") in selected_ids
                and row.get("status") == "failed"
            ),
            "attempts": attempts,
            "resource_deferrals": resource_deferrals,
        }

    def run_plan_batches(
        self,
        *,
        stage_prefix: str,
        index_path: Path,
        batch_prefix: str,
        dry_run: bool = False,
        maximum_products: int | None = None,
    ) -> dict[str, Any]:
        ready_count = len(self.ready_plan_rows(index_path))
        selected_total = min(ready_count, maximum_products or ready_count)
        windows = [
            (offset, min(MAX_MUTATION_WINDOW, selected_total - offset))
            for offset in range(0, selected_total, MAX_MUTATION_WINDOW)
        ]
        results = []
        for number, (offset, limit) in enumerate(windows, start=1):
            results.append(self.run_plan_window(
                stage_prefix=f"{stage_prefix}-b{number:04d}",
                index_path=index_path,
                batch_name=f"{batch_prefix}-b{number:04d}",
                offset=offset,
                limit=limit,
                dry_run=dry_run,
            ))
        return {
            "ready": ready_count,
            "selected": selected_total,
            "windows": len(windows),
            "complete_windows": sum(1 for row in results if row.get("complete") is True),
            "deferred_windows": sum(1 for row in results if row.get("complete") is not True),
            "terminal": sum(int(row.get("terminal") or 0) for row in results),
            "failed": sum(int(row.get("failed") or 0) for row in results),
        }

    def build_plans(self, stage: str, details: Path, output_dir: Path) -> int:
        recommendations = self.run_dir / f"official-recommendations-full-c001-initial-{len(self.spus)}.json"
        self.run_action(
            stage,
            "build_channel_plans",
            [PYTHON, str(SCRIPTS / "build_channel_contract_v2_plans.py")],
            env={
                "QNH_RUN_DIR": str(self.run_dir),
                "QNH_DETAILS_PATH": str(details),
                "QNH_RECOMMENDATIONS_PATH": str(recommendations),
                "QNH_PLAN_OUTPUT_DIR": str(output_dir),
            },
        )
        index = read_json(output_dir / "index.json")
        return sum(1 for row in index.get("rows") or [] if row.get("status") == "ready")

    def details_snapshot_complete(self, path: Path) -> bool:
        if not path.is_file():
            return False
        try:
            products = read_json(path).get("products") or []
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        observed = {
            str(row.get("spu_id") or row.get("spuId") or "").strip()
            for row in products
        }
        return observed == set(self.spus) and len(products) == len(self.spus)

    def recommendation_snapshot_complete(self, path: Path) -> bool:
        if not path.is_file():
            return False
        try:
            products = read_json(path).get("products") or []
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        observed = {
            str(row.get("spu_id") or row.get("spuId") or "").strip()
            for row in products
        }
        return observed == set(self.spus) and len(products) == len(self.spus)

    def plan_snapshot_complete(self, output_dir: Path) -> bool:
        index_path = output_dir / "index.json"
        audit_path = output_dir / "audit.json"
        if not index_path.is_file() or not audit_path.is_file():
            return False
        try:
            rows = read_json(index_path).get("rows") or []
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        seen: set[str] = set()
        for row in rows:
            spu_id = str(row.get("spu_id") or "")
            if not spu_id or spu_id in seen or spu_id not in set(self.spus):
                return False
            seen.add(spu_id)
            if row.get("status") == "ready":
                plan_path = Path(str(row.get("plan_path") or ""))
                if not plan_path.is_file() or plan_path.parent.parent != output_dir:
                    return False
        return True

    def validate(self, stage: str, details: Path) -> dict[str, Any]:
        output = self.run_dir / "channel-contract-validation.json"
        self.run_action(
            stage,
            "validate_channel_contracts",
            [
                PYTHON,
                str(SCRIPTS / "validate_channel_contracts.py"),
                "--details",
                str(details),
                "--output",
                str(output),
            ],
            allowed_exit_codes=(0, 1),
        )
        return read_json(output)

    def close_edit_tabs(self, stage: str) -> None:
        self.run_action(
            stage,
            "close_edit_tabs",
            self.qnh_command("close-edit-tabs"),
        )

    def collect_save_metrics(self) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        checkpoints = [
            checkpoint
            for checkpoint in sorted(self.run_dir.glob("*-checkpoint.json"))
            if "-save-" in checkpoint.name
        ]
        for checkpoint in checkpoints:
            payload = read_json(checkpoint)
            for row in payload.get("rows") or []:
                if row.get("status") in {"verified", "no_change", "failed"}:
                    rows.append({**row, "checkpoint": checkpoint.name})
        durations = [int(row.get("duration_ms") or 0) for row in rows]
        return {
            "checkpoint_files": len(checkpoints),
            "rows": len(rows),
            "verified": sum(1 for row in rows if row.get("status") == "verified"),
            "no_change": sum(1 for row in rows if row.get("status") == "no_change"),
            "failed": sum(1 for row in rows if row.get("status") == "failed"),
            "item_p50_ms": round(statistics.median(durations)) if durations else 0,
            "item_p95_ms": percentile(durations, 0.95),
            "max_item_ms": max(durations, default=0),
            "stage_timing_rows": sum(1 for row in rows if row.get("stage_timings")),
        }

    def execute(self) -> dict[str, Any]:
        if self.contract.get("task_mode") != "channel_attributes_only":
            raise RuntimeError("orchestrator_requires_channel_attributes_only")
        if Path(self.contract["source"]["manifest_path"]).resolve() != self.manifest_path:
            raise RuntimeError("manifest_does_not_match_frozen_contract")
        if len(self.spus) != int(self.contract["source"]["source_unique_spu_count"]):
            raise RuntimeError("manifest_count_does_not_match_frozen_contract")
        if self.args.concurrency < 1 or self.args.concurrency > 10:
            raise RuntimeError("concurrency_must_be_between_1_and_10")
        if not 5 <= self.args.dry_run_count <= 10:
            raise RuntimeError("dry_run_count_must_be_between_5_and_10")

        count = len(self.spus)
        for preflight_attempt in range(1, MAX_PREFLIGHT_ATTEMPTS + 1):
            try:
                self.run_action(
                    f"session_preflight_a{preflight_attempt:02d}",
                    "session_preflight",
                    self.qnh_command(
                        "preflight",
                        "--profile-dir",
                        self.args.profile_dir,
                    ),
                )
                break
            except RuntimeError:
                if preflight_attempt >= MAX_PREFLIGHT_ATTEMPTS:
                    raise
                emit(
                    "session_preflight_retry",
                    self.trace_id,
                    {
                        "attempt": preflight_attempt,
                        "maximum_attempts": MAX_PREFLIGHT_ATTEMPTS,
                        "retry_after_seconds": 3,
                    },
                )
                time.sleep(3)
        identity = read_json(self.run_dir / "session_identity.json")
        self.close_edit_tabs("close_edit_tabs_before")

        initial_details = self.run_dir / f"details-full-c001-initial-{count}.json"
        if self.details_snapshot_complete(initial_details):
            emit("stage_checkpoint_reused", self.trace_id, {
                "stage": "read_details_initial", "products": count,
            })
        else:
            self.run_action(
                "read_details_initial",
                "read_details_initial",
                self.qnh_command(
                    "details",
                    "--manifest",
                    str(self.manifest_path),
                    "--limit",
                    str(count),
                    "--offset",
                    "0",
                    "--label",
                    "full-c001-initial",
                ),
            )
        recommendations = self.run_dir / f"official-recommendations-full-c001-initial-{count}.json"
        if self.recommendation_snapshot_complete(recommendations):
            emit("stage_checkpoint_reused", self.trace_id, {
                "stage": "read_recommendations", "products": count,
            })
        else:
            self.run_action(
                "read_recommendations",
                "read_recommendations",
                self.qnh_command(
                    "recommendations",
                    "--details",
                    str(initial_details),
                    "--limit",
                    str(count),
                    "--label",
                    "full-c001-initial",
                ),
            )

        plan_dir = self.run_dir / "full-c001-plans"
        if self.plan_snapshot_complete(plan_dir):
            ready = len(self.ready_plan_rows(plan_dir / "index.json"))
            emit("stage_checkpoint_reused", self.trace_id, {
                "stage": "build_channel_plans", "ready": ready,
            })
        else:
            ready = self.build_plans("build_channel_plans", initial_details, plan_dir)
        if ready:
            canary = min(self.args.dry_run_count, ready)
            canary_result = self.run_plan_batches(
                stage_prefix="dry-run-canary",
                index_path=plan_dir / "index.json",
                batch_prefix="full-c001-dryrun",
                dry_run=True,
                maximum_products=canary,
            )
            if (
                canary_result["complete_windows"] != canary_result["windows"]
                or canary_result["terminal"] != canary_result["selected"]
                or canary_result["failed"] != 0
            ):
                raise RuntimeError("dry_run_canary_incomplete")
            self.run_plan_batches(
                stage_prefix="save-batch",
                index_path=plan_dir / "index.json",
                batch_prefix="full-c001-save",
            )

        residual_round = 0
        stagnant_rounds = 0
        previous_issue_count: int | None = None
        validation: dict[str, Any] = {}
        final_details = initial_details
        while True:
            validation_cycle = residual_round + 1
            validation_label = f"full-c{validation_cycle:03d}-final"
            final_details = self.run_dir / f"details-{validation_label}-{count}.json"
            self.run_action(
                f"read_details_final_r{validation_cycle:02d}",
                "read_details_final",
                self.qnh_command(
                    "details",
                    "--manifest",
                    str(self.manifest_path),
                    "--limit",
                    str(count),
                    "--offset",
                    "0",
                    "--label",
                    validation_label,
                ),
            )
            validation = self.validate(
                f"validate_channel_contracts_r{validation_cycle:02d}",
                final_details,
            )
            issue_count = int(validation.get("issue_count") or 0)
            if issue_count == 0:
                break
            if previous_issue_count is not None and issue_count >= previous_issue_count:
                stagnant_rounds += 1
            else:
                stagnant_rounds = 0
            previous_issue_count = issue_count
            if stagnant_rounds >= MAX_STAGNANT_ATTEMPTS:
                raise RuntimeError("residual_no_progress")
            if residual_round >= MAX_RESIDUAL_ROUNDS:
                raise RuntimeError("final_channel_contract_issues_remain")
            residual_round += 1
            residual_dir = self.run_dir / f"full-c{residual_round:03d}-residual-plans"
            residual_ready = self.build_plans(
                f"build_channel_residual_r{residual_round:02d}",
                final_details,
                residual_dir,
            )
            if not residual_ready:
                raise RuntimeError("residual_issues_without_writable_plan")
            residual_canary = min(self.args.dry_run_count, residual_ready)
            residual_canary_result = self.run_plan_batches(
                stage_prefix=f"dry-run-residual-r{residual_round:02d}",
                index_path=residual_dir / "index.json",
                batch_prefix=f"full-c{residual_round:03d}-residual-dryrun",
                dry_run=True,
                maximum_products=residual_canary,
            )
            if (
                residual_canary_result["complete_windows"]
                != residual_canary_result["windows"]
                or residual_canary_result["terminal"]
                != residual_canary_result["selected"]
                or residual_canary_result["failed"] != 0
            ):
                raise RuntimeError("dry_run_canary_incomplete")
            self.run_plan_batches(
                stage_prefix=f"save-residual-r{residual_round:02d}",
                index_path=residual_dir / "index.json",
                batch_prefix=f"full-c{residual_round:03d}-residual-save",
            )

        output_name = self.run_action(
            "standard_output_name",
            "standard_output_name",
            [
                PYTHON,
                str(SCRIPTS / "standard_output_name.py"),
                "--tenant-name",
                str(identity.get("tenant_name") or "牵牛花租户"),
                "--spu-count",
                str(count),
                "--output-dir",
                str(self.run_dir),
            ],
        )
        output_lines = [line.strip() for line in output_name.stdout.splitlines() if line.strip()]
        if not output_lines:
            raise RuntimeError("standard_output_name_missing")
        self.output_workbook = Path(output_lines[-1]).resolve()

        export_command = [
            PYTHON,
            str(SCRIPTS / "export_standard_channel_fill_workbook.py"),
            "--run-dir",
            str(self.run_dir),
            "--manifest",
            str(self.manifest_path),
            "--task-contract",
            str(self.contract_path),
            "--validation",
            str(self.run_dir / "channel-contract-validation.json"),
            "--tenant-name",
            str(identity.get("tenant_name") or "牵牛花租户"),
            "--output",
            str(self.output_workbook),
        ]
        if self.args.source_xlsx:
            export_command.extend(["--source-xlsx", str(Path(self.args.source_xlsx).resolve())])
        for history_run_dir in self.args.history_run_dir:
            export_command.extend(
                ["--history-run-dir", str(Path(history_run_dir).resolve())]
            )
        self.run_action("export_workbook", "export_workbook", export_command)

        summary_path = self.output_workbook.with_suffix(".summary.json")
        coverage_path = self.output_workbook.with_suffix(".coverage.json")
        workbook_validation = self.run_dir / "workbook-validation.json"
        validate_workbook_command = [
            PYTHON,
            str(SCRIPTS / "validate_standard_channel_fill_workbook.py"),
            "--contract",
            str(self.contract_path),
            "--manifest",
            str(self.manifest_path),
            "--workbook",
            str(self.output_workbook),
            "--summary",
            str(summary_path),
            "--output",
            str(workbook_validation),
        ]
        if self.args.source_xlsx:
            validate_workbook_command.extend(
                ["--source-xlsx", str(Path(self.args.source_xlsx).resolve())]
            )
        self.run_action("validate_workbook", "validate_workbook", validate_workbook_command)
        completion_path = self.run_dir / "task-completion-gate.json"
        self.run_action(
            "completion_gate",
            "completion_gate",
            [
                PYTHON,
                str(SCRIPTS / "qnh_completion_gate.py"),
                "--contract",
                str(self.contract_path),
                "--manifest",
                str(self.manifest_path),
                "--validation",
                str(self.run_dir / "channel-contract-validation.json"),
                "--workbook",
                str(self.output_workbook),
                "--summary",
                str(summary_path),
                "--coverage",
                str(coverage_path),
                "--workbook-validation",
                str(workbook_validation),
                "--output",
                str(completion_path),
            ],
        )
        handoff_path = self.run_dir / "workbook-handoff.json"
        self.run_action(
            "handoff_workbook",
            "handoff_workbook",
            [
                PYTHON,
                str(SCRIPTS / "qnh_workbook_handoff_gate.py"),
                "--contract",
                str(self.contract_path),
                "--workbook",
                str(self.output_workbook),
                "--summary",
                str(summary_path),
                "--completion",
                str(completion_path),
                "--workbook-validation",
                str(workbook_validation),
                "--output",
                str(handoff_path),
            ],
        )
        self.close_edit_tabs("close_edit_tabs_after")

        total_wall_ms = round((time.monotonic() - self.started) * 1000)
        nested_action_ms = sum(int(stage["elapsed_ms"]) for stage in self.stages)
        completion = read_json(completion_path)
        summary = read_json(summary_path)
        result = {
            "schema": "qnh-channel-orchestrator-performance-v1",
            "skill_version": self.contract.get("skill_version"),
            "contract_fingerprint_sha256": self.contract.get(
                "contract_fingerprint_sha256"
            ),
            "complete": completion.get("complete") is True,
            "source_unique_spu": count,
            "platform_extant": completion.get("platform_extant"),
            "missing_on_platform": completion.get("missing_on_platform"),
            "products_with_issues": completion.get("products_with_issues"),
            "issue_count": completion.get("issue_count"),
            "changed_products": summary.get("changed_products"),
            "verified_changed_fields": summary.get("verified_changed_fields"),
            "total_wall_ms": total_wall_ms,
            "nested_action_ms": nested_action_ms,
            "inter_stage_gap_ms": max(0, total_wall_ms - nested_action_ms),
            "stages": self.stages,
            "save_metrics": self.collect_save_metrics(),
            "external_calls": summary.get("external_calls"),
            "workbook": str(self.output_workbook),
            "workbook_handoff": str(handoff_path),
        }
        write_json_atomic(self.run_dir / "orchestrator-performance.json", result)
        emit(
            "task_finished",
            self.trace_id,
            {
                "complete": result["complete"],
                "source_unique_spu": count,
                "issue_count": result["issue_count"],
                "total_wall_ms": total_wall_ms,
                "inter_stage_gap_ms": result["inter_stage_gap_ms"],
            },
        )
        return result


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--contract", required=True)
    value.add_argument("--manifest", required=True)
    value.add_argument("--cdp", required=True)
    value.add_argument("--profile-dir", required=True)
    value.add_argument("--source-xlsx")
    value.add_argument("--history-run-dir", action="append", default=[])
    value.add_argument("--concurrency", type=int, default=2)
    value.add_argument("--dry-run-count", type=int, default=5)
    return value


def main() -> int:
    args = parser().parse_args()
    if args.concurrency < 1 or args.concurrency > 10:
        parser().error("--concurrency 必须在 1 到 10 之间")
    orchestrator = Orchestrator(args)
    try:
        result = orchestrator.execute()
    except Exception as exc:  # noqa: BLE001 - stable boundary for task runner
        if (orchestrator.run_dir / "session_identity.json").is_file():
            try:
                orchestrator.close_edit_tabs("close_edit_tabs_failure")
            except Exception:  # noqa: BLE001 - preserve the primary failure
                pass
        emit(
            "task_failed",
            orchestrator.trace_id,
            {
                "reason_code": str(exc).split(":", 1)[0],
                "stage_count": len(orchestrator.stages),
            },
            "ERROR",
        )
        failure = {
            "schema": "qnh-channel-orchestrator-performance-v1",
            "skill_version": orchestrator.contract.get("skill_version"),
            "complete": False,
            "reason_code": str(exc).split(":", 1)[0],
            "total_wall_ms": round((time.monotonic() - orchestrator.started) * 1000),
            "stages": orchestrator.stages,
        }
        write_json_atomic(orchestrator.run_dir / "orchestrator-performance.json", failure)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("complete") else 1


if __name__ == "__main__":
    raise SystemExit(main())
