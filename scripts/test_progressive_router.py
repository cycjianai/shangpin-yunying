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
        ("牵牛花扫描其他品牌主图水印，输出SPU清单", "qnh", "watermark_scan", "runtime_guided"),
        ("牵牛花渠道类目属性100%填充", "qnh", "channel_attributes_only", "implemented"),
        ("牵牛花从货盘按条码和名称补齐总部零售价，多规格逐规格填充", "qnh", "headquarters_price_fill", "runtime_guided"),
        ("美团把目标价推送到活动价并回读", "meituan", "price_push", "runtime_guided"),
        ("饿了么批量调价", "eleme", "price_push", "runtime_guided"),
        ("美团医疗器械整店迁移并复制分类", "meituan", "medical_device_store_migration", "runtime_guided"),
        ("美团修改店内码并逐SKU回读", "meituan", "product_editing", "runtime_guided"),
        ("把美团门店全部商品包括店内分类全部删除掉", "meituan", "product_editing", "runtime_guided"),
        ("翱象补齐美团和饿了么渠道属性", "aoxiang", "channel_attributes_only", "implemented"),
        ("牵牛花重试原点搬品助手历史新增失败", "qnh", "copy_history_retry", "implemented"),
        ("牵牛花新增前后映射表按末尾1回退名称和条形码做搬品冲突复核", "qnh", "copy_conflict_reconciliation", "runtime_guided"),
        ("牵牛花把门店原商品SKU替换成新SKU，迁移渠道库存、库位、供应商关系和渠道状态，删除旧商品并将新商品上架", "qnh", "store_sku_replacement", "runtime_guided"),
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
            if task in {"watermark_scan", "protected_request_maintenance", "copy_conflict_reconciliation", "store_sku_replacement"}:
                assert "references/core/output-contract.md" not in payload["load_order"]
                assert "references/excel-schema-v1.md" not in payload["load_order"]
            else:
                assert "references/core/output-contract.md" in payload["load_order"]
            assert len(payload["load_order"]) < 10

    scan = run("--request-text", "牵牛花执行全量水印扫描", "--intent", "execution")
    assert scan["side_effect_policy"] == "read_only"
    assert "references/tasks/qnh-watermark-scan.md" in scan["load_order"]
    assert run("--request-text", "美团水印扫描", expected=2)["routing_status"] == "unsupported_combination"

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

    price = run("--request-text", "商品标签筛选后从货盘价格填充空总部零售价，多规格对应规格保存", "--page-url", "https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list")
    assert price["task_mode"] == "headquarters_price_fill"
    assert price["intent"] == "execution"
    assert "references/qnh-bulk-operations.md" in price["load_order"]
    assert "references/meituan.md" not in price["load_order"]
    assert "references/channel-attribute-contract-v2.md" not in price["load_order"]
    review = run("--request-text", "分析牵牛花总部零售价补齐请求链路")
    assert review["intent"] == "review" and review["side_effect_policy"] == "read_only"
    unsupported = run("--request-text", "美团总部零售价补齐", expected=2)
    assert unsupported["routing_status"] == "unsupported_combination"
    assert unsupported["side_effect_policy"].startswith("zero_writes")
    assert run("--request-text", "牵牛花补齐总部零售价并修改活动价", expected=2)["routing_status"] == "ambiguous_task"
    legacy = run("--request-text", "牵牛花调价", expected=2)
    assert legacy["routing_status"] == "unsupported_combination"
    assert run("--request-text", "牵牛花总部零售价补齐并填充渠道类目属性", expected=2)["routing_status"] == "ambiguous_task"
    for request, intent in [
        ("诊断美团调价失败原因", "diagnosis"),
        ("解释饿了么价格推送链路", "review"),
        ("分析牵牛花渠道属性填充", "review"),
        ("牵牛花总部零售价只读核对，不要保存", "review"),
        ("开发美团商品信息编辑功能", "implementation"),
        ("美团修改店内码", "execution"),
        ("把美团门店全部商品和店内分类全部删除掉", "execution"),
        ("分析美团整店清空流程，不要删除", "review"),
    ]:
        result = run("--request-text", request)
        assert result["intent"] == intent, (request, result)
        if intent in {"review", "diagnosis"}:
            assert result["side_effect_policy"] == "read_only"
    result = run("--request-text", "牵牛花填充渠道类目属性，包括保质期")
    assert result["task_mode"] == "channel_attributes_only"
    print(json.dumps({"passed": True, "cases": len(cases) + 15}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
