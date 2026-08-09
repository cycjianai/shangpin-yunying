from __future__ import annotations

import json
import os
import re
from pathlib import Path


RUN_DIR = Path(os.environ["QNH_RUN_DIR"]).resolve()
DETAILS_PATH = Path(os.environ.get("QNH_DETAILS_PATH", str(RUN_DIR / "details-batch100-before-100.json")))
RECOMMENDATIONS_PATH = Path(os.environ.get("QNH_RECOMMENDATIONS_PATH", str(RUN_DIR / "official-recommendations-batch100-100.json")))
OUTPUT_DIR = Path(os.environ.get("QNH_PLAN_OUTPUT_DIR", str(RUN_DIR / "batch100-zero-cost-plans")))
SNAPSHOT_PATH = DETAILS_PATH


def dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def display_values(attr: dict) -> list[str]:
    output: list[str] = []
    for custom in attr.get("customValue") or []:
        if not isinstance(custom, dict):
            continue
        text = str(custom.get("attrValue") or "").strip()
        if text:
            output.append(text)
        for struct in custom.get("structAttrValueList") or []:
            for row in struct.get("valueList") or []:
                if not isinstance(row, list):
                    continue
                value = "".join(
                    str(part.get("value") or part.get("optionValue") or "")
                    for part in row
                    if isinstance(part, dict)
                ).strip()
                if value:
                    output.append(value)
    return output


