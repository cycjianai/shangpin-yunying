#!/usr/bin/env python3
"""Validate shared browser/page/memory admission for every product-governance platform."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
POLICY_PATH = ROOT / "runtime_resource_policy.json"


def load_policy() -> dict[str, Any]:
    payload = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if payload.get("schema") != "product-governance-runtime-resource-policy-v1":
        raise ValueError("runtime_resource_policy_schema_invalid")
    page = payload.get("page_budget") or {}
    if page.get("scale_steps") != [1, 2, 4] or int(page.get("max_writer_pages") or 0) != 4:
        raise ValueError("runtime_resource_policy_page_budget_invalid")
    return payload


def integer(metrics: dict[str, Any], key: str) -> int:
    value = metrics.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"runtime_metric_invalid:{key}")
    return value


def evaluate(metrics: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or load_policy()
    admission = policy["admission"]
    page = policy["page_budget"]
    total = integer(metrics, "total_memory_bytes")
    available = integer(metrics, "mem_available_bytes")
    rss = integer(metrics, "task_process_rss_bytes")
    owned = integer(metrics, "task_owned_live_pages")
    control = integer(metrics, "control_pages")
    writers = integer(metrics, "writer_pages")
    bootstrap = integer(metrics, "bootstrap_pages")
    reasons: list[str] = []
    if total == 0 or available > total:
        reasons.append("host_memory_metrics_invalid")
    required_available = max(
        int(admission["min_mem_available_bytes"]),
        math.ceil(total * float(admission["min_mem_available_ratio"])),
    )
    if available < required_available:
        reasons.append("host_memory_reserve_insufficient")
    rss_limit = admission.get("max_task_process_rss_bytes")
    if rss_limit is not None and rss > int(rss_limit):
        reasons.append("task_process_rss_exceeded")
    if admission.get("require_bounded_runtime") and metrics.get("bounded_runtime") is not True:
        reasons.append("bounded_runtime_required")
    if control > int(page["max_control_pages"]):
        reasons.append("control_page_budget_exceeded")
    if writers > int(page["max_writer_pages"]):
        reasons.append("writer_page_budget_exceeded")
    if writers not in {0, *map(int, page["scale_steps"])}:
        reasons.append("writer_page_scale_invalid")
    if bootstrap > int(page["max_bootstrap_pages"]):
        reasons.append("bootstrap_page_budget_exceeded")
    if page.get("bootstrap_must_close_before_writer") and bootstrap and writers:
        reasons.append("bootstrap_and_writer_overlap")
    if owned > control + writers + bootstrap:
        reasons.append("task_owned_page_count_unexplained")
    if metrics.get("runtime_pressure_observed") is True and writers > 1:
        reasons.append("pressure_requires_single_writer")
    return {
        "schema": "product-governance-runtime-resource-admission-v1",
        "admitted": not reasons,
        "reasons": reasons,
        "required_mem_available_bytes": required_available,
        "observed_mem_available_bytes": available,
        "writer_pages": writers,
        "task_owned_live_pages": owned,
        "policy_version": policy["policy_version"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--metrics", required=True)
    validate.add_argument("--output", required=True)
    args = parser.parse_args()
    metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))
    result = evaluate(metrics)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["admitted"] else 75


if __name__ == "__main__":
    raise SystemExit(main())
