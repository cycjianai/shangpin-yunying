#!/usr/bin/env python3
"""User-operated Meituan qualification image workflow with progress and receipts."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import re
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
PREPARE = HERE / "prepare_manifest.py"
IMPORTER = HERE / "import_batch.mjs"
DEFAULT_RUN_DIR = Path.home() / "Documents" / "美团资质图导入"
DEFAULT_PROFILE = Path.home() / "Library" / "Application Support" / "MeituanQualificationTool"
DEFAULT_CDP_URL = "http://127.0.0.1:9333"
CHROME_CANDIDATES = [
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cdp_ready(cdp_url: str) -> bool:
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d{2,5}", cdp_url):
        return False
    try:
        with urllib.request.urlopen(f"{cdp_url}/json/version", timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def find_node() -> Path:
    explicit = os.environ.get("QNH_NODE_BIN")
    candidates = [Path(explicit)] if explicit else []
    found = shutil.which("node")
    if found:
        candidates.append(Path(found))
    candidates.extend(
        Path.home().glob(".cache/codex-runtimes/*/dependencies/node/bin/node")
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    raise RuntimeError("未找到 Node.js。请先安装 Node.js 20+，或设置 QNH_NODE_BIN。")


def find_playwright_core() -> Path:
    explicit = os.environ.get("QNH_PLAYWRIGHT_CORE_PATH")
    candidates = [Path(explicit)] if explicit else []
    candidates.extend(
        Path.home().glob(".cache/codex-runtimes/*/dependencies/node/node_modules/playwright-core/index.mjs")
    )
    candidates.extend(
        Path.home().glob(".cache/codex-runtimes/*/dependencies/node/node_modules/playwright-core/index.js")
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError("未找到 playwright-core。请执行 npm install playwright-core，或设置 QNH_PLAYWRIGHT_CORE_PATH。")


def run_dir_of(args) -> Path:
    path = Path(args.run_dir or DEFAULT_RUN_DIR).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_config(run_dir: Path, **updates) -> dict:
    path = run_dir / "tool-config.json"
    config = read_json(path, {}) or {}
    config.update({key: value for key, value in updates.items() if value not in (None, "")})
    config["updated_at"] = now_iso()
    write_json(path, config)
    return config


def start_browser(args) -> int:
    cdp_url = args.cdp_url or DEFAULT_CDP_URL
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d{2,5}", cdp_url):
        raise RuntimeError("CDP 地址必须是本机 http://127.0.0.1:端口。")
    if cdp_ready(cdp_url):
        print(f"浏览器已就绪：{cdp_url}")
        return 0
    chrome = next((path for path in CHROME_CANDIDATES if path.is_file()), None)
    if not chrome:
        raise RuntimeError("没有找到 Google Chrome 或 Microsoft Edge。")
    port = int(cdp_url.rsplit(":", 1)[-1])
    profile = Path(getattr(args, "profile_dir", None) or DEFAULT_PROFILE).expanduser().resolve()
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        [
            str(chrome),
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "https://shangoue.meituan.com/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(30):
        if cdp_ready(cdp_url):
            print(f"专用浏览器已启动：{cdp_url}")
            print("请在该窗口登录美团闪购，进入商品管理页面；登录状态会保存在独立目录。")
            return 0
        time.sleep(0.5)
    raise RuntimeError("浏览器已启动，但调试端口未就绪。")


EVENT_LABELS = {
    "scan_started": "开始只读扫描",
    "scan_completed": "扫描完成",
    "import_started": "开始导入",
    "spu_started": "开始处理商品",
    "spu_skipped_verified": "已验证，断点跳过",
    "upload_started": "上传图片",
    "upload_completed": "图片上传完成",
    "save_started": "提交平台保存",
    "spu_verified": "保存并回读验证成功",
    "spu_failed": "回读不一致",
    "import_completed": "本轮结束",
    "summary": "汇总",
}


def show_event(event: dict) -> None:
    name = str(event.get("event") or "event")
    label = EVENT_LABELS.get(name, name)
    spu = f" SPU={event['spu_id']}" if event.get("spu_id") else ""
    progress = ""
    if event.get("total") is not None:
        progress = f" [{event.get('completed', 0)}/{event['total']}]"
    if event.get("file_total") is not None:
        progress += f" 图片[{event.get('file_index', 0)}/{event['file_total']}]"
    file_name = f" {event['file_name']}" if event.get("file_name") else ""
    print(f"{label}{progress}{spu}{file_name}", flush=True)


def node_environment() -> tuple[Path, dict]:
    node = find_node()
    env = os.environ.copy()
    env["QNH_PLAYWRIGHT_CORE_PATH"] = str(find_playwright_core())
    return node, env


def run_node(args, extra: list[str]) -> list[dict]:
    cdp_url = args.cdp_url or DEFAULT_CDP_URL
    if not cdp_ready(cdp_url):
        raise RuntimeError("专用浏览器未启动。请先运行 browser-start，并完成美团登录。")
    run_dir = run_dir_of(args)
    node, env = node_environment()
    command = [str(node), str(IMPORTER), "--run-dir", str(run_dir), "--cdp-url", cdp_url, *extra]
    events_path = run_dir / "operator-events.jsonl"
    events: list[dict] = []
    with events_path.open("a", encoding="utf-8") as event_log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                event = {"event": "raw_output", "text": line}
            event["observed_at"] = now_iso()
            events.append(event)
            event_log.write(json.dumps(event, ensure_ascii=False) + "\n")
            event_log.flush()
            show_event(event)
        stderr = process.stderr.read().strip() if process.stderr else ""
        code = process.wait()
    if code:
        detail = stderr or "浏览器导入子进程失败"
        try:
            detail = json.loads(stderr.splitlines()[-1]).get("error", detail)
        except (json.JSONDecodeError, IndexError, AttributeError):
            pass
        failed_spu = next((str(event.get("spu_id")) for event in reversed(events) if event.get("spu_id")), "")
        failures_path = run_dir / "operator-errors.json"
        failures = read_json(failures_path, {}) or {}
        if failed_spu:
            failures[failed_spu] = {"status": "execution_failed", "error": detail, "updated_at": now_iso()}
            write_json(failures_path, failures)
        raise RuntimeError(detail)
    return events


def needs_rows(manifest: dict) -> list[dict]:
    rows = []
    for product in manifest.get("products", []):
        for issue in product.get("issues", []):
            if issue.get("type") != "qualification_image":
                continue
            rows.append(
                {
                    "spu_id": product.get("spu_id", ""),
                    "商品名称": product.get("name", ""),
                    "图片类型": issue.get("qua_pic_type", ""),
                    "资料名称": issue.get("qua_pic_title") or issue.get("field_name", ""),
                    "图片规范": issue.get("qua_pic_desc", ""),
                    "平台说明": issue.get("comment") or issue.get("description", ""),
                    "当前资料图链接": issue.get("current_url", ""),
                    "状态": "待准备资料",
                }
            )
    return rows


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows([{field: row.get(field, "") for field in fields} for row in rows])


def scan(args) -> int:
    run_dir = run_dir_of(args)
    run_node(args, ["--scan-only"])
    manifest = read_json(run_dir / "manifest.json")
    if not manifest:
        raise RuntimeError("扫描结束但没有生成 manifest.json。")
    rows = needs_rows(manifest)
    output = run_dir / "待补资质清单.csv"
    write_csv(output, rows, ["spu_id", "商品名称", "图片类型", "资料名称", "图片规范", "平台说明", "当前资料图链接", "状态"])
    save_config(run_dir, cdp_url=args.cdp_url or DEFAULT_CDP_URL, wm_poi_id=manifest.get("wm_poi_id"))
    print(f"待补商品：{len({row['spu_id'] for row in rows})}；待补资料：{len(rows)}")
    print(f"清单：{output}")
    return 0


def call_prepare(command: list[str]) -> dict:
    result = subprocess.run([sys.executable, str(PREPARE), *command], capture_output=True, text=True)
    output = result.stdout.strip()
    if result.returncode:
        raise RuntimeError(output or result.stderr.strip())
    return json.loads(output)


def template(args) -> int:
    run_dir = run_dir_of(args)
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_csv = getattr(args, "output_csv", None)
    output = Path(output_csv).expanduser().resolve() if output_csv else run_dir / "qualification-evidence.csv"
    result = call_prepare(["template", "--input-dir", str(input_dir), "--output-csv", str(output)])
    save_config(run_dir, input_dir=str(input_dir), evidence_csv=str(output))
    print(f"已识别图片：{result['rows']} 张")
    print(f"资料核验表：{output}")
    return 0


def build(args) -> int:
    run_dir = run_dir_of(args)
    config = read_json(run_dir / "tool-config.json", {}) or {}
    input_dir = Path(getattr(args, "input_dir", None) or config.get("input_dir", "")).expanduser().resolve()
    evidence_csv = Path(getattr(args, "evidence_csv", None) or config.get("evidence_csv", "")).expanduser().resolve()
    wm_poi_id = str(getattr(args, "wm_poi_id", None) or config.get("wm_poi_id", ""))
    if not input_dir.is_dir():
        raise RuntimeError(f"图片目录不存在：{input_dir}")
    if not evidence_csv.is_file():
        raise RuntimeError(f"资料核验表不存在：{evidence_csv}")
    manifest_arg = getattr(args, "manifest", None)
    manifest = Path(manifest_arg).expanduser().resolve() if manifest_arg else run_dir / "qualification-import-manifest.json"
    review = run_dir / "qualification-import-review.csv"
    result = call_prepare(
        ["build", "--input-dir", str(input_dir), "--evidence-csv", str(evidence_csv), "--wm-poi-id", wm_poi_id,
         "--output", str(manifest), "--review-csv", str(review)]
    )
    save_config(run_dir, input_dir=str(input_dir), evidence_csv=str(evidence_csv), wm_poi_id=wm_poi_id, manifest=str(manifest))
    print(f"校验结果：可导入 {result['ready']} 张，阻塞 {result['blocked']} 张")
    print(f"审核表：{review}")
    if result["blocked"]:
        print("存在阻塞项，默认整批不会写入；请先按审核表修正资料。")
        return 3
    print(f"导入清单：{manifest}")
    return 0


def selected_manifest(args) -> Path:
    run_dir = run_dir_of(args)
    config = read_json(run_dir / "tool-config.json", {}) or {}
    value = getattr(args, "manifest", None) or config.get("manifest") or run_dir / "qualification-import-manifest.json"
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise RuntimeError(f"找不到导入清单：{path}")
    return path


def canary(args) -> int:
    manifest = selected_manifest(args)
    run_node(args, ["--manifest", str(manifest), "--canary-only"])
    status(args)
    return 0


def import_all(args) -> int:
    run_dir = run_dir_of(args)
    manifest = selected_manifest(args)
    checkpoint = read_json(run_dir / "qualification-import-checkpoint.json", {}) or {}
    if checkpoint.get("manifest_sha256") != sha256_file(manifest) or not any(
        item.get("status") == "readback_verified" for item in checkpoint.get("items", {}).values()
    ):
        raise RuntimeError("同一份清单尚无 canary 回读成功记录。请先运行 canary。")
    run_node(args, ["--manifest", str(manifest)])
    status(args)
    return 0


def status(args) -> int:
    run_dir = run_dir_of(args)
    checkpoint = read_json(run_dir / "qualification-import-checkpoint.json", {}) or {}
    failures = read_json(run_dir / "operator-errors.json", {}) or {}
    rows = []
    for spu_id, item in sorted(checkpoint.get("items", {}).items()):
        protected = item.get("protected_media", {}) or {}
        rows.append(
            {
                "spu_id": spu_id,
                "状态": item.get("status", ""),
                "上传张数": item.get("uploaded_count", ""),
                "平台保存状态": item.get("save_status", ""),
                "回读成功": "是" if item.get("status") == "readback_verified" else "否",
                "主图未改动": protected.get("main_unchanged", ""),
                "详情图保留": protected.get("detail_preserved", ""),
                "旧资质图保留": protected.get("old_cpv_preserved", ""),
                "更新时间": item.get("updated_at", ""),
            }
        )
    completed_ids = {row["spu_id"] for row in rows}
    for spu_id, item in sorted(failures.items()):
        if spu_id in completed_ids:
            continue
        rows.append(
            {
                "spu_id": spu_id,
                "状态": item.get("status", "execution_failed"),
                "上传张数": "",
                "平台保存状态": "",
                "回读成功": "否",
                "主图未改动": "",
                "详情图保留": "",
                "旧资质图保留": "",
                "更新时间": item.get("updated_at", ""),
                "错误": item.get("error", ""),
            }
        )
    receipt = run_dir / "qualification-status.csv"
    fields = ["spu_id", "状态", "上传张数", "平台保存状态", "回读成功", "主图未改动", "详情图保留", "旧资质图保留", "更新时间", "错误"]
    write_csv(receipt, rows, fields)
    verified = sum(row["回读成功"] == "是" for row in rows)
    print(f"已回读成功：{verified}/{len(rows)}")
    print(f"状态回执：{receipt}")
    summary = read_json(run_dir / "qualification-import-summary.json")
    if summary:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def interactive(args) -> int:
    actions = {
        "1": ("启动专用浏览器", start_browser),
        "2": ("扫描哪些商品需要资质图", scan),
        "3": ("按图片目录生成资料核验表", template),
        "4": ("校验资料并生成导入清单", build),
        "5": ("导入 1 个商品测试（canary）", canary),
        "6": ("批量导入 / 断点续跑", import_all),
        "7": ("查看进度和状态回执", status),
    }
    while True:
        print("\n美团资质图批量导入工具")
        for key, (label, _) in actions.items():
            print(f"  {key}. {label}")
        print("  0. 退出")
        choice = input("请选择：").strip()
        if choice == "0":
            return 0
        selected = actions.get(choice)
        if not selected:
            print("无效选项。")
            continue
        try:
            if choice == "3" and not getattr(args, "input_dir", None):
                args.input_dir = input("图片目录：").strip()
            if choice == "4":
                config = read_json(run_dir_of(args) / "tool-config.json", {}) or {}
                if not getattr(args, "input_dir", None) and not config.get("input_dir"):
                    args.input_dir = input("图片目录：").strip()
                if not getattr(args, "evidence_csv", None) and not config.get("evidence_csv"):
                    args.evidence_csv = input("资料核验表 CSV：").strip()
                if not getattr(args, "wm_poi_id", None) and not config.get("wm_poi_id"):
                    args.wm_poi_id = input("门店 wmPoiId：").strip()
            selected[1](args)
        except Exception as exc:
            print(f"操作失败：{exc}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="用户自助控制的美团资质图批量导入工具")
    root.add_argument("--run-dir", default=str(DEFAULT_RUN_DIR), help="任务与回执目录")
    root.add_argument("--cdp-url", default=DEFAULT_CDP_URL, help="仅允许本机 CDP 地址")
    sub = root.add_subparsers(dest="command")
    browser = sub.add_parser("browser-start", help="启动独立登录浏览器")
    browser.add_argument("--profile-dir")
    sub.add_parser("scan", help="只读扫描待补资质")
    template_parser = sub.add_parser("template", help="生成资料核验 CSV")
    template_parser.add_argument("--input-dir", required=True)
    template_parser.add_argument("--output-csv")
    build_parser = sub.add_parser("build", help="校验并生成导入 manifest")
    build_parser.add_argument("--input-dir")
    build_parser.add_argument("--evidence-csv")
    build_parser.add_argument("--wm-poi-id")
    build_parser.add_argument("--manifest")
    for name in ("canary", "import", "status"):
        item = sub.add_parser(name)
        if name != "status":
            item.add_argument("--manifest")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        actions = {
            "browser-start": start_browser,
            "scan": scan,
            "template": template,
            "build": build,
            "canary": canary,
            "import": import_all,
            "status": status,
            None: interactive,
        }
        return actions[args.command](args)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
