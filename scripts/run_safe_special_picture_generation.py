#!/usr/bin/env python3
"""Run evidence-bound special-picture jobs with durable local provider receipts."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from app.services.toolbox.base import ToolboxError
from app.services.toolbox.qnh_main_image_art import (
    _rank_art_providers_by_runtime_metrics,
    ArtImageAcceptedTaskUnavailable,
    ArtImageProviderUnavailable,
    generate_art_image_with_provider_info,
    query_art_image_task_by_provider,
    resolve_art_image_provider_chain,
)


PROHIBITED_GENERATION_TOKENS = (
    "认证证书",
    "检验报告",
    "备案",
    "注册证",
    "医疗器械",
    "公章",
)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--poll-timeout-seconds", type=int, default=300)
    parser.add_argument("--poll-interval-seconds", type=int, default=15)
    parser.add_argument("--single-provider-submit", action="store_true")
    return parser.parse_args()


def _text(value: object, limit: int = 2000) -> str:
    return " ".join(str(value or "").split())[:limit]


def _job_id(job: dict[str, Any]) -> str:
    identity = "|".join(
        (
            "qnh-safe-special-v1",
            _text(job.get("tenant_scope"), 128),
            _text(job.get("spu_id"), 64),
            _text(job.get("picture_type"), 64),
            _text(job.get("picture_title"), 128),
            _text(job.get("prompt")),
            _text(job.get("reference_image_url"), 2000),
        )
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _validate_job(job: dict[str, Any]) -> None:
    for required in (
        "tenant_scope",
        "spu_id",
        "picture_type",
        "picture_title",
        "prompt",
        "reference_image_url",
        "evidence",
    ):
        if not _text(job.get(required)):
            raise ValueError(f"job missing {required}")
    prompt_blob = f"{job.get('picture_title')} {job.get('prompt')}".lower()
    if (
        re.search(r"(?<![a-z0-9])3c(?![a-z0-9])", prompt_blob, re.IGNORECASE)
        or any(token in prompt_blob for token in PROHIBITED_GENERATION_TOKENS)
    ):
        raise ValueError("法定证照/备案/报告图片禁止进入生成链路")
    expected = job.get("expected_text_tokens")
    if not isinstance(expected, list) or not [_text(item, 120) for item in expected if _text(item, 120)]:
        raise ValueError("job missing expected_text_tokens")


async def _query_existing(
    *,
    receipt: dict[str, Any],
    receipt_path: Path,
    artifact_path: Path,
    poll_timeout_seconds: int,
    poll_interval_seconds: int,
) -> dict[str, Any]:
    provider_key = _text(receipt.get("provider_key"), 80)
    provider_task_id = _text(receipt.get("provider_task_id"), 160)
    if not provider_key or not provider_task_id:
        receipt["status"] = "blocked_missing_provider_receipt"
        _write_json(receipt_path, receipt)
        return receipt
    deadline = time.monotonic() + max(0, poll_timeout_seconds)
    while True:
        try:
            result = await query_art_image_task_by_provider(
                provider_key=provider_key,
                provider_task_id=provider_task_id,
                trace_id=_text(receipt.get("trace_id"), 128),
            )
        except (ArtImageProviderUnavailable, ToolboxError) as exc:
            receipt.update(
                {
                    "status": "query_error",
                    "message": str(exc)[:500],
                    "updated_at": time.time(),
                    "call_type": "query",
                }
            )
            _write_json(receipt_path, receipt)
            return receipt
        receipt.update(
            {
                "status": result.status,
                "message": result.message,
                "updated_at": time.time(),
                "call_type": "query",
                "provider_model": result.provider_model,
            }
        )
        if result.status == "success" and result.image_bytes:
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_path.write_bytes(result.image_bytes)
            os.chmod(artifact_path, 0o600)
            receipt["status"] = "ready"
            receipt["artifact_path"] = str(artifact_path)
            receipt["bytes"] = len(result.image_bytes)
            _write_json(receipt_path, receipt)
            return receipt
        _write_json(receipt_path, receipt)
        if result.status == "failed" or time.monotonic() >= deadline:
            return receipt
        await asyncio.sleep(max(1, poll_interval_seconds))


async def _run_one(
    *,
    job: dict[str, Any],
    output_dir: Path,
    semaphore: asyncio.Semaphore,
    poll_timeout_seconds: int,
    poll_interval_seconds: int,
    single_provider_submit: bool,
) -> dict[str, Any]:
    job_id = _job_id(job)
    receipt_path = output_dir / "receipts" / f"{job_id}.json"
    artifact_path = output_dir / "artifacts" / f"{job_id}.png"
    receipt = _read_json(receipt_path)
    if not receipt.get("provider_task_id"):
        _validate_job(job)
    if receipt.get("status") in {"validation_rejected", "failed"}:
        return receipt
    if receipt.get("status") == "ready" and artifact_path.exists() and artifact_path.stat().st_size:
        return receipt

    async with semaphore:
        if receipt.get("provider_task_id"):
            return await _query_existing(
                receipt=receipt,
                receipt_path=receipt_path,
                artifact_path=artifact_path,
                poll_timeout_seconds=poll_timeout_seconds,
                poll_interval_seconds=poll_interval_seconds,
            )

        trace_id = f"qnh_safe_special_{job_id[:24]}"
        receipt = {
            "job_id": job_id,
            "status": "prepared",
            "call_type": "submit",
            "trace_id": trace_id,
            "tenant_scope": _text(job.get("tenant_scope"), 128),
            "spu_id": _text(job.get("spu_id"), 64),
            "picture_type": _text(job.get("picture_type"), 64),
            "picture_title": _text(job.get("picture_title"), 128),
            "prompt_sha256": hashlib.sha256(_text(job.get("prompt")).encode("utf-8")).hexdigest(),
            "reference_image_url": _text(job.get("reference_image_url"), 2000),
            "evidence": _text(job.get("evidence"), 1000),
            "expected_text_tokens": [
                _text(item, 120)
                for item in job.get("expected_text_tokens") or []
                if _text(item, 120)
            ],
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        _write_json(receipt_path, receipt)

        async def capture(event: dict[str, Any]) -> None:
            current = _read_json(receipt_path) or receipt
            provider_key = _text(event.get("provider_key"), 80)
            provider_model = _text(event.get("provider_model"), 120)
            provider_task_id = _text(
                event.get("provider_task_id")
                or event.get("api_provider_task_id")
                or event.get("task_id"),
                160,
            )
            if provider_key:
                current["provider_key"] = provider_key
            if provider_model:
                current["provider_model"] = provider_model
            if provider_task_id:
                current["provider_task_id"] = provider_task_id
            current["provider_stage"] = _text(event.get("stage"), 64)
            current["updated_at"] = time.time()
            _write_json(receipt_path, current)

        try:
            preferred_provider_key = None
            exclude_provider_keys: set[str] = set()
            if single_provider_submit:
                providers, _ = await resolve_art_image_provider_chain()
                providers = await _rank_art_providers_by_runtime_metrics(
                    providers,
                    trace_id=trace_id,
                )
                if not providers:
                    raise ArtImageProviderUnavailable("没有可用的单一生图渠道")
                preferred_provider_key = str(providers[0].name or "").strip()
                exclude_provider_keys = {
                    str(provider.name or "").strip()
                    for provider in providers[1:]
                    if str(provider.name or "").strip()
                }
                receipt["single_provider_submit"] = True
                receipt["selected_provider_key"] = preferred_provider_key
                _write_json(receipt_path, receipt)
            image_bytes, provider_key = await generate_art_image_with_provider_info(
                _text(job.get("prompt")),
                reference_image_url=_text(job.get("reference_image_url"), 2000),
                trace_id=trace_id,
                provider_state_callback=capture,
                preferred_provider_key=preferred_provider_key,
                exclude_provider_keys=exclude_provider_keys,
                attempt_id=job_id,
                generation_round=1,
                stop_failover_after_provider_task_id=True,
            )
        except ArtImageAcceptedTaskUnavailable as exc:
            current = _read_json(receipt_path) or receipt
            current.update(
                {
                    "status": "pending",
                    "provider_task_id": exc.provider_task_id,
                    "message": str(exc)[:500],
                    "updated_at": time.time(),
                }
            )
            _write_json(receipt_path, current)
            return current
        except (ArtImageProviderUnavailable, ToolboxError) as exc:
            current = _read_json(receipt_path) or receipt
            current.update(
                {
                    "status": "submit_failed",
                    "message": str(exc)[:500],
                    "updated_at": time.time(),
                }
            )
            _write_json(receipt_path, current)
            return current

        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_bytes(image_bytes)
        os.chmod(artifact_path, 0o600)
        current = _read_json(receipt_path) or receipt
        current.update(
            {
                "status": "ready",
                "provider_key": provider_key,
                "provider_stage": "success",
                "artifact_path": str(artifact_path),
                "bytes": len(image_bytes),
                "updated_at": time.time(),
            }
        )
        _write_json(receipt_path, current)
        return current


async def _main() -> None:
    args = _args()
    jobs_payload = json.loads(Path(args.jobs).resolve().read_text(encoding="utf-8"))
    jobs = jobs_payload.get("jobs") if isinstance(jobs_payload, dict) else jobs_payload
    if not isinstance(jobs, list):
        raise ValueError("jobs manifest must contain a jobs list")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(output_dir, 0o700)
    valid_jobs: list[dict[str, Any]] = []
    validation_results: list[dict[str, Any]] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = _job_id(job)
        receipt_path = output_dir / "receipts" / f"{job_id}.json"
        existing = _read_json(receipt_path)
        if existing.get("provider_task_id"):
            valid_jobs.append(job)
            continue
        try:
            _validate_job(job)
        except ValueError as exc:
            rejected = {
                "job_id": job_id,
                "status": "validation_rejected",
                "call_type": "not_sent",
                "trace_id": f"qnh_safe_special_{job_id[:24]}",
                "tenant_scope": _text(job.get("tenant_scope"), 128),
                "spu_id": _text(job.get("spu_id"), 64),
                "picture_type": _text(job.get("picture_type"), 64),
                "picture_title": _text(job.get("picture_title"), 128),
                "message": str(exc)[:500],
                "created_at": existing.get("created_at") or time.time(),
                "updated_at": time.time(),
            }
            _write_json(receipt_path, rejected)
            validation_results.append(rejected)
            continue
        valid_jobs.append(job)
    semaphore = asyncio.Semaphore(max(1, min(10, int(args.concurrency))))
    executed_results = await asyncio.gather(
        *(
            _run_one(
                job=job,
                output_dir=output_dir,
                semaphore=semaphore,
                poll_timeout_seconds=max(0, int(args.poll_timeout_seconds)),
                poll_interval_seconds=max(1, int(args.poll_interval_seconds)),
                single_provider_submit=bool(args.single_provider_submit),
            )
            for job in valid_jobs
        )
    )
    results = [*validation_results, *executed_results]
    counts: dict[str, int] = {}
    for result in results:
        status = _text(result.get("status"), 80) or "unknown"
        counts[status] = counts.get(status, 0) + 1
    summary = {
        "ok": True,
        "job_total": len(results),
        "status_counts": counts,
        "results": results,
    }
    _write_json(output_dir / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
