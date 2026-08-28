#!/usr/bin/env python3
"""Low-sensitive adaptive concurrency controller for bounded QNH batches."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MIN_CONCURRENCY = 1
FIRST_CONCURRENCY = 1
MAX_CONCURRENCY = 4
CONCURRENCY_STEPS = (1, 2, 4)


def step_up(value: int) -> int:
    for candidate in CONCURRENCY_STEPS:
        if candidate > value:
            return candidate
    return MAX_CONCURRENCY


def step_down(value: int) -> int:
    lower = [candidate for candidate in CONCURRENCY_STEPS if candidate < value]
    return lower[-1] if lower else MIN_CONCURRENCY


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def uint_environment(name: str) -> int | None:
    value = os.environ.get(name, "")
    return int(value) if re.fullmatch(r"\d+", value) else None


def mem_available_kib() -> int:
    injected = uint_environment("QNH_ADAPTIVE_TEST_MEM_AVAILABLE_KIB")
    if injected is not None:
        return injected
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])
    raise RuntimeError("MemAvailable unavailable")


def slice_memory_bytes() -> int:
    injected = uint_environment("QNH_ADAPTIVE_TEST_SLICE_MEMORY_BYTES")
    if injected is not None:
        return injected
    result = subprocess.run(
        ["systemctl", "show", "yuandian-automation.slice", "-p", "MemoryCurrent", "--value"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    value = result.stdout.strip()
    if result.returncode != 0 or not value.isdigit():
        raise RuntimeError("automation slice MemoryCurrent unavailable")
    return int(value)


def swap_in_kib_s() -> int:
    injected = uint_environment("QNH_ADAPTIVE_TEST_SWAP_IN_KIB_S")
    if injected is not None:
        return injected

    def pages() -> int:
        for line in Path("/proc/vmstat").read_text(encoding="utf-8").splitlines():
            if line.startswith("pswpin "):
                return int(line.split()[1])
        raise RuntimeError("pswpin unavailable")

    start = pages()
    started = time.monotonic()
    time.sleep(0.25)
    end = pages()
    elapsed = max(0.001, time.monotonic() - started)
    page_kib = os.sysconf("SC_PAGE_SIZE") // 1024
    return max(0, round((end - start) * page_kib / elapsed))


def resource_ceiling(mem_kib: int, slice_bytes: int, swap_kib_s: int) -> tuple[int, str]:
    gib = 1024**3
    if mem_kib < 5 * 1024**2 or slice_bytes >= 4 * gib or swap_kib_s > 1024:
        return 1, "resource_critical"
    if mem_kib < 7 * 1024**2 or slice_bytes >= 2500 * 1024**2 or swap_kib_s > 128:
        return 2, "resource_cautious"
    return 4, "resource_healthy"


def decide(state_path: Path) -> dict[str, Any]:
    state = read_json(state_path)
    mem_kib = mem_available_kib()
    slice_bytes = slice_memory_bytes()
    swap_kib_s = swap_in_kib_s()
    ceiling, resource_reason = resource_ceiling(mem_kib, slice_bytes, swap_kib_s)
    previous = state.get("last_observation") or {}
    validation = state.get("last_validation") or {}
    last_decision = state.get("last_decision") or {}
    prior_concurrency = int(last_decision.get("concurrency") or MIN_CONCURRENCY)
    pressure_ceiling = max(
        MIN_CONCURRENCY,
        min(MAX_CONCURRENCY, int(state.get("pressure_ceiling") or MAX_CONCURRENCY)),
    )

    if not previous:
        proposed = FIRST_CONCURRENCY
        workload_reason = "initial_canary"
    elif int(previous.get("decision_sequence") or 0) != int(last_decision.get("decision_sequence") or 0):
        proposed = prior_concurrency
        workload_reason = "previous_batch_unobserved_hold"
    else:
        selected = int(previous.get("selected_total") or 0)
        failed = int(previous.get("failed") or 0)
        delivered = int(previous.get("verified") or 0) + int(previous.get("no_change") or 0)
        if bool(previous.get("dry_run")):
            delivered += int(previous.get("previewed") or 0)
        p95_ms = int(previous.get("item_p95_ms") or 0)
        peak_rss_bytes = int(
            previous.get("runtime_peak_combined_rss_bytes")
            or previous.get("runtime_peak_rss_bytes")
            or 0
        )
        runtime_memory_pressure_stop = bool(previous.get("runtime_memory_pressure_stop") or False)
        exit_code = int(previous.get("exit_code") or 0)
        validation_recovered = (
            bool(previous.get("batch_name"))
            and previous.get("batch_name") == validation.get("batch_name")
            and int(validation.get("products_with_issues") or 0) == 0
            and int(validation.get("issue_count") or 0) == 0
        )
        if runtime_memory_pressure_stop:
            observed_peak = int(previous.get("runtime_peak_concurrency") or prior_concurrency)
            proposed = step_down(min(prior_concurrency, observed_peak))
            workload_reason = "soft_recycle_step_down"
        elif exit_code == 143 and selected == 0:
            # The task-owned RSS watchdog can stop a short process before the
            # final JSON summary is emitted. Full independent readback then
            # removes already materialized heavy products, so lowering the
            # residual concurrency only wastes capacity without improving the
            # next process's memory shape.
            proposed = prior_concurrency
            workload_reason = "watchdog_recycle_hold"
        elif peak_rss_bytes >= 2400 * 1024**2:
            proposed = step_down(prior_concurrency)
            workload_reason = "process_memory_peak_step_down"
        elif validation_recovered and (failed > 0 or delivered < selected):
            proposed = prior_concurrency
            workload_reason = "independent_validation_recovered_hold"
        elif exit_code != 0 or failed > 0 or delivered < selected:
            proposed = step_down(prior_concurrency)
            workload_reason = "delivery_failure_step_down"
        elif p95_ms > 90_000:
            proposed = step_down(prior_concurrency)
            workload_reason = "latency_critical_step_down"
        elif p95_ms > 60_000:
            proposed = prior_concurrency
            workload_reason = "latency_high_hold"
        else:
            proposed = step_up(prior_concurrency)
            workload_reason = "healthy_step_up"

    concurrency = max(
        MIN_CONCURRENCY,
        min(MAX_CONCURRENCY, ceiling, pressure_ceiling, proposed),
    )
    decision_sequence = int(last_decision.get("decision_sequence") or 0) + 1
    decision = {
        "decided_at": now(),
        "decision_sequence": decision_sequence,
        "concurrency": concurrency,
        "proposed_concurrency": proposed,
        "resource_ceiling": ceiling,
        "pressure_ceiling": pressure_ceiling,
        "reason": f"{workload_reason}:{resource_reason}:pressure_ceiling_{pressure_ceiling}",
        "metrics": {
            "mem_available_mib": mem_kib // 1024,
            "automation_slice_memory_mib": slice_bytes // 1024**2,
            "swap_in_kib_s": swap_kib_s,
        },
    }
    history = list(state.get("decision_history") or [])[-99:]
    history.append(decision)
    state.update({"schema_version": 1, "last_decision": decision, "decision_history": history})
    atomic_write(state_path, state)
    return decision


def observe(
    state_path: Path,
    summary_path: Path,
    exit_code: int,
    batch_name: str,
) -> dict[str, Any]:
    state = read_json(state_path)
    summary = read_json(summary_path)
    observation = {
        "observed_at": now(),
        "decision_sequence": int(state.get("last_decision", {}).get("decision_sequence") or 0),
        "exit_code": exit_code,
        "batch_name": batch_name,
        "selected_total": int(summary.get("selectedTotal") or 0),
        "concurrency": int(summary.get("concurrency") or state.get("last_decision", {}).get("concurrency") or 0),
        "verified": int(summary.get("verified") or 0),
        "no_change": int(summary.get("noChange") or 0),
        "previewed": int(summary.get("previewed") or 0),
        "dry_run": bool(summary.get("dryRun") or False),
        "failed": int(summary.get("failed") or 0),
        "elapsed_ms": int(summary.get("elapsedMs") or 0),
        "throughput_ms_per_product": int(summary.get("throughputAverageMsPerProduct") or 0),
        "item_p95_ms": int(summary.get("itemP95Ms") or 0),
        "runtime_peak_rss_bytes": int(summary.get("runtimePeakRssBytes") or 0),
        "runtime_peak_browser_worker_rss_bytes": int(
            summary.get("runtimePeakBrowserWorkerRssBytes") or 0
        ),
        "runtime_peak_browser_total_rss_bytes": int(
            summary.get("runtimePeakBrowserTotalRssBytes") or 0
        ),
        "runtime_peak_combined_rss_bytes": int(
            summary.get("runtimePeakCombinedRssBytes")
            or summary.get("runtimePeakRssBytes")
            or 0
        ),
        "runtime_peak_concurrency": int(summary.get("runtimePeakConcurrency") or 0),
        "runtime_min_mem_available_kib": int(summary.get("runtimeMinMemAvailableKib") or 0),
        "runtime_final_concurrency": int(summary.get("runtimeFinalConcurrency") or 0),
        "runtime_memory_pressure_stop": bool(summary.get("runtimeMemoryPressureStop") or False),
        "runtime_pressure_observed": bool(summary.get("runtimePressureObserved") or False),
        "runtime_single_worker_gc_count": int(summary.get("runtimeSingleWorkerGcCount") or 0),
        "runtime_single_worker_gc_ms": int(summary.get("runtimeSingleWorkerGcMs") or 0),
        "runtime_single_worker_renderer_gc_count": int(
            summary.get("runtimeSingleWorkerRendererGcCount") or 0
        ),
        "runtime_single_worker_renderer_gc_ms": int(
            summary.get("runtimeSingleWorkerRendererGcMs") or 0
        ),
        "runtime_single_worker_renderer_gc_failures": int(
            summary.get("runtimeSingleWorkerRendererGcFailures") or 0
        ),
    }
    history = list(state.get("observation_history") or [])[-99:]
    history.append(observation)
    if observation["runtime_memory_pressure_stop"] or observation["runtime_pressure_observed"]:
        observed_peak = int(observation.get("runtime_peak_concurrency") or MIN_CONCURRENCY)
        state["pressure_ceiling"] = step_down(observed_peak)
    state.update({"schema_version": 1, "last_observation": observation, "observation_history": history})
    atomic_write(state_path, state)
    return observation


def validate(
    state_path: Path,
    batch_name: str,
    selected_total: int,
    products_with_issues: int,
    issue_count: int,
) -> dict[str, Any]:
    state = read_json(state_path)
    validation = {
        "validated_at": now(),
        "batch_name": batch_name,
        "selected_total": selected_total,
        "products_with_issues": products_with_issues,
        "issue_count": issue_count,
    }
    history = list(state.get("validation_history") or [])[-99:]
    history.append(validation)
    state.update({"schema_version": 1, "last_validation": validation, "validation_history": history})
    atomic_write(state_path, state)
    return validation


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    decide_parser = subparsers.add_parser("decide")
    decide_parser.add_argument("--state", required=True)
    observe_parser = subparsers.add_parser("observe")
    observe_parser.add_argument("--state", required=True)
    observe_parser.add_argument("--summary", required=True)
    observe_parser.add_argument("--exit-code", type=int, required=True)
    observe_parser.add_argument("--batch-name", default="")
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--state", required=True)
    validate_parser.add_argument("--batch-name", required=True)
    validate_parser.add_argument("--selected-total", type=int, required=True)
    validate_parser.add_argument("--products-with-issues", type=int, required=True)
    validate_parser.add_argument("--issue-count", type=int, required=True)
    args = parser.parse_args()
    state = Path(args.state).resolve()
    if args.command == "decide":
        payload = decide(state)
    elif args.command == "observe":
        payload = observe(
            state,
            Path(args.summary).resolve(),
            args.exit_code,
            args.batch_name,
        )
    else:
        payload = validate(
            state,
            args.batch_name,
            args.selected_total,
            args.products_with_issues,
            args.issue_count,
        )
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