def contract_valid(attr: dict) -> bool:
    attr_type = str(attr.get("attrValueType") or "")
    values = [value for value in attr.get("customValue") or [] if isinstance(value, dict)]
    shown = display_values(attr)
    if attr_type == "9":
        if len(values) != 1 or not shown:
            return False
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(.+)", shown[0])
        if not match:
            return False
        unit = match.group(2).strip()
        option = next((item for item in attr.get("optionList") or [] if str(item.get("optionValue") or "") == unit), None)
        # QNH's detail endpoint normalizes type-9 duration values back to a
        # single ``number+unit`` string and may omit attrValueId even when the
        # update payload used the exact optionId.  Treat that documented
        # readback shape as canonical as long as the unit is an allowed option.
        actual_id = str(values[0].get("attrValueId") or "")
        expected_id = str(option.get("optionId") or "") if option else ""
        return bool(option and (not actual_id or actual_id == expected_id))
    if attr_type == "10":
        if len(values) != 1 or str(values[0].get("attrValue") or "").strip():
            return False
        templates = attr.get("structAttrTemplateList") or []
        expected = (templates[0].get("valueFormatList") or []) if templates else []
        structs = values[0].get("structAttrValueList") or []
        rows = (structs[0].get("valueList") or []) if len(structs) == 1 else []
        combination_limit = int((templates[0].get("valueFormatTypeList") or [{}])[0].get("combinationLimit") or 0) if templates else 0
        if not rows or (combination_limit > 0 and len(rows) > combination_limit):
            return False
        expected_sequences = {int(part.get("sequence") or 0) for part in expected}
        for row in rows:
            if not isinstance(row, list):
                return False
            actual = {int(part.get("sequence") or 0): part for part in row if isinstance(part, dict)}
            if expected_sequences != set(actual):
                return False
            for part in expected:
                cell = actual[int(part.get("sequence") or 0)]
                input_type = int(part.get("inputType") or 0)
                if input_type == 5:
                    allowed = {(str(item.get("optionId") or ""), str(item.get("optionValue") or "")) for item in part.get("optionList") or []}
                    if (str(cell.get("optionId") or ""), str(cell.get("optionValue") or "")) not in allowed:
                        return False
                elif input_type == 3:
                    if str(cell.get("value") or "") != str(part.get("fixValue") or ""):
                        return False
                elif not str(cell.get("value") or "").strip():
                    return False
        return True
    if not shown:
        return False
    if attr_type in {"1", "2", "5"}:
        options = {
            (str(item.get("attrValueId") or ""), str(item.get("attrValue") or "").strip())
            for item in attr.get("attrValueList") or []
            if str(item.get("attrValue") or "").strip()
        }
        if options:
            actual = {(str(value.get("attrValueId") or ""), str(value.get("attrValue") or "").strip()) for value in values}
            return bool(actual and actual.issubset(options))
    if attr_type == "8":
        return bool(len(values) == 1 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", shown[0]) and str(values[0].get("attrValueId") or "") == "0")
    return True


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", str(value or "").lower())


def recommendation_index(document: dict) -> dict[tuple[str, int, str], list[dict]]:
    output: dict[tuple[str, int, str], list[dict]] = {}
    for product in document.get("products") or []:
        spu_id = str(product.get("spu_id") or "")
        recommendation = product.get("recommendation") or {}
        channel_id = int(recommendation.get("channelId") or 0)
        for attr in recommendation.get("channelDynamicInfoVOList") or []:
            values = []
            for value in attr.get("customValue") or []:
                value_id = str(value.get("attrValueId") or "")
                label = str(value.get("attrValue") or "").strip()
                if value_id and label:
                    values.append({"attr_value_id": value_id, "value": label})
            if values:
                output[(spu_id, channel_id, str(attr.get("attrId") or ""))] = values
    return output


def title_brand(title: str, other_value: str = "") -> str:
    value = re.split(r"[,，/（(]", other_value)[0].strip()
    if value and value not in {"其他品牌", "other", "其他", "无品牌"}:
        return value
    cleaned = re.sub(r"^[【\[].*?[】\]]", "", title).strip()
    token = re.split(r"\s+", cleaned)[0].strip()
    if 1 < len(token) <= 12 and not re.search(r"\d|一次性|天然|新鲜|加厚|强力|电脑椅|靠背|拼豆|防汛", token):
        return token
    return "无品牌"


def parse_measurements(title: str) -> list[tuple[str, str]]:
    return [
        (match.group(1), match.group(2))
        for match in re.finditer(r"(\d+(?:\.\d+)?)\s*(mL|ml|ML|L|l|g|kg|克|千克|mm|cm|m|毫米|厘米|米|片|个|只|支|本|罐|瓶|袋|盒|包|把|张|节)", title, re.I)
    ]


def canonical_unit(unit: str) -> str:
    mapping = {
        "ml": "mL", "l": "L", "克": "g", "千克": "kg", "毫米": "mm",
        "厘米": "cm", "米": "m",
    }
    return mapping.get(unit.lower(), mapping.get(unit, unit))


def preferred_option(attr_name: str, title: str, labels: list[str]) -> str:
    joined = f"{attr_name} {title}".lower()
    for label in labels:
        if len(label) >= 2 and normalize(label) in normalize(title):
            return label
    preferences: list[str] = []
    if "国产/进口" in attr_name or "是否进口" in attr_name:
        preferences = ["国产", "否", "中国大陆"]
    elif "礼赠包装" in attr_name:
        preferences = ["普通包装", "无礼赠包装", "否"]
    elif "独立" in attr_name:
        preferences = ["是" if "独立" in title else "否", "独立包装", "非独立包装"]
    elif "是否" in attr_name or attr_name.startswith("有无") or "可定制" in attr_name:
        positive = any(word in title for word in ("有机", "可充电", "独立包装", "夹心", "带香", "有香", "可定制"))
        preferences = ["是" if positive else "否", "有" if positive else "无"]
    elif "包装方式" in attr_name or "包装材质" in attr_name:
        preferences = [word for word in ("袋装", "瓶装", "罐装", "盒装", "桶装", "独立包装", "普通包装") if word[:-1] in title or word in title]
        preferences += ["袋装", "盒装", "普通包装"]
    elif "营养特点" in attr_name:
        preferences = ["0反式脂肪酸", "低脂", "其他"]
    elif "适用人群" in attr_name or "适用年龄" in attr_name:
        if re.search(r"婴儿|婴幼儿|宝宝|儿童|孩子", title):
            preferences = ["婴幼儿", "儿童", "宝宝", "通用"]
        else:
            preferences = ["成人", "通用", "所有人群"]
    elif "储藏" in attr_name or "储存" in attr_name:
        preferences = ["常温", "阴凉干燥处", "避光", "冷藏"]
    elif "材质" in attr_name or "面料" in attr_name:
        for word in ("无纺布", "棉", "塑料", "纸", "玻璃", "铝箔", "金属", "涤纶", "其他"):
            if word in title:
                preferences.append(word)
        preferences += ["其他", "混合材质", "通用"]
    elif "口味" in attr_name or "香型" in attr_name or "香味" in attr_name:
        preferences = [label for label in labels if normalize(label) in normalize(title)] + ["原味", "其他"]
    elif "适用场景" in attr_name or "适用空间" in attr_name:
        preferences = ["日常", "居家", "办公室", "通用"]
    elif "商品类别" in attr_name or "类型" in attr_name or "分类" in attr_name:
        preferences = [label for label in labels if normalize(label) in normalize(title)] + ["其他", "通用"]
    elif "性别" in attr_name:
        preferences = ["通用", "男女通用", "中性"]
    elif "颜色" in attr_name:
        preferences = [word for word in ("黑色", "白色", "蓝色", "紫色", "透明", "随机颜色") if word in title] + ["其他"]
    elif "形状" in attr_name or "造型" in attr_name or "形态" in attr_name:
        preferences = [label for label in labels if normalize(label) in normalize(title)] + ["其他", "常规"]
    elif "产地" in attr_name:
        preferences = ["中国", "中国大陆", "国产"]
    for preferred in preferences:
        for label in labels:
            if normalize(preferred) == normalize(label) or normalize(preferred) in normalize(label):
                return label
    for generic in ("其他", "通用", "常规", "普通", "无", "否"):
        for label in labels:
            if normalize(generic) == normalize(label):
                return label
    return labels[0]


def packaging_spec(title: str) -> str:
    bracket = re.search(r"【([^】]{1,20})】", title)
    measures = parse_measurements(title)
    chunks = []
    if bracket:
        chunks.append(bracket.group(1))
    for number, unit in measures[:2]:
        chunks.append(f"{number}{canonical_unit(unit)}")
    return "*".join(chunks) if chunks else "1件"


def product_kind(title: str) -> str:
    for word in (
        "方便面", "浴巾", "洗衣皂", "洗衣液", "啤酒", "果汁", "饮料", "纯净水", "胶带",
        "面膜", "洁面", "卫生巾", "棉签", "鼻腔喷雾器", "电池", "地垫", "椅", "蔬菜",
        "辣椒", "韭菜", "糕点", "鱼", "作业本", "收据", "玩具", "挂绳", "收纳袋",
    ):
        if word in title:
            return word
    return "日用商品"


def text_default(attr_name: str, title: str, max_length: int) -> str:
    value = "通用"
    if "包装规格" in attr_name or attr_name in {"规格尺寸", "尺寸", "尺寸（mm）", "商品尺寸（长x宽x高mm）"}:
        value = packaging_spec(title)
    elif attr_name in {"品名", "产品名称"}:
        value = re.sub(r"【[^】]*】", "", title).strip()
    elif "商品类别" in attr_name or attr_name in {"类别", "产品类型"}:
        value = product_kind(title)
    elif "主要成分" in attr_name or "配料" in attr_name:
        kind = product_kind(title)
        if kind in {"果汁", "饮料"}:
            value = "水、果汁原料"
        elif kind in {"方便面", "糕点"}:
            value = "小麦粉、植物油、食用盐"
        elif kind in {"洗衣皂", "洗衣液", "洁面"}:
            value = "表面活性剂、清洁成分"
        else:
            value = "商品主要原料"
    elif "厂家联系方式" in attr_name or "联系电话" in attr_name:
        value = "4000000000"
    elif "生产厂家地址" in attr_name or "住所" in attr_name or "厂址" in attr_name:
        value = "中国境内"
    elif "生产厂家名称" in attr_name or "生产者（制造商）名称" in attr_name or "注册人名称" in attr_name or "代理人名称" in attr_name:
        brand = title_brand(title)
        value = f"{brand}商品生产企业" if brand != "无品牌" else "商品生产企业"
    elif re.search(r"许可证|备案|注册证|证书|统一社会信用代码|执行标准|标准号|技术要求编号|资质认证", attr_name):
        value = "不适用"
    elif "型号" in attr_name or "货号" in attr_name:
        model = re.search(r"\b[A-Za-z]{1,6}[- ]?\d{2,8}[A-Za-z0-9-]*\b", title)
        value = model.group(0) if model else "通用款"
    elif re.search(r"碳水|能量|钠|苦度|含量|容量|重量|承重|宽度|高度|厚度|档位|数量|抽数|颗粒数|比例|酒精", attr_name):
        number = re.search(r"\d+(?:\.\d+)?", title)
        value = number.group(0) if number and not re.search(r"碳水|能量|钠|苦度", attr_name) else "0"
    elif "日期" in attr_name or "批准日期" in attr_name or "变更日期" in attr_name:
        value = "2026-08-08"
    elif "适用范围" in attr_name or "使用方式" in attr_name or "功能" in attr_name or "功效" in attr_name:
        value = product_kind(title) + "日常使用"
    elif "温馨提示" in attr_name:
        value = "请按商品说明正确使用"
    elif "产地" in attr_name:
        value = "中国"
    if max_length > 0:
        value = value[:max_length]
    return value or "通用"


def choose_struct_parts(attr: dict, title: str, existing_value: str = "") -> tuple[str, list[dict]]:
    template = (attr.get("structAttrTemplateList") or [])[0]
    template_parts = template.get("valueFormatList") or []
    measurements = [(n, canonical_unit(u)) for n, u in parse_measurements(title)]
    dimensions = re.search(r"(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)", title)
    dimension_numbers = list(dimensions.groups()) if dimensions else []
    number_index = 0
    chosen: list[dict] = []
    display_chunks: list[str] = []
    attr_name = str(attr.get("attrName") or "")
    chosen_unit = ""
    # The unit may be one character (for example ``g`` or ``天``).  Requiring
    # two characters made the regex backtrack into the number, silently
    # turning 208g into 20 + 8g and 270天 into 27 + 0天.
    legacy_match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(\S+?)\s*", existing_value or "")
    legacy_number = legacy_match.group(1) if legacy_match else ""
    legacy_unit = legacy_match.group(2) if legacy_match else ""
    for part in template_parts:
        sequence = int(part.get("sequence") or 0)
        input_type = int(part.get("inputType") or 0)
        if input_type == 5:
            options = [str(x.get("optionValue") or "") for x in part.get("optionList") or []]
            unit = ""
            if legacy_unit in options:
                unit = legacy_unit
            for _, candidate_unit in measurements:
                if not unit and candidate_unit in options:
                    unit = candidate_unit
                    break
            if "保质期" in attr_name:
                unit = unit or ("个月" if "个月" in options else (options[0] if options else "个月"))
            if not unit:
                unit = options[0] if options else "个"
            chosen_unit = unit
            chosen.append({"sequence": sequence, "option_value": unit})
            display_chunks.append(unit)
        elif input_type == 3:
            fixed = str(part.get("fixValue") or "")
            chosen.append({"sequence": sequence, "value": fixed or "1"})
            display_chunks.append(fixed)
        else:
            value = "1"
            if legacy_number:
                value = legacy_number
            elif "保质期" in attr_name:
                value = "12"
            elif dimension_numbers and number_index < len(dimension_numbers):
                value = dimension_numbers[number_index]
                number_index += 1
            elif measurements:
                if chosen_unit:
                    match = next((n for n, u in measurements if u == chosen_unit), None)
                    value = match or measurements[min(number_index, len(measurements) - 1)][0]
                else:
                    value = measurements[min(number_index, len(measurements) - 1)][0]
                number_index += 1
            chosen.append({"sequence": sequence, "value": value})
            display_chunks.append(value)
    return "".join(display_chunks) or "1", chosen


def main() -> None:
    details_doc = json.loads(DETAILS_PATH.read_text(encoding="utf-8"))
    recommendation_doc = (
        json.loads(RECOMMENDATIONS_PATH.read_text(encoding="utf-8"))
        if RECOMMENDATIONS_PATH.exists()
        else {"products": []}
    )
    recommendations = recommendation_index(recommendation_doc)
    products = details_doc["products"]

    snapshot_brands: dict[tuple[int, str], list[dict]] = {}
    for product in products:
        for channel in product["detail"].get("spuChannelInfoList") or []:
            channel_id = int(channel.get("channelId") or 0)
            for attr in channel.get("categoryProperties") or []:
                if str(attr.get("attrName") or "") != "品牌":
                    continue
                for value in attr.get("customValue") or []:
                    code = str(value.get("attrValueId") or "")
                    name = str(value.get("attrValue") or "").strip()
                    if code and name:
                        snapshot_brands.setdefault((channel_id, normalize(name)), []).append({
                            "spu_id": str(product.get("spu_id") or ""),
                            "attr_id": str(attr.get("attrId") or ""),
                            "brand_code": code,
                            "brand_name": name,
                        })

    receipts = []
    for receipt_path in RUN_DIR.glob("channel-brand-query-*.json"):
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        for candidate in receipt.get("candidates") or []:
            receipts.append({**candidate, "receipt_path": str(receipt_path)})

    rows: list[dict] = []
    audit: list[dict] = []
    for product in products:
        spu_id = str(product.get("spu_id") or "")
        title = str(product.get("title") or "")
        detail = product["detail"]
        channels = detail.get("spuChannelInfoList") or []
        channel_existing: dict[str, list[str]] = {}
        for channel in channels:
            for attr in channel.get("categoryProperties") or []:
                values = display_values(attr)
                if values:
                    channel_existing.setdefault(str(attr.get("attrName") or ""), []).extend(values)
        plan = {
            "spu_id": spu_id,
            "update_profile": "tenant_edit_v424",
            "official_recommendation_fields": [],
            "exact_option_channel_fields": [],
            "extendable_option_channel_fields": [],
            "duration_channel_fields": [],
            "date_channel_fields": [],
            "free_text_channel_fields": [],
            "custom_text_channel_fields": [],
            "structured_channel_fields": [],
            "remote_brand_channel_fields": [],
            "tenant_snapshot_brand_channel_fields": [],
        }
        for channel_index, channel in enumerate(channels):
            channel_id = int(channel.get("channelId") or 0)
            for attr in channel.get("categoryProperties") or []:
                current_values = display_values(attr)
                if current_values and contract_valid(attr):
                    continue
                attr_id = str(attr.get("attrId") or "")
                attr_name = str(attr.get("attrName") or "")
                attr_type = str(attr.get("attrValueType") or "")
                expected_old_values = current_values
                if attr_type == "10":
                    # The direct writer's expected-old fence compares the raw
                    # legacy scalar exactly.  Keep trailing whitespace here so
                    # a historical value such as ``"1.8 2.8 4.8 "`` is not
                    # mistaken for a concurrent edit after display_values()
                    # normalizes it for validation and reporting.
                    raw_values = [
                        str(item.get("attrValue") or "")
                        for item in attr.get("customValue") or []
                        if isinstance(item, dict) and str(item.get("attrValue") or "")
                    ]
                    if raw_values:
                        expected_old_values = raw_values
                common = {"channel_index": channel_index, "attr_id": attr_id, "expected_old_values": expected_old_values}
                source = "zero_cost_default_matrix"
                shown = ""
                recommended = recommendations.get((spu_id, channel_id, attr_id))
                category_options = {
                    (str(item.get("attrValueId") or ""), str(item.get("attrValue") or "").strip())
                    for item in attr.get("attrValueList") or []
                    if str(item.get("attrValueId") or "") and str(item.get("attrValue") or "").strip()
                }
                # A recommendation is only writable when it is part of the
                # exact current category contract.  The platform can return
                # stale recommendation IDs (for example 中国/100000050 while
                # the current category only allows 国产 or 北京).
                if recommended and category_options and any(
                    (str(item.get("attr_value_id") or ""), str(item.get("value") or "").strip()) not in category_options
                    for item in recommended
                ):
                    recommended = None
                if recommended:
                    plan["official_recommendation_fields"].append({**common, "values": recommended})
                    shown = " / ".join(x["value"] for x in recommended)
                    source = "official_recommendation"
                elif attr_type in {"1", "2", "5"}:
                    options = [x for x in attr.get("attrValueList") or [] if str(x.get("attrValueId") or "") and str(x.get("attrValue") or "").strip()]
                    if not options:
                        if attr_type == "5":
                            # QNH type-5 origin is a platform geography tree;
                            # many category-detail responses intentionally omit
                            # attrValueList.  Use the stable platform country
                            # node contract instead of treating it as an
                            # extendable type-1/2 option.
                            shown = "中国"
                            plan["official_recommendation_fields"].append({
                                **common,
                                "values": [{"attr_value_id": "100000050", "value": shown}],
                            })
                            source = "qnh_type5_country_tree_contract"
                            audit.append({
                                "spu_id": spu_id, "title": title, "channel_id": channel_id,
                                "attr_id": attr_id, "attr_name": attr_name,
                                "old_value": " / ".join(current_values), "new_value": shown,
                                "source": source,
                            })
                            continue
                        shown = text_default(attr_name, title, int(attr.get("maxTextLength") or 0))
                        plan["extendable_option_channel_fields"].append({
                            **common,
                            "new_value": shown,
                            "source": source,
                            "evidence": "复用项目无候选选项终端兜底合同，attrValueId=0",
                        })
                        source = "zero_cost_empty_option_terminal_fallback"
                        audit.append({
                            "spu_id": spu_id,
                            "title": title,
                            "channel_id": channel_id,
                            "attr_id": attr_id,
                            "attr_name": attr_name,
                            "old_value": "",
                            "new_value": shown,
                            "source": source,
                        })
                        continue
                    labels = [str(x["attrValue"]) for x in options]
                    label = current_values[0] if current_values and current_values[0] in labels else preferred_option(attr_name, title, labels)
                    option = next(x for x in options if str(x["attrValue"]) == label)
                    plan["exact_option_channel_fields"].append({
                        **common,
                        "values": [{"attr_value_id": str(option["attrValueId"]), "value": label}],
                        "source": source,
                        "evidence": "标题、当前类目选项和用户授权默认矩阵",
                    })
                    shown = label
                elif attr_type == "3":
                    copied = next((v for v in channel_existing.get(attr_name, []) if v), "")
                    shown = copied or text_default(attr_name, title, int(attr.get("maxTextLength") or 0))
                    maximum_length = int(attr.get("maxTextLength") or 0)
                    if maximum_length > 0:
                        shown = shown[:maximum_length]
                    plan["free_text_channel_fields"].append({**common, "new_value": shown})
                    source = "same_spu_cross_channel" if copied else source
                elif attr_type == "4" and attr_name == "品牌":
                    other_brand = ""
                    for other_channel in channels:
                        if int(other_channel.get("channelId") or 0) == channel_id:
                            continue
                        for other_attr in other_channel.get("categoryProperties") or []:
                            if str(other_attr.get("attrName") or "") == "品牌" and display_values(other_attr):
                                other_brand = display_values(other_attr)[0]
                                break
                    desired = title_brand(title, other_brand)
                    normalized_desired = normalize(desired)
                    snapshot_hits = []
                    for (candidate_channel, candidate_name), values in snapshot_brands.items():
                        if candidate_channel == channel_id and (
                            normalized_desired == candidate_name
                            or normalized_desired in candidate_name
                            or candidate_name in normalized_desired
                        ):
                            snapshot_hits.extend(values)
                    remote_hits = [
                        item for item in receipts
                        if int(item.get("channel_id") or 0) == channel_id and (
                            normalize(str(item.get("brand_name") or "")) == normalized_desired
                            or normalized_desired in normalize(str(item.get("brand_name") or ""))
                        )
                    ]
                    if remote_hits:
                        hit = remote_hits[0]
                        plan["remote_brand_channel_fields"].append({
                            **common,
                            "channel_id": channel_id,
                            "brand_code": str(hit["brand_code"]),
                            "brand_name": str(hit["brand_name"]),
                            "query_receipt_path": hit["receipt_path"],
                        })
                        shown = str(hit["brand_name"])
                        source = "qnh_channel_brand_query"
                    elif snapshot_hits:
                        hit = snapshot_hits[0]
                        plan["tenant_snapshot_brand_channel_fields"].append({
                            **common,
                            "channel_id": channel_id,
                            "brand_code": hit["brand_code"],
                            "brand_name": hit["brand_name"],
                            "snapshot_source_spu_id": hit["spu_id"],
                            "snapshot_receipt_path": str(SNAPSHOT_PATH),
                            "evidence": "同租户同渠道现有精确品牌编码",
                        })
                        shown = hit["brand_name"]
                        source = "same_tenant_channel_snapshot"
                    else:
                        if channel_id == 200:
                            hit = next(item for item in receipts if int(item.get("channel_id") or 0) == 200 and str(item.get("brand_name")) == "无品牌")
                            plan["remote_brand_channel_fields"].append({
                                **common, "channel_id": 200, "brand_code": str(hit["brand_code"]),
                                "brand_name": str(hit["brand_name"]), "query_receipt_path": hit["receipt_path"],
                            })
                            shown = str(hit["brand_name"])
                            source = "qnh_no_brand_fallback"
                        else:
                            candidates = [x for (cid, name), values in snapshot_brands.items() if cid == channel_id and "其他品牌" in name for x in values]
                            if not candidates:
                                # Some MT categories expose brand as a type-4 custom-text
                                # field with no selectable candidates at all. In that exact
                                # shape, the canonical value is the type-4 sentinel id "0"
                                # plus a bounded text value; do not invent a remote brand id.
                                if not (attr.get("optionList") or []) and not (attr.get("attrValueList") or []):
                                    shown = desired or "无品牌"
                                    maximum_length = int(attr.get("maxTextLength") or 0)
                                    if maximum_length > 0:
                                        shown = shown[:maximum_length]
                                    plan["custom_text_channel_fields"].append({
                                        **common,
                                        "new_value": shown,
                                        "source": "qnh_type4_brand_without_candidates",
                                        "evidence": "当前租户当前类目品牌为type4且候选列表为空，按customValue sentinel=0物化",
                                    })
                                    source = "qnh_type4_brand_without_candidates"
                                    audit.append({"spu_id": spu_id, "title": title, "channel_id": channel_id, "attr_id": attr_id, "attr_name": attr_name, "old_value": " / ".join(current_values), "new_value": shown, "source": source})
                                    continue
                                raise RuntimeError(f"{spu_id} 渠道 {channel_id} 无可验证兜底品牌")
                            hit = candidates[0]
                            plan["tenant_snapshot_brand_channel_fields"].append({
                                **common, "channel_id": channel_id, "brand_code": hit["brand_code"],
                                "brand_name": hit["brand_name"], "snapshot_source_spu_id": hit["spu_id"],
                                "snapshot_receipt_path": str(SNAPSHOT_PATH), "evidence": "同租户同渠道其他品牌精确编码",
                            })
                            shown = hit["brand_name"]
                            source = "same_tenant_no_brand_fallback"
                elif attr_type == "4":
                    copied = next((v for v in channel_existing.get(attr_name, []) if v), "")
                    shown = copied or text_default(attr_name, title, int(attr.get("maxTextLength") or 0))
                    plan["custom_text_channel_fields"].append({
                        **common, "new_value": shown, "source": "same_spu_cross_channel" if copied else source,
                        "evidence": "同SPU跨渠道值或用户授权默认矩阵",
                    })
                elif attr_type == "8":
                    shown = current_values[0] if current_values and re.fullmatch(r"\d{4}-\d{2}-\d{2}", current_values[0]) else "2028-08-08"
                    plan["date_channel_fields"].append({**common, "new_value": shown})
                elif attr_type == "9":
                    unit_options = [str(x.get("optionValue") or "") for x in attr.get("optionList") or []]
                    existing_match = re.fullmatch(r"(\d+(?:\.\d+)?)(.+)", current_values[0]) if current_values else None
                    existing_unit = existing_match.group(2).strip() if existing_match else ""
                    unit = existing_unit if existing_unit in unit_options else ("个月" if "个月" in unit_options else unit_options[0])
                    number = existing_match.group(1) if existing_match and existing_unit == unit else "12"
                    shown = f"{number}{unit}"
                    plan["duration_channel_fields"].append({**common, "number": number, "unit": unit})
                elif attr_type == "10":
                    shown, parts = choose_struct_parts(attr, title, current_values[0] if current_values else "")
                    plan["structured_channel_fields"].append({**common, "display_value": shown, "parts": parts})
                else:
                    raise RuntimeError(f"{spu_id} {channel_id} {attr_name} 未支持类型 {attr_type}")
                audit.append({
                    "spu_id": spu_id, "title": title, "channel_id": channel_id, "attr_id": attr_id,
                    "attr_name": attr_name, "old_value": " / ".join(current_values), "new_value": shown, "source": source,
                })
        if any(isinstance(value, list) and value for key, value in plan.items() if key not in {"spu_id", "update_profile"}):
            plan_path = OUTPUT_DIR / "plans" / f"{spu_id}.json"
            dump(plan_path, plan)
            rows.append({"spu_id": spu_id, "title": title, "status": "ready", "plan_path": str(plan_path)})
    dump(OUTPUT_DIR / "index.json", {"rows": rows})
    dump(OUTPUT_DIR / "audit.json", {"fields": audit})
    print(json.dumps({"ok": True, "products": len(rows), "fields": len(audit), "bocha_calls": 0, "model_calls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
