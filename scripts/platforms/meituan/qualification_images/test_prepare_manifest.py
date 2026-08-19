from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).with_name("prepare_manifest.py")


def run(*args: str) -> dict:
    result = subprocess.run([sys.executable, str(SCRIPT), *args], text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory(prefix="meituan-qualification-manifest-") as raw:
    root = Path(raw)
    images = root / "images"
    images.mkdir()
    valid_name = "12345678901_4_3C证书_01.jpg"
    blocked_name = "12345678902_4_3C证书_01.jpg"
    Image.new("RGB", (800, 1000), "white").save(images / valid_name)
    Image.new("RGB", (800, 1000), "black").save(images / blocked_name)
    template = root / "evidence.csv"
    result = run("template", "--input-dir", str(images), "--output-csv", str(template))
    assert result["rows"] == 2
    with template.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        fields = rows[0].keys()
    for row in rows:
        row.update(
            product_name="测试商品",
            expected_model="MODEL-1",
            source_kind="official_registry",
            source_reference="https://cx.cnca.cn/example",
            certificate_number="2026010203040506",
            subject="测试制造商",
            valid_until="2028-08-19",
            verification_status="verified",
            verified_by="operator-a",
            verified_at="2026-08-19T12:00:00+08:00",
            ocr_text="中国国家强制性产品认证证书 CCC 证书编号 2026010203040506 测试制造商 型号 MODEL-1",
        )
        if row["file_name"] == blocked_name:
            row["ocr_text"] += " 演示样张 不可用于平台审核"
    with template.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    manifest = root / "manifest.json"
    review = root / "review.csv"
    result = run(
        "build",
        "--input-dir",
        str(images),
        "--evidence-csv",
        str(template),
        "--wm-poi-id",
        "30635659",
        "--output",
        str(manifest),
        "--review-csv",
        str(review),
        "--today",
        "2026-08-19",
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert result["ready"] == 1
    assert result["blocked"] == 1
    assert payload["schema"] == "meituan-qualification-import-manifest-v1"
    assert payload["wm_poi_id"] == "30635659"
    blocked = next(item for item in payload["items"] if item["status"] == "blocked")
    assert "placeholder_or_nonreal_mark_detected" in blocked["blockers"]

print(json.dumps({"ok": True, "tests": 8}))
