#!/usr/bin/env python3
"""Return the minimum platform/task references required for one request."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = Path(__file__).with_name("capability_registry.json")

PLATFORMS = ("qnh", "meituan", "eleme", "aoxiang", "taobao_flash")
TASKS = (
    "channel_attributes_only",
    "unavailable_one_pass",
    "qualification_images_only",
    "plugin_attribute_fill",
    "copy_history_retry",
    "copy_conflict_reconciliation",
    "price_push",
    "product_editing",
    "medical_device_store_migration",
    "protected_request_maintenance",
)
INTENTS = ("auto", "review", "diagnosis", "implementation", "execution")


def load_registry() -> dict[str, Any]:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def validate_registry(registry: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    statuses = set(registry.get("capability_statuses") or [])
    if statuses != {"implemented", "runtime_guided", "planned"}:
        errors.append("capability_statuses_invalid")
    for path in registry.get("shared", {}).get("execution_references", []):
        if not (ROOT / path).is_file():
            errors.append(f"missing_reference:{path}")
    for path in registry.get("shared", {}).get("output_references", []):
        if not (ROOT / path).is_file():
            errors.append(f"missing_reference:{path}")
    for path in registry.get("shared", {}).get("diagnosis_references", []):
        if not (ROOT / path).is_file():
            errors.append(f"missing_reference:{path}")
    platforms = registry.get("platforms") or {}
    if set(platforms) != set(PLATFORMS):
        errors.append("platform_registry_mismatch")
    for platform, platform_spec in platforms.items():
        adapter_reference = str(platform_spec.get("adapter_reference") or "")
        if not adapter_reference or not (ROOT / adapter_reference).is_file():
            errors.append(f"missing_platform_reference:{platform}:{adapter_reference}")
        for task, task_spec in (platform_spec.get("tasks") or {}).items():
            if task not in TASKS:
                errors.append(f"unknown_task:{platform}:{task}")
            if task_spec.get("status") not in statuses:
                errors.append(f"unknown_status:{platform}:{task}")
            paths = [task_spec.get("task_reference"), *(task_spec.get("detail_references") or [])]
            for path in paths:
                if not path or not (ROOT / str(path)).is_file():
                    errors.append(f"missing_task_reference:{platform}:{task}:{path}")
    return errors


def contains(text: str, *patterns: str) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def infer_platform(request_text: str, page_url: str) -> tuple[str | None, list[str]]:
    text = f"{request_text}\n{page_url}".lower()
    candidates: set[str] = set()

    if contains(text, r"牵牛花", r"\bqnh\b", r"/qnh-gw3/", r"qnh\.meituan\.com"):
        candidates.add("qnh")
    if contains(text, r"翱象", r"saas-retail\.ele\.me", r"tc-supply-chain-portal\.ele\.me"):
        candidates.add("aoxiang")
    if contains(text, r"美团", r"yiyao\.meituan\.com", r"\bmeituan\b"):
        candidates.add("meituan")
    if contains(text, r"饿了么", r"\beleme\b", r"(?<!saas-retail)(?<!portal)\.ele\.me"):
        candidates.add("eleme")
    if contains(text, r"淘宝闪购直连", r"淘宝闪购商家平台", r"taobao[_ -]?flash"):
        candidates.add("taobao_flash")

    # QNH/Aoxiang requests often name the downstream Meituan/Eleme channels.
    # An explicit management-platform signal owns the session and adapter.
    if "aoxiang" in candidates:
        candidates.discard("eleme")
        candidates.discard("meituan")
    # QNH may be hosted under a Meituan-owned domain and may manage Meituan/Eleme
    # channels, but it never uses either direct-platform adapter.
    if "qnh" in candidates:
        candidates.discard("meituan")
        candidates.discard("eleme")
    ordered = [item for item in PLATFORMS if item in candidates]
    return (ordered[0] if len(ordered) == 1 else None, ordered)


def infer_task(request_text: str) -> tuple[str | None, list[str]]:
    text = request_text.lower()
    candidates: set[str] = set()

    if contains(text, r"403", r"h5guard", r"\ba9\b", r"受保护请求", r"成本同步", r"保质期", r"健康检查"):
        candidates.add("protected_request_maintenance")
    if contains(text, r"医疗器械", r"买药") and contains(text, r"整店", r"迁移", r"搬店", r"分类复制", r"全店备份"):
        candidates.add("medical_device_store_migration")
    if contains(text, r"原点搬品助手", r"搬品历史", r"历史.*新增失败", r"失败.*重新新增"):
        candidates.add("copy_history_retry")
    if contains(text, r"新增前后映射", r"搬品.*冲突.*复核", r"名称变化.*条形码变化", r"末尾.*(?:1|一).*回退", r"一样的商品sku"):
        candidates.add("copy_conflict_reconciliation")
    if contains(text, r"调价", r"价格推送", r"目标价", r"target_price", r"活动价", r"修改原价"):
        candidates.add("price_push")
    if contains(text, r"店内码", r"商品名称编辑", r"修改商品名", r"修改规格", r"修改条码", r"商品信息编辑"):
        candidates.add("product_editing")
    if contains(text, r"资质图", r"专项图", r"配料营养图", r"背签图", r"3c证书", r"吊牌", r"洗唛"):
        candidates.add("qualification_images_only")
    if contains(text, r"不可售", r"无法售卖", r"审核未通过", r"影响流量", r"清退"):
        candidates.add("unavailable_one_pass")
    if contains(text, r"插件") and contains(text, r"属性", r"填充"):
        candidates.add("plugin_attribute_fill")
    if contains(text, r"渠道属性", r"渠道类目属性", r"类目属性", r"信息填充", r"补齐信息", r"属性.*100%"):
        candidates.add("channel_attributes_only")

    # Composite task signals that are subordinate to a stronger one-pass goal.
    if "medical_device_store_migration" in candidates:
        candidates.discard("product_editing")
    if "copy_history_retry" in candidates:
        candidates.discard("product_editing")
    if "copy_conflict_reconciliation" in candidates:
        candidates.discard("product_editing")
    if "unavailable_one_pass" in candidates and "qualification_images_only" in candidates:
        if contains(text, r"只.*(?:资质图|专项图|背签|营养图|3c)", r"仅.*(?:资质图|专项图|背签|营养图|3c)"):
            candidates.discard("unavailable_one_pass")
        else:
            candidates.discard("qualification_images_only")
    if "plugin_attribute_fill" in candidates:
        candidates.discard("channel_attributes_only")

    ordered = [item for item in TASKS if item in candidates]
    return (ordered[0] if len(ordered) == 1 else None, ordered)


def infer_intent(request_text: str) -> str:
    text = request_text.lower()
    execution = contains(text, r"执行", r"处理", r"填充", r"推送", r"调价", r"迁移", r"新增", r"导入", r"清退")
    implementation = contains(text, r"实现", r"修复代码", r"改代码", r"开发", r"重构")
    diagnosis = contains(text, r"诊断", r"排查", r"为什么", r"报错", r"失败原因")
    review = contains(text, r"解释", r"审查", r"阅读", r"分析", r"对比", r"设计")
    if execution:
        return "execution"
    if implementation:
        return "implementation"
    if diagnosis:
        return "diagnosis"
    if review:
        return "review"
    return "review"


def dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def route(args: argparse.Namespace, registry: dict[str, Any]) -> tuple[dict[str, Any], int]:
    platform = args.platform
    platform_candidates: list[str] = [platform] if platform else []
    if not platform:
        platform, platform_candidates = infer_platform(args.request_text, args.page_url or "")
    if not platform:
        return ({
            "schema": registry["schema_version"],
            "routing_status": "ambiguous_platform",
            "platform_candidates": platform_candidates,
            "task_candidates": [],
            "load_order": [],
            "side_effect_policy": "zero_product_reads_and_zero_writes_until_platform_is_unique",
        }, 2)

    task = args.task
    task_candidates: list[str] = [task] if task else []
    if not task:
        task, task_candidates = infer_task(args.request_text)
    if not task:
        return ({
            "schema": registry["schema_version"],
            "routing_status": "ambiguous_task",
            "platform_adapter": platform,
            "platform_candidates": [platform],
            "task_candidates": task_candidates,
            "load_order": [registry["platforms"][platform]["adapter_reference"]],
            "side_effect_policy": "zero_product_reads_and_zero_writes_until_task_is_unique",
        }, 2)

    platform_spec = registry["platforms"][platform]
    task_spec = (platform_spec.get("tasks") or {}).get(task)
    if task_spec is None:
        return ({
            "schema": registry["schema_version"],
            "routing_status": "unsupported_combination",
            "platform_adapter": platform,
            "platform_display": platform_spec["display_name"],
            "task_mode": task,
            "capability_status": "planned",
            "load_order": [platform_spec["adapter_reference"]],
            "side_effect_policy": "zero_writes_missing_platform_task_adapter",
        }, 2)

    intent = infer_intent(args.request_text) if args.intent == "auto" else args.intent
    load_order = [platform_spec["adapter_reference"], task_spec["task_reference"]]
    if intent == "execution" and task_spec["status"] != "planned":
        load_order.extend(registry["shared"]["execution_references"])
        if task_spec.get("uses_operations_workbook", True):
            load_order.extend(registry["shared"]["output_references"])
        load_order.extend(task_spec.get("detail_references") or [])
    elif intent in {"diagnosis", "implementation"}:
        load_order.extend(task_spec.get("detail_references") or [])
        load_order.extend(registry["shared"]["diagnosis_references"])

    if task_spec["status"] == "planned":
        side_effect_policy = "zero_writes_capability_not_implemented"
    elif intent in {"review", "diagnosis"}:
        side_effect_policy = "read_only"
    elif intent == "implementation":
        side_effect_policy = "local_changes_only_unless_live_canary_is_explicitly_authorized"
    elif task_spec["status"] == "runtime_guided":
        side_effect_policy = "explicit_authorization_plus_current_runtime_evidence_plus_canary_required"
    else:
        side_effect_policy = "explicit_current_task_authorization_and_all_completion_gates_required"

    payload = {
        "schema": registry["schema_version"],
        "routing_status": "ok",
        "platform_adapter": platform,
        "platform_display": platform_spec["display_name"],
        "task_mode": task,
        "intent": intent,
        "capability_status": task_spec["status"],
        "side_effect_policy": side_effect_policy,
        "load_order": dedupe(load_order),
        "optional_references": [
            {
                "path": "references/debugging-and-rollout.md",
                "when": "403/429/5xx/session/signature/identity mismatch/unknown write/materialization delay appears",
            },
            {
                "path": "references/repository-governance.md",
                "when": "the request updates or synchronizes this Skill repository",
            },
        ],
        "progressive_disclosure": {
            "read_only_load_order_now": True,
            "do_not_scan_sibling_platform_or_task_references": True,
            "required_reference_count": len(dedupe(load_order)),
        },
    }
    return payload, 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--request-text", default="")
    result.add_argument("--page-url", default="")
    result.add_argument("--platform", choices=PLATFORMS)
    result.add_argument("--task", choices=TASKS)
    result.add_argument("--intent", choices=INTENTS, default="auto")
    result.add_argument("--validate-registry", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    registry = load_registry()
    errors = validate_registry(registry)
    if args.validate_registry:
        print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=False, indent=2))
        return 0 if not errors else 1
    if errors:
        print(json.dumps({"routing_status": "registry_invalid", "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    if not args.request_text and not (args.platform and args.task):
        print(json.dumps({"routing_status": "request_text_required"}, ensure_ascii=False, indent=2))
        return 2
    payload, exit_code = route(args, registry)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
