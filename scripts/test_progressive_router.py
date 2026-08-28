from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ROUTER = ROOT / "scripts" / "route_skill.py"


def run(*args: str, expected: int = 0) -> dict:
    completed = subprocess.run(
        [sys.executable, str(ROUTER), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == expected, completed.stderr or completed.stdout
    return json.loads(completed.stdout)


def main() -> int:
    assert run("--validate-registry")["valid"] is True

    cases = [
        ("牵牛花渠道类目属性100%填充", "qnh", "channel_attributes_only", "implemented"),
        ("美团把目标价推送到活动价并回读", "meituan", "price_push", "runtime_guided"),
        ("饿了么批量调价", "eleme", "price_push", "runtime_guided"),
        ("美团医疗器械整店迁移并复制分类", "meituan", "medical_device_store_migration", "runtime_guided"),
        ("美团修改店内码并逐SKU回读", "meituan", "product_editing", "runtime_guided"),
        ("翱象补齐美团和饿了么渠道属性", "aoxiang", "channel_attributes_only", "implemented"),
        ("牵牛花重试原点搬品助手历史新增失败", "qnh", "copy_history_retry", "implemented"),
        ("牵牛花新增前后映射表按末尾1回退名称和条形码做搬品冲突复核", "qnh", "copy_conflict_reconciliation", "runtime_guided"),
        ("淘宝闪购直连商家平台批量调价", "taobao_flash", "price_push", "planned"),
        ("牵牛花排查H5guard 403", "qnh", "protected_request_maintenance", "runtime_guided"),
    ]
    for request, platform, task, status in cases:
        payload = run("--request-text", request, "--intent", "execution")
        assert payload["routing_status"] == "ok"
        assert payload["platform_adapter"] == platform
        assert payload["task_mode"] == task
        assert payload["capability_status"] == status
        assert payload["load_order"][0].startswith("references/platforms/")
        if status == "planned":
            assert payload["side_effect_policy"].startswith("zero_writes")
        else:
            if task in {"protected_request_maintenance", "copy_conflict_reconciliation"}:
                assert "references/core/output-contract.md" not in payload["load_order"]
                assert "references/excel-schema-v1.md" not in payload["load_order"]
            else:
                assert "references/core/output-contract.md" in payload["load_order"]
            assert len(payload["load_order"]) < 10

    ambiguous = run(
        "--request-text",
        "同时给美团和饿了么调价",
        "--intent",
        "execution",
        expected=2,
    )
    assert ambiguous["routing_status"] == "ambiguous_platform"
    assert ambiguous["load_order"] == []

    read_only = run(
        "--request-text",
        "分析美团商品信息编辑的安全边界",
        "--intent",
        "review",
    )
    assert read_only["side_effect_policy"] == "read_only"
    assert "references/core/output-contract.md" not in read_only["load_order"]

    print(json.dumps({"passed": True, "cases": len(cases) + 2}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
