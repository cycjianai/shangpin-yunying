#!/usr/bin/env python3
"""Discover product-owned qualification evidence with OCR; never generate evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image, ImageOps


TYPE_RULES = [
    (re.compile(r"3C|质量认证|强制性产品认证"), 4),
    (re.compile(r"配料|营养成分"), 5),
    (re.compile(r"包装标签"), 3),
    (re.compile(r"化妆品备案|小金盾|背签"), 8),
    (re.compile(r"能效"), 11),
    (re.compile(r"医疗器械.*(?:注册|备案)|注册证|备案凭证"), 10),
    (re.compile(r"尺寸图"), 13),
    (re.compile(r"纺织品使用说明|吊牌|洗唛|洗标"), 6),
]


def compact(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def score(img_type: int, text: str, requirement: str) -> tuple[bool, list[str]]:
    body, req, signals = compact(text), compact(requirement), []

    def hit(name: str, pattern: str) -> bool:
        if re.search(pattern, body, re.I):
            signals.append(name)
            return True
        return False

    if img_type == 5:
        ingredients = hit("ingredients", r"配料|原料")
        nutrition = hit("nutrition", r"营养成分|营养成份|能量.{0,20}蛋白质|蛋白质.{0,20}脂肪")
        need_ingredients = bool(re.search(r"配料|原料", req)) or not re.search(r"配料|原料|营养", req)
        need_nutrition = bool(re.search(r"营养", req)) or not re.search(r"配料|原料|营养", req)
        return (not need_ingredients or ingredients) and (not need_nutrition or nutrition), signals
    if img_type == 4:
        return hit("ccc", r"CCC|3C|强制性产品认证") and hit("certificate", r"证书|认证") and hit("certificate_number", r"(?:证书编号|编号|No\.?)[：:]?[A-Z0-9\-]{8,}"), signals
    if img_type == 3:
        hit("producer", r"生产企业|生产商|制造商|委托方|厂名")
        hit("address", r"厂址|生产地址|地址")
        hit("standard_or_model", r"执行标准|产品标准|型号|规格")
        return len(signals) >= 2, signals
    if img_type in (6, 7):
        hit("standard", r"执行标准|产品标准")
        hit("safety", r"安全类别|安全技术类别")
        hit("material", r"成分|面料|纤维|填充物")
        hit("care", r"洗涤|洗护|维护|水洗")
        return len(signals) >= 3, signals
    if img_type == 8 and re.search(r"化妆品备案|小金盾|儿童化妆品", req):
        filing = hit("cosmetic_filing", r"G妆网备字|国妆网备进字|国妆特字|国妆特进字|化妆品备案(?:编码|编号)?|备案(?:编码|编号)")
        child = hit("child_cosmetic_mark", r"小金盾|儿童化妆品")
        return (not re.search(r"备案", req) or filing) and (not re.search(r"小金盾|儿童化妆品", req) or child), signals
    if img_type == 8:
        for name, pattern in (("standard", r"执行标准|产品标准"), ("hygiene", r"卫生标准|卫生许可"), ("producer", r"生产企业|生产商|制造商"), ("shelf_life", r"保质期"), ("materials", r"主要原材料|配料|原料"), ("barcode", r"条形码|条码")):
            hit(name, pattern)
        return len(signals) >= 3, signals
    if img_type == 11:
        energy = hit("energy", r"能效")
        level = hit("level", r"等级|级")
        hit("model_or_parameter", r"型号|功率|耗电|参数")
        return energy and level and len(signals) >= 3, signals
    if img_type == 10:
        registration = hit("registration_number", r"(?:国|京|津|冀|晋|蒙|辽|吉|黑|沪|苏|浙|皖|闽|赣|鲁|豫|鄂|湘|粤|桂|琼|渝|川|贵|云|藏|陕|甘|青|宁|新)械(?:注准|注进|注许|备)[A-Z0-9]{8,}")
        product = hit("medical_product", r"医疗器械|避孕套|医用|热敷贴|敷料|口罩|导管")
        registrant = hit("registrant", r"注册人|备案人|生产企业|制造商")
        validity = hit("validity", r"有效期|有效期限|有效至|批准日期|发证日期")
        return registration and product and registrant and validity, signals
    if img_type == 13:
        dimension = hit("dimension", r"尺寸|长.{0,8}宽|宽.{0,8}高|直径")
        units = re.findall(r"\d+(?:\.\d+)?(?:毫米|厘米|米|mm|cm|m)", body, re.I)
        if len(units) >= 2:
            signals.append("two_dimensions")
        return dimension and len(units) >= 2, signals
    return False, signals


def infer_jobs(product: dict) -> list[dict]:
    jobs: dict[int, dict] = {}
    for issue in product.get("issues", []):
        text = " ".join(str(issue.get(k) or "") for k in ("field_name", "comment", "qua_pic_title", "qua_pic_desc"))
        img_type = int(issue.get("qua_pic_type") or 0)
        if not img_type:
            img_type = next((value for pattern, value in TYPE_RULES if pattern.search(text)), 0)
        if img_type:
            jobs.setdefault(img_type, {"img_type": img_type, "requirement": text})
            jobs[img_type]["requirement"] += " " + text
    return list(jobs.values())


def ocr(url: str, cache: Path) -> dict:
    key = hashlib.sha256(url.encode()).hexdigest()
    image_path, prepared_path, text_path = cache / f"{key}.image", cache / f"{key}.ocr.png", cache / f"{key}.txt"
    try:
        if not image_path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                image_path.write_bytes(response.read())
        if not prepared_path.exists():
            with Image.open(image_path) as image:
                image = ImageOps.exif_transpose(image).convert("L")
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                image.save(prepared_path, format="PNG", optimize=True)
        if not text_path.exists():
            result = subprocess.run(["tesseract", str(prepared_path), "stdout", "-l", "chi_sim+eng", "--psm", "11"], capture_output=True, text=True, timeout=25, check=True, env={**os.environ, "OMP_THREAD_LIMIT": "1"})
            text_path.write_text(result.stdout, encoding="utf-8")
        return {"url": url, "text": text_path.read_text(encoding="utf-8")}
    except Exception as exc:
        return {"url": url, "error": str(exc)[:300], "text": ""}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    inventory = {str(row["spu_id"]): row for row in json.loads(Path(args.inventory).read_text(encoding="utf-8"))}
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    jobs = []
    for product in manifest.get("products", []):
        detail = inventory.get(str(product.get("spu_id")), {})
        source_urls = list(dict.fromkeys((detail.get("main") or []) + (detail.get("detail") or []) + [url for entry in (detail.get("cpv_map") or {}).values() for url in entry.get("urls", [])]))
        for job in infer_jobs(product):
            jobs.append({"spu_id": str(product.get("spu_id")), "name": product.get("name", ""), "source_urls": source_urls, **job})
    urls = sorted({url for job in jobs for url in job["source_urls"] if url.startswith(("http://", "https://"))})
    ocr_by_url = {}
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 16))) as pool:
        futures = {pool.submit(ocr, url, cache): url for url in urls}
        for future in as_completed(futures):
            result = future.result()
            ocr_by_url[result["url"]] = result
    output = []
    for job in jobs:
        attempts, matched = [], None
        for url in job["source_urls"]:
            result = ocr_by_url.get(url, {"url": url, "text": "", "error": "not_scanned"})
            ok, signals = score(job["img_type"], result.get("text", ""), job["requirement"] + " 商品名称：" + job["name"])
            attempt = {"url": url, "matched": ok, "signals": signals, "text_excerpt": compact(result.get("text", ""))[:500], "error": result.get("error", "")}
            attempts.append(attempt)
            if ok and matched is None:
                matched = attempt
        output.append({**job, "source_urls": None, "status": "verified_product_original" if matched else "evidence_not_found", "matched": matched, "checked_image_count": len(attempts), "attempts": attempts})
    Path(args.output).write_text(json.dumps({"schema": "meituan-product-original-evidence-v1", "jobs": output}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"jobs": len(output), "urls": len(urls), "matched": sum(bool(row["matched"]) for row in output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
