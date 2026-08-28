#!/usr/bin/env python3
"""Build a deterministic SPU manifest without trusting a formatted XLSX max row."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from xml.etree.ElementTree import iterparse
from zipfile import ZipFile


MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def column_number(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        return 0
    number = 0
    for char in letters.group(0):
        number = number * 26 + ord(char) - 64
    return number


def read_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    output: list[str] = []
    with archive.open("xl/sharedStrings.xml") as handle:
        for _, element in iterparse(handle, events=("end",)):
            if element.tag == MAIN_NS + "si":
                output.append("".join(node.text or "" for node in element.iter(MAIN_NS + "t")))
                element.clear()
    return output


def read_first_sheet_column(path: Path, selected_column: int) -> list[tuple[int, str]]:
    with ZipFile(path) as archive:
        shared = read_shared_strings(archive)
        rows: list[tuple[int, str]] = []
        with archive.open("xl/worksheets/sheet1.xml") as handle:
            for _, cell in iterparse(handle, events=("end",)):
                if cell.tag != MAIN_NS + "c":
                    continue
                reference = str(cell.get("r") or "")
                if column_number(reference) != selected_column:
                    cell.clear()
                    continue
                row_match = re.search(r"(\d+)$", reference)
                row_number = int(row_match.group(1)) if row_match else 0
                cell_type = cell.get("t")
                raw = cell.find(MAIN_NS + "v")
                if cell_type == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(MAIN_NS + "t"))
                elif raw is None:
                    value = ""
                elif cell_type == "s":
                    value = shared[int(raw.text or 0)]
                else:
                    value = raw.text or ""
                value = value.strip()
                if value:
                    rows.append((row_number, value))
                cell.clear()
        return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--column", type=int, default=1)
    parser.add_argument("--header", default="SPUID")
    parser.add_argument("--scope", default="only_channel_category_attributes")
    args = parser.parse_args()

    source = Path(args.xlsx).resolve()
    cells = read_first_sheet_column(source, args.column)
    if cells and cells[0][1].strip().upper().replace(" ", "") == args.header.strip().upper().replace(" ", ""):
        cells = cells[1:]
    products: list[dict[str, object]] = []
    seen: set[str] = set()
    for source_row, raw_value in cells:
        spu_id = re.sub(r"\.0$", "", raw_value.strip())
        if not re.fullmatch(r"\d+", spu_id):
            raise ValueError(f"invalid SPU at row {source_row}: {raw_value!r}")
        if spu_id in seen:
            continue
        seen.add(spu_id)
        products.append({"spu_id": spu_id, "source_row": source_row})
    if not products:
        raise ValueError("no SPU values found")
    digest = hashlib.sha256("\n".join(item["spu_id"] for item in products).encode()).hexdigest()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file": str(source),
        "source_sheet": "Sheet1",
        "source_column": args.header,
        "scope": args.scope,
        "expected_total": len(products),
        "raw_row_total": len(cells),
        "unique_total": len(products),
        "duplicate_total": len(cells) - len(products),
        "dynamic_total_mismatch": False,
        "spu_id_sha256": digest,
        "products": products,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(json.dumps({"ok": True, "unique_total": len(products), "duplicate_total": payload["duplicate_total"], "spu_id_sha256": digest, "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
