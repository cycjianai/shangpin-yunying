#!/usr/bin/env python3
"""Scan existing QNH product media for reusable factual evidence.

The scanner is intentionally read-only with respect to QNH. It downloads only
the product image URLs already present in a frozen detail snapshot, runs local
OCR, and records conservative evidence matches. It never invents or renders a
qualification image.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


TOKEN_PATTERNS: dict[str, tuple[str, ...]] = {
    "ingredients": ("配料", "成分", "原料"),
    "nutrition": ("营养成分", "营养素参考值", "nrv", "能量", "蛋白质", "脂肪", "碳水化合物"),
    "factory": ("厂名", "生产商", "生产企业", "制造商", "委托方", "委托商"),
    "address": ("厂址", "地址", "住所"),
    "model": ("产品型号", "型号", "规格型号"),
    "standard": ("执行标准", "产品标准"),
    "license": ("生产许可证", "卫生许可证", "许可证号", "sc"),
    "cosmetic": ("g妆网备字", "国妆网备进字", "国妆特字", "国妆特进字"),
    "ccc": ("中国国家强制性产品认证", "ccc", "3c认证", "认证证书"),
    "textile_material": ("面料", "纤维含量", "成分", "材质"),
    "textile_care": ("洗涤", "水洗", "使用说明", "维护方法"),
}

REGEX_PATTERNS = {
    "barcode": re.compile(r"(?<!\d)\d{8,14}(?!\d)"),
    "ccc_number": re.compile(r"(?<!\d)\d{16}(?!\d)"),
    "cosmetic_number": re.compile(
        r"(?:G妆网备字|国妆网备进字|国妆特字|国妆特进字)[A-Za-z0-9一-龥\-]{4,40}",
        re.IGNORECASE,
    ),
    "dimension": re.compile(
        r"(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米|米)(?![A-Za-z0-9])",
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--offset-products", type=int, default=0)
    parser.add_argument("--limit-products", type=int, default=0)
    parser.add_argument("--label", default="media-scan")
    parser.add_argument("--list-only", action="store_true")
    return parser.parse_args()


def normalize_url(value: str) -> str:
    url = str(value or "").strip()
    if url.startswith("http://"):
        url = "https://" + url.removeprefix("http://")
    return url


def compact_text(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def required_missing(detail: dict[str, Any], issue_text: str = "") -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    issue_kinds: set[str] = set()
    if issue_text:
        if "配料" in issue_text or "营养成分图" in issue_text:
            issue_kinds.add("ingredients_nutrition")
        if "包装标签图" in issue_text or "商品参数图" in issue_text:
            issue_kinds.add("packaging")
        if "背签图" in issue_text or "化妆品备案" in issue_text or "备案编码" in issue_text:
            issue_kinds.add("back_label")
            if "化妆品" in issue_text or "备案" in issue_text:
                issue_kinds.add("cosmetic")
        if "3C证书" in issue_text or "质量认证" in issue_text:
            issue_kinds.add("ccc")
        if "尺寸图" in issue_text:
            issue_kinds.add("dimension")
        if "纺织品使用说明" in issue_text or "吊牌洗唛" in issue_text:
            issue_kinds.add("textile")
    for picture in detail.get("mtSpecialPictureList") or []:
        if not isinstance(picture, dict):
            continue
        if int(picture.get("isRequired") or 0) != 1:
            continue
        if issue_kinds:
            if requirement_kind(picture) not in issue_kinds:
                continue
        elif picture.get("pictureUrl"):
            continue
        rows.append(picture)
    present_kinds = {requirement_kind(row) for row in rows}
    synthetic_requirements = {
        "ingredients_nutrition": (5, "配料&营养成分图"),
        "packaging": (3, "包装标签图"),
        "back_label": (8, "背签图"),
        "cosmetic": (8, "化妆品备案/背签图"),
        "ccc": (4, "3C证书"),
        "dimension": (13, "尺寸图"),
        "textile": (6, "纺织品使用说明"),
    }
    for kind in sorted(issue_kinds - present_kinds):
        picture_type, picture_title = synthetic_requirements[kind]
        rows.append(
            {
                "pictureType": picture_type,
                "pictureTitle": picture_title,
                "pictureDesc": issue_text,
                "isRequired": 1,
                "isDisplay": 1,
                "numLimit": 4,
                "numMin": 1,
                "pictureUrl": None,
                "syntheticFromAudit": True,
            }
        )
    return rows


def image_sources(detail: dict[str, Any]) -> dict[str, set[str]]:
    sources: dict[str, set[str]] = {}
    for source_name, field in (
        ("main", "picUrlList"),
        ("detail", "picContentList"),
        ("real", "realPicList"),
    ):
        for raw in detail.get(field) or []:
            if isinstance(raw, dict):
                raw = raw.get("url") or raw.get("pictureUrl") or raw.get("picUrl") or ""
            url = normalize_url(str(raw or ""))
            if url:
                sources.setdefault(url, set()).add(source_name)
    for picture in detail.get("mtSpecialPictureList") or []:
        if not isinstance(picture, dict):
            continue
        picture_type = int(picture.get("pictureType") or 0)
        raw_urls = picture.get("pictureUrl") or []
        if not isinstance(raw_urls, list):
            raw_urls = [raw_urls]
        for raw in raw_urls:
            if isinstance(raw, dict):
                raw = raw.get("url") or raw.get("pictureUrl") or raw.get("picUrl") or ""
            url = normalize_url(str(raw or ""))
            if url:
                sources.setdefault(url, set()).add(f"special:{picture_type}")
    return sources


def download(url: str, destination: Path) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
    )
    last_error: BaseException | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read(20 * 1024 * 1024)
                content_type = str(response.headers.get("Content-Type") or "")
            if not data:
                raise ValueError("empty image")
            destination.write_bytes(data)
            return len(data), content_type
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(0.4 * (attempt + 1))
    if last_error is not None:
        raise last_error
    raise ValueError("download failed")


def prepare_ocr_image(source: Path, destination: Path) -> tuple[int, int]:
    with Image.open(source) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        width, height = rgb.size
        scale = min(1.0, 1200.0 / max(width, height))
        if scale < 0.95:
            rgb = rgb.resize((int(width * scale), int(height * scale)), Image.Resampling.LANCZOS)
        gray = ImageOps.grayscale(rgb)
        gray = ImageOps.autocontrast(gray, cutoff=1)
        gray = ImageEnhance.Contrast(gray).enhance(1.7)
        gray = ImageEnhance.Sharpness(gray).enhance(1.8)
        gray = gray.filter(ImageFilter.SHARPEN)
        gray.save(destination, format="PNG", optimize=True)
    return width, height


def tesseract(image_path: Path, psm: int) -> str:
    env = os.environ.copy()
    env["OMP_THREAD_LIMIT"] = "1"
    completed = subprocess.run(
        [
            "tesseract",
            str(image_path),
            "stdout",
            "-l",
            "chi_sim+eng",
            "--psm",
            str(psm),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=12,
        env=env,
    )
    return completed.stdout.decode("utf-8", errors="replace")


def detect(text: str) -> dict[str, Any]:
    compact = compact_text(text)
    tokens = {
        key: [candidate for candidate in candidates if compact_text(candidate) in compact]
        for key, candidates in TOKEN_PATTERNS.items()
    }
    tokens = {key: values for key, values in tokens.items() if values}
    regex_hits = {
        key: sorted(set(pattern.findall(text)))
        for key, pattern in REGEX_PATTERNS.items()
    }
    regex_hits = {key: values for key, values in regex_hits.items() if values}
    return {"tokens": tokens, "regex_hits": regex_hits}


def scan_one(job: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    url = job["url"]
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    source_path = cache_dir / f"{digest}.bin"
    ocr_path = cache_dir / f"{digest}-ocr.png"
    result_path = cache_dir / f"{digest}-result.json"
    if result_path.exists():
        try:
            cached = json.loads(result_path.read_text(encoding="utf-8"))
            if cached.get("url") == url and cached.get("ok") is True:
                return cached
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    started = time.monotonic()
    try:
        if source_path.exists() and source_path.stat().st_size > 0:
            byte_count = source_path.stat().st_size
            content_type = ""
        else:
            byte_count, content_type = download(url, source_path)
        if ocr_path.exists() and ocr_path.stat().st_size > 0:
            with Image.open(source_path) as image:
                width, height = image.size
        else:
            width, height = prepare_ocr_image(source_path, ocr_path)
        text = tesseract(ocr_path, 11).strip()
        result = {
            **job,
            "ok": True,
            "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
            "bytes": byte_count,
            "content_type": content_type,
            "width": width,
            "height": height,
            "ocr_text": text[:12000],
            **detect(text),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
        result_path.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(result_path, 0o600)
        return result
    except (OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as exc:
        result = {
            **job,
            "ok": False,
            "error": f"{type(exc).__name__}: {str(exc)[:300]}",
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
        result_path.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(result_path, 0o600)
        return result


def requirement_kind(picture: dict[str, Any]) -> str:
    picture_type = int(picture.get("pictureType") or 0)
    title = str(picture.get("pictureTitle") or "")
    desc = str(picture.get("pictureDesc") or "")
    text = f"{title} {desc}".lower()
    if picture_type == 5 or "配料" in text or "营养" in text:
        return "ingredients_nutrition"
    if picture_type == 3 or "包装标签" in text or "商品参数" in text:
        return "packaging"
    if picture_type == 8 and ("化妆" in text or "备案" in text):
        return "cosmetic"
    if picture_type == 8 or "背签" in text:
        return "back_label"
    if picture_type == 4 or "3c" in text or "认证" in text:
        return "ccc"
    if picture_type == 13 or "尺寸" in text:
        return "dimension"
    if picture_type in (6, 7) or "纺织" in text or "洗唛" in text:
        return "textile"
    return "unknown"


def evidence_for(scan: dict[str, Any], picture: dict[str, Any]) -> tuple[bool, list[str]]:
    if not scan.get("ok"):
        return False, ["ocr_failed"]
    tokens = scan.get("tokens") or {}
    regex_hits = scan.get("regex_hits") or {}
    kind = requirement_kind(picture)
    title = str(picture.get("pictureTitle") or "")
    desc = str(picture.get("pictureDesc") or "")
    issue = f"{title} {desc}"
    reasons: list[str] = []
    if kind == "ingredients_nutrition":
        need_ingredients = "配料" in issue
        need_nutrition = "营养" in issue
        ingredient_tokens = tokens.get("ingredients") or []
        if need_ingredients and "配料" not in ingredient_tokens:
            return False, ["missing_ingredients_text"]
        if need_nutrition and not tokens.get("nutrition"):
            return False, ["missing_nutrition_text"]
        if not need_ingredients and not need_nutrition:
            return False, ["ambiguous_requirement"]
        if need_ingredients:
            reasons.append("ocr_ingredients")
        if need_nutrition:
            reasons.append("ocr_nutrition")
        return True, reasons
    if kind == "packaging":
        required_groups = []
        if any(word in issue for word in ("厂名", "生产企业", "制造商")):
            required_groups.append("factory")
        if any(word in issue for word in ("厂址", "地址")):
            required_groups.append("address")
        if any(word in issue for word in ("产品型号", "型号", "商品参数")):
            required_groups.append("model")
        if not required_groups:
            required_groups = ["factory", "address"]
        missing = [group for group in required_groups if not tokens.get(group)]
        if missing:
            return False, [f"missing_{group}" for group in missing]
        return True, [f"ocr_{group}" for group in required_groups]
    if kind == "cosmetic":
        if regex_hits.get("cosmetic_number"):
            return True, ["ocr_cosmetic_registration_number"]
        return False, ["missing_cosmetic_registration_number"]
    if kind == "back_label":
        needed = ["standard", "license", "ingredients"]
        missing = [
            group
            for group in needed
            if (
                not tokens.get(group)
                or (group == "ingredients" and "配料" not in (tokens.get(group) or []))
            )
        ]
        if missing:
            return False, [f"missing_{group}" for group in missing]
        return True, [f"ocr_{group}" for group in needed]
    if kind == "ccc":
        if not tokens.get("ccc"):
            return False, ["missing_ccc_text"]
        if not regex_hits.get("ccc_number"):
            return False, ["missing_16_digit_ccc_number"]
        return True, ["ocr_ccc_text", "ocr_16_digit_ccc_number"]
    if kind == "dimension":
        dimensions = regex_hits.get("dimension") or []
        if len(dimensions) < 2:
            return False, ["fewer_than_two_dimensions"]
        return True, ["ocr_dimensions"]
    if kind == "textile":
        if not tokens.get("textile_material") or not tokens.get("textile_care"):
            return False, ["missing_textile_material_or_care"]
        return True, ["ocr_textile_material", "ocr_textile_care"]
    return False, ["unsupported_requirement"]


def main() -> None:
    args = parse_args()
    details_path = Path(args.details)
    run_dir = Path(args.run_dir).resolve()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", str(args.label or "")):
        raise ValueError("label 只能包含字母、数字和连字符")
    output_dir = run_dir / str(args.label)
    cache_dir = run_dir / "media-scan" / "cache"
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    os.chmod(cache_dir, 0o700)

    payload = json.loads(details_path.read_text(encoding="utf-8"))
    issue_by_spu: dict[str, str] = {}
    if args.manifest:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        for product in manifest.get("products") or []:
            spu_id = str(product.get("spu_id") or "")
            source = product.get("source") if isinstance(product.get("source"), dict) else {}
            texts: list[str] = []
            for channel in source.get("noSaleChannelInfoList") or []:
                for issue in channel.get("noSaleAbnormalInfoList") or []:
                    text = str(issue.get("abnormalInfo") or "")
                    if text:
                        texts.append(text)
            issue_by_spu[spu_id] = " ".join(texts)
    selected: list[dict[str, Any]] = []
    for product in payload.get("products") or []:
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = str(product.get("spu_id") or detail.get("spuId") or "")
        if issue_by_spu and spu_id not in issue_by_spu:
            continue
        missing = required_missing(detail, issue_by_spu.get(spu_id, ""))
        if not missing:
            continue
        sources = image_sources(detail)
        selected.append(
            {
                "spu_id": spu_id,
                "title": str(product.get("title") or detail.get("spuName") or ""),
                "requirements": missing,
                "sources": sources,
            }
        )
    offset = max(0, int(args.offset_products))
    selected = selected[offset:]
    if args.limit_products > 0:
        selected = selected[: args.limit_products]
    if args.list_only:
        print(
            json.dumps(
                {
                    "ok": True,
                    "selected_product_count": len(selected),
                    "offset_products": offset,
                    "products": [
                        {
                            "spu_id": item["spu_id"],
                            "title": item["title"],
                            "requirement_count": len(item["requirements"]),
                            "image_count": len(item["sources"]),
                        }
                        for item in selected
                    ],
                },
                ensure_ascii=False,
            )
        )
        return

    job_by_url: dict[str, dict[str, Any]] = {}
    for product in selected:
        for url, sources in product["sources"].items():
            existing = job_by_url.setdefault(url, {"url": url, "source_types": set(), "spu_ids": set()})
            existing["source_types"].update(sources)
            existing["spu_ids"].add(product["spu_id"])
    jobs = [
        {
            "url": item["url"],
            "source_types": sorted(item["source_types"]),
            "spu_ids": sorted(item["spu_ids"]),
        }
        for item in job_by_url.values()
    ]

    scans: list[dict[str, Any]] = []
    workers = max(1, min(16, int(args.workers)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(scan_one, job, cache_dir) for job in jobs]
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            result = future.result()
            scans.append(result)
            if index % 25 == 0 or index == len(jobs):
                print(
                    json.dumps(
                        {
                            "event": "media_scan_progress",
                            "done": index,
                            "total": len(jobs),
                            "ok": bool(result.get("ok")),
                            "spu_count": len(result.get("spu_ids") or []),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

    scan_by_url = {item["url"]: item for item in scans}
    products_out: list[dict[str, Any]] = []
    accepted_count = 0
    for product in selected:
        requirements_out: list[dict[str, Any]] = []
        for requirement in product["requirements"]:
            candidates = []
            rejected = []
            for url, sources in product["sources"].items():
                scan = scan_by_url.get(url) or {"url": url, "ok": False}
                accepted, reasons = evidence_for(scan, requirement)
                item = {
                    "url": url,
                    "source_types": sorted(sources),
                    "accepted": accepted,
                    "reasons": reasons,
                    "sha256": scan.get("sha256"),
                    "width": scan.get("width"),
                    "height": scan.get("height"),
                    "tokens": scan.get("tokens") or {},
                    "regex_hits": scan.get("regex_hits") or {},
                }
                if accepted:
                    candidates.append(item)
                else:
                    rejected.append(item)
            if candidates:
                accepted_count += 1
            requirements_out.append(
                {
                    "pictureType": requirement.get("pictureType"),
                    "pictureTitle": requirement.get("pictureTitle"),
                    "pictureDesc": requirement.get("pictureDesc"),
                    "kind": requirement_kind(requirement),
                    "accepted_candidates": candidates,
                    "rejected_candidates": rejected,
                }
            )
        products_out.append(
            {
                "spu_id": product["spu_id"],
                "title": product["title"],
                "requirements": requirements_out,
            }
        )

    result = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "details_path": str(details_path),
        "manifest_path": str(args.manifest or ""),
        "offset_products": offset,
        "product_count": len(selected),
        "image_count": len(scans),
        "image_ok_count": sum(1 for item in scans if item.get("ok")),
        "requirement_with_candidate_count": accepted_count,
        "products": products_out,
        "images": scans,
    }
    result_path = output_dir / "media-evidence.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(result_path, 0o600)
    print(
        json.dumps(
            {
                "ok": True,
                "result_path": str(result_path),
                "product_count": len(selected),
                "image_count": len(scans),
                "image_ok_count": result["image_ok_count"],
                "requirement_with_candidate_count": accepted_count,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
