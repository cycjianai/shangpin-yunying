#!/usr/bin/env python3
"""Read same-SPU product images for checksum-valid retail barcodes.

This helper is deliberately read-only. It consumes the immutable QNH detail
snapshot plus the local image cache produced by scan_media.py. A barcode is
reported only when ZXing decodes it and its GTIN check digit is valid.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import statistics
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import zxingcpp
from PIL import Image, ImageOps


SUPPORTED_LENGTHS = {8, 12, 13, 14}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--media-cache", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--workers", type=int, default=10)
    return parser.parse_args()


def products_from(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("products") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError(f"{path} does not contain a products list")
    return [row for row in rows if isinstance(row, dict)]


def has_barcode_issue(product: dict[str, Any]) -> bool:
    issue_blob = " ".join(str(value) for value in product.get("issue_text") or [])
    return any(token in issue_blob for token in ("条形码", "条码", "UPC"))


def gtin_valid(value: str) -> bool:
    if not value.isdigit() or len(value) not in SUPPORTED_LENGTHS:
        return False
    digits = [int(char) for char in value]
    total = 0
    for offset, digit in enumerate(reversed(digits[:-1]), start=1):
        total += digit * (3 if offset % 2 == 1 else 1)
    return (10 - total % 10) % 10 == digits[-1]


def normalized_url(value: object) -> str:
    url = str(value or "").strip()
    if url.startswith("http://"):
        url = "https://" + url.removeprefix("http://")
    parsed = urlparse(url)
    host = str(parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host.endswith(".meituan.net"):
        return ""
    return url


def image_jobs(
    products: list[dict[str, Any]],
    barcode_issue_spus: set[str],
    cache_dir: Path,
) -> list[dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for product in products:
        detail = product.get("detail") if isinstance(product.get("detail"), dict) else {}
        spu_id = str(product.get("spu_id") or detail.get("spuId") or "")
        if spu_id not in barcode_issue_spus:
            continue
        sources: list[tuple[str, object]] = [
            ("main", detail.get("picUrlList")),
            ("detail", detail.get("picContentList")),
            ("real", detail.get("realPicList")),
        ]
        special_urls: list[object] = []
        for picture in detail.get("mtSpecialPictureList") or []:
            if isinstance(picture, dict):
                special_urls.extend(picture.get("pictureUrl") or [])
        sources.append(("special", special_urls))
        for source_type, values in sources:
            for raw in values or []:
                if isinstance(raw, dict):
                    raw = raw.get("url") or raw.get("pictureUrl") or raw.get("picUrl")
                url = normalized_url(raw)
                if not url:
                    continue
                row = indexed.setdefault(
                    url,
                    {"url": url, "spu_ids": set(), "source_types": set()},
                )
                row["spu_ids"].add(spu_id)
                row["source_types"].add(source_type)
    rows: list[dict[str, Any]] = []
    for url, row in indexed.items():
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        rows.append(
            {
                "url": url,
                "spu_ids": sorted(row["spu_ids"]),
                "source_types": sorted(row["source_types"]),
                "image_path": str(cache_dir / f"{digest}.bin"),
            }
        )
    return rows


def ensure_downloaded(row: dict[str, Any]) -> None:
    image_path = Path(str(row["image_path"]))
    if image_path.exists() and image_path.stat().st_size > 0:
        return
    request = urllib.request.Request(
        str(row["url"]),
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(20 * 1024 * 1024)
    if not data:
        raise ValueError("empty image")
    image_path.write_bytes(data)


def normalized_code(result: Any) -> str:
    text = str(getattr(result, "text", "") or "").strip()
    if not text.isdigit():
        return ""
    fmt = str(getattr(result, "format", "") or "")
    if "UPCA" in fmt.upper() and len(text) == 12:
        return text
    return text


def decode_one(row: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        ensure_downloaded(row)
        with Image.open(row["image_path"]) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
            variants = [("original", image)]
            long_edge = max(width, height)
            if long_edge < 1600:
                factor = min(4.0, 1600.0 / max(1, long_edge))
                variants.append(
                    (
                        "upscaled",
                        image.resize(
                            (max(1, int(width * factor)), max(1, int(height * factor))),
                            Image.Resampling.LANCZOS,
                        ),
                    )
                )
            hits: dict[str, dict[str, Any]] = {}
            for variant_name, variant in variants:
                for result in zxingcpp.read_barcodes(
                    variant,
                    try_rotate=True,
                    try_downscale=True,
                    try_invert=True,
                    text_mode=zxingcpp.TextMode.Plain,
                ):
                    code = normalized_code(result)
                    if not gtin_valid(code):
                        continue
                    hits.setdefault(
                        code,
                        {
                            "value": code,
                            "format": str(getattr(result, "format", "") or ""),
                            "variant": variant_name,
                        },
                    )
        return {
            **row,
            "ok": True,
            "width": width,
            "height": height,
            "barcodes": sorted(hits.values(), key=lambda item: item["value"]),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    except (OSError, ValueError, RuntimeError, urllib.error.URLError) as exc:
        return {
            **row,
            "ok": False,
            "barcodes": [],
            "error": f"{type(exc).__name__}: {str(exc)[:300]}",
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }


def main() -> None:
    args = parse_args()
    detail_products = products_from(Path(args.details))
    manifest_products = products_from(Path(args.manifest))
    current_spus = {str(row.get("spu_id") or "") for row in detail_products}
    barcode_issue_spus = {
        str(row.get("spu_id") or "")
        for row in manifest_products
        if has_barcode_issue(row)
    }
    jobs = image_jobs(
        detail_products,
        current_spus & barcode_issue_spus,
        Path(args.media_cache),
    )
    workers = max(1, min(20, int(args.workers)))
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        scanned = list(pool.map(decode_one, jobs))

    candidates: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"barcode_values": set(), "evidence": []}
    )
    for row in scanned:
        if not row.get("barcodes"):
            continue
        for spu_id in set(row["spu_ids"]) & barcode_issue_spus:
            for barcode in row["barcodes"]:
                candidates[spu_id]["barcode_values"].add(barcode["value"])
                candidates[spu_id]["evidence"].append(
                    {
                        "value": barcode["value"],
                        "format": barcode["format"],
                        "url": row["url"],
                        "source_types": row["source_types"],
                        "image_width": row.get("width"),
                        "image_height": row.get("height"),
                    }
                )

    details_by_spu = {
        str(row.get("spu_id") or ""): row for row in detail_products
    }
    candidate_rows: list[dict[str, Any]] = []
    for spu_id, candidate in sorted(candidates.items()):
        product = details_by_spu.get(spu_id) or {}
        detail = product.get("detail") or {}
        skus = detail.get("skus") or []
        values = sorted(candidate["barcode_values"])
        candidate_rows.append(
            {
                "spu_id": spu_id,
                "title": product.get("title") or detail.get("spuName") or "",
                "sku_count": len(skus),
                "sku_ids": [str(sku.get("skuId") or "") for sku in skus],
                "barcode_values": values,
                "evidence": candidate["evidence"],
                "single_sku_unique_candidate": len(skus) == 1 and len(values) == 1,
            }
        )

    durations = [int(row.get("elapsed_ms") or 0) for row in scanned]
    elapsed_ms = int((time.monotonic() - started) * 1000)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "details_path": str(Path(args.details)),
        "manifest_path": str(Path(args.manifest)),
        "media_cache": str(Path(args.media_cache)),
        "workers": workers,
        "barcode_issue_spu_count": len(barcode_issue_spus),
        "images_scanned": len(scanned),
        "images_with_valid_barcode": sum(bool(row.get("barcodes")) for row in scanned),
        "candidate_spu_count": len(candidate_rows),
        "single_sku_unique_candidate_count": sum(
            bool(row["single_sku_unique_candidate"]) for row in candidate_rows
        ),
        "elapsed_ms": elapsed_ms,
        "throughput_average_ms_per_image": round(elapsed_ms / max(1, len(scanned)), 2),
        "item_average_ms": round(statistics.mean(durations), 2) if durations else 0,
        "item_p95_ms": (
            sorted(durations)[min(len(durations) - 1, int(len(durations) * 0.95))]
            if durations
            else 0
        ),
        "candidates": candidate_rows,
        "scan_results": scanned,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                key: payload[key]
                for key in (
                    "barcode_issue_spu_count",
                    "images_scanned",
                    "images_with_valid_barcode",
                    "candidate_spu_count",
                    "single_sku_unique_candidate_count",
                    "elapsed_ms",
                    "throughput_average_ms_per_image",
                )
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
