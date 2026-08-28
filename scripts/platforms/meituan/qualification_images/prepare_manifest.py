#!/usr/bin/env python3
"""Build a fail-closed manifest for local Meituan qualification images."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


FILE_RE = re.compile(
    r"^(?P<spu_id>\d{5,20})_(?P<picture_type>\d{1,3})_(?P<title>.+)_(?P<sequence>\d{2})\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)
SUPPORTED_TYPES = {3, 4, 5, 6, 7, 8, 10, 11, 13, 14}
REGULATED_RE = re.compile(r"3C|CCC|强制性产品认证|备案|注册证|许可证|检测报告|公章|能效", re.I)
PLACEHOLDER_RE = re.compile(
    r"演示样张|非真实凭证|不可用于平台审核|仅供展示|样例|示例|XX省|XX市|XX区|XX路|某某|随机|test certificate",
    re.I,
)
SOURCE_KINDS = {
    "official_registry",
    "issuer_scan",
    "regulator_scan",
    "manufacturer_original",
    "product_original",
}
CSV_FIELDS = [
    "file_name",
    "spu_id",
    "picture_type",
    "title",
    "sequence",
    "product_name",
    "expected_model",
    "source_kind",
    "source_reference",
    "certificate_number",
    "subject",
    "valid_until",
    "verification_status",
    "verified_by",
    "verified_at",
    "allow_shared_evidence",
    "ocr_text",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_file(path: Path) -> dict:
    match = FILE_RE.fullmatch(path.name)
    if not match:
        return {"file_name": path.name, "blockers": ["file_name_schema_invalid"]}
    row = match.groupdict()
    row["file_name"] = path.name
    row["picture_type"] = int(row["picture_type"])
    row["sequence"] = int(row["sequence"])
    row["file_path"] = str(path.resolve())
    row["blockers"] = []
    if row["picture_type"] not in SUPPORTED_TYPES:
        row["blockers"].append("picture_type_not_supported")
    try:
        with Image.open(path) as raw:
            image = ImageOps.exif_transpose(raw)
            row.update(
                image_format=str(raw.format or "").upper(),
                width=int(image.width),
                height=int(image.height),
                file_size=int(path.stat().st_size),
                sha256=sha256_file(path),
            )
        if row["image_format"] not in {"JPEG", "PNG"}:
            row["blockers"].append("image_format_not_jpeg_or_png")
        if min(row["width"], row["height"]) < 300:
            row["blockers"].append("image_resolution_too_small")
        if row["file_size"] > 5 * 1024 * 1024:
            row["blockers"].append("image_file_exceeds_5mb")
    except Exception as exc:
        row["blockers"].append(f"image_decode_failed:{type(exc).__name__}")
    return row


def scan(input_dir: Path) -> list[dict]:
    paths = sorted(
        path
        for path in input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    return [parse_file(path) for path in paths]


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in CSV_FIELDS})


def read_csv(path: Path) -> dict[str, dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    by_name: dict[str, dict] = {}
    for row in rows:
        name = str(row.get("file_name") or "").strip()
        if not name or name in by_name:
            raise ValueError("evidence_csv_file_name_missing_or_duplicate")
        by_name[name] = {key: str(value or "").strip() for key, value in row.items()}
    return by_name


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", value or "").lower()


def is_regulated(row: dict) -> bool:
    return int(row.get("picture_type") or 0) in {4, 10, 11} or bool(
        REGULATED_RE.search(str(row.get("title") or ""))
    )


def validate_metadata(row: dict, metadata: dict, today: date) -> list[str]:
    blockers: list[str] = []
    for key in ("spu_id", "picture_type", "title", "sequence"):
        if str(metadata.get(key, "")).strip() != str(row.get(key, "")).strip():
            blockers.append(f"metadata_identity_mismatch:{key}")
    regulated = is_regulated(row)
    source_kind = metadata.get("source_kind", "")
    if source_kind not in SOURCE_KINDS:
        blockers.append("source_kind_invalid")
    if not metadata.get("source_reference"):
        blockers.append("source_reference_missing")
    if source_kind == "official_registry" and not re.match(r"^https://", metadata.get("source_reference", ""), re.I):
        blockers.append("official_registry_reference_must_be_https")
    if metadata.get("verification_status") != "verified":
        blockers.append("verification_status_not_verified")
    if not metadata.get("verified_by") or not metadata.get("verified_at"):
        blockers.append("verification_audit_missing")
    ocr = metadata.get("ocr_text", "")
    if PLACEHOLDER_RE.search(ocr):
        blockers.append("placeholder_or_nonreal_mark_detected")
    if regulated:
        for key in ("certificate_number", "subject", "expected_model", "valid_until", "ocr_text"):
            if not metadata.get(key):
                blockers.append(f"regulated_{key}_missing")
        valid_until = metadata.get("valid_until", "")
        try:
            if date.fromisoformat(valid_until) < today:
                blockers.append("regulated_evidence_expired")
        except ValueError:
            blockers.append("regulated_valid_until_invalid")
        certificate = normalized(metadata.get("certificate_number", ""))
        if certificate and certificate not in normalized(ocr):
            blockers.append("certificate_number_not_found_in_ocr")
        model = normalized(metadata.get("expected_model", ""))
        if model and model not in normalized(ocr):
            blockers.append("expected_model_not_found_in_ocr")
        subject = normalized(metadata.get("subject", ""))
        if subject and subject not in normalized(ocr):
            blockers.append("subject_not_found_in_ocr")
        if int(row.get("picture_type") or 0) == 4 and not re.search(
            r"CCC|3C|强制性产品认证", ocr, re.I
        ):
            blockers.append("ccc_mark_not_found_in_ocr")
    return blockers


def build(args: argparse.Namespace) -> dict:
    input_dir = Path(args.input_dir).resolve()
    if not re.fullmatch(r"\d{5,20}", str(args.wm_poi_id)):
        raise ValueError("wm_poi_id_invalid")
    rows = scan(input_dir)
    metadata = read_csv(Path(args.evidence_csv).resolve())
    today = date.fromisoformat(args.today) if args.today else date.today()
    seen_hashes: dict[str, list[dict]] = {}
    for row in rows:
        meta = metadata.get(row.get("file_name", ""))
        if not meta:
            row["blockers"].append("evidence_metadata_missing")
            row["metadata"] = {}
        else:
            row["metadata"] = meta
            row["blockers"].extend(validate_metadata(row, meta, today))
        if row.get("sha256"):
            seen_hashes.setdefault(row["sha256"], []).append(row)
    for duplicates in seen_hashes.values():
        spus = {str(row.get("spu_id") or "") for row in duplicates}
        if len(spus) <= 1:
            continue
        for row in duplicates:
            if row.get("metadata", {}).get("allow_shared_evidence", "").lower() not in {"yes", "true", "1"}:
                row["blockers"].append("same_file_reused_across_spu_without_approval")
    for row in rows:
        row["blockers"] = list(dict.fromkeys(row["blockers"]))
        row["status"] = "ready" if not row["blockers"] else "blocked"
        row["placement"] = "prepend"
        row["authoritative_evidence"] = {
            key: row.get("metadata", {}).get(key, "")
            for key in (
                "source_kind",
                "source_reference",
                "certificate_number",
                "subject",
                "expected_model",
                "valid_until",
                "verification_status",
                "verified_by",
                "verified_at",
            )
        }
        row.pop("metadata", None)
    ready = sum(row["status"] == "ready" for row in rows)
    payload = {
        "schema": "meituan-qualification-import-manifest-v1",
        "platform_adapter": "meituan",
        "task_mode": "unavailable_one_pass",
        "wm_poi_id": str(args.wm_poi_id),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_dir": str(input_dir),
        "file_count": len(rows),
        "unique_spu_count": len({row.get("spu_id") for row in rows if row.get("spu_id")}),
        "ready_count": ready,
        "blocked_count": len(rows) - ready,
        "items": rows,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.review_csv:
        review_rows = []
        for row in rows:
            review_rows.append(
                {
                    "file_name": row.get("file_name", ""),
                    "spu_id": row.get("spu_id", ""),
                    "picture_type": row.get("picture_type", ""),
                    "status": row["status"],
                    "blockers": ";".join(row["blockers"]),
                    "sha256": row.get("sha256", ""),
                }
            )
        review_path = Path(args.review_csv).resolve()
        review_path.parent.mkdir(parents=True, exist_ok=True)
        with review_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=["file_name", "spu_id", "picture_type", "status", "blockers", "sha256"],
            )
            writer.writeheader()
            writer.writerows(review_rows)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    template = sub.add_parser("template")
    template.add_argument("--input-dir", required=True)
    template.add_argument("--output-csv", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--input-dir", required=True)
    build_parser.add_argument("--evidence-csv", required=True)
    build_parser.add_argument("--wm-poi-id", required=True)
    build_parser.add_argument("--output", required=True)
    build_parser.add_argument("--review-csv")
    build_parser.add_argument("--today")
    args = parser.parse_args()
    try:
        if args.command == "template":
            rows = scan(Path(args.input_dir).resolve())
            write_csv(Path(args.output_csv).resolve(), rows)
            result = {"schema": "meituan-qualification-evidence-template-v1", "rows": len(rows)}
        else:
            payload = build(args)
            result = {
                "schema": payload["schema"],
                "files": payload["file_count"],
                "ready": payload["ready_count"],
                "blocked": payload["blocked_count"],
            }
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}:{exc}"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
