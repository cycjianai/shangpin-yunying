#!/usr/bin/env python3
"""Build a per-SPU QNH audit-error strategy ledger from a frozen detail snapshot."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


RULES: tuple[dict[str, Any], ...] = (
    {
        "key": "regulated_or_prohibited",
        "name": "禁售/经营范围/受监管商品",
        "pattern": r"禁售|超出经营范围|商家端删除|情趣用品|农药|医疗器械",
        "action": "停止自动提交；核对经营资质、类目和商品本体，不能通过改名规避平台规则。",
        "evidence": "平台经营资质、商品真实类目和监管登记。",
        "automation": "manual_block",
    },
    {
        "key": "cosmetic_filing",
        "name": "化妆品备案/小金盾",
        "pattern": r"化妆品备案|备案编码|小金盾|国妆",
        "action": "检索国家药监备案并复用真实包装背签；备案号、备案人和商品名必须一致。",
        "evidence": "国家药监公开记录或同一商品清晰真实背签。",
        "automation": "evidence_only",
    },
    {
        "key": "ccc_certificate",
        "name": "3C证书/编号/制造商",
        "pattern": r"3C|强制性产品认证|制造商|社会信用代码",
        "action": "按品牌+精确型号查询博查/CQC；仅写16位真实证书编号并核对制造商，真实证书图可复用。",
        "evidence": "博查/CQC命中品牌、型号、制造商一致的有效证书。",
        "automation": "evidence_only",
    },
    {
        "key": "ingredients_nutrition",
        "name": "配料/营养成分图",
        "pattern": r"配料(?:&|/)?营养|配料表|营养成分图|缺少配料图",
        "action": "先取同SPU真实背标或精确同款图库图；需要增强时复用正式配料营养提示词，生成后逐字OCR/目视对照再上传。",
        "evidence": "品牌、品名、口味、规格一致，且配料表与营养成分表共同清晰完整。",
        "automation": "reference_generate_or_reuse",
    },
    {
        "key": "back_label",
        "name": "背签图",
        "pattern": r"缺少背签图|执行标准号|卫生许可证号|主要原材料",
        "action": "复用同款真实背签；增强仅限基于同一真实参考图做清晰化，不新增标签事实，随后OCR核对执行标准、许可证及原材料。",
        "evidence": "同一精确商品真实包装背签或可逐字核验的参考图。",
        "automation": "reference_generate_or_reuse",
    },
    {
        "key": "factory_model_label",
        "name": "包装标签/厂名厂址/型号",
        "pattern": r"包装标签图|厂名|厂址|产品型号",
        "action": "从同SPU或精确同款包装标签取厂名、厂址、型号；可做清晰化增强，不得编造厂家或型号。",
        "evidence": "同款标签上可见厂名、厂址、型号，且型号与标题/SKU无冲突。",
        "automation": "reference_generate_or_reuse",
    },
    {
        "key": "size_picture",
        "name": "尺寸图",
        "pattern": r"缺少尺寸图|【尺寸图】",
        "action": "只用标题、SKU或真实包装中明确尺寸生成标注图；多规格分别核对。",
        "evidence": "可追溯的长宽高/长度及单位，型号和规格完全一致。",
        "automation": "fact_generate",
    },
    {
        "key": "textile_label",
        "name": "纺织品说明/吊牌洗唛",
        "pattern": r"纺织品使用说明|吊牌|洗唛|安全类别|面料成分|填充物成分",
        "action": "复用同款吊牌/洗唛或真实标签；安全类别、面料和填充物需逐字核对。",
        "evidence": "同一商品吊牌、洗唛或包装标识。",
        "automation": "evidence_only",
    },
    {
        "key": "barcode",
        "name": "条形码",
        "pattern": r"条形码|条码",
        "action": "扫描同SPU图片或检索权威精确同款GTIN；校验GTIN校验位、规格和SKU映射后写入。",
        "evidence": "GTIN-8/12/13/14校验通过，品牌、品名、容量/件数完全一致。",
        "automation": "evidence_only",
    },
    {
        "key": "missing_detail_image",
        "name": "缺少详情图",
        "pattern": r"缺少图片详情|缺少详情图",
        "action": "详情为空时复用同SPU现有主图，最多5张；不得跨SPU取图。",
        "evidence": "图片属于当前SPU。",
        "automation": "safe_direct",
    },
    {
        "key": "main_image_quality",
        "name": "主图质量/水印/空图",
        "pattern": r"水印|空图|无主图|图片模糊|主体占比|主体未完整|违规图",
        "action": "从同SPU详情或精确标题图库选择无水印、主体完整清晰图片并维持至少3张。",
        "evidence": "品牌、型号、规格、图案一致且人工目视无水印/空图。",
        "automation": "reviewed_gallery",
    },
    {
        "key": "title_fact",
        "name": "商品名缺品牌/规格/功率",
        "pattern": r"商品名称缺少(?:品牌|规格|重量|功率)|商品名.*缺少",
        "action": "只把商品现有品牌字段、SKU规格/重量或铭牌功率补入标题，并遵守标题长度。",
        "evidence": "当前主档字段、SKU或同SPU图片中的明确事实。",
        "automation": "safe_direct",
    },
    {
        "key": "attribute_exact_suggestion",
        "name": "平台明确属性建议",
        "pattern": r"建议“[^”]+”改为“[^”]+”",
        "action": "核对字段对齐、候选选项和包装/口味冲突后，采用平台建议；当前值相同则不重复保存。",
        "evidence": "审核原文建议值+当前类目候选+商品标题/规格无冲突。",
        "automation": "safe_direct",
    },
    {
        "key": "attribute_missing_or_invalid",
        "name": "属性错误或未填",
        "pattern": r"类目属性.*(?:填写错误|未填写|不符合平台填写规范)",
        "action": "先用平台明确建议，其次跨渠道同名字段和SKU结构化事实；无证据的文本字段保留阻塞。",
        "evidence": "平台建议、同商品跨渠道值、SKU或同SPU图片。",
        "automation": "conditional",
    },
)


def _text(value: object) -> str:
    return " ".join(str(value or "").split())


def _abnormal_rows(detail: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for channel in detail.get("noSaleChannelInfoList") or []:
        if not isinstance(channel, dict):
            continue
        for issue in channel.get("noSaleAbnormalInfoList") or []:
            if isinstance(issue, dict):
                rows.append(issue)
    return rows


def _classify(issue_text: str) -> list[dict[str, Any]]:
    matched = [rule for rule in RULES if re.search(rule["pattern"], issue_text, re.IGNORECASE)]
    if matched:
        return matched
    return [
        {
            "key": "manual_other",
            "name": "其他平台审核问题",
            "action": "保留审核原文，进入人工/增量规则分析；未识别前不盲目保存。",
            "evidence": "平台审核原文与商品当前详情。",
            "automation": "manual_review",
        }
    ]


def _missing_pictures(detail: dict[str, Any]) -> list[dict[str, Any]]:
    pictures: list[dict[str, Any]] = []
    for raw in detail.get("mtSpecialPictureList") or []:
        if not isinstance(raw, dict):
            continue
        existing = raw.get("pictureUrl") or []
        if isinstance(existing, str):
            existing = [existing] if existing else []
        required = int(raw.get("isRequired") or 0) == 1
        minimum = int(raw.get("numMin") or (1 if required else 0))
        if required and len(existing) < minimum:
            pictures.append(raw)
    return pictures


def _autosize(sheet: Any, maximum: int = 60) -> None:
    for column in range(1, sheet.max_column + 1):
        width = max(
            (len(_text(sheet.cell(row, column).value)) for row in range(1, sheet.max_row + 1)),
            default=8,
        )
        sheet.column_dimensions[get_column_letter(column)].width = min(maximum, max(10, width + 2))


def _style_sheet(sheet: Any) -> None:
    fill = PatternFill("solid", fgColor="F05A28")
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    _autosize(sheet)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--output-prefix", required=True)
    args = parser.parse_args()

    details_path = Path(args.details).resolve()
    output_prefix = Path(args.output_prefix).resolve()
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    snapshot = json.loads(details_path.read_text(encoding="utf-8"))

    detail_rows: list[dict[str, Any]] = []
    picture_rows: list[dict[str, Any]] = []
    product_rule_keys: dict[str, set[str]] = {}
    rule_counter: Counter[str] = Counter()

    for product in snapshot.get("products") or []:
        if not isinstance(product, dict):
            continue
        spu_id = _text(product.get("spu_id"))
        title = _text(product.get("title"))
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        for issue in _abnormal_rows(detail):
            original = _text(issue.get("abnormalInfo"))
            prefix = "；".join(
                part
                for part in (
                    _text(issue.get("abnormalDesc")),
                    _text(issue.get("abnormalHandleMsg")),
                )
                if part
            )
            issue_text = "；".join(part for part in (prefix, original) if part)
            rules = _classify(issue_text)
            keys = product_rule_keys.setdefault(spu_id, set())
            for rule in rules:
                keys.add(rule["key"])
            detail_rows.append(
                {
                    "SPU": spu_id,
                    "商品名": title,
                    "异常码": _text(issue.get("abnormalCode")),
                    "审核类型": _text(issue.get("abnormalDesc")),
                    "处理提示": _text(issue.get("abnormalHandleMsg")),
                    "审核原文": original,
                    "规则分类": "；".join(rule["name"] for rule in rules),
                    "执行策略": "；".join(rule["action"] for rule in rules),
                    "证据门": "；".join(rule["evidence"] for rule in rules),
                    "自动化级别": "；".join(rule["automation"] for rule in rules),
                }
            )
        for picture in _missing_pictures(detail):
            existing = picture.get("pictureUrl") or []
            if isinstance(existing, str):
                existing = [existing] if existing else []
            picture_rows.append(
                {
                    "SPU": spu_id,
                    "商品名": title,
                    "图片类型": _text(picture.get("pictureType")),
                    "图片标题": _text(picture.get("pictureTitle")),
                    "图片要求": _text(picture.get("pictureDesc")),
                    "最低数量": int(picture.get("numMin") or 1),
                    "数量上限": int(picture.get("numLimit") or 4),
                    "当前数量": len(existing),
                }
            )

    for keys in product_rule_keys.values():
        rule_counter.update(keys)
    summary_rows = []
    rule_by_key = {rule["key"]: rule for rule in RULES}
    rule_by_key["manual_other"] = {
        "name": "其他平台审核问题",
        "action": "保留原文并人工分析，不盲目保存。",
        "evidence": "平台审核原文与商品详情。",
        "automation": "manual_review",
    }
    for key, count in rule_counter.most_common():
        rule = rule_by_key[key]
        summary_rows.append(
            {
                "规则编码": key,
                "规则分类": rule["name"],
                "涉及SPU数": count,
                "执行策略": rule["action"],
                "证据门": rule["evidence"],
                "自动化级别": rule["automation"],
            }
        )

    csv_path = output_prefix.with_suffix(".csv")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(detail_rows[0].keys()) if detail_rows else ["SPU"])
        writer.writeheader()
        writer.writerows(detail_rows)

    json_path = output_prefix.with_suffix(".json")
    json_path.write_text(
        json.dumps(
            {
                "details_path": str(details_path),
                "product_total": len(snapshot.get("products") or []),
                "audit_row_total": len(detail_rows),
                "classified_product_total": len(product_rule_keys),
                "missing_picture_row_total": len(picture_rows),
                "summary": summary_rows,
                "details": detail_rows,
                "missing_pictures": picture_rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    workbook = Workbook()
    overview = workbook.active
    overview.title = "统计"
    overview.append(["指标", "数量"])
    overview.append(["冻结商品数", len(snapshot.get("products") or [])])
    overview.append(["审核问题行数", len(detail_rows)])
    overview.append(["已分类SPU数", len(product_rule_keys)])
    overview.append(["缺少必传专项图行数", len(picture_rows)])
    _style_sheet(overview)

    for title, rows in (
        ("报错策略汇总", summary_rows),
        ("商品报错明细", detail_rows),
        ("缺少资质图", picture_rows),
    ):
        sheet = workbook.create_sheet(title)
        headers = list(rows[0].keys()) if rows else ["无数据"]
        sheet.append(headers)
        for row in rows:
            sheet.append([row.get(header, "") for header in headers])
        _style_sheet(sheet)

    xlsx_path = output_prefix.with_suffix(".xlsx")
    workbook.save(xlsx_path)
    print(
        json.dumps(
            {
                "ok": True,
                "product_total": len(snapshot.get("products") or []),
                "audit_row_total": len(detail_rows),
                "missing_picture_row_total": len(picture_rows),
                "csv": str(csv_path),
                "xlsx": str(xlsx_path),
                "json": str(json_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
