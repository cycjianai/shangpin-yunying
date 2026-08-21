"""
【业务说明书：多平台商品渠道治理 Skill - 发布前快速校验入口】
建立时间：2026年
核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
1. 发布前必须递归执行全部 Python 与 Node 专项测试，不能遗漏平台子模块测试。
2. Python、JavaScript 与 MJS 源码必须通过确定性语法检查。
3. 任一测试或语法检查失败时立即非零退出，禁止把部分通过表述为 Skill 可发布。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRIPTS = ROOT / "scripts"


def run(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        if completed.stdout:
            print(completed.stdout, end="", file=sys.stderr)
        if completed.stderr:
            print(completed.stderr, end="", file=sys.stderr)
        raise SystemExit(completed.returncode)


def main() -> int:
    python_sources = sorted(SCRIPTS.rglob("*.py"))
    node_sources = sorted((*SCRIPTS.rglob("*.js"), *SCRIPTS.rglob("*.mjs")))
    python_tests = sorted(SCRIPTS.rglob("test_*.py"))
    node_tests = sorted(SCRIPTS.rglob("test_*.mjs"))

    for path in python_sources:
        compile(path.read_text(encoding="utf-8"), str(path), "exec")
    for path in node_sources:
        run(["node", "--check", str(path)])
    for path in python_tests:
        run([sys.executable, str(path)])
    for path in node_tests:
        run(["node", str(path)])

    print(
        json.dumps(
            {
                "passed": True,
                "python_sources": len(python_sources),
                "node_sources": len(node_sources),
                "python_tests": len(python_tests),
                "node_tests": len(node_tests),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
