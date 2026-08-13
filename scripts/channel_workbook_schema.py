"""Canonical workbook topology and headers for QNH channel-attribute runs."""

from __future__ import annotations


SCHEMA_VERSION = "qnh-channel-fill-workbook-v1"

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

HEADERS: dict[str, list[str]] = {
    SUMMARY_SHEET: ["指标", "结果"],
    GENERATED_SOURCE_SHEET: [
        "SPUID",
        "执行前缺失/无效字段",
        "本次实际填充及最终回读",
    ],
    AUDIT_SHEET: [
        "SPU编码",
        "商品名称",
        "渠道",
        "字段ID",
        "字段名",
        "执行前",
        "计划值",
        "最终回读值",
        "结果",
        "来源策略",
    ],
    MISSING_SHEET: ["SPU编码", "平台结果", "处理口径"],
    VERIFY_SHEET: ["指标", "结果"],
    FEEDBACK_SHEET: ["本次新情况", "修正规则", "验证结果"],
    PERFORMANCE_SHEET: ["指标", "结果"],
}

SOURCE_B_HEADER = "执行前缺失/无效字段"
SOURCE_C_HEADER = "本次实际填充及最终回读"

SUMMARY_METRICS = (
    "Excel Schema版本",
    "Skill版本",
    "任务模式",
    "合同指纹SHA256",
    "牵牛花租户名称",
    "源表唯一SPU数",
    "平台现存SPU数",
    "平台记录不存在",
    "现存SPU最终结构合同通过",
    "现存SPU填充率",
    "本次有字段修正的SPU",
    "执行前完整无需修改",
    "唯一字段修正数",
    "字段最终回读通过数",
    "最终字段问题数",
    "OCR调用数",
    "媒体扫描数",
    "条码扫描数",
    "博查调用数",
    "Web搜索调用数",
    "模型调用数",
    "Provider Submit数",
    "Provider Query数",
    "图片上传数",
    "验收口径",
)

VERIFY_METRICS = (
    "最终详情分片",
    "源清单SPU",
    "平台现存SPU",
    "结构合同通过SPU",
    "products_with_issues",
    "issue_count",
    "填充率",
)
