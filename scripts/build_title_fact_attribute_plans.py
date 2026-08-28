#!/usr/bin/env python3
"""Build conservative QNH required-attribute plans from official and literal product facts."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any


LEGAL_RE = re.compile(
    r"3C|CCC|认证|证书|许可证|许可编号|备案|注册证|卫生标准|执行标准|"
    r"生产者|制造商|厂名|厂址|社会信用代码|有效期|保质期|化妆品|医疗器械"
)
GENERIC_OPTION_BLOCKLIST = {
    "其他",
    "无",
    "普通",
    "正常",
    "是",
    "否",
    "有",
    "没有",
    "国产",
    "进口",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--recommendations", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--label", default="title-facts")
    return parser.parse_args()


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def display_values(prop: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for item in as_list(prop.get("customValue")):
        if not isinstance(item, dict):
            continue
        direct = str(item.get("attrValue") or "").strip()
        if direct:
            values.append(direct)
        for group in as_list(item.get("structAttrValueList")):
            if not isinstance(group, dict):
                continue
            for row in as_list(group.get("valueList")):
                if not isinstance(row, list):
                    continue
                parts = [
                    str(part.get("value") or part.get("optionValue") or "").strip()
                    for part in sorted(
                        (part for part in row if isinstance(part, dict)),
                        key=lambda part: int(part.get("sequence") or 0),
                    )
                ]
                joined = "".join(part for part in parts if part)
                if joined:
                    values.append(joined)
    return list(dict.fromkeys(values))


def exact_options(prop: dict[str, Any]) -> dict[str, dict[str, str]]:
    return {
        str(option.get("attrValue") or "").strip(): {
            "attr_value_id": str(option.get("attrValueId") or ""),
            "value": str(option.get("attrValue") or "").strip(),
        }
        for option in as_list(prop.get("attrValueList"))
        if isinstance(option, dict)
        and str(option.get("attrValueId") or "")
        and str(option.get("attrValue") or "").strip()
    }


def first_template(prop: dict[str, Any]) -> list[dict[str, Any]]:
    templates = as_list(prop.get("structAttrTemplateList"))
    if not templates or not isinstance(templates[0], dict):
        return []
    return [
        part
        for part in as_list(templates[0].get("valueFormatList"))
        if isinstance(part, dict)
    ]


def allowed_units(template: list[dict[str, Any]]) -> set[str]:
    return {
        str(option.get("optionValue") or "")
        for part in template
        if int(part.get("inputType") or 0) == 5
        for option in as_list(part.get("optionList"))
        if isinstance(option, dict) and str(option.get("optionValue") or "")
    }


def compact_number(number: float) -> str:
    return str(int(number)) if number.is_integer() else f"{number:.6f}".rstrip("0").rstrip(".")


def normalize_unit(unit: str, allowed: set[str]) -> str:
    normalized = unit.lower()
    candidates = {
        "ml": ["ml", "mL", "毫升"],
        "l": ["L", "l", "升"],
        "g": ["g", "克", "克(g)"],
        "kg": ["kg", "千克", "公斤"],
        "m": ["m", "米"],
        "mm": ["mm", "毫米"],
        "cm": ["cm", "厘米"],
        "w": ["W", "w"],
        "mah": ["mAh", "毫安"],
        "%vol": ["%vol"],
        "°p": ["°P"],
        "片": ["片"],
        "斤": ["斤"],
    }.get(normalized, [unit])
    return next((candidate for candidate in candidates if candidate in allowed), "")


def one_number_struct(
    prop: dict[str, Any],
    number: float,
    source_unit: str,
) -> tuple[str, list[dict[str, Any]]] | None:
    template = first_template(prop)
    units = allowed_units(template)
    unit = normalize_unit(source_unit, units)
    numeric_parts = [
        part for part in template if int(part.get("inputType") or 0) in {1, 2, 4}
    ]
    unit_parts = [part for part in template if int(part.get("inputType") or 0) == 5]
    fixed_parts = [part for part in template if int(part.get("inputType") or 0) == 3]
    if len(numeric_parts) != 1 or len(unit_parts) != 1 or not unit:
        return None
    text = compact_number(number)
    parts = [
        {"sequence": int(numeric_parts[0].get("sequence") or 0), "value": text},
        {"sequence": int(unit_parts[0].get("sequence") or 0), "option_value": unit},
        *[
            {
                "sequence": int(part.get("sequence") or 0),
                "value": str(part.get("fixValue") or ""),
            }
            for part in fixed_parts
        ],
    ]
    return f"{text}{unit}", sorted(parts, key=lambda item: item["sequence"])


def two_number_dimension_struct(
    prop: dict[str, Any],
    first: float,
    second: float,
    source_unit: str,
) -> tuple[str, list[dict[str, Any]]] | None:
    template = first_template(prop)
    units = allowed_units(template)
    unit = normalize_unit(source_unit, units)
    numeric_parts = [
        part for part in template if int(part.get("inputType") or 0) in {1, 2, 4}
    ]
    unit_parts = [part for part in template if int(part.get("inputType") or 0) == 5]
    fixed_parts = [part for part in template if int(part.get("inputType") or 0) == 3]
    if len(numeric_parts) != 2 or len(unit_parts) != 2 or not unit:
        return None
    first_text = compact_number(first)
    second_text = compact_number(second)
    parts = [
        {"sequence": int(numeric_parts[0].get("sequence") or 0), "value": first_text},
        {"sequence": int(unit_parts[0].get("sequence") or 0), "option_value": unit},
        {"sequence": int(numeric_parts[1].get("sequence") or 0), "value": second_text},
        {"sequence": int(unit_parts[1].get("sequence") or 0), "option_value": unit},
        *[
            {
                "sequence": int(part.get("sequence") or 0),
                "value": str(part.get("fixValue") or ""),
            }
            for part in fixed_parts
        ],
    ]
    return (
        (
            f"{first_text}{unit}"
            f"{''.join(str(part.get('fixValue') or '') for part in fixed_parts) or '×'}"
            f"{second_text}{unit}"
        ),
        sorted(parts, key=lambda item: item["sequence"]),
    )


def title_measurements(title: str) -> list[tuple[float, str, int]]:
    values: list[tuple[float, str, int]] = []
    pattern = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(ml|mL|L|kg|g)(?![A-Za-z])")
    for match in pattern.finditer(title):
        if title[max(0, match.start() - 1) : match.start()] == "约":
            continue
        multiplier_match = re.match(
            r"(?:/[^*×x（(\s]+)?\s*[*×x]\s*(\d+)",
            title[match.end() :],
        )
        multiplier = int(multiplier_match.group(1)) if multiplier_match else 1
        values.append((float(match.group(1)), match.group(2), multiplier))
    return values


def structured_title_fact(
    prop: dict[str, Any],
    title: str,
) -> tuple[str, list[dict[str, Any]], str] | None:
    name = str(prop.get("attrName") or "")
    if LEGAL_RE.search(name):
        return None
    if name == "总净含量":
        measurements = title_measurements(title)
        if len(measurements) == 1:
            number, unit, multiplier = measurements[0]
            result = one_number_struct(prop, number * multiplier, unit)
            if result:
                return result[0], result[1], "title_exact_measurement_and_multiplier"
    if name in {"商品净重（kg）", "商品净重"}:
        measurements = title_measurements(title)
        if len(measurements) == 1:
            number, unit, multiplier = measurements[0]
            total = number * multiplier
            if unit.lower() == "g":
                total /= 1000
                unit = "kg"
            result = one_number_struct(prop, total, unit)
            if result:
                return result[0], result[1], "title_exact_weight"
    if name in {"长度（m）", "全长（m）", "线长"}:
        matches = re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:米|m)(?![A-Za-z])", title)
        if len(set(matches)) == 1:
            result = one_number_struct(prop, float(matches[0]), "m")
            if result:
                return result[0], result[1], "title_exact_length"
    if name in {"尺寸", "尺寸（mm）"}:
        millimeters = re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*mm", title, re.I)
        if len(set(millimeters)) == 1:
            result = one_number_struct(prop, float(millimeters[0]), "mm")
            if result:
                return result[0], result[1], "title_exact_size"
        dimension = re.search(
            r"(?<![\d.])(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*cm",
            title,
        )
        if dimension:
            result = two_number_dimension_struct(
                prop,
                float(dimension.group(1)),
                float(dimension.group(2)),
                "cm",
            )
            if result:
                return result[0], result[1], "title_exact_dimensions"
    if name in {"尺寸（长x宽cm）", "尺寸（长×宽cm）"}:
        dimension = re.search(
            r"(?<![\d.])(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*cm",
            title,
        )
        if dimension:
            result = two_number_dimension_struct(
                prop,
                float(dimension.group(1)),
                float(dimension.group(2)),
                "cm",
            )
            if result:
                return result[0], result[1], "title_exact_dimensions"
    if name == "片数":
        combined = re.search(r"(?<!\d)(\d+)\s*[+＋]\s*(\d+)\s*(?:片|条)", title)
        simple = re.search(r"(?<!\d)(\d+)\s*(?:片|条)(?:/|每|装|袋|包|盒|\b)", title)
        number = float(int(combined.group(1)) + int(combined.group(2))) if combined else (
            float(simple.group(1)) if simple else 0
        )
        if number:
            result = one_number_struct(prop, number, "片")
            if result:
                return result[0], result[1], "title_exact_piece_count"
    if "麦汁浓度" in name:
        values = re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*°\s*P", title, re.I)
        if len(set(values)) == 1:
            result = one_number_struct(prop, float(values[0]), "°P")
            if result:
                return result[0], result[1], "title_exact_original_gravity"
    if "酒精度" in name:
        values = re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*%vol", title, re.I)
        if len(set(values)) == 1:
            result = one_number_struct(prop, float(values[0]), "%vol")
            if result:
                return result[0], result[1], "title_exact_alcohol"
    if any(token in name for token in ("功率", "输出功率")):
        values = [float(value) for value in re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*W", title, re.I)]
        if values:
            result = one_number_struct(prop, max(values), "W")
            if result:
                return result[0], result[1], "title_exact_power"
    if "电池容量" in name:
        values = re.findall(r"(?<!\d)(\d+)\s*(?:mAh|毫安)", title, re.I)
        if len(set(values)) == 1:
            result = one_number_struct(prop, float(values[0]), "mAh")
            if result:
                return result[0], result[1], "title_exact_battery_capacity"
    return None


def option_title_fact(
    prop: dict[str, Any],
    title: str,
    cross_channel_values: list[str],
) -> tuple[dict[str, str], str] | None:
    name = str(prop.get("attrName") or "")
    if LEGAL_RE.search(name) or name == "品牌":
        return None
    options = exact_options(prop)
    if not options:
        return None
    for value in cross_channel_values:
        if value in options:
            return options[value], "cross_channel_exact_value"
    if name == "包装方式":
        mapping = [
            (r"(?:/|每)(?:瓶)|\d+\s*瓶", "瓶装"),
            (r"(?:/|每)(?:罐|听)|\d+\s*(?:罐|听)", "罐装"),
            (r"(?:/|每)(?:袋)|\d+\s*袋", "袋装"),
            (r"(?:/|每)(?:盒)|\d+\s*盒", "盒装"),
            (r"(?:/|每)(?:杯)|\d+\s*杯", "杯装"),
            (r"(?:/|每)(?:桶)|\d+\s*桶", "桶装"),
            (r"(?:/|每)(?:箱)|\d+\s*箱", "箱装"),
        ]
        matched_package_forms = {
            value
            for pattern, value in mapping
            if value in options
            and (
                re.search(pattern, title)
                or value in title
                or (
                    value == "罐装"
                    and re.search(r"(?:铝罐|易拉罐|瓦罐)", title)
                )
            )
        }
        if len(matched_package_forms) > 1:
            return None
        for pattern, value in mapping:
            if value in matched_package_forms:
                return options[value], "title_exact_package_form"
    if name == "供电方式" and "充电" in title and "电池" in title:
        return None
    if name == "适用人数" and (
        ("单人" in title and "双人" in title)
        or re.search(r"单\s*(?:[/、与及和]|双)\s*双?人", title)
    ):
        return None
    if name == "接口类型":
        normalized = title.lower().replace(" ", "")
        mappings = [
            ("type-c转lightning", ["type-c转lightning"]),
            ("双typec", ["TYPE-C"]),
            ("双type-c", ["TYPE-C"]),
            ("micro usb", ["Micro USB"]),
            ("microusb", ["Micro USB"]),
            ("lightning", ["apple Lightning", "apple lighting"]),
        ]
        for marker, candidates in mappings:
            if marker.replace(" ", "") not in normalized:
                continue
            matched = [options[value] for value in candidates if value in options]
            if len(matched) == 1:
                return matched[0], "title_exact_interface"
    if name in {"容量（L）", "容量(L)"}:
        match = re.search(r"(?<![\d.])(\d+(?:\.\d+)?)\s*L(?![A-Za-z])", title)
        if match:
            capacity = float(match.group(1))
            ranges = [
                (capacity < 1.5, "0-1.49L"),
                (1.5 <= capacity < 2.0, "1.5-1.99L"),
                (2.0 <= capacity < 2.5, "2.0-2.49L"),
                (2.5 <= capacity < 3.0, "2.5-2.99L"),
                (3.0 <= capacity < 3.5, "3.0-3.49L"),
                (3.5 <= capacity < 5.0, "3.5-4.99L"),
                (capacity >= 5.0, "5.0L以上"),
            ]
            for applies, value in ranges:
                if applies and value in options:
                    return options[value], "title_exact_capacity_range"
    matches = []
    for value in options:
        if value in GENERIC_OPTION_BLOCKLIST or len(value) < 2:
            continue
        if (
            "材质" in name
            and re.search(r"(?:检测器|测试仪|测量仪|含水率|水分测试)", title)
        ):
            continue
        boundary = (
            rf"(?<![\d.]){re.escape(value)}(?![\d.])"
            if value[0].isdigit() or value[-1].isdigit()
            else re.escape(value)
        )
        match = re.search(boundary, title, re.I)
        if not match:
            continue
        prefix = title[max(0, match.start() - 4) : match.start()]
        if re.search(r"(?:无|不带|非|没有)\s*$", prefix):
            continue
        matches.append(value)
    if matches:
        longest = max(len(value) for value in matches)
        longest_matches = [value for value in matches if len(value) == longest]
        if len(longest_matches) == 1:
            return options[longest_matches[0]], "title_exact_option_literal"
    return None


def main() -> None:
    args = parse_args()
    details_path = Path(args.details).resolve()
    recommendations_path = Path(args.recommendations).resolve()
    run_dir = Path(args.run_dir).resolve()
    if not args.label or any(not (char.isalnum() or char == "-") for char in args.label):
        raise SystemExit("label 只能包含字母、数字和连字符")
    details = json.loads(details_path.read_text(encoding="utf-8"))
    recommendations_payload = json.loads(recommendations_path.read_text(encoding="utf-8"))
    recommendations = {
        str(row.get("spu_id") or ""): row
        for row in as_list(recommendations_payload.get("products"))
        if isinstance(row, dict)
    }
    plans_dir = run_dir / f"plans-{args.label}"
    plans_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(plans_dir, 0o700)
    rows: list[dict[str, Any]] = []
    for product in as_list(details.get("products")):
        if not isinstance(product, dict):
            continue
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = str(detail.get("spuId") or product.get("spu_id") or "")
        title = str(detail.get("spuName") or product.get("title") or "")
        known_values: dict[str, list[str]] = {}
        for channel in as_list(detail.get("spuChannelInfoList")):
            if not isinstance(channel, dict):
                continue
            for prop in as_list(channel.get("categoryProperties")):
                if not isinstance(prop, dict):
                    continue
                name = str(prop.get("attrName") or "")
                for value in display_values(prop):
                    if value not in known_values.setdefault(name, []):
                        known_values[name].append(value)
        official_by_attr: dict[str, list[dict[str, Any]]] = {}
        recommendation = recommendations.get(spu_id) or {}
        recommendation_data = (
            recommendation.get("recommendation")
            if isinstance(recommendation.get("recommendation"), dict)
            else {}
        )
        for prop in as_list(recommendation_data.get("channelDynamicInfoVOList")):
            if not isinstance(prop, dict):
                continue
            official_by_attr[str(prop.get("attrId") or "")] = [
                value
                for value in as_list(prop.get("customValue"))
                if isinstance(value, dict)
            ]

        exact_fields: list[dict[str, Any]] = []
        structured_fields: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        unresolved: list[str] = []
        for channel_index, channel in enumerate(as_list(detail.get("spuChannelInfoList"))):
            if not isinstance(channel, dict) or not channel.get("categoryCode"):
                continue
            channel_id = int(channel.get("channelId") or 0)
            for prop in as_list(channel.get("categoryProperties")):
                if (
                    not isinstance(prop, dict)
                    or int(prop.get("isRequired") or 0) != 1
                    or display_values(prop)
                ):
                    continue
                attr_id = str(prop.get("attrId") or "")
                attr_name = str(prop.get("attrName") or "")
                if not attr_id or not attr_name:
                    continue
                if LEGAL_RE.search(attr_name) or attr_name == "品牌":
                    unresolved.append(f"{channel_id}:{attr_name}:regulated_or_directory")
                    continue
                official_values = official_by_attr.get(attr_id) if channel_id == 100 else []
                options = exact_options(prop)
                official_exact = [
                    options[str(value.get("attrValue") or "")]
                    for value in official_values or []
                    if str(value.get("attrValue") or "") in options
                    and str(options[str(value.get("attrValue") or "")]["attr_value_id"])
                    == str(value.get("attrValueId") or "")
                ]
                option_fact: tuple[dict[str, str], str] | None = None
                if official_exact:
                    option_fact = (official_exact[0], "qnh_official_dynamic_recommendation")
                if option_fact is None:
                    option_fact = option_title_fact(
                        prop,
                        title,
                        known_values.get(attr_name) or [],
                    )
                if option_fact is not None:
                    option, source = option_fact
                    exact_fields.append(
                        {
                            "channel_index": channel_index,
                            "attr_id": attr_id,
                            "expected_old_values": [],
                            "values": [option],
                            "source": source,
                            "evidence": title,
                        }
                    )
                    decisions.append(
                        {
                            "field": f"{channel_id}:{attr_name}",
                            "status": "accepted",
                            "new_value": [option["value"]],
                            "source": source,
                            "evidence": title,
                        }
                    )
                    continue
                structured = structured_title_fact(prop, title)
                if structured is not None:
                    display_value, parts, source = structured
                    structured_fields.append(
                        {
                            "channel_index": channel_index,
                            "attr_id": attr_id,
                            "expected_old_values": [],
                            "display_value": display_value,
                            "parts": parts,
                            "source": source,
                            "evidence": title,
                        }
                    )
                    decisions.append(
                        {
                            "field": f"{channel_id}:{attr_name}",
                            "status": "accepted",
                            "new_value": display_value,
                            "source": source,
                            "evidence": title,
                        }
                    )
                    continue
                unresolved.append(f"{channel_id}:{attr_name}:no_literal_fact")
        if not exact_fields and not structured_fields:
            continue
        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "update_profile": "tenant_edit_v424",
            "exact_option_channel_fields": exact_fields,
            "structured_channel_fields": structured_fields,
            "audit_decisions": decisions,
            "unresolved_required": unresolved,
        }
        plan_path = plans_dir / f"{spu_id}.json"
        plan_path.write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(plan_path, 0o600)
        rows.append(
            {
                "spu_id": spu_id,
                "title": title,
                "status": "ready",
                "plan_path": str(plan_path),
                "accepted_count": len(exact_fields) + len(structured_fields),
                "unresolved_required": unresolved,
                "decisions": decisions,
            }
        )
    index_path = plans_dir / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "details_path": str(details_path),
                "recommendations_path": str(recommendations_path),
                "ready_count": len(rows),
                "accepted_field_count": sum(row["accepted_count"] for row in rows),
                "rows": rows,
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
                "indexPath": str(index_path),
                "ready": len(rows),
                "acceptedFields": sum(row["accepted_count"] for row in rows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
