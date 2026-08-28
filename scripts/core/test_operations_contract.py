from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from openpyxl import load_workbook
from operations_contract import canonical_field_id, canonical_source_strategy


ROOT = Path(__file__).resolve().parent.parent.parent
EXPORTER = ROOT / "scripts" / "core" / "export_operations_workbook.py"
VALIDATOR = ROOT / "scripts" / "core" / "validate_operations_workbook.py"
SCHEMA = json.loads((ROOT / "scripts" / "operations_workbook_schema.json").read_text(encoding="utf-8"))


CASES = {
    "channel_attributes_only": ("qnh", "channel_attribute.meituan.packing", "包装方式"),
    "unavailable_one_pass": ("meituan", "review.scope_state", "审核集合状态"),
    "qualification_images_only": ("qnh", "qualification.8.01", "背签 01"),
    "plugin_attribute_fill": ("qnh", "channel_attribute.meituan.material", "材质"),
    "copy_history_retry": ("qnh", "copy_mapping.target_spu_id", "目标 SPU ID"),
    "price_push": ("eleme", "price.sku-001.effective", "最终有效价"),
    "product_editing": ("meituan", "sku.sku-001.store_code", "店内码"),
    "medical_device_store_migration": ("meituan", "migration.target_spu_id", "目标 SPU ID"),
}


def run(*args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        [sys.executable, *args], cwd=ROOT, text=True, capture_output=True, check=False
    )
    assert completed.returncode == expected, completed.stdout + completed.stderr
    return completed


def payload(task: str, platform: str, field_id: str, field_name: str) -> dict:
    source = "business_strategy_result" if task == "price_push" else "platform_current_fact"
    target_value = "CNY 12.34" if field_id.startswith("price.") else "目标值"
    if task == "plugin_attribute_fill":
        source = "plugin_native_result"
    if task == "medical_device_store_migration":
        source = "source_store_verified_archive"
    return {
        "metadata": {
            "skill_version": "1.0.0",
            "platform": platform,
            "task_mode": task,
            "contract_fingerprint_sha256": "a" * 64,
            "store_name": "统一合同测试店",
            "external_calls": {},
        },
        "products": [
            {
                "spu_id": "000012345678901234",
                "product_name": "测试商品",
                "before_summary": "执行前存在一个目标问题",
                "outcome_summary": "已按目标写入并独立回读",
                "result": "verified_complete",
            },
            {
                "spu_id": "000012345678901235",
                "product_name": "无需修改商品",
                "before_summary": "执行前已满足合同",
                "outcome_summary": "无需修改；最终独立回读通过",
                "result": "verified_no_change",
            },
        ],
        "audit_events": [
            {
                "spu_id": "000012345678901234",
                "product_name": "测试商品",
                "channel": "不适用",
                "field_id": field_id,
                "field_name": field_name,
                "before": None,
                "planned": target_value,
                "readback": target_value,
                "result": "verified_complete",
                "source_strategy": source,
            }
        ],
        "missing": [],
        "verification": {"final_detail_partitions": 1},
        "feedback": [
            {"situation": "样例", "rule": "统一字段合同", "validation": "通过"}
        ],
        "performance": {
            "wall_seconds": 2.0,
            "peak_concurrency": 1,
            "configured_concurrency_limit": 1,
        },
    }


def main() -> int:
    assert canonical_field_id("channel_attribute", "美团", "材质") == canonical_field_id(
        "channel_attribute", "美团", "材质"
    )
    assert canonical_field_id("product", "商品名称") != canonical_field_id(
        "product", "商品卖点"
    )
    assert canonical_source_strategy("同商品原图OCR实证") == "same_product_media_evidence"
    assert canonical_source_strategy("DeepSeek高置信候选") == "semantic_model_candidate_validated"
    with tempfile.TemporaryDirectory(prefix="operations-contract-") as temporary:
        root = Path(temporary)
        sheet_signatures = set()
        header_signatures = set()
        for task, (platform, field_id, field_name) in CASES.items():
            input_path = root / f"{task}.json"
            output_path = root / f"{task}.xlsx"
            validation_path = root / f"{task}.validation.json"
            input_path.write_text(
                json.dumps(payload(task, platform, field_id, field_name), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            run(str(EXPORTER), "--input", str(input_path), "--output", str(output_path))
            run(str(VALIDATOR), "--workbook", str(output_path), "--output", str(validation_path))
            assert json.loads(validation_path.read_text(encoding="utf-8"))["valid"] is True
            workbook = load_workbook(output_path, read_only=True)
            sheet_signatures.add(tuple(workbook.sheetnames))
            header_signatures.add(tuple(
                tuple(cell.value for cell in workbook[name][1]) for name in workbook.sheetnames
            ))
            assert workbook["字段级审计"]["A2"].value == "000012345678901234"
            assert workbook["字段级审计"]["A2"].data_type == "s"
            workbook.close()
        assert sheet_signatures == {tuple(SCHEMA["sheets"])}
        assert len(header_signatures) == 1

        bad = payload("price_push", "eleme", "price.sku-001.effective", "最终有效价")
        bad["audit_events"][0]["result"] = "success"
        # Legacy aliases normalize to the single canonical result in the workbook.
        bad_input = root / "alias.json"
        bad_output = root / "alias.xlsx"
        bad_input.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        run(str(EXPORTER), "--input", str(bad_input), "--output", str(bad_output))
        workbook = load_workbook(bad_output, read_only=True)
        assert workbook["字段级审计"]["I2"].value == "verified_complete"
        workbook.close()

        numeric_id = payload("price_push", "eleme", "price.sku-001.effective", "最终有效价")
        numeric_id["products"][0]["spu_id"] = 123456789012345678
        numeric_input = root / "numeric-id.json"
        numeric_input.write_text(json.dumps(numeric_id, ensure_ascii=False), encoding="utf-8")
        failed = run(
            str(EXPORTER), "--input", str(numeric_input), "--output", str(root / "numeric.xlsx"), expected=1
        )
        assert "identifier_must_be_text" in failed.stdout

    print(json.dumps({"passed": True, "task_modes": len(CASES)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
