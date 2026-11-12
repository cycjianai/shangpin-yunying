#!/usr/bin/env python3
"""Build conservative direct-CDP UI plans from frozen QNH evidence."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any


EXPLICIT_SUGGESTION_RE = re.compile(
    r"(?:建议|[，,])[“\"](?P<attr>[^”\"]+)[”\"]改为[“\"](?P<value>[^”\"]+)[”\"]"
)
BLOCKING_ISSUE_RE = re.compile(
    r"合规审核|禁售|超出经营范围|3C认证证书编号|生产者（制造商）名称不匹配|"
    r"化妆品备案|质量认证标识|医疗器械|注册证|备案编号"
)
HARD_BLOCKING_ISSUE_RE = re.compile(
    r"合规审核|禁售|超出经营范围|化妆品备案|质量认证标识|医疗器械|注册证|备案编号"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--recommendations", required=True)
    parser.add_argument("--run-dir", required=True)
    return parser.parse_args()


def values_of(prop: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for value in prop.get("customValue") or []:
        if not isinstance(value, dict):
            continue
        direct = str(value.get("attrValue") or "").strip()
        if direct:
            values.append(direct)
        for struct in value.get("structAttrValueList") or []:
            if not isinstance(struct, dict):
                continue
            for combination in struct.get("valueList") or []:
                if not isinstance(combination, list):
                    continue
                parts = []
                for field in sorted(
                    (item for item in combination if isinstance(item, dict)),
                    key=lambda item: int(item.get("sequence") or 0),
                ):
                    part = str(field.get("value") or field.get("optionValue") or "").strip()
                    if part:
                        parts.append(part)
                if parts:
                    values.append("".join(parts))
    return list(dict.fromkeys(values))


def option_map(prop: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(value.get("attrValue") or "").strip(): value
        for value in prop.get("attrValueList") or []
        if isinstance(value, dict) and str(value.get("attrValue") or "").strip()
    }


def issue_text(detail: dict[str, Any]) -> str:
    texts = []
    for channel in detail.get("noSaleChannelInfoList") or []:
        if not isinstance(channel, dict) or int(channel.get("channelId") or 0) != 100:
            continue
        for issue in channel.get("noSaleAbnormalInfoList") or []:
            if isinstance(issue, dict):
                texts.append(str(issue.get("abnormalInfo") or ""))
                texts.append(str(issue.get("abnormalDesc") or ""))
    return "；".join(text for text in texts if text)


def explicit_suggestions(text: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for match in EXPLICIT_SUGGESTION_RE.finditer(text):
        attr = match.group("attr").strip()
        value = match.group("value").strip()
        if attr and value:
            result[attr] = [value]
    return result


def recommendation_map(item: dict[str, Any]) -> dict[str, dict[str, Any]]:
    recommendation = item.get("recommendation") if isinstance(item.get("recommendation"), dict) else {}
    return {
        str(prop.get("attrName") or "").strip(): prop
        for prop in recommendation.get("channelDynamicInfoVOList") or []
        if isinstance(prop, dict) and str(prop.get("attrName") or "").strip()
    }


def struct_units(prop: dict[str, Any]) -> list[str]:
    units: list[str] = []
    for template in prop.get("structAttrTemplateList") or []:
        if not isinstance(template, dict):
            continue
        for field in template.get("valueFormatList") or []:
            if not isinstance(field, dict) or int(field.get("inputType") or 0) != 5:
                continue
            units.extend(
                str(option.get("optionValue") or "").strip()
                for option in field.get("optionList") or []
                if isinstance(option, dict) and str(option.get("optionValue") or "").strip()
            )
    return list(dict.fromkeys(units))


def map_weight_unit(raw: Any, allowed: list[str]) -> str:
    value = str(raw or "").strip().lower()
    candidates = []
    if "千克" in value or "公斤" in value or value == "kg":
        candidates = ["kg", "千克", "公斤"]
    elif "克" in value or value in {"g", "克(g)"}:
        candidates = ["g", "克", "克(g)"]
    elif "毫升" in value or value in {"ml", "毫升(ml)"}:
        candidates = ["mL", "ml", "毫升", "毫升(ml)"]
    elif "升" in value or value == "l":
        candidates = ["L", "l", "升"]
    return next((candidate for candidate in candidates if candidate in allowed), "")


def packaged_evidence(detail: dict[str, Any]) -> bool:
    title = str(detail.get("spuName") or "")
    if re.search(r"袋|盒|瓶|罐|桶|杯|包|支|片|粒|条|个|台|件|套|箱", title):
        return True
    for channel in detail.get("spuChannelInfoList") or []:
        for prop in channel.get("categoryProperties") or []:
            if not isinstance(prop, dict):
                continue
            if str(prop.get("attrName") or "") in {"包装方式", "包装规格"} and values_of(prop):
                return True
    return False


def compact_number(raw: Any) -> str:
    value = str(raw or "").strip()
    return value.rstrip("0").rstrip(".") if "." in value else value


def plausible_weight(raw: Any, unit: Any) -> bool:
    try:
        number = float(str(raw or "").strip())
    except (TypeError, ValueError):
        return False
    value = str(unit or "").strip().lower()
    if "千克" in value or "公斤" in value or value == "kg":
        return 0.001 <= number <= 1000
    if "克" in value or value == "g":
        return 1 <= number <= 1_000_000
    if "毫升" in value or value == "ml":
        return 1 <= number <= 1_000_000
    if "升" in value or value == "l":
        return 0.001 <= number <= 100_000
    return False


def conflicts_with_title(attr_name: str, wanted: list[str], title: str) -> bool:
    if attr_name != "层数" or len(wanted) != 1:
        return False
    title_match = re.search(r"(?<!\d)(\d+)\s*层", title)
    wanted_match = re.fullmatch(r"\s*(\d+)\s*层\s*", wanted[0])
    return bool(
        title_match
        and wanted_match
        and title_match.group(1) != wanted_match.group(1)
    )


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    recommendation_path = Path(args.recommendations).resolve()
    run_dir = Path(args.run_dir).resolve()
    plans_dir = run_dir / "plans-official"
    plans_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(plans_dir, 0o700)

    details_payload = json.loads(details_path.read_text(encoding="utf-8"))
    recommendation_payload = json.loads(recommendation_path.read_text(encoding="utf-8"))
    recommendations = {
        str(item.get("spu_id") or ""): item
        for item in recommendation_payload.get("products") or []
        if isinstance(item, dict)
    }

    index_rows: list[dict[str, Any]] = []
    plan_count = 0
    for product in details_payload.get("products") or []:
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = str(product.get("spu_id") or detail.get("spuId") or "")
        title = str(product.get("title") or detail.get("spuName") or "")
        issue = issue_text(detail)
        channel = next(
            (
                row
                for row in detail.get("spuChannelInfoList") or []
                if isinstance(row, dict) and int(row.get("channelId") or 0) == 100
            ),
            None,
        )
        if not channel:
            index_rows.append(
                {
                    "spu_id": spu_id,
                    "title": title,
                    "status": "blocked",
                    "reason": "美团渠道类目数据为空",
                }
            )
            continue

        recommended = recommendation_map(recommendations.get(spu_id) or {})
        explicit = explicit_suggestions(issue)
        text_fields: dict[str, Any] = {}
        select_fields: dict[str, Any] = {}
        replace_select_fields: list[str] = []
        decisions: list[dict[str, Any]] = []
        unresolved_required: list[str] = []
        for prop in channel.get("categoryProperties") or []:
            if not isinstance(prop, dict):
                continue
            attr_id = str(prop.get("attrId") or "")
            attr_name = str(prop.get("attrName") or "").strip()
            if not attr_id or not attr_name:
                continue
            existing = values_of(prop)
            required_missing = int(prop.get("isRequired") or 0) == 1 and not existing
            requires_correction = (
                attr_name in issue
                and any(fragment in issue for fragment in ("填写错误或未填写", "填写错误", f"建议“{attr_name}”"))
            )
            wanted: list[str] = []
            source = ""
            if attr_name in explicit:
                wanted = explicit[attr_name]
                source = "platform_abnormal_exact_suggestion"
            elif (required_missing or requires_correction) and attr_name in recommended:
                wanted = values_of(recommended[attr_name])
                source = "platform_official_dynamic_recommendation"
            if not wanted:
                if required_missing:
                    unresolved_required.append(attr_name)
                continue
            # Search-like brand inputs do not have the stable attr-id control
            # used by ordinary channel properties. Leave them for an exact
            # brand-directory workflow instead of guessing a DOM id.
            if attr_name == "品牌":
                if required_missing:
                    unresolved_required.append(attr_name)
                continue
            options = option_map(prop)
            if options and any(value not in options for value in wanted):
                if required_missing:
                    unresolved_required.append(attr_name)
                decisions.append(
                    {
                        "field": attr_name,
                        "status": "rejected",
                        "reason": "平台建议值不在当前类目选项中",
                        "candidate": wanted,
                        "source": source,
                    }
                )
                continue
            if not options:
                # Text and structured inputs require a different shape. The
                # official recommendation is retained for later evidence work.
                if required_missing:
                    unresolved_required.append(attr_name)
                decisions.append(
                    {
                        "field": attr_name,
                        "status": "deferred",
                        "reason": "非普通选项字段，需结构化或文本控件计划",
                        "candidate": wanted,
                        "source": source,
                    }
                )
                continue
            if conflicts_with_title(attr_name, wanted, title):
                if required_missing:
                    unresolved_required.append(attr_name)
                decisions.append(
                    {
                        "field": attr_name,
                        "status": "rejected",
                        "reason": "平台建议值与商品标题中的明确数值冲突",
                        "candidate": wanted,
                        "source": source,
                        "evidence": title,
                    }
                )
                continue
            if existing == wanted:
                decisions.append(
                    {
                        "field": attr_name,
                        "attr_id": attr_id,
                        "old_value": existing,
                        "new_value": wanted,
                        "status": "no_change",
                        "source": source,
                        "evidence": issue if source.startswith("platform_abnormal") else title,
                        "reason": "当前值已与平台建议一致，不重复保存",
                    }
                )
                continue
            field_id = f"channelDynamicInfos_0___formData_{attr_id}"
            select_fields[field_id] = wanted if len(wanted) > 1 else wanted[0]
            if existing and existing != wanted:
                replace_select_fields.append(field_id)
            decisions.append(
                {
                    "field": attr_name,
                    "attr_id": attr_id,
                    "old_value": existing,
                    "new_value": wanted,
                    "status": "accepted",
                    "source": source,
                    "evidence": issue if source.startswith("platform_abnormal") else title,
                }
            )

        channels = [
            row
            for row in detail.get("spuChannelInfoList") or []
            if isinstance(row, dict) and row.get("categoryCode")
        ]
        known_values: dict[str, list[str]] = {}
        for source_channel in channels:
            for source_prop in source_channel.get("categoryProperties") or []:
                if not isinstance(source_prop, dict):
                    continue
                attr_name = str(source_prop.get("attrName") or "").strip()
                for value in values_of(source_prop):
                    if attr_name and value not in known_values.setdefault(attr_name, []):
                        known_values[attr_name].append(value)
        skus = [sku for sku in detail.get("skus") or [] if isinstance(sku, dict)]
        unique_sku = skus[0] if len(skus) == 1 else {}
        sku_weight = str(unique_sku.get("weightForUnit") or "").strip()
        sku_weight_unit = str(unique_sku.get("weightUnit") or "").strip()
        if (
            unique_sku
            and sku_weight
            and plausible_weight(sku_weight, sku_weight_unit)
            and re.search(r"商品名称缺少规格或重量（缺少(?:重量|毫升数)", issue)
        ):
            unit_label = (
                "kg"
                if "千克" in sku_weight_unit or "公斤" in sku_weight_unit
                else "g"
                if "克" in sku_weight_unit
                else "ml"
                if "毫升" in sku_weight_unit
                else "L"
                if "升" in sku_weight_unit
                else ""
            )
            normalized_weight = compact_number(sku_weight)
            if unit_label and normalized_weight and not re.search(
                rf"(?<!\d){re.escape(normalized_weight)}\s*{re.escape(unit_label)}\b",
                title,
                re.IGNORECASE,
            ):
                sale_unit = str(unique_sku.get("saleUnit") or "").strip()
                suffix = f"{normalized_weight}{unit_label}"
                if sale_unit and sale_unit not in {"份", "公斤"}:
                    suffix += f"/{sale_unit}"
                new_title = f"{title.rstrip()} {suffix}"
                # 牵牛花当前保存接口按 50 个字符校验商品名；历史超长标题可能仍能展示，
                # 但只要提交任意属性就会被整单驳回。这里不自动拼出超过限制的新标题。
                if len(new_title) <= 50:
                    text_fields["basicInfo_spuName"] = new_title
                    decisions.append(
                        {
                            "field": "商品名称",
                            "old_value": title,
                            "new_value": new_title,
                            "status": "accepted",
                            "source": "platform_abnormal_plus_existing_unique_sku_weight",
                            "evidence": f"SKU {unique_sku.get('skuId')} weight={sku_weight}{sku_weight_unit}",
                        }
                    )
        unresolved_cross_channel: list[str] = []
        for channel_index, target_channel in enumerate(detail.get("spuChannelInfoList") or []):
            if not isinstance(target_channel, dict):
                continue
            channel_id = int(target_channel.get("channelId") or 0)
            if channel_id == 100 or not target_channel.get("categoryCode"):
                continue
            for prop in target_channel.get("categoryProperties") or []:
                if not isinstance(prop, dict):
                    continue
                attr_id = str(prop.get("attrId") or "")
                attr_name = str(prop.get("attrName") or "").strip()
                if not attr_id or not attr_name or int(prop.get("isRequired") or 0) != 1 or values_of(prop):
                    continue
                # Brand inputs are directory searches. “使用全部” often fills
                # an exact official brand; if not, validate-only will retain a
                # blocking error instead of substituting a made-up brand.
                if attr_name == "品牌":
                    unresolved_cross_channel.append(f"{channel_id}:{attr_name}")
                    continue
                options = option_map(prop)
                wanted: list[str] = []
                source = ""
                preferred_candidates = [
                    *(explicit.get(attr_name) or []),
                    *(known_values.get(attr_name) or []),
                ]
                for candidate in preferred_candidates:
                    if candidate in options:
                        wanted = [candidate]
                        source = (
                            "platform_abnormal_exact_suggestion_cross_channel"
                            if candidate in (explicit.get(attr_name) or [])
                            else "cross_channel_exact_value"
                        )
                        break
                if not wanted and attr_name == "口味":
                    for candidate in known_values.get(attr_name) or []:
                        if candidate == "混合口味" and "什锦味" in options and re.search(r"混合|组合|三色|什锦|随机", title):
                            wanted = ["什锦味"]
                            source = "cross_channel_controlled_synonym"
                            break
                if not wanted and attr_name == "商品类别":
                    source_category = str(channel.get("categoryName") or "")
                    if source_category in options:
                        wanted = [source_category]
                        source = "cross_channel_category_exact_value"
                if not wanted and attr_name == "售卖方式" and "预包装" in options and packaged_evidence(detail):
                    wanted = ["预包装"]
                    source = "packaging_evidence"
                if options and wanted:
                    field_id = f"channelDynamicInfos_{channel_index}___formData_{attr_id}"
                    select_fields[field_id] = wanted[0] if len(wanted) == 1 else wanted
                    decisions.append(
                        {
                            "field": f"{channel_id}:{attr_name}",
                            "attr_id": attr_id,
                            "old_value": [],
                            "new_value": wanted,
                            "status": "accepted",
                            "source": source,
                            "evidence": title,
                        }
                    )
                    continue
                units = struct_units(prop)
                if (
                    not options
                    and units
                    and sku_weight
                    and plausible_weight(sku_weight, sku_weight_unit)
                    and attr_name in {"单件净含量", "净含量", "单包净含量", "容量"}
                ):
                    unit = map_weight_unit(sku_weight_unit, units)
                    if unit:
                        base_id = f"channelDynamicInfos_{channel_index}___formData_{attr_id}"
                        text_fields[f"{base_id}_1"] = sku_weight
                        select_fields[f"{base_id}_2"] = unit
                        decisions.append(
                            {
                                "field": f"{channel_id}:{attr_name}",
                                "attr_id": attr_id,
                                "old_value": [],
                                "new_value": {"number": sku_weight, "unit": unit},
                                "status": "accepted",
                                "source": "existing_unique_sku_weight",
                                "evidence": f"SKU {unique_sku.get('skuId')} weight={sku_weight}{sku_weight_unit}",
                            }
                        )
                        continue
                unresolved_cross_channel.append(f"{channel_id}:{attr_name}")

        blocked_issue = bool(BLOCKING_ISSUE_RE.search(issue))
        if not select_fields and not text_fields:
            status = "blocked" if blocked_issue or unresolved_required else "no_official_change"
            reason = (
                "涉及禁售/经营范围/受监管资质，禁止自动填造"
                if blocked_issue
                else f"仍缺必填字段：{','.join(unresolved_required)}"
                if unresolved_required
                else "没有可直接采用的官方属性推荐"
            )
            index_rows.append(
                {
                    "spu_id": spu_id,
                    "title": title,
                    "status": status,
                    "reason": reason,
                    "unresolved_required": unresolved_required,
                    "unresolved_cross_channel": unresolved_cross_channel,
                    "decisions": decisions,
                }
            )
            continue
        hard_blocked_issue = bool(HARD_BLOCKING_ISSUE_RE.search(issue))
        if hard_blocked_issue:
            index_rows.append(
                {
                    "spu_id": spu_id,
                    "title": title,
                    "status": "deferred",
                    "reason": "存在禁售、经营范围或法定资质问题，禁止自动提交",
                    "unresolved_required": unresolved_required,
                    "unresolved_cross_channel": unresolved_cross_channel,
                    "decisions": decisions,
                }
            )
            continue

        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "use_all_official_recommendations": True,
            "recommendation_contains": [],
            "post_category_recommendation_contains": [],
            "text_fields": text_fields,
            "select_fields": select_fields,
            "replace_select_fields": replace_select_fields,
            "select_context_fields": [],
            "cascader_fields": [],
            "sale_attribute_replacements": [],
            "sku_upc_fields": [],
            "audit_decisions": decisions,
            "partial": bool(unresolved_required or blocked_issue),
            "unresolved_required": unresolved_required,
            "unresolved_regulated_issue": bool(blocked_issue),
        }
        plan_path = plans_dir / f"{spu_id}.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(plan_path, 0o600)
        plan_count += 1
        index_rows.append(
            {
                "spu_id": spu_id,
                "title": title,
                "status": "ready",
                "plan_path": str(plan_path),
                "partial": bool(unresolved_required or blocked_issue),
                "reason": (
                    "先物化有证据字段，仍需补齐：" + ",".join(unresolved_required)
                    if unresolved_required
                    else "先物化非监管字段，3C/制造商等证照图按上游生图链路补齐"
                    if blocked_issue
                    else ""
                ),
                "unresolved_required": unresolved_required,
                "unresolved_cross_channel": unresolved_cross_channel,
                "decisions": decisions,
            }
        )

    index_path = plans_dir / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "details_path": str(details_path),
                "recommendations_path": str(recommendation_path),
                "total": len(index_rows),
                "ready_count": plan_count,
                "rows": index_rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.chmod(index_path, 0o600)
    print(
        json.dumps(
            {
                "ok": True,
                "index_path": str(index_path),
                "ready_count": plan_count,
                "status_counts": {
                    status: sum(1 for row in index_rows if row["status"] == status)
                    for status in sorted({row["status"] for row in index_rows})
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
