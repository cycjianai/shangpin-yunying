#!/usr/bin/env python3
"""Load and validate the single-source QNH qualification-image policy."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any


POLICY_PATH = Path(__file__).with_name("qualification_image_policy.json")
POLICY_SCHEMA = "qnh-qualification-image-policy-v1"


class QualificationImagePolicyError(ValueError):
    """The canonical qualification-image policy is missing or malformed."""


def _require_mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QualificationImagePolicyError(f"policy section must be an object: {name}")
    return value


def _require_positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise QualificationImagePolicyError(f"policy value must be a positive integer: {name}")
    return value


@lru_cache(maxsize=1)
def load_qualification_image_policy() -> dict[str, Any]:
    try:
        payload = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise QualificationImagePolicyError(f"cannot load policy: {POLICY_PATH}") from exc
    policy = _require_mapping(payload, "root")
    if policy.get("schema") != POLICY_SCHEMA:
        raise QualificationImagePolicyError("qualification-image policy schema mismatch")
    generation = _require_mapping(policy.get("generation"), "generation")
    _require_mapping(policy.get("asset_builders"), "asset_builders")
    _require_mapping(policy.get("post_generation_gates"), "post_generation_gates")
    authentic = _require_mapping(policy.get("authentic_evidence"), "authentic_evidence")
    candidate_selection = _require_mapping(
        policy.get("candidate_selection"), "candidate_selection"
    )
    _require_mapping(policy.get("writeback"), "writeback")
    _require_mapping(policy.get("external_call_default_budgets"), "external_call_default_budgets")
    minimum = _require_positive_int(generation.get("minimum_concurrency"), "minimum_concurrency")
    maximum = _require_positive_int(generation.get("maximum_concurrency"), "maximum_concurrency")
    if minimum > maximum:
        raise QualificationImagePolicyError("minimum_concurrency exceeds maximum_concurrency")
    ocr_minimum = _require_positive_int(
        authentic.get("minimum_ocr_workers"), "minimum_ocr_workers"
    )
    ocr_maximum = _require_positive_int(
        authentic.get("maximum_ocr_workers"), "maximum_ocr_workers"
    )
    if ocr_minimum > ocr_maximum:
        raise QualificationImagePolicyError(
            "minimum_ocr_workers exceeds maximum_ocr_workers"
        )
    candidate_minimum = _require_positive_int(
        candidate_selection.get("minimum_concurrency"),
        "candidate_selection.minimum_concurrency",
    )
    candidate_maximum = _require_positive_int(
        candidate_selection.get("maximum_concurrency"),
        "candidate_selection.maximum_concurrency",
    )
    if candidate_minimum > candidate_maximum:
        raise QualificationImagePolicyError(
            "candidate selection minimum concurrency exceeds maximum"
        )
    candidate_default = _require_positive_int(
        candidate_selection.get("default_concurrency"),
        "candidate_selection.default_concurrency",
    )
    if not candidate_minimum <= candidate_default <= candidate_maximum:
        raise QualificationImagePolicyError(
            "candidate selection default concurrency is outside its bounds"
        )
    if not authentic.get("picture_kind_rules") or not authentic.get("ocr_rules"):
        raise QualificationImagePolicyError(
            "authentic evidence picture-kind and OCR rules cannot be empty"
        )
    _require_positive_int(generation.get("default_batch_limit"), "default_batch_limit")
    if not generation.get("required_job_fields"):
        raise QualificationImagePolicyError("required_job_fields cannot be empty")
    if not generation.get("allowed_picture_types"):
        raise QualificationImagePolicyError("allowed_picture_types cannot be empty")
    allowed_types = {int(item) for item in generation["allowed_picture_types"]}
    writeback_types = {
        int(item) for item in policy["writeback"].get("allowed_generated_picture_types") or []
    }
    if allowed_types != writeback_types:
        raise QualificationImagePolicyError(
            "generation and writeback allowed picture types must match"
        )
    formal_assets = policy["asset_builders"].get("formal_assets") or {}
    configured_builder_types = {
        int(item["default_type"])
        for item in formal_assets.values()
        if isinstance(item, dict) and item.get("default_type") is not None
    }
    nutrition = _require_mapping(
        policy["asset_builders"].get("nutrition"),
        "asset_builders.nutrition",
    )
    configured_builder_types.add(int(nutrition["picture_type"]))
    if not configured_builder_types.issubset(allowed_types):
        raise QualificationImagePolicyError(
            "asset builder picture types must be allowed by generation policy"
        )
    return policy


def qualification_default_budgets() -> dict[str, int]:
    policy = load_qualification_image_policy()
    budgets = _require_mapping(
        policy.get("external_call_default_budgets"),
        "external_call_default_budgets",
    )
    return {str(key): int(value) for key, value in budgets.items()}


def _text(value: object, limit: int = 2000) -> str:
    return " ".join(str(value or "").split())[:limit]


def validate_qualification_generation_job(job: dict[str, Any]) -> None:
    """Apply the canonical pre-submit restrictions to one generation job."""
    generation = load_qualification_image_policy()["generation"]
    for required in generation["required_job_fields"]:
        if not _text(job.get(str(required))):
            raise QualificationImagePolicyError(f"job missing {required}")
    try:
        picture_type = int(_text(job.get("picture_type"), 64))
    except ValueError as exc:
        raise QualificationImagePolicyError("job has invalid picture_type") from exc
    if picture_type not in {int(item) for item in generation["allowed_picture_types"]}:
        raise QualificationImagePolicyError(
            "picture_type is not allowed by qualification image policy"
        )
    scanned_values: list[str] = []
    for field in generation["content_scan_fields"]:
        value = job.get(str(field))
        if isinstance(value, list):
            scanned_values.extend(_text(item, 500) for item in value)
        else:
            scanned_values.append(_text(value))
    content = " ".join(scanned_values).lower()
    prohibited = generation["prohibited_legal_content"]
    if any(str(token).lower() in content for token in prohibited["tokens"]) or any(
        re.search(str(pattern), content, re.IGNORECASE)
        for pattern in prohibited["regexes"]
    ):
        raise QualificationImagePolicyError(str(prohibited["message"]))
    for required in generation["required_nonempty_list_fields"]:
        value = job.get(str(required))
        if not isinstance(value, list) or not [
            _text(item, 120) for item in value if _text(item, 120)
        ]:
            raise QualificationImagePolicyError(f"job missing {required}")
