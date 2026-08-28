"""
【业务说明书：牵牛花 Skill - 搬品历史失败重试适配器校验脚本】
建立时间：2026年
核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
1. 只有原失败清单成员可以进入新增结果，非成员必须失败关闭。
2. 一个旧 SPU 只能映射到一个新 SPU，一个新 SPU 不能被多个旧 SPU 共用。
3. 全量完成必须覆盖全部失败 SPU，canary 才允许使用严格子集。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from adapter import (
    ACCEPTED_VALIDATION_SCHEMAS,
    MANIFEST_SCHEMA,
    MAPPING_SCHEMA,
    manifest_from_error_rows,
    mapping_from_result_rows,
    validate_mapping,
)


class CopyHistoryRetryAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="qnh-copy-adapter-")
        self.source = Path(self.temp.name) / "source.xlsx"
        self.source.write_bytes(b"fixture")
        self.error_header = ["复制SPU", "错误类型", "诊断类型", "错误信息", "重试次数"]
        self.error_rows = [
            {"复制SPU": "1001", "错误类型": "新增失败", "诊断类型": "新增失败", "错误信息": "记录不存在", "重试次数": 0},
            {"复制SPU": "1002", "错误类型": "新增失败", "诊断类型": "新增失败", "错误信息": "记录不存在", "重试次数": 0},
        ]
        self.manifest = manifest_from_error_rows(self.error_header, self.error_rows, source_path=self.source)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def mapping(self, old_spus: list[str]) -> dict:
        rows = []
        for index, old_spu in enumerate(old_spus, start=1):
            rows.append({
                "旧SPU": old_spu,
                "旧SKU ID": f"8{index}",
                "旧商品条码": f"6{index}",
                "旧商品名称": f"商品{index}",
                "旧商品规格": "1件",
                "目标SPU ID": f"2090{index}",
                "目标SKU ID": f"3090{index}",
                "目标商品条码": f"7{index}",
                "处理结果": "成功",
            })
        return mapping_from_result_rows(
            ["旧SPU", "旧SKU ID", "旧商品条码", "旧商品名称", "旧商品规格", "目标SPU ID", "目标SKU ID", "目标商品条码", "处理结果"],
            rows,
            manifest=self.manifest,
            source_path=self.source,
        )

    def test_manifest_freezes_unique_failures(self) -> None:
        self.assertIn("operations-workbook-validation-v1", ACCEPTED_VALIDATION_SCHEMAS)
        self.assertEqual(self.manifest["schema"], MANIFEST_SCHEMA)
        self.assertEqual(self.manifest["source_failed_count"], 2)
        self.assertEqual([item["spu_id"] for item in self.manifest["products"]], ["1001", "1002"])

    def test_non_manifest_result_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "mapping_contains_non_manifest_spu"):
            self.mapping(["9999"])

    def test_canary_subset_and_full_gate(self) -> None:
        partial = self.mapping(["1001"])
        self.assertEqual(partial["schema"], MAPPING_SCHEMA)
        self.assertTrue(validate_mapping(self.manifest, partial, allow_subset=True)["valid"])
        self.assertFalse(validate_mapping(self.manifest, partial, allow_subset=False)["valid"])
        full = self.mapping(["1001", "1002"])
        self.assertTrue(validate_mapping(self.manifest, full, allow_subset=False)["valid"])


if __name__ == "__main__":
    unittest.main()
