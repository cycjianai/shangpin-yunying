"""Canonical values and validation helpers for the shared seven-sheet workbook."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from decimal import Decimal
from pathlib import Path
from typing import Any


SCRIPTS = Path(__file__).resolve().parent.parent
SCHEMA_PATH = SCRIPTS / "operations_workbook_schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
CONTENT = SCHEMA["content_contract"]

PLATFORM_VALUES: dict[str, str] = CONTENT["platform_values"]
PLATFORM_LABELS = frozenset(PLATFORM_VALUES.values())
TASK_VALUES = frozenset(CONTENT["task_values"])
RESULT_VALUES = frozenset(CONTENT["result_values"])
SOURCE_STRATEGY_VALUES = frozenset(CONTENT["source_strategy_values"])
CHANNEL_VALUES = frozenset(CONTENT["channel_values"])
READBACK_PASS_RESULT_VALUES = frozenset(CONTENT["readback_pass_result_values"])
FIELD_ID_PREFIXES = tuple(CONTENT["field_id_prefixes"])
EMPTY_VALUE = CONTENT["empty_value"]
NOT_APPLICABLE = CONTENT["not_applicable_value"]
UNKNOWN_VALUE = CONTENT["unknown_value"]
FORBIDDEN_LEGACY_CELL_VALUES = frozenset(CONTENT["forbidden_legacy_cell_values"])
PRICE_VALUE_PATTERN = re.compile(CONTENT["price_value_pattern"])

RESULT_ALIASES = {
    "verified": "verified_complete",
    "success": "verified_complete",
    "success_changed": "verified_complete",
    "readback_verified": "verified_complete",
    "no_change": "verified_no_change",
    "already_target": "verified_no_change",
    "missing": "missing_on_platform",
    "materialized_waiting_review": "waiting_platform_review",
    "blocked_without_evidence": "manual_evidence_required",
    "unknown": "pending_verify",
}

SOURCE_ALIASES = {
    "platform_match": "platform_recommendation_validated",
    "official_recommendation": "platform_recommendation_validated",
    "qnh_channel_brand_query": "platform_recommendation_validated",
    "exact_obsolete_category_repair": "platform_recommendation_validated",
    "cross_channel_equivalent": "cross_channel_equivalent_fact",
    "same_spu_cross_channel": "cross_channel_equivalent_fact",
    "same_product_composite": "same_product_master_fact",
    "repair_partial_composite": "same_product_master_fact",
    "title_or_spec_fact": "same_product_master_fact",
    "safe_packaging_reference": "same_product_master_fact",
    "existing_channel_value": "platform_current_fact",
    "same_tenant_channel_snapshot": "platform_current_fact",
    "same_product_media_evidence": "same_product_media_evidence",
    "page_readback_diff": "runtime_readback",
    "safe_non_regulated_default": "deterministic_safe_default",
    "zero_cost_default_matrix": "deterministic_safe_default",
    "zero_cost_empty_option_terminal_fallback": "deterministic_safe_default",
    "qnh_type5_country_tree_contract": "deterministic_safe_default",
    "qnh_no_brand_fallback": "deterministic_safe_default",
    "qnh_type4_brand_without_candidates": "deterministic_safe_default",
    "same_tenant_no_brand_fallback": "deterministic_safe_default",
}


class ContractError(ValueError):
    pass


def platform_label(value: Any) -> str:
    text = str(value or "").strip()
    if text in PLATFORM_VALUES:
        return PLATFORM_VALUES[text]
    if text in PLATFORM_LABELS:
        return text
    raise ContractError(f"platform_value_invalid:{text}")


def task_value(value: Any) -> str:
    text = str(value or "").strip()
    if text not in TASK_VALUES:
        raise ContractError(f"task_value_invalid:{text}")
    return text


def channel_value(value: Any) -> str:
    text = str(value or "").strip()
    if text not in CHANNEL_VALUES:
        raise ContractError(f"channel_value_invalid:{text}")
    return text


def result_value(value: Any) -> str:
    text = str(value or "").strip()
    text = RESULT_ALIASES.get(text, text)
    if text not in RESULT_VALUES:
        raise ContractError(f"result_value_invalid:{text}")
    return text


def source_strategy_value(value: Any) -> str:
    text = str(value or "").strip()
    if text not in SOURCE_STRATEGY_VALUES:
        raise ContractError(f"source_strategy_invalid:{text}")
    return text


def canonical_source_strategy(value: Any, *, fallback: str = "runtime_readback") -> str:
    """Normalize legacy platform evidence labels to the shared source enum."""

    text = str(value or "").strip()
    if text in SOURCE_STRATEGY_VALUES:
        return text
    lowered = text.lower()
    if lowered in SOURCE_ALIASES:
        return SOURCE_ALIASES[lowered]

    keyword_rules = (
        (("真实资料", "人工资料", "manual", "real_evidence"), "manual_evidence_required"),
        (("平台审核", "审核原文", "review_reason"), "platform_review_reason"),
        (("官方注册", "official_registry", "registry"), "official_registry"),
        (("用户提供", "user_provided"), "user_provided_verified"),
        (("插件", "plugin"), "plugin_native_result"),
        (("源店", "source_store", "archive"), "source_store_verified_archive"),
        (("经营策略", "business_strategy"), "business_strategy_result"),
        (("provider", "generated"), "provider_generated_non_regulated"),
        (("deepseek", "llm", "model", "semantic"), "semantic_model_candidate_validated"),
        (("默认", "fallback", "no_brand", "country_tree", "no_upc", "safe_non"), "deterministic_safe_default"),
        (("ocr", "媒体", "原图", "主图", "media"), "same_product_media_evidence"),
        (("跨渠道", "cross_channel", "same_spu_cross"), "cross_channel_equivalent_fact"),
        (("平台候选", "平台匹配", "official_recommendation", "platform_match"), "platform_recommendation_validated"),
        (("标题", "规格", "包装", "same_product", "master_fact"), "same_product_master_fact"),
        (("现有渠道", "当前事实", "existing_channel", "platform_current"), "platform_current_fact"),
        (("回读", "readback", "page_readback"), "runtime_readback"),
    )
    for needles, result in keyword_rules:
        if any(needle in lowered for needle in needles):
            return result
    return source_strategy_value(fallback)


def identifier(value: Any, field: str) -> str:
    if isinstance(value, bool) or not isinstance(value, str):
        raise ContractError(f"identifier_must_be_text:{field}")
    text = value.strip()
    if not text:
        raise ContractError(f"identifier_empty:{field}")
    return text


def field_id(value: Any) -> str:
    text = identifier(value, "field_id")
    if not text.startswith(FIELD_ID_PREFIXES):
        raise ContractError(f"field_id_prefix_invalid:{text}")
    if not re.fullmatch(r"[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+", text):
        raise ContractError(f"field_id_format_invalid:{text}")
    return text


def canonical_segment(value: Any, *, fallback_label: str = "field") -> str:
    """Return one deterministic ASCII identifier segment.

    Human labels remain visible in ``字段名``. Machine ``字段ID`` values use a
    stable digest when the label contains no ASCII token, preventing exporters
    from inventing incompatible transliterations.
    """

    raw = unicodedata.normalize("NFKC", str(value or "").strip())
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", raw.lower()).strip("_-")
    slug = re.sub(r"[_-]{2,}", "_", slug)
    if slug:
        return slug
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{fallback_label}_{digest}"


def canonical_field_id(prefix: str, *segments: Any) -> str:
    """Build and validate a field ID from the shared namespace registry."""

    namespace = str(prefix or "").strip().rstrip(".")
    valid_namespaces = {item.rstrip(".") for item in FIELD_ID_PREFIXES}
    if namespace not in valid_namespaces:
        raise ContractError(f"field_id_namespace_invalid:{namespace}")
    if not segments:
        raise ContractError(f"field_id_segments_empty:{namespace}")
    parts = [canonical_segment(value) for value in segments]
    return field_id(".".join((namespace, *parts)))


def value_text(value: Any, *, role: str) -> str:
    if value is None or value == "" or value == []:
        return EMPTY_VALUE if role == "before" else NOT_APPLICABLE
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, Decimal):
        return format(value, "f")
    text = str(value).strip()
    if not text:
        return EMPTY_VALUE if role == "before" else NOT_APPLICABLE
    return text


def nonempty_text(value: Any, field: str, *, fallback: str | None = None) -> str:
    text = str(value or "").strip()
    if text:
        return text
    if fallback is not None:
        return fallback
    raise ContractError(f"required_text_empty:{field}")


def normalize_event(event: dict[str, Any]) -> dict[str, str]:
    normalized = {
        "spu_id": identifier(event.get("spu_id"), "spu_id"),
        "product_name": nonempty_text(event.get("product_name"), "product_name", fallback=NOT_APPLICABLE),
        "channel": channel_value(event.get("channel") or NOT_APPLICABLE),
        "field_id": field_id(event.get("field_id")),
        "field_name": nonempty_text(event.get("field_name"), "field_name"),
        "before": value_text(event.get("before"), role="before"),
        "planned": value_text(event.get("planned"), role="planned"),
        "readback": value_text(event.get("readback"), role="readback"),
        "result": result_value(event.get("result")),
        "source_strategy": source_strategy_value(event.get("source_strategy")),
    }
    for role in ("before", "planned", "readback"):
        text = normalized[role]
        if text in FORBIDDEN_LEGACY_CELL_VALUES:
            raise ContractError(f"legacy_cell_value_forbidden:{role}:{text}")
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ContractError(f"multivalue_json_invalid:{role}") from exc
            if not isinstance(parsed, list):
                raise ContractError(f"multivalue_not_array:{role}")
            compact = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
            if compact != text:
                raise ContractError(f"multivalue_not_compact:{role}")
    if normalized["field_id"].startswith("price."):
        for role in ("before", "planned", "readback"):
            text = normalized[role]
            if text not in {EMPTY_VALUE, NOT_APPLICABLE, UNKNOWN_VALUE} and not PRICE_VALUE_PATTERN.fullmatch(text):
                raise ContractError(f"price_value_invalid:{role}:{text}")
    return normalized


def integer(value: Any, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise ContractError(f"integer_invalid:{field}")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ContractError(f"integer_invalid:{field}") from exc
    if parsed < minimum:
        raise ContractError(f"integer_below_minimum:{field}:{minimum}")
    return parsed
