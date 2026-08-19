import csv
import importlib.util
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("meituan_qualification_tool.py")
SPEC = importlib.util.spec_from_file_location("meituan_qualification_tool", MODULE_PATH)
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


class QualificationToolTests(unittest.TestCase):
    def test_needs_rows_only_includes_qualification_images(self):
        manifest = {
            "products": [
                {
                    "spu_id": "12345",
                    "name": "测试商品",
                    "issues": [
                        {"type": "qualification_image", "qua_pic_type": 8, "qua_pic_title": "背签图", "comment": "清晰"},
                        {"type": "attribute", "field_name": "品牌"},
                    ],
                }
            ]
        }
        self.assertEqual(
            TOOL.needs_rows(manifest),
            [{"spu_id": "12345", "商品名称": "测试商品", "图片类型": 8, "资料名称": "背签图", "图片规范": "", "平台说明": "清晰", "当前资料图链接": "", "状态": "待准备资料"}],
        )

    def test_status_writes_per_spu_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            TOOL.write_json(
                run_dir / "qualification-import-checkpoint.json",
                {
                    "items": {
                        "12345": {
                            "status": "readback_verified",
                            "uploaded_count": 2,
                            "save_status": "success",
                            "protected_media": {"main_unchanged": True, "detail_preserved": True, "old_cpv_preserved": True},
                        }
                    }
                },
            )
            result = TOOL.status(Namespace(run_dir=directory))
            self.assertEqual(result, 0)
            with (run_dir / "qualification-status.csv").open(encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["spu_id"], "12345")
            self.assertEqual(rows[0]["回读成功"], "是")

    def test_cdp_check_rejects_non_loopback_without_request(self):
        self.assertFalse(TOOL.cdp_ready("https://example.com:9333"))
        self.assertFalse(TOOL.cdp_ready("http://192.168.1.2:9333"))


if __name__ == "__main__":
    unittest.main()
