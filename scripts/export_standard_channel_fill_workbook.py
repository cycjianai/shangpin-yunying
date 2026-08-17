#!/usr/bin/env python3
"""Create the schema-locked B/C ledger for a completed QNH channel run."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill

from channel_workbook_schema import (
    AUDIT_SHEET,
    CANONICAL_GENERATED_SHEETS,
    FEEDBACK_SHEET,
    GENERATED_SOURCE_SHEET,
    HEADERS,
    MISSING_SHEET,
    PERFORMANCE_SHEET,
    SCHEMA_VERSION,
    SOURCE_B_HEADER,
    SOURCE_C_HEADER,
    SUMMARY_METRICS,
    SUMMARY_SHEET,
    VERIFY_METRICS,
    VERIFY_SHEET,
)
from qnh_task_contract import read_ledger, verify_contract

CHANNELS = {100: "美团", 200: "饿了么", 300: "京东"}
HEADER_FILL = PatternFill("solid", fgColor="F4B183")


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def header(sheet, values: list[str]) -> None:
    sheet.append(values)
    for cell in sheet[sheet.max_row]:
        cell.font = Font(bold=True)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(wrap_text=True, vertical="top")


def displayed(attr: dict) -> str:
    values: list[str] = []
    for custom in attr.get("customValue") or []:
        if not isinstance(custom, dict):
            continue
        scalar = str(custom.get("attrValue") or "").strip()
        if scalar:
            values.append(scalar)
        for struct in custom.get("structAttrValueList") or []:
            for row in struct.get("valueList") or []:
                if isinstance(row, list):
                    text = "".join(
                        str(part.get("value") or part.get("optionValue") or "")
                        for part in row if isinstance(part, dict)
                    ).strip()
                    if text:
                        values.append(text)
    return " / ".join(values)


def product_ids(path: Path) -> list[str]:
    return [
        str(item.get("spu_id") or "")
        for item in read(path).get("products") or []
        if isinstance(item, dict) and str(item.get("spu_id") or "")
    ]


def final_files(run_dir: Path, expected_spus: set[str] | None = None) -> list[Path]:
    """Select direct-CDP chunks or one manifest-complete extension snapshot."""
    pattern = re.compile(r"details-full-c(\d+)-(final2|final)-(\d+)\.json$")
    selected: dict[int, tuple[int, Path]] = {}
    for path in run_dir.glob("details-full-c*-final*.json"):
        match = pattern.match(path.name)
        if not match:
            continue
        chunk = int(match.group(1))
        modified_ns = path.stat().st_mtime_ns
        if chunk not in selected or modified_ns > selected[chunk][0]:
            selected[chunk] = (modified_ns, path)
    chunk_files = [selected[index][1] for index in sorted(selected)]
    if expected_spus is None:
        return chunk_files
    chunk_ids = [spu_id for path in chunk_files for spu_id in product_ids(path)]
    if len(chunk_ids) == len(set(chunk_ids)) and set(chunk_ids) == expected_spus:
        return chunk_files

    # The extension writes a resumable singleton. Only an exact frozen-manifest
    # set is eligible, so an interrupted/partial file can never feed Excel.
    candidates: list[tuple[int, Path]] = []
    for path in run_dir.glob("details-final*.json"):
        try:
            ids = product_ids(path)
        except (OSError, json.JSONDecodeError):
            continue
        if len(ids) == len(set(ids)) and set(ids) == expected_spus:
            candidates.append((path.stat().st_mtime_ns, path))
    return [max(candidates, key=lambda item: item[0])[1]] if candidates else []


def verified_history_spus(run_dir: Path) -> set[str]:
    verified: set[str] = set()
    for path in run_dir.glob("*-result.json"):
        try:
            payload = read(path)
        except (OSError, json.JSONDecodeError):
            continue
        requested = payload.get("requested_changes") or []
        checks = payload.get("verification") or []
        if (
            payload.get("verified") is True
            and requested
            and len(requested) == len(checks)
            and all(item.get("verified") is True for item in checks)
        ):
            verified.add(str(payload.get("spu_id") or ""))
    return {spu_id for spu_id in verified if spu_id}


def value_text(value: object) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, list):
        return " / ".join(
            part for part in (value_text(item) for item in value) if part
        )
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return str(value).strip()


def verified_result_events(run_dir: Path) -> dict[tuple[str, int, str], dict]:
    """Recover audited fields when an old aggregate audit is partial or absent.

    A history result is admitted only when every requested change has a matching
    independently verified check.  This keeps result fallback as strict as the
    existing history SPU gate; plan-only or partially verified files contribute
    no Excel history.
    """
    events: dict[tuple[str, int, str], dict] = {}
    field_pattern = re.compile(r"^channel\.(\d+)\.(.+)$")
    for path in sorted(run_dir.glob("*-result.json")):
        try:
            payload = read(path)
        except (OSError, json.JSONDecodeError):
            continue
        requested = payload.get("requested_changes") or []
        checks = payload.get("verification") or []
        if not (
            payload.get("verified") is True
            and requested
            and len(requested) == len(checks)
            and all(item.get("verified") is True for item in checks)
        ):
            continue
        check_by_path = {
            str(item.get("field_path") or ""): item for item in checks
        }
        spu_id = str(payload.get("spu_id") or "")
        title = str((payload.get("before") or {}).get("title") or "")
        for change in requested:
            field_path = str(change.get("field_path") or "")
            match = field_pattern.match(field_path)
            check = check_by_path.get(field_path)
            if not match or not check or check.get("verified") is not True:
                continue
            channel_id = int(match.group(1))
            attr_id = str(change.get("attr_id") or "")
            if not spu_id or not attr_id:
                continue
            key = (spu_id, channel_id, attr_id)
            event = {
                "spu_id": spu_id,
                "title": title,
                "channel_id": channel_id,
                "attr_id": attr_id,
                "attr_name": match.group(2),
                "old_value": value_text(change.get("old_value")),
                "new_value": value_text(change.get("new_value")),
                "source": str(change.get("source") or "verified_result_fallback"),
            }
            if key in events:
                event["old_value"] = events[key].get("old_value")
            events[key] = event
    return events


def plan_audit_paths(run_dir: Path) -> list[Path]:
    paths = sorted(run_dir.glob("full-c*-plans/audit.json"))
    paths += sorted(run_dir.glob("full-c*-residual/audit.json"))
    paths += sorted(run_dir.glob("full-c*-residual-plans/audit.json"))
    paths += sorted(run_dir.glob("channel-plans/audit.json"))
    paths += sorted(run_dir.glob("residual-round*-plans/audit.json"))
    recommended = run_dir / "poc10-plans-recommended" / "audit.json"
    if recommended.exists():
        paths.append(recommended)
    return list(dict.fromkeys(paths))


def audit_events(
    run_dir: Path,
    history_run_dirs: list[Path],
) -> dict[tuple[str, int, str], dict]:
    events: dict[tuple[str, int, str], dict] = {}
    sources = [
        (history, verified_history_spus(history))
        for history in history_run_dirs
    ] + [(run_dir, None)]
    for source_dir, verified_spus in sources:
        source_events: dict[tuple[str, int, str], dict] = {}
        for path in plan_audit_paths(source_dir):
            for event in read(path).get("fields") or []:
                spu_id = str(event["spu_id"])
                if verified_spus is not None and spu_id not in verified_spus:
                    continue
                key = (spu_id, int(event["channel_id"]), str(event["attr_id"]))
                source_events[key] = event
        if verified_spus is not None:
            for key, event in verified_result_events(source_dir).items():
                source_events.setdefault(key, event)
        for key, event in source_events.items():
            if key in events:
                event = {**event, "old_value": events[key].get("old_value")}
            events[key] = event
    return events


def performance(run_dirs: list[Path]) -> dict:
    rows: list[dict] = []
    elapsed = 0
    # Direct QNH and extension batches persist one checkpoint per save attempt;
    # preview checkpoints must not be counted as platform delivery events.
    paths: list[Path] = []
    for run_dir in run_dirs:
        for path in sorted(run_dir.glob("*-checkpoint.json")):
            name = path.name
            if (
                "-save-" in name
                or name.startswith("save-")
                or re.match(r"residual-r\d+-.*-checkpoint\.json$", name)
            ):
                paths.append(path)
    counted_paths = 0
    for path in paths:
        payload = read(path)
        if payload.get("dry_run") is True:
            continue
        counted_paths += 1
        checkpoint_rows = payload.get("rows") or []
        rows += checkpoint_rows
        elapsed += int(
            payload.get("elapsed_ms")
            or sum(int(row.get("duration_ms") or 0) for row in checkpoint_rows)
        )
    counts = Counter(str(row.get("status") or "unknown") for row in rows)
    return {
        "checkpoint_files": counted_paths, "events": len(rows),
        "verified": counts["verified"], "failed_responses": counts["failed"],
        "elapsed_ms": elapsed,
    }


def external_counts(contract: dict) -> dict[str, int]:
    counts = {
        "ocr": 0,
        "media_scan": 0,
        "barcode_scan": 0,
        "bocha": 0,
        "web_search": 0,
        "llm": 0,
        "provider_submit": 0,
        "provider_query": 0,
        "image_upload": 0,
    }
    for row in read_ledger(Path(contract["action_ledger_path"])):
        payload = row.get("payload") or {}
        if row.get("action") != "task_action_terminal":
            continue
        if payload.get("outcome") != "succeeded":
            continue
        key = payload.get("budget_key")
        if key in counts:
            counts[key] += int(payload.get("units") or 0)
    return counts


def merge_history(existing: object, current: str, *, generic: bool = False) -> str:
    old = str(existing or "").strip()
    new = str(current or "").strip()
    if not old:
        return new
    if generic or not new or new in old:
        return old
    return f"{old}\n---本轮追加---\n{new}"


def feedback_rows(path: Path | None) -> list[tuple[str, str, str]]:
    if path is None:
        return [("本轮未发现新的可泛化问题", "沿用当前固定合同", "全量机器门通过")]
    payload = read(path)
    source = payload.get("rows") if isinstance(payload, dict) else payload
    rows: list[tuple[str, str, str]] = []
    for item in source or []:
        if not isinstance(item, dict):
            continue
        rows.append(
            (
                str(item.get("new_issue") or item.get("issue") or "").strip(),
                str(item.get("rule") or item.get("fix") or "").strip(),
                str(item.get("validation") or item.get("result") or "").strip(),
            )
        )
    return [row for row in rows if any(row)] or [
        ("本轮未发现新的可泛化问题", "沿用当前固定合同", "全量机器门通过")
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--tenant-name", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-xlsx")
    parser.add_argument("--task-contract", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--feedback-json")
    parser.add_argument("--history-run-dir", action="append", default=[])
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    history_run_dirs = [Path(value).resolve() for value in args.history_run_dir]
    contract = verify_contract(Path(args.task_contract).resolve())
    if contract.get("task_mode") not in {
        "channel_attributes_only",
        "plugin_attribute_fill",
    }:
        raise RuntimeError("标准渠道属性工作簿仅适用于属性填充模式")
    if contract.get("excel_schema_version") != SCHEMA_VERSION:
        raise RuntimeError("Excel Schema 版本不匹配")
    frozen_source = contract.get("source") or {}
    if frozen_source.get("type") == "xlsx":
        if not args.source_xlsx:
            raise RuntimeError("冻结合同包含源 XLSX，导出时必须传 --source-xlsx")
        if Path(args.source_xlsx).resolve() != Path(frozen_source["source_path"]).resolve():
            raise RuntimeError("导出源 XLSX 与冻结合同不一致")
    elif args.source_xlsx:
        raise RuntimeError("冻结合同未绑定源 XLSX，禁止临时替换底稿")
    manifest = read(Path(args.manifest).resolve())
    validation = read(Path(args.validation).resolve())
    if int(validation.get("products_with_issues") or 0) != 0 or int(
        validation.get("issue_count") or 0
    ) != 0:
        raise RuntimeError("最终结构验证仍有问题，禁止导出100%工作簿")
    ordered = [str(item["spu_id"]) for item in manifest["products"]]
    if len(set(ordered)) != len(ordered):
        raise RuntimeError("manifest 包含重复 SPU")
    if len(ordered) != int(contract["source"]["source_unique_spu_count"]):
        raise RuntimeError("manifest 数量与冻结合同不一致")
    current_tenant_id = ""
    if history_run_dirs:
        current_identity = read(run_dir / "session_identity.json")
        current_tenant_id = str(current_identity.get("tenant_id") or "")
    for history_run_dir in history_run_dirs:
        if history_run_dir == run_dir:
            raise RuntimeError("历史 run-dir 不得等于当前 run-dir")
        identity_path = history_run_dir / "session_identity.json"
        if not identity_path.is_file():
            raise RuntimeError(f"历史 run-dir 缺少 session_identity：{history_run_dir}")
        history_tenant_id = str(read(identity_path).get("tenant_id") or "")
        if not current_tenant_id or history_tenant_id != current_tenant_id:
            raise RuntimeError(f"历史 run-dir 租户不一致：{history_run_dir}")
    events = audit_events(run_dir, history_run_dirs)
    by_spu: dict[str, list[dict]] = defaultdict(list)
    wanted: dict[str, set[tuple[int, str]]] = defaultdict(set)
    for (spu_id, channel_id, attr_id), event in events.items():
        by_spu[spu_id].append(event)
        wanted[spu_id].add((channel_id, attr_id))

    states: dict[str, dict] = {}
    final_values: dict[tuple[str, int, str], str] = {}
    selected_files = final_files(run_dir, set(ordered))
    for path in selected_files:
        for product in read(path).get("products") or []:
            spu_id = str(product.get("spu_id") or "")
            states[spu_id] = {
                "title": product.get("title") or "",
                "missing": bool(product.get("missing_on_platform")),
                "reason": product.get("missing_reason") or "",
            }
            for channel in (product.get("detail") or {}).get("spuChannelInfoList") or []:
                channel_id = int(channel.get("channelId") or 0)
                for attr in channel.get("categoryProperties") or []:
                    attr_id = str(attr.get("attrId") or "")
                    if (channel_id, attr_id) in wanted.get(spu_id, set()):
                        final_values[(spu_id, channel_id, attr_id)] = displayed(attr)

    if set(states) != set(ordered):
        raise RuntimeError(f"最终集合不等：final={len(states)} source={len(ordered)}")
    missing = [spu_id for spu_id in ordered if states[spu_id]["missing"]]
    incomplete = [key for key in events if not final_values.get(key)]
    if incomplete:
        raise RuntimeError(f"字段最终回读不完整：{len(events)-len(incomplete)}/{len(events)}")
    extant = len(ordered) - len(missing)
    checked = int(
        validation.get("platform_extant_checked")
        if validation.get("platform_extant_checked") is not None
        else validation.get("products_checked") or 0
    )
    if checked != extant:
        raise RuntimeError(f"最终验证集合不等：checked={checked} extant={extant}")
    changed = sum(bool(by_spu.get(spu_id)) for spu_id in ordered)
    strategy_counts = Counter(str(item.get("source") or "unknown") for item in events.values())
    perf = performance([*history_run_dirs, run_dir])
    ext_calls = external_counts(contract)
    if contract["task_mode"] == "channel_attributes_only" and any(ext_calls.values()):
        raise RuntimeError("纯渠道属性模式检测到禁止的外部调用")

    if args.source_xlsx:
        workbook = load_workbook(Path(args.source_xlsx).resolve())
        for name in CANONICAL_GENERATED_SHEETS:
            if name in workbook.sheetnames:
                workbook.remove(workbook[name])
        if not workbook.worksheets:
            raise RuntimeError("源工作簿移除旧审计表后没有业务工作表")
        source = workbook.worksheets[0]
        summary = workbook.create_sheet(SUMMARY_SHEET, 0)
    else:
        workbook = Workbook()
        workbook.remove(workbook.active)
        summary = workbook.create_sheet(SUMMARY_SHEET)
        source = workbook.create_sheet(GENERATED_SOURCE_SHEET)
    audit = workbook.create_sheet(AUDIT_SHEET)
    missing_sheet = workbook.create_sheet(MISSING_SHEET)
    verify = workbook.create_sheet(VERIFY_SHEET)
    strategy = workbook.create_sheet(FEEDBACK_SHEET)
    speed = workbook.create_sheet(PERFORMANCE_SHEET)

    header(summary, HEADERS[SUMMARY_SHEET])
    summary_values = dict([
        ("Excel Schema版本", SCHEMA_VERSION),
        ("Skill版本", contract["skill_version"]),
        ("任务模式", contract["task_mode"]),
        ("合同指纹SHA256", contract["contract_fingerprint_sha256"]),
        ("牵牛花租户名称", args.tenant_name), ("源表唯一SPU数", len(ordered)),
        ("平台现存SPU数", extant), ("平台记录不存在", len(missing)),
        ("现存SPU最终结构合同通过", extant), ("现存SPU填充率", "100.00%"),
        ("本次有字段修正的SPU", changed), ("执行前完整无需修改", extant - changed),
        ("唯一字段修正数", len(events)), ("字段最终回读通过数", len(events)),
        ("最终字段问题数", 0),
        ("OCR调用数", ext_calls["ocr"]),
        ("媒体扫描数", ext_calls["media_scan"]),
        ("条码扫描数", ext_calls["barcode_scan"]),
        ("博查调用数", ext_calls["bocha"]),
        ("Web搜索调用数", ext_calls["web_search"]),
        ("模型调用数", ext_calls["llm"]),
        ("Provider Submit数", ext_calls["provider_submit"]),
        ("Provider Query数", ext_calls["provider_query"]),
        ("图片上传数", ext_calls["image_upload"]),
        ("验收口径", "非空+类型结构合法+当前类目候选合法+保存后独立全量回读"),
    ])
    for metric in SUMMARY_METRICS:
        summary.append((metric, summary_values[metric]))

    source_rows: dict[str, int] = {}
    if args.source_xlsx:
        source.cell(1, 2, SOURCE_B_HEADER)
        source.cell(1, 3, SOURCE_C_HEADER)
        for cell in source[1]:
            cell.font = Font(bold=True)
            cell.fill = HEADER_FILL
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        for row_number in range(2, source.max_row + 1):
            raw = source.cell(row_number, 1).value
            if raw is None:
                continue
            spu_id = re.sub(r"\.0$", "", str(raw).strip())
            if spu_id:
                source_rows[spu_id] = row_number
        if set(source_rows) != set(ordered):
            raise RuntimeError(
                f"源工作表集合不等：sheet={len(source_rows)} manifest={len(ordered)}"
            )
    else:
        header(source, HEADERS[GENERATED_SOURCE_SHEET])

    def write_source(spu_id: str, before: str, after: str) -> None:
        if args.source_xlsx:
            row_number = source_rows[spu_id]
            generic = before == "执行前已满足渠道属性结构合同"
            source.cell(
                row_number,
                2,
                merge_history(source.cell(row_number, 2).value, before, generic=generic),
            )
            source.cell(
                row_number,
                3,
                merge_history(source.cell(row_number, 3).value, after, generic=generic),
            )
            source.cell(row_number, 2).alignment = Alignment(wrap_text=True, vertical="top")
            source.cell(row_number, 3).alignment = Alignment(wrap_text=True, vertical="top")
        else:
            source.append([spu_id, before, after])

    header(audit, HEADERS[AUDIT_SHEET])
    for spu_id in ordered:
        state = states[spu_id]
        if state["missing"]:
            write_source(spu_id, f"平台无法读取｜{state['reason'] or '记录不存在'}", "未写入｜不计入现存填充率分母")
            continue
        product_events = sorted(by_spu.get(spu_id) or [], key=lambda item: (int(item["channel_id"]), str(item.get("attr_name") or "")))
        if not product_events:
            write_source(spu_id, "执行前已满足渠道属性结构合同", "无需修改；最终全字段复核通过")
            continue
        before: list[str] = []
        after: list[str] = []
        for event in product_events:
            channel_id, attr_id = int(event["channel_id"]), str(event["attr_id"])
            name = str(event.get("attr_name") or "")
            old = str(event.get("old_value") or "").strip()
            planned = str(event.get("new_value") or "").strip()
            final = final_values[(spu_id, channel_id, attr_id)]
            channel = CHANNELS.get(channel_id, str(channel_id))
            reason = "空值" if not old else "旧结构/当前类目合同无效"
            before.append(f"[{channel}] 字段ID={attr_id}｜字段名={name}｜原因={reason}｜旧值={old or '(空值)'}")
            after.append(f"[{channel}] 字段ID={attr_id}｜字段名={name}｜最终值={final}｜已保存并独立回读")
            audit.append([spu_id, state["title"], channel, attr_id, name, old or "(空值)", planned, final, "结构合同通过", str(event.get("source") or "unknown")])
        write_source(spu_id, "；\n".join(before), "；\n".join(after))

    header(missing_sheet, HEADERS[MISSING_SHEET])
    for spu_id in missing:
        missing_sheet.append([spu_id, states[spu_id]["reason"] or "记录不存在", "未写入；从平台现存填充率分母剔除"])
    header(verify, HEADERS[VERIFY_SHEET])
    verify_values = {
        "最终详情分片": len(selected_files),
        "源清单SPU": len(ordered),
        "平台现存SPU": extant,
        "结构合同通过SPU": extant,
        "products_with_issues": 0,
        "issue_count": 0,
        "填充率": "100.00%",
    }
    for metric in VERIFY_METRICS:
        verify.append((metric, verify_values[metric]))

    header(strategy, HEADERS[FEEDBACK_SHEET])
    for row in feedback_rows(Path(args.feedback_json).resolve() if args.feedback_json else None):
        strategy.append(row)

    header(speed, HEADERS[PERFORMANCE_SHEET])
    for row in [
        ("保存checkpoint文件数", perf["checkpoint_files"]), ("保存结果事件数（含残差）", perf["events"]),
        ("verified事件", perf["verified"]), ("failed响应事件（均经复读判定）", perf["failed_responses"]),
        ("批量写墙钟累计秒", round(perf["elapsed_ms"] / 1000, 3)),
        ("OCR调用数", ext_calls["ocr"]),
        ("媒体扫描数", ext_calls["media_scan"]),
        ("条码扫描数", ext_calls["barcode_scan"]),
        ("博查调用数", ext_calls["bocha"]),
        ("Web搜索调用数", ext_calls["web_search"]),
        ("模型调用数", ext_calls["llm"]),
        ("Provider Submit数", ext_calls["provider_submit"]),
        ("Provider Query数", ext_calls["provider_query"]),
        ("图片上传数", ext_calls["image_upload"]),
    ]:
        speed.append(row)
    for key, count in sorted(strategy_counts.items()):
        speed.append((f"策略字段数：{key}", count))

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)
    report = {
        "excel_schema_version": SCHEMA_VERSION,
        "skill_version": contract["skill_version"],
        "task_mode": contract["task_mode"],
        "task_role": contract.get("task_role", "execution"),
        "delivery_eligible": contract.get("task_role", "execution") == "execution",
        "contract_fingerprint_sha256": contract["contract_fingerprint_sha256"],
        "output_xlsx": str(output), "tenant_name": args.tenant_name,
        "source_unique_spu": len(ordered), "platform_extant": extant,
        "missing_on_platform": len(missing), "fill_rate": 1.0,
        "changed_products": changed, "unique_changed_fields": len(events),
        "verified_changed_fields": len(events), "final_issue_count": 0,
        "external_calls": ext_calls,
        "performance": perf,
    }
    coverage = {
        "schema": "qnh-channel-fill-coverage-v1",
        "source_unique_spu": len(ordered),
        "platform_extant": extant,
        "missing_on_platform": len(missing),
        "rows": [
            {
                "spu_id": spu_id,
                "terminal_status": (
                    "missing_on_platform"
                    if states[spu_id]["missing"]
                    else "verified"
                    if by_spu.get(spu_id)
                    else "no_change"
                ),
            }
            for spu_id in ordered
        ],
    }
    output.with_suffix(".summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output.with_suffix(".coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
