"""Shared operator workbook schema for every platform and task module."""

from __future__ import annotations

import json
from pathlib import Path


_SCHEMA = json.loads(
    Path(__file__).with_name("operations_workbook_schema.json").read_text(encoding="utf-8")
)
SCHEMA_VERSION = _SCHEMA["schema_version"]

SUMMARY_SHEET = "执行汇总"
GENERATED_SOURCE_SHEET = "SPU清单"
AUDIT_SHEET = "字段级审计"
MISSING_SHEET = "平台不存在"
VERIFY_SHEET = "最终结构复核"
FEEDBACK_SHEET = "问题与策略回灌"
PERFORMANCE_SHEET = "性能与外部调用统计"

CANONICAL_GENERATED_SHEETS = (
    SUMMARY_SHEET,
    AUDIT_SHEET,
    MISSING_SHEET,
    VERIFY_SHEET,
    FEEDBACK_SHEET,
    PERFORMANCE_SHEET,
)

HEADERS: dict[str, list[str]] = _SCHEMA["headers"]

SOURCE_B_HEADER = "执行前缺失/无效字段"
SOURCE_C_HEADER = "本次实际填充及最终回读"

SUMMARY_METRICS = tuple(_SCHEMA["summary_metrics"])

VERIFY_METRICS = tuple(_SCHEMA["verify_metrics"])
PERFORMANCE_METRICS = tuple(_SCHEMA["performance_metrics"])
