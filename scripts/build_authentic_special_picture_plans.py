#!/usr/bin/env python3
"""Build QNH special-picture plans from authentic same-SPU or exact-title gallery images.

The script never generates credentials or label facts. It downloads candidate
images, OCRs a bounded subset with four workers, and only emits a plan when the
visible text satisfies the requested picture class. Full OCR text is not
persisted; the audit contains keyword hits and source provenance only.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageOps, ImageStat

from qualification_image_policy import load_qualification_image_policy


QUALIFICATION_IMAGE_POLICY = load_qualification_image_policy()
AUTHENTIC_EVIDENCE_POLICY = QUALIFICATION_IMAGE_POLICY["authentic_evidence"]


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def normalized_url(value: object) -> str:
    return text(value).replace("http://", "https://", 1)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def download_image(url: str, cache_dir: Path) -> Path:
    target = cache_dir / f"{sha256(normalized_url(url))}.img"
    if target.exists() and target.stat().st_size > 200:
        return target
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "image/avif,image/webp,image/*,*/*"},
    )
    maximum_bytes = int(AUTHENTIC_EVIDENCE_POLICY["maximum_download_bytes"])
    with urllib.request.urlopen(
        request,
        timeout=int(AUTHENTIC_EVIDENCE_POLICY["download_timeout_seconds"]),
    ) as response:
        payload = response.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise ValueError("candidate_image_too_large")
    target.write_bytes(payload)
    return target


def image_complexity(path: Path) -> float:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("L")
        image.thumbnail((640, 640))
        if image.width < 80 or image.height < 80:
            return 0.0
        edge = image.filter(ImageFilter.FIND_EDGES)
        stat = ImageStat.Stat(edge)
        return float(stat.mean[0]) + float(stat.stddev[0]) * 0.35


def ocr_image(path: Path) -> str:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("L")
        if max(image.size) < 1100:
            scale = min(2.5, 1200 / max(1, max(image.size)))
            image = image.resize(
                (max(1, int(image.width * scale)), max(1, int(image.height * scale))),
                Image.Resampling.LANCZOS,
            )
        image = ImageOps.autocontrast(image)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    completed = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", "chi_sim+eng", "--psm", "6"],
        input=buffer.getvalue(),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=int(AUTHENTIC_EVIDENCE_POLICY["ocr_timeout_seconds"]),
        check=False,
        env={**os.environ, "OMP_THREAD_LIMIT": "1"},
    )
    return completed.stdout.decode("utf-8", errors="ignore")[
        : int(AUTHENTIC_EVIDENCE_POLICY["maximum_ocr_characters"])
    ]


def picture_kind(picture: dict[str, Any]) -> str:
    value = f"{picture.get('picture_title', '')} {picture.get('picture_desc', '')}".lower()
    picture_type = int(picture.get("picture_type") or 0)
    for rule in AUTHENTIC_EVIDENCE_POLICY["picture_kind_rules"]:
        if picture_type in {int(item) for item in rule.get("picture_types") or []} or any(
            str(token).lower() in value for token in rule.get("title_tokens") or []
        ):
            return str(rule["kind"])
    return "unknown"


def normalized_ocr(value: str) -> str:
    return re.sub(r"\s+", "", value or "").lower()


def score_ocr(kind: str, raw_ocr: str) -> tuple[int, list[str], bool]:
    value = normalized_ocr(raw_ocr)
    rule = (AUTHENTIC_EVIDENCE_POLICY["ocr_rules"] or {}).get(kind)
    if not isinstance(rule, dict):
        return 0, [], False
    hits = {
        str(label)
        for label, pattern in (rule.get("patterns") or {}).items()
        if re.search(str(pattern), value, re.IGNORECASE) is not None
    }
    required_all = {str(item) for item in rule.get("required_all") or []}
    required_any = {str(item) for item in rule.get("required_any") or []}
    valid = required_all.issubset(hits) and (not required_any or bool(required_any & hits))
    minimum_hits = rule.get("minimum_hits") or {}
    if minimum_hits:
        labels = {str(item) for item in minimum_hits.get("labels") or []}
        valid = valid and len(labels & hits) >= int(minimum_hits.get("count") or 0)
    any_or_characters = rule.get("required_any_or_minimum_characters") or {}
    if any_or_characters:
        labels = {str(item) for item in any_or_characters.get("labels") or []}
        valid = valid and (
            bool(labels & hits)
            or len(value) >= int(any_or_characters.get("characters") or 0)
        )
    forbidden = str(rule.get("forbidden_regex") or "")
    if forbidden and re.search(forbidden, value, re.IGNORECASE):
        valid = False
    return len(hits), sorted(hits), valid


def title_tokens(title: str, brand: str) -> list[str]:
    values: list[str] = []
    if text(brand):
        values.append(text(brand))
    bracket = re.search(r"【([^】]{2,20})】", title)
    if bracket:
        values.append(bracket.group(1))
    for token in re.findall(r"[A-Za-z][A-Za-z0-9-]{1,20}", title):
        values.append(token)
    chinese_prefix = re.match(r"[\u4e00-\u9fff]{2,20}", re.sub(r"^【[^】]+】", "", title).strip())
    if chinese_prefix:
        prefix = chinese_prefix.group(0)
        values.extend(prefix[:length] for length in (2, 4, 6) if len(prefix) >= length)
    stop = ("优选好物", "爆款", "新款", "颜色可选", "多规格")
    output: list[str] = []
    for value in values:
        normalized = normalized_ocr(value)
        if len(normalized) < 2 or any(item in normalized for item in stop):
            continue
        if normalized not in output:
            output.append(normalized)
    return output[:8]


def candidate_conflicts(title: str, ocr: str) -> bool:
    title_model = set(re.findall(r"\b[A-Za-z]{1,6}[-_]?\d{2,8}[A-Za-z0-9-]*\b", title, re.IGNORECASE))
    ocr_model = set(re.findall(r"\b[A-Za-z]{1,6}[-_]?\d{2,8}[A-Za-z0-9-]*\b", ocr, re.IGNORECASE))
    if title_model and ocr_model and not {item.lower() for item in title_model}.intersection(
        item.lower() for item in ocr_model
    ):
        return True
    return False


def process_candidate(candidate: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    path = download_image(candidate["url"], cache_dir)
    complexity = image_complexity(path)
    return {**candidate, "cache_path": str(path), "complexity": round(complexity, 3)}


def build_plans(args: argparse.Namespace) -> dict[str, Any]:
    source = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    rows = [row for row in source.get("rows", []) if row.get("status") == "ready"]
    if args.offset > 0:
        rows = rows[args.offset :]
    if args.limit > 0:
        rows = rows[: args.limit]
    run_dir = Path(args.run_dir).resolve()
    output_dir = run_dir / args.label
    cache_dir = (
        Path(args.cache_dir).resolve()
        if args.cache_dir
        else output_dir / "image-cache"
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    ocr_workers = max(
        int(AUTHENTIC_EVIDENCE_POLICY["minimum_ocr_workers"]),
        min(int(AUTHENTIC_EVIDENCE_POLICY["maximum_ocr_workers"]), args.workers),
    )

    candidate_rows: dict[str, list[dict[str, Any]]] = {}
    all_candidates: dict[str, dict[str, Any]] = {}
    for row in rows:
        spu_id = str(row.get("spu_id") or "")
        values: list[dict[str, Any]] = []
        seen: set[str] = set()
        for source_kind, urls in (
            ("same_spu", [*(row.get("current_main_urls") or []), *(row.get("current_detail_urls") or [])]),
            ("gallery", row.get("gallery_urls") or []),
        ):
            for rank, url in enumerate(urls):
                normalized = normalized_url(url)
                if not normalized or normalized in seen:
                    continue
                seen.add(normalized)
                candidate = {
                    "spu_id": spu_id,
                    "url": str(url),
                    "source_kind": source_kind,
                    "source_rank": rank + 1,
                }
                values.append(candidate)
                all_candidates[f"{spu_id}|{normalized}"] = candidate
        candidate_rows[spu_id] = values

    prepared: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=ocr_workers) as pool:
        futures = {
            pool.submit(process_candidate, candidate, cache_dir): key
            for key, candidate in all_candidates.items()
        }
        for future, key in [(future, key) for future, key in futures.items()]:
            try:
                prepared[key] = future.result()
            except Exception as exc:
                prepared[key] = {**all_candidates[key], "error": type(exc).__name__}

    ocr_targets: dict[str, dict[str, Any]] = {}
    for row in rows:
        spu_id = str(row.get("spu_id") or "")
        values = [
            prepared.get(f"{spu_id}|{normalized_url(candidate['url'])}", candidate)
            for candidate in candidate_rows.get(spu_id, [])
        ]
        for source_kind, per_source_limit in AUTHENTIC_EVIDENCE_POLICY[
            "candidates_per_source"
        ].items():
            ranked = sorted(
                (
                    candidate
                    for candidate in values
                    if candidate.get("source_kind") == source_kind and candidate.get("cache_path")
                ),
                key=lambda candidate: (
                    float(candidate.get("complexity") or 0),
                    -int(candidate.get("source_rank") or 999),
                ),
                reverse=True,
            )
            for candidate in ranked[:per_source_limit]:
                key = f"{spu_id}|{normalized_url(candidate['url'])}"
                ocr_targets[key] = candidate

    ocr_values: dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=ocr_workers) as pool:
        futures = {
            pool.submit(ocr_image, Path(candidate["cache_path"])): key
            for key, candidate in ocr_targets.items()
        }
        for future, key in [(future, key) for future, key in futures.items()]:
            try:
                ocr_values[key] = future.result()
            except Exception:
                ocr_values[key] = ""

    index_rows: list[dict[str, Any]] = []
    for row in rows:
        spu_id = str(row.get("spu_id") or "")
        title = text(row.get("title"))
        tokens = title_tokens(title, text(row.get("basic_brand")))
        special_reuse: list[dict[str, Any]] = []
        special_gallery: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        blocked: list[dict[str, Any]] = []
        for picture in row.get("missing_pictures") or []:
            kind = picture_kind(picture)
            existing_urls = {
                normalized_url(url)
                for url in picture.get("existing_urls") or []
                if normalized_url(url)
            }
            scored: list[dict[str, Any]] = []
            for candidate in candidate_rows.get(spu_id, []):
                if normalized_url(candidate.get("url")) in existing_urls:
                    continue
                key = f"{spu_id}|{normalized_url(candidate['url'])}"
                raw_ocr = ocr_values.get(key, "")
                score, hits, valid = score_ocr(kind, raw_ocr)
                if not valid or candidate_conflicts(title, raw_ocr):
                    continue
                normalized_text = normalized_ocr(raw_ocr)
                product_token_hits = [token for token in tokens if token in normalized_text]
                if candidate["source_kind"] == "gallery" and (not tokens or not product_token_hits):
                    continue
                scored.append(
                    {
                        **candidate,
                        "score": score + (3 if candidate["source_kind"] == "same_spu" else 0),
                        "keyword_hits": hits,
                        "product_token_hits": product_token_hits[:4],
                        "ocr_char_count": len(normalized_text),
                    }
                )
            scored.sort(
                key=lambda candidate: (
                    int(candidate.get("score") or 0),
                    candidate.get("source_kind") == "same_spu",
                    -int(candidate.get("source_rank") or 999),
                ),
                reverse=True,
            )
            chosen = scored[0] if scored else None
            if chosen is None:
                blocked.append(
                    {
                        "picture_type": picture.get("picture_type"),
                        "picture_title": picture.get("picture_title"),
                        "kind": kind,
                        "reason": "no_authentic_ocr_evidence",
                    }
                )
                continue
            plan_item = {
                "picture_type": picture.get("picture_type"),
                "picture_title": picture.get("picture_title"),
                "url": chosen["url"],
            }
            evidence = (
                f"{'同SPU现有图片' if chosen['source_kind'] == 'same_spu' else '牵牛花图库完整标题查询'}；"
                f"OCR命中={','.join(chosen['keyword_hits'])}；"
                f"商品词命中={','.join(chosen['product_token_hits']) or ('同SPU免重复校验' if chosen['source_kind'] == 'same_spu' else '未命中')}"
            )
            plan_item["evidence"] = evidence
            if chosen["source_kind"] == "same_spu":
                special_reuse.append(plan_item)
            else:
                special_gallery.append(plan_item)
            decisions.append(
                {
                    "field": f"专项图:{picture.get('picture_title')}",
                    "status": "accepted",
                    "source": (
                        "same_spu_ocr_evidence"
                        if chosen["source_kind"] == "same_spu"
                        else "qnh_gallery_exact_title_ocr_evidence"
                    ),
                    "evidence": evidence,
                    "ocr_char_count": chosen["ocr_char_count"],
                }
            )
        if not special_reuse and not special_gallery:
            index_rows.append(
                {
                    "spu_id": spu_id,
                    "title": title,
                    "status": "blocked_no_authentic_evidence",
                    "blocked_pictures": blocked,
                }
            )
            continue
        plan = {
            "spu_id": spu_id,
            "activity_conflict_policy": "update_product",
            "coverage_scope": "all_stores",
            "update_profile": "tenant_edit_v424",
            "gallery_search_text": row.get("gallery_search_text"),
            "gallery_page": row.get("gallery_page", 1),
            "gallery_page_size": row.get("gallery_page_size", 10),
            "special_picture_reuse": special_reuse,
            "special_picture_gallery": special_gallery,
            "audit_decisions": decisions,
            "blocked_pictures": blocked,
        }
        plan_path = output_dir / f"{spu_id}.json"
        write_json(plan_path, plan)
        index_rows.append(
            {
                "spu_id": spu_id,
                "title": title,
                "status": "ready",
                "selected_picture_count": len(special_reuse) + len(special_gallery),
                "same_spu_count": len(special_reuse),
                "gallery_count": len(special_gallery),
                "blocked_picture_count": len(blocked),
                "plan_path": str(plan_path),
            }
        )

    index_path = output_dir / args.index_name
    write_json(
        index_path,
        {
            "generated_at": source.get("generated_at"),
            "candidate_snapshot": str(Path(args.candidates).resolve()),
            "ocr_workers": ocr_workers,
            "rows": index_rows,
        },
    )
    return {
        "index_path": str(index_path),
        "selected_total": len(rows),
        "ready": sum(row.get("status") == "ready" for row in index_rows),
        "blocked": sum(row.get("status") != "ready" for row in index_rows),
        "selected_pictures": sum(int(row.get("selected_picture_count") or 0) for row in index_rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--label", default="authentic-special-picture-plans")
    parser.add_argument(
        "--workers",
        type=int,
        default=int(AUTHENTIC_EVIDENCE_POLICY["maximum_ocr_workers"]),
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--index-name", default="index.json")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}", args.label):
        raise SystemExit("label 只能包含字母、数字和连字符")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json", args.index_name):
        raise SystemExit("index-name 必须是安全的 JSON 文件名")
    result = build_plans(args)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
