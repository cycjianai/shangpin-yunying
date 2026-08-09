#!/usr/bin/env python3
"""Export field-level QNH change evidence and per-product terminal status."""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any


CHANNEL_NAMES = {100: "美团闪购", 200: "饿了么", 300: "京东"}

REASON_GROUPS = (
    ("配料/营养成分图片", ("配料", "营养成分")),
    ("包装标签/厂名厂址/型号", ("包装标签", "厂名", "厂址", "产品型号")),
    ("条形码/UPC", ("条形码", "条码", "UPC")),
    ("尺寸/背签/纺织标识", ("尺寸图", "背签图", "纺织品使用说明", "洗涤标识")),
    ("CCC/强制认证", ("3C", "CCC", "强制性产品认证")),
    ("医疗/化妆品/经营资质", ("医疗器械", "化妆品", "备案", "注册证", "经营资质", "许可证")),
    ("主图/详情图数量", ("缺少图片详情", "少于2张", "少于3张", "空图", "无主图")),
    ("图片质量/水印/主体", ("图片模糊", "图片主体", "水印", "图片信息违规", "图片质量")),
    ("名称/规格/类目/普通属性", ("商品名称", "规格名称", "类目属性", "商品类目", "缺少属性")),
    ("禁售/经营范围/侵权", ("禁售", "经营范围", "平台下架", "商标侵权")),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--initial-manifest", required=True)
    parser.add_argument("--initial-details", required=True)
    parser.add_argument("--final-manifest", required=True)
    parser.add_argument("--final-details", required=True)
    parser.add_argument("--planning-index", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--completed-prefix")
    return parser.parse_args()


def load(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def issue_text(row: dict[str, Any]) -> str:
    value = row.get("issue_text") or []
    return "；".join(str(item) for item in value if str(item).strip())


def channel_snapshot(summary: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for channel in summary.get("channels") or []:
        channel_id = int(channel.get("channel_id") or 0)
        prefix = f"{channel_id}"
        values[f"{prefix}:渠道类目"] = {
            "code": channel.get("category_code") or "",
            "name": channel.get("category_name") or "",
        }
        if channel.get("brand_name"):
            values[f"{prefix}:渠道品牌"] = channel.get("brand_name")
        for prop in channel.get("properties") or []:
            values[f"{prefix}:{prop.get('attr_name') or prop.get('attr_id')}"] = prop.get("values") or []
    return values


def ui_changes(result: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    before = result.get("before") or {}
    after = result.get("after") or {}
    for key, label in (
        ("title", "商品名称"),
        ("selling_point", "商品卖点"),
        ("basic_brand", "总部品牌"),
        ("origin_place", "原产地"),
        ("product_place", "产地"),
        ("main_image_count", "主图数量"),
        ("detail_image_count", "详情图数量"),
        ("qualification_image_count", "医疗器械资质图数量"),
    ):
        if before.get(key) != after.get(key):
            changes.append(
                {
                    "field_path": key,
                    "field_name": label,
                    "old_value": before.get(key),
                    "new_value": after.get(key),
                }
            )
    old_channels = channel_snapshot(before)
    new_channels = channel_snapshot(after)
    for key in sorted(set(old_channels) | set(new_channels)):
        if old_channels.get(key) == new_channels.get(key):
            continue
        channel_id, field_name = key.split(":", 1)
        changes.append(
            {
                "field_path": f"channel.{channel_id}.{field_name}",
                "field_name": f"{CHANNEL_NAMES.get(int(channel_id), channel_id)}:{field_name}",
                "old_value": old_channels.get(key),
                "new_value": new_channels.get(key),
            }
        )
    return changes


def field_name(field_path: str) -> str:
    if field_path == "title":
        return "商品名称"
    if field_path == "selling_point":
        return "商品卖点"
    if field_path == "basic.brand":
        return "总部品牌"
    if field_path == "main_images":
        return "商品主图"
    if field_path == "detail_images":
        return "商品详情图"
    if field_path.startswith("special_picture."):
        return f"专项/资质图类型{field_path.rsplit('.', 1)[-1]}"
    if field_path.startswith("channel."):
        _, channel_id, name = field_path.split(".", 2)
        return f"{CHANNEL_NAMES.get(int(channel_id), channel_id)}:{name}"
    if field_path.startswith("sku.") and field_path.endswith(".spec_name"):
        return "SKU规格名称"
    if field_path.startswith("sku.") and field_path.endswith(".upc_list"):
        return "SKU条形码"
    return field_path


def best_decision(
    decisions_by_spu: dict[str, list[dict[str, Any]]],
    spu_id: str,
    path: str,
    name: str,
) -> dict[str, Any]:
    candidates = decisions_by_spu.get(spu_id) or []
    special_picture_names = {
        "3": "包装标签图",
        "4": "质量认证图",
        "5": "配料&营养成分图",
        "6": "纺织品使用说明",
        "7": "吊牌洗唛图",
        "8": "背签图",
        "13": "尺寸图",
    }
    channel_id = ""
    attr_name = name
    if path.startswith("channel."):
        _, channel_id, attr_name = path.split(".", 2)
    for decision in candidates:
        field = str(decision.get("field") or "")
        if path == "title" and field == "商品名称":
            return decision
        if path == "selling_point" and field == "商品卖点":
            return decision
        if path == "main_images" and field == "商品主图":
            return decision
        if path.startswith("special_picture."):
            picture_type = path.rsplit(".", 1)[-1]
            expected_title = special_picture_names.get(picture_type, "")
            if (
                field.startswith("资质图:")
                or (expected_title and expected_title in field)
                or (
                    picture_type == "5"
                    and "配料" in field
                    and "营养成分" in field
                )
            ):
                return decision
        if path.startswith("sku.") and name in {"SKU规格名称", "SKU条形码"} and field == name:
            return decision
        if channel_id and (field == f"{channel_id}:{attr_name}" or field == attr_name):
            return decision
        if field.endswith(f":{attr_name}"):
            return decision
        if attr_name and attr_name in field:
            return decision
    return {}


def percentile95(values: list[float]) -> float | str:
    if not values:
        return ""
    ordered = sorted(values)
    index = int((len(ordered) - 1) * 0.95)
    return round(ordered[index], 2)


def remaining_reason_rows(final_unavailable: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in final_unavailable.values():
        current_issue = issue_text(row)
        matched = False
        for group_name, tokens in REASON_GROUPS:
            if any(token.lower() in current_issue.lower() for token in tokens):
                grouped[group_name].append(row)
                matched = True
        if not matched:
            grouped["其他/需逐条复核"].append(row)

    rows: list[dict[str, Any]] = []
    total = len(final_unavailable)
    for group_name, products in grouped.items():
        examples = products[:5]
        rows.append(
            {
                "剩余原因分类": group_name,
                "涉及SPU数": len(products),
                "占当前不可售比例": round(len(products) / total, 4) if total else 0,
                "样例SPU": "；".join(str(row.get("spu_id") or "") for row in examples),
                "样例商品": "\n".join(str(row.get("title") or "") for row in examples),
                "处理边界": (
                    "必须取得同SPU实物包装、法定证照或权威商品证据后再写入"
                    if group_name
                    in {
                        "配料/营养成分图片",
                        "包装标签/厂名厂址/型号",
                        "条形码/UPC",
                        "尺寸/背签/纺织标识",
                        "CCC/强制认证",
                        "医疗/化妆品/经营资质",
                    }
                    else "依据平台原始报错逐条复核；仅提交有证据且可回读的字段"
                ),
            }
        )
    return sorted(rows, key=lambda row: (-int(row["涉及SPU数"]), str(row["剩余原因分类"])))


def checkpoint_performance_rows(run_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for checkpoint_path in sorted(run_dir.glob("*-checkpoint.json")):
        try:
            checkpoint = load(checkpoint_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        item_rows = checkpoint.get("rows") or []
        statuses: dict[str, int] = defaultdict(int)
        durations: list[float] = []
        for item in item_rows:
            statuses[str(item.get("status") or "unknown")] += 1
            duration = item.get("duration_ms")
            if isinstance(duration, (int, float)):
                durations.append(float(duration))
        selected_total = int(checkpoint.get("selected_total") or len(item_rows))
        elapsed_ms = checkpoint.get("elapsed_ms")
        throughput = (
            round(float(elapsed_ms) / selected_total, 2)
            if isinstance(elapsed_ms, (int, float)) and selected_total
            else ""
        )
        rows.append(
            {
                "批次": checkpoint_path.stem,
                "选择商品数": selected_total,
                "并发数": int(checkpoint.get("concurrency") or 1),
                "墙钟耗时ms": elapsed_ms if elapsed_ms is not None else "",
                "墙钟平均ms/商品": throughput,
                "单商品平均ms": round(mean(durations), 2) if durations else "",
                "单商品P95ms": percentile95(durations),
                "保存回读成功": statuses.get("verified", 0),
                "无需修改": statuses.get("no_change", 0),
                "失败": statuses.get("failed", 0),
                "说明": (
                    "当前检查点可能包含断点续跑复用；墙钟平均仅在记录elapsed_ms时用于吞吐考核"
                ),
                "检查点文件": str(checkpoint_path),
            }
        )
    return rows


def main() -> None:
    args = parse_args()
    run_dir = Path(args.run_dir).resolve()
    initial_manifest = load(args.initial_manifest)
    initial_details = load(args.initial_details)
    final_manifest = load(args.final_manifest)
    final_details = load(args.final_details)
    planning = load(args.planning_index)
    initial_by_spu = {
        str(row.get("spu_id") or ""): row for row in initial_manifest.get("products") or []
    }
    final_unavailable = {
        str(row.get("spu_id") or ""): row for row in final_manifest.get("products") or []
    }
    final_detail_by_spu = {
        str(row.get("spu_id") or ""): row for row in final_details.get("products") or []
    }
    planning_by_spu = {
        str(row.get("spu_id") or ""): row for row in planning.get("rows") or []
    }

    decisions_by_spu: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pattern in (
        run_dir / "planning-v7/plans-official/*.json",
        run_dir / "planning-resume1/plans-official/*.json",
        run_dir / "planning-postwrite1/plans-official/*.json",
        run_dir / "retry-plans/*.json",
        run_dir / "planning-media-*/*.json",
        run_dir / "planning-media-final/*.json",
        run_dir / "safe-text-postwrite1/*.json",
        run_dir / "safe-text-final-audit/*.json",
        run_dir / "safe-spec-postwrite1/*.json",
        run_dir / "safe-barcode-postwrite1/*.json",
        run_dir / "gallery-poc5/*.json",
        run_dir / "gallery-min3-all/*.json",
        run_dir / "special-picture-mirror-all/*.json",
        run_dir / "authentic-special-picture-poc5/*.json",
        run_dir / "planning-post-qualification/plans-official/*.json",
        run_dir / "official-fact-corrections-*/*.json",
        run_dir / "nutrition-aishuch-*/*-plan.json",
        run_dir / "increment-*/*.json",
        run_dir / "round*-*/*.json",
        run_dir / "poc-plan-*.json",
    ):
        for plan_path in glob.glob(str(pattern)):
            if plan_path.endswith("/index.json"):
                continue
            try:
                plan = load(plan_path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            decisions_by_spu[str(plan.get("spu_id") or "")].extend(plan.get("audit_decisions") or [])
    # Later reason-driven rounds live in their own run directories. Discover only
    # plan-shaped JSON recursively so new evidence does not disappear from the
    # final field ledger when a directory name is added.
    for plan_path in run_dir.rglob("*.json"):
        if plan_path.name in {"index.json"} or plan_path.name.endswith(
            ("-result.json", "-preview.json", "-checkpoint.json", "-receipt.json")
        ):
            continue
        try:
            plan = load(plan_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        spu_id = str(plan.get("spu_id") or "")
        decisions = plan.get("audit_decisions")
        if not spu_id or not isinstance(decisions, list):
            continue
        existing = decisions_by_spu[spu_id]
        for decision in decisions:
            if decision not in existing:
                existing.append(decision)

    changes: list[dict[str, Any]] = []
    product_result_paths: dict[str, list[str]] = defaultdict(list)
    product_verified_changes: dict[str, int] = defaultdict(int)
    result_patterns = (
        "*-result.json",
        "direct-*-result.json",
        "retry-*-result.json",
        "media-main-*-result.json",
        "media-special-*-result.json",
        "poc-*-result.json",
        "resume1-poc-*-result.json",
        "resume1-all-*-result.json",
        "detail-poc-*-result.json",
        "detail-all-*-result.json",
        "safe-text-*-result.json",
        "final-audit-text-*-result.json",
        "safe-spec-poc-*-result.json",
        "safe-spec-all-*-result.json",
        "safe-barcode-*-result.json",
    )
    result_paths: list[str] = []
    for pattern in result_patterns:
        result_paths.extend(glob.glob(str(run_dir / pattern)))
    for result_path in sorted(set(result_paths)):
        result = load(result_path)
        spu_id = str(result.get("spu_id") or "")
        if not spu_id:
            continue
        product_result_paths[spu_id].append(result_path)
        method = (
            "页面UI+CDP"
            if Path(result_path).name.startswith("poc-")
            else "CDP页面上下文直连"
        )
        requested = result.get("requested_changes")
        raw_changes = requested if isinstance(requested, list) else ui_changes(result)
        verification_by_path = {
            str(row.get("field_path") or ""): row for row in result.get("verification") or []
        }
        for change in raw_changes:
            path = str(change.get("field_path") or "")
            name = str(change.get("field_name") or field_name(path))
            decision = best_decision(decisions_by_spu, spu_id, path, name.split(":", 1)[-1])
            verification = verification_by_path.get(path) or {}
            business = result.get("update_business") or {}
            business_code = business.get("code")
            verified = (
                bool(verification.get("verified"))
                if verification
                else business_code in (0, "0", 200, "200")
            )
            readback_status = "是" if verified else "否"
            if (
                path == "special_picture_contract.channel100"
                and business_code in (0, "0", 200, "200")
            ):
                # The public detail response normalizes the modern channel-100
                # mirror back to the authoritative top-level picture list.
                # Keep the request-contract audit row, but do not misreport the
                # non-readable duplicate container as a failed business field.
                readback_status = "不适用（合同镜像已提交）"
            changes.append(
                {
                    "SPU": spu_id,
                    "商品名称(初始)": initial_by_spu.get(spu_id, {}).get("title") or "",
                    "问题(初始)": issue_text(initial_by_spu.get(spu_id, {})),
                    "字段路径": path,
                    "字段名称": name,
                    "修改前": text(change.get("old_value")),
                    "修改后": text(change.get("new_value")),
                    "证据来源": decision.get("source") or "page_readback_diff",
                    "证据说明": decision.get("evidence") or "页面提交前后详情回读差异",
                    "提交方式": method,
                    "HTTP状态": result.get("update_http_status") or "",
                    "业务码": business_code if business_code is not None else "",
                    "业务消息": business.get("message") or "",
                    "全部门店覆盖": text(result.get("coverage_request") or result.get("coverage_scope") or ""),
                    "回读通过": readback_status,
                    "验证时间": result.get("verified_at") or "",
                    "结果文件": result_path,
                }
            )
            if verified:
                product_verified_changes[spu_id] += 1

    changes.sort(key=lambda row: (row["SPU"], row["字段路径"], row["验证时间"]))

    checkpoint_rows: dict[str, dict[str, Any]] = {}
    for checkpoint_path in glob.glob(str(run_dir / "*-checkpoint.json")):
        try:
            checkpoint = load(checkpoint_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        for row in checkpoint.get("rows") or []:
            checkpoint_rows[str(row.get("spu_id") or "")] = row

    latest_verified_title_by_spu: dict[str, str] = {}
    for change in changes:
        if (
            change.get("字段路径") == "title"
            and change.get("回读通过") == "是"
            and str(change.get("修改后") or "").strip()
        ):
            latest_verified_title_by_spu[str(change.get("SPU") or "")] = str(change["修改后"])

    products_out: list[dict[str, Any]] = []
    for spu_id, initial in initial_by_spu.items():
        final_row = final_unavailable.get(spu_id)
        final_detail = (final_detail_by_spu.get(spu_id) or {}).get("detail") or {}
        planning_row = planning_by_spu.get(spu_id) or {}
        result_count = product_verified_changes.get(spu_id, 0)
        checkpoint = checkpoint_rows.get(spu_id) or {}
        if spu_id not in final_unavailable:
            terminal = "已退出渠道不可售筛选"
        elif result_count:
            terminal = "已修改并回读，仍在不可售列表"
        elif planning_row.get("status") == "blocked":
            terminal = "缺少真实资质/受监管信息，未编造"
        elif planning_row.get("status") == "deferred":
            terminal = "候选不足，待人工材料"
        else:
            terminal = "无高置信可安全修改字段"
        products_out.append(
            {
                "SPU": spu_id,
                "商品名称(初始)": initial.get("title") or "",
                "商品名称(终态)": latest_verified_title_by_spu.get(spu_id)
                or final_detail.get("spuName")
                or (final_row or {}).get("title")
                or "",
                "初始问题": issue_text(initial),
                "规划状态": planning_row.get("status") or "",
                "规划原因": planning_row.get("reason") or "",
                "已验证修改字段数": result_count,
                "执行状态": checkpoint.get("status") or ("verified" if result_count else ""),
                "终态是否仍不可售": "是" if final_row else "否",
                "终态问题": issue_text(final_row or {}),
                "终态结论": terminal,
                "结果文件": "\n".join(product_result_paths.get(spu_id) or []),
            }
        )
    products_out.sort(key=lambda row: row["SPU"], reverse=True)

    verified_changes_by_spu: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for change in changes:
        if change.get("回读通过") == "是":
            verified_changes_by_spu[str(change.get("SPU") or "")].append(change)
    product_status_by_spu = {str(row["SPU"]): row for row in products_out}
    completed_out: list[dict[str, Any]] = []
    for spu_id, rows in verified_changes_by_spu.items():
        if not spu_id:
            continue
        status = product_status_by_spu.get(spu_id) or {}
        latest_value_by_field: dict[str, str] = {}
        for row in rows:
            latest_value_by_field[str(row.get("字段名称") or "")] = str(row.get("修改后") or "")
        completed_out.append(
            {
                "SPU": spu_id,
                "商品名称(初始)": status.get("商品名称(初始)")
                or rows[0].get("商品名称(初始)")
                or "",
                "商品名称(终态)": status.get("商品名称(终态)") or "",
                "初始问题": status.get("初始问题") or rows[0].get("问题(初始)") or "",
                "已回读字段数": len(rows),
                "本次新增/修改字段": "；".join(sorted(latest_value_by_field)),
                "字段改后值摘要": "\n".join(
                    f"{name}={value}" for name, value in sorted(latest_value_by_field.items())
                ),
                "证据来源": "；".join(
                    sorted(
                        {
                            str(row.get("证据来源") or "")
                            for row in rows
                            if row.get("证据来源")
                        }
                    )
                ),
                "提交方式": "；".join(
                    sorted(
                        {
                            str(row.get("提交方式") or "")
                            for row in rows
                            if row.get("提交方式")
                        }
                    )
                ),
                "全部字段回读通过": "是",
                "终态是否仍不可售": status.get("终态是否仍不可售") or "",
                "终态问题": status.get("终态问题") or "",
                "终态结论": status.get("终态结论") or "",
                "结果文件": status.get("结果文件")
                or "\n".join(
                    sorted(
                        {
                            str(row.get("结果文件") or "")
                            for row in rows
                            if row.get("结果文件")
                        }
                    )
                ),
            }
        )
    completed_out.sort(key=lambda row: row["SPU"], reverse=True)
    reason_rows = remaining_reason_rows(final_unavailable)
    performance_rows = checkpoint_performance_rows(run_dir)
    readback_changes = [
        row for row in changes if row.get("回读通过") in {"是", "否"}
    ]
    verified_change_count = sum(
        1 for row in readback_changes if row.get("回读通过") == "是"
    )
    modified_still_reviewing = sum(
        1 for spu_id in verified_changes_by_spu if spu_id in final_unavailable
    )
    initial_total = len(initial_by_spu)
    final_initial_scope = {
        spu_id: row
        for spu_id, row in final_unavailable.items()
        if spu_id in initial_by_spu
    }
    platform_added = {
        spu_id: row
        for spu_id, row in final_unavailable.items()
        if spu_id not in initial_by_spu
    }
    final_total = len(final_unavailable)
    final_initial_total = len(final_initial_scope)
    platform_added_total = len(platform_added)
    exited_total = initial_total - final_initial_total
    safe_text_performance = next(
        (row for row in performance_rows if row.get("批次") == "safe-text-all-checkpoint"),
        {},
    )
    if not safe_text_performance:
        safe_text_performance = max(
            (
                row
                for row in performance_rows
                if int(row.get("并发数") or 0) == 10
                and int(row.get("保存回读成功") or 0) > 0
            ),
            key=lambda row: int(row.get("选择商品数") or 0),
            default={},
        )
    barcode_path = run_dir / "barcode-scan-resume1.json"
    if not barcode_path.exists():
        barcode_path = run_dir / "barcode-scan.json"
    barcode = load(barcode_path) if barcode_path.exists() else {}
    self_evaluation_rows = [
        {
            "指标": "初始渠道不可售SPU",
            "值": initial_total,
            "口径/说明": "任务开始时冻结的完整筛选快照",
        },
        {
            "指标": f"当前审核快照仍不可售SPU（初始{initial_total}口径）",
            "值": final_initial_total,
            "口径/说明": "当前快照与初始清单按SPU取交集；用于计算初始任务退出数",
        },
        {
            "指标": "当前平台不可售SPU（含任务后新增）",
            "值": final_total,
            "口径/说明": "保存后平台异步审核中的当前快照，不等同最终审核结论",
        },
        {
            "指标": "任务后平台新增不可售SPU",
            "值": platform_added_total,
            "口径/说明": f"当前平台快照中不属于初始{initial_total}清单的SPU，不计入本任务退出率分母",
        },
        {
            "指标": "已退出当前不可售筛选SPU",
            "值": exited_total,
            "口径/说明": f"初始{initial_total}-当前初始口径仍不可售{final_initial_total}",
        },
        {
            "指标": "当前筛选退出率",
            "值": round(exited_total / initial_total, 4) if initial_total else 0,
            "口径/说明": "仅反映当前平台审核快照",
        },
        {
            "指标": "有逐字段回读证据的SPU",
            "值": len(completed_out),
            "口径/说明": "至少一个字段保存后重新读取并与计划值完全一致",
        },
        {
            "指标": "字段级修改事件",
            "值": len(changes),
            "口径/说明": "每次提交的字段级审计行；同字段若分批修订会保留多次事件",
        },
        {
            "指标": "字段回读通过率",
            "值": round(verified_change_count / len(readback_changes), 4)
            if readback_changes
            else 0,
            "口径/说明": (
                f"{verified_change_count}/{len(readback_changes)}；"
                "排除公开详情不返回的内部渠道合同镜像；衡量保存物化，不代表平台审核必然通过"
            ),
        },
        {
            "指标": "已修改但当前仍在审核/不可售",
            "值": modified_still_reviewing,
            "口径/说明": "平台审核可能需几分钟至1–2小时，需后续复扫",
        },
        {
            "指标": "10并发实写批次墙钟平均ms/商品",
            "值": safe_text_performance.get("墙钟平均ms/商品", ""),
            "口径/说明": (
                f"{safe_text_performance.get('选择商品数', '')}个商品，"
                f"耗时{safe_text_performance.get('墙钟耗时ms', '')}ms，"
                f"成功{safe_text_performance.get('保存回读成功', '')}，"
                f"失败{safe_text_performance.get('失败', '')}"
            ),
        },
        {
            "指标": "同SPU图片条码扫描",
            "值": barcode.get("images_scanned", ""),
            "口径/说明": (
                f"涉及{barcode.get('barcode_issue_spu_count', '')}个条码报错SPU；"
                f"校验通过候选{barcode.get('candidate_spu_count', '')}，"
                "未命中时不猜测、不把SKU号当条码"
            ),
        },
    ]

    output_prefix = Path(args.output_prefix).resolve()
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    csv_path = output_prefix.with_suffix(".csv")
    fields = list(changes[0].keys()) if changes else [
        "SPU",
        "商品名称(初始)",
        "问题(初始)",
        "字段路径",
        "字段名称",
        "修改前",
        "修改后",
        "证据来源",
        "证据说明",
        "提交方式",
        "HTTP状态",
        "业务码",
        "业务消息",
        "全部门店覆盖",
        "回读通过",
        "验证时间",
        "结果文件",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(changes)

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError as exc:
        raise SystemExit("缺少 openpyxl；请先安装后再导出 XLSX") from exc

    workbook = Workbook()
    change_sheet = workbook.active
    change_sheet.title = "字段修改明细"
    status_sheet = workbook.create_sheet("商品终态")
    completed_sheet = workbook.create_sheet("已完成SPU清单")
    reason_sheet = workbook.create_sheet("剩余不可售原因")
    performance_sheet = workbook.create_sheet("并发性能")
    self_evaluation_sheet = workbook.create_sheet("自评与口径")

    def append_sheet(sheet: Any, rows: list[dict[str, Any]], headers: list[str]) -> None:
        sheet.append(headers)
        for row in rows:
            sheet.append([row.get(header, "") for header in headers])
        fill = PatternFill("solid", fgColor="FDE9D9")
        for cell in sheet[1]:
            cell.font = Font(bold=True)
            cell.fill = fill
            cell.alignment = Alignment(horizontal="center", vertical="center")
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for index, header in enumerate(headers, start=1):
            width = min(70, max(12, len(header) * 2 + 2))
            if header in {"商品名称(初始)", "商品名称(终态)", "问题(初始)", "初始问题", "终态问题", "证据说明"}:
                width = 45
            sheet.column_dimensions[get_column_letter(index)].width = width
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)

    append_sheet(change_sheet, changes, fields)
    product_fields = list(products_out[0].keys()) if products_out else []
    append_sheet(status_sheet, products_out, product_fields)
    completed_fields = list(completed_out[0].keys()) if completed_out else []
    append_sheet(completed_sheet, completed_out, completed_fields)
    reason_fields = list(reason_rows[0].keys()) if reason_rows else []
    append_sheet(reason_sheet, reason_rows, reason_fields)
    performance_fields = list(performance_rows[0].keys()) if performance_rows else []
    append_sheet(performance_sheet, performance_rows, performance_fields)
    self_evaluation_fields = list(self_evaluation_rows[0].keys())
    append_sheet(self_evaluation_sheet, self_evaluation_rows, self_evaluation_fields)
    xlsx_path = output_prefix.with_suffix(".xlsx")
    workbook.save(xlsx_path)

    completed_prefix = Path(
        args.completed_prefix or (output_prefix.parent / "qnh-completed-spus")
    ).resolve()
    completed_prefix.parent.mkdir(parents=True, exist_ok=True)
    completed_csv_path = completed_prefix.with_suffix(".csv")
    with completed_csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=completed_fields)
        writer.writeheader()
        writer.writerows(completed_out)
    completed_workbook = Workbook()
    completed_only_sheet = completed_workbook.active
    completed_only_sheet.title = "已完成SPU清单"
    append_sheet(completed_only_sheet, completed_out, completed_fields)
    completed_xlsx_path = completed_prefix.with_suffix(".xlsx")
    completed_workbook.save(completed_xlsx_path)

    os.chmod(csv_path, 0o600)
    os.chmod(xlsx_path, 0o600)
    os.chmod(completed_csv_path, 0o600)
    os.chmod(completed_xlsx_path, 0o600)
    print(
        json.dumps(
            {
                "ok": True,
                "csv_path": str(csv_path),
                "xlsx_path": str(xlsx_path),
                "completed_csv_path": str(completed_csv_path),
                "completed_xlsx_path": str(completed_xlsx_path),
                "change_row_count": len(changes),
                "product_row_count": len(products_out),
                "completed_spu_count": len(completed_out),
                "current_platform_unavailable_count": final_total,
                "final_unavailable_count": final_initial_total,
                "platform_added_unavailable_count": platform_added_total,
                "exited_unavailable_count": exited_total,
                "reason_group_count": len(reason_rows),
                "performance_batch_count": len(performance_rows),
                "field_readback_pass_rate": (
                    round(verified_change_count / len(readback_changes), 4)
                    if readback_changes
                    else 0
                ),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
