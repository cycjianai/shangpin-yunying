#!/usr/bin/env python3
"""Offline QNH headquarters-price planning, write-intent claiming and verification.

Snapshot JSON: {tenant: text, filter: object (no pagination), complete: true,
 total: int, products: [{spuId: text, name: text, tenantId: text or int,
 skus: [{skuId: text, specName: text, upcList: [text], suggestPrice: native object
 or null, basicPrice: value, baseSalePrice: value, externalCode: value,
 onlineStatus: value}]}]}.
All pages must be read and deduplicated before complete=true. For claim only, a
partial same-filter observation may set complete=false and retain native total;
it must contain every target SKU and every SKU of each observed SPU. Never mark
this partial observation complete, or use it as baseline/final. Preserve the same
projection for preflight/final; extra observed business fields are protected too.

Source JSON: {version_id: text, complete: true, total_products: int,
 total_skus: int, rows: [{native_product_id: text, native_sku_id: text,
 title: text, specification: text, barcode: text or null, price: decimal text}]}.
Source permissions and runtime/network evidence are owned by the caller.
This module never contacts a browser, database, provider or platform.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path


class ContractError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise ContractError(reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, data, exclusive=False):
    with Path(path).open("x" if exclusive else "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def identifier(value):
    require(isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]+", value)), "identifier_must_be_text")
    return value


def norm(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or ""))).casefold()


def money(value, target=True):
    require(isinstance(value, (str, Decimal, int)) and not isinstance(value, bool), "price_must_be_decimal_text")
    try:
        number = Decimal(value)
        require(number.is_finite(), "price_not_finite")
        rounded = number.quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ContractError("price_invalid") from None
    require(number == rounded, "price_sub_cent_precision")
    if target:
        require(Decimal("0.01") <= number <= Decimal("99999"), "price_out_of_range")
    return format(rounded, ".2f")


def price_state(sku):
    require("suggestPrice" in sku, "headquarters_price_field_missing")
    obj = sku["suggestPrice"]
    if obj is None:
        return "empty", None
    require(isinstance(obj, dict) and "tenantSuggestPrice" in obj, "headquarters_price_shape_unknown")
    tenant = obj["tenantSuggestPrice"]
    require(tenant is None or isinstance(tenant, dict), "tenant_price_shape_unknown")
    if tenant is not None:
        require("unifiedSuggestPrice" in tenant, "unified_price_field_missing")
    value = (tenant or {}).get("unifiedSuggestPrice")
    if value is not None and value != "":
        return "present", money(value, target=False)
    if obj.get("areaSuggestPriceList") or (tenant or {}).get("channelSuggestPriceList"):
        return "blocked", None
    return "empty", None


def snapshot_index(snapshot, allow_partial=False):
    require(isinstance(snapshot, dict) and (snapshot.get("complete") is True or
            (allow_partial and snapshot.get("complete") is False)), "snapshot_incomplete")
    tenant = identifier(snapshot.get("tenant"))
    require(isinstance(snapshot.get("filter"), dict), "snapshot_filter_missing")
    require(not {"page", "pageSize"}.intersection(snapshot["filter"]), "filter_contains_pagination")
    products = snapshot.get("products")
    require(isinstance(products, list) and type(snapshot.get("total")) is int
            and (snapshot["total"] == len(products) if snapshot["complete"] else
                 snapshot["total"] >= len(products)), "snapshot_total_mismatch")
    by_spu, by_sku = {}, {}
    for product in products:
        spu = identifier(product.get("spuId"))
        require(spu not in by_spu, "duplicate_spu")
        require(str(product.get("tenantId")) == tenant, "tenant_mismatch")
        require(isinstance(product.get("name"), str) and norm(product["name"]), "product_name_missing")
        require(isinstance(product.get("skus"), list) and product["skus"], "sku_list_missing")
        by_spu[spu] = product
        for sku in product["skus"]:
            key = identifier(sku.get("skuId"))
            require(key not in by_sku, "duplicate_sku")
            require(all(k in sku for k in ("specName", "upcList", "basicPrice", "baseSalePrice",
                                           "externalCode", "onlineStatus")), "protection_fields_missing")
            require(isinstance(sku["specName"], str), "specification_missing")
            require(isinstance(sku["upcList"], list), "barcode_list_invalid")
            for code in sku["upcList"]:
                identifier(code)
            price_state(sku)
            by_sku[key] = (product, sku)
    return by_spu, by_sku


def source_index(source):
    require(source.get("complete") is True and source.get("version_id"), "source_incomplete")
    rows = source.get("rows")
    require(isinstance(rows, list) and type(source.get("total_skus")) is int
            and source["total_skus"] == len(rows), "source_sku_total_mismatch")
    names, barcodes, ids, products = defaultdict(list), defaultdict(list), set(), set()
    for row in rows:
        key = identifier(row.get("native_sku_id"))
        require(key not in ids, "duplicate_source_sku")
        ids.add(key)
        products.add(identifier(row.get("native_product_id")))
        require(isinstance(row.get("title"), str) and norm(row["title"]), "source_name_missing")
        require(isinstance(row.get("specification"), str), "source_spec_missing")
        require("barcode" in row and "price" in row, "source_fields_missing")
        names[norm(row["title"])].append(row)
        if row["barcode"]:
            identifier(row["barcode"])
            barcodes[row["barcode"]].append(row)
    require(type(source.get("total_products")) is int and source["total_products"] == len(products),
            "source_product_total_mismatch")
    return names, barcodes


def match_sku(product, sku, names, barcodes):
    named = [r for r in names[norm(product["name"])] if norm(r["specification"]) == norm(sku["specName"])]
    # Generated QNH SKU barcodes are not evidence of a different physical product.
    codes = [c for c in sku["upcList"] if c != sku["skuId"]]
    bar = {r["native_sku_id"]: r for c in codes for r in barcodes[c]}
    bar_spec = [r for r in bar.values() if norm(r["specification"]) == norm(sku["specName"])]
    both = [r for r in named if r["native_sku_id"] in {b["native_sku_id"] for b in bar_spec}]
    if both:
        candidates, method = both, "name_spec_barcode"
    elif named and codes:
        return None, "physical_barcode_conflict"
    elif named:
        candidates, method = named, "name_spec"
    else:
        candidates, method = bar_spec, "barcode_spec"
    if len(candidates) != 1:
        return None, "ambiguous_source" if candidates else "source_not_found"
    row = candidates[0]
    try:
        price = money(row["price"])
    except ContractError as error:
        return None, str(error)
    return {"spu_id": product["spuId"], "sku_id": sku["skuId"], "product_name": product["name"],
            "specification": sku["specName"], "price": price, "method": method,
            "source_product_id": row["native_product_id"], "source_sku_id": row["native_sku_id"],
            "source_price": row["price"]}, None


def build_plan(baseline, source, batch_size=5000):
    require(type(batch_size) is int and 1 <= batch_size <= 5000, "batch_size_invalid")
    products, skus = snapshot_index(baseline)
    names, barcodes = source_index(source)
    entries, blocked = [], []
    for key, (product, sku) in skus.items():
        state, _ = price_state(sku)
        if state == "present":
            continue
        if state == "blocked":
            blocked.append({"spu_id": product["spuId"], "sku_id": key, "reason": "regional_or_channel_price_present"})
            continue
        entry, reason = match_sku(product, sku, names, barcodes)
        if entry:
            entries.append(entry)
        else:
            blocked.append({"spu_id": product["spuId"], "sku_id": key, "reason": reason})
    groups = defaultdict(list)
    for entry in entries:
        groups[entry["spu_id"]].append(entry)
    canary = []
    single = next((g for g in groups.values() if len(g) == 1 and len(products[g[0]["spu_id"]]["skus"]) == 1), [])
    multi = next((g for g in groups.values() if 1 < len(g) <= min(10, batch_size)
                  and len({x["price"] for x in g}) > 1), [])
    canary = single + multi if len(single) + len(multi) <= batch_size else multi or single
    if not canary and entries:
        canary = next(iter(groups.values()))
    canary_ids = {x["sku_id"] for x in canary}
    batches = []
    if canary:
        require(len(canary) <= batch_size, "canary_exceeds_platform_limit")
        batches.append({"id": "canary", "sku_ids": [x["sku_id"] for x in canary]})
    current = []
    for group in groups.values():
        rest = [x["sku_id"] for x in group if x["sku_id"] not in canary_ids]
        require(len(rest) <= batch_size, "single_spu_exceeds_batch_limit")
        if current and len(current) + len(rest) > batch_size:
            batches.append({"id": f"batch-{len(batches)}", "sku_ids": current})
            current = []
        current.extend(rest)
    if current:
        batches.append({"id": f"batch-{len(batches)}", "sku_ids": current})
    result = {"schema": "qnh-headquarters-price-plan-v1", "tenant": baseline["tenant"],
              "filter": baseline["filter"], "baseline": baseline, "source_version": source["version_id"],
              "source_sha256": digest(source), "entries": entries, "blocked": blocked,
              "batches": batches, "mode": "only_master", "batch_size": batch_size}
    result["plan_sha256"] = digest(result)
    return result


def validate_plan(plan):
    require(plan.get("schema") == "qnh-headquarters-price-plan-v1" and plan.get("mode") == "only_master", "plan_schema")
    require(plan.get("plan_sha256") == digest({k: v for k, v in plan.items() if k != "plan_sha256"}), "plan_changed")
    _, skus = snapshot_index(plan["baseline"])
    require(plan["tenant"] == plan["baseline"]["tenant"] and plan["filter"] == plan["baseline"]["filter"], "plan_scope_mismatch")
    require(type(plan.get("batch_size")) is int and 1 <= plan["batch_size"] <= 5000, "plan_batch_limit")
    for batch in plan["batches"]:
        require(bool(re.fullmatch(r"canary|batch-[0-9]+", batch["id"])) and 0 < len(batch["sku_ids"]) <= plan["batch_size"], "invalid_batch")
    entries = plan["entries"]
    require(len({x["sku_id"] for x in entries}) == len(entries), "duplicate_plan_sku")
    for entry in entries:
        require(entry["sku_id"] in skus and skus[entry["sku_id"]][0]["spuId"] == entry["spu_id"], "plan_outside_scope")
        require(price_state(skus[entry["sku_id"]][1])[0] == "empty", "plan_targets_existing_price")
        money(entry["price"])
    batch_ids = [b["id"] for b in plan["batches"]]
    require(len(set(batch_ids)) == len(batch_ids), "duplicate_batch")
    flattened = [k for b in plan["batches"] for k in b["sku_ids"]]
    require(sorted(flattened) == sorted(x["sku_id"] for x in entries), "batch_membership_mismatch")


def write_plan(plan, directory):
    from openpyxl import Workbook
    validate_plan(plan)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    by_id = {x["sku_id"]: x for x in plan["entries"]}
    manifest = {"plan_sha256": plan["plan_sha256"], "files": {}}
    for batch in plan["batches"]:
        book = Workbook()
        sheet = book.active
        sheet.append(["*SKU编码", "*总部零售价（元）", "渠道编码"])
        for key in batch["sku_ids"]:
            sheet.append([key, by_id[key]["price"], None])
            sheet.cell(sheet.max_row, 1).number_format = "@"
        path = directory / f"{batch['id']}.xlsx"
        book.save(path)
        manifest["files"][batch["id"]] = hashlib.sha256(path.read_bytes()).hexdigest()
    write(directory / "plan.json", plan, exclusive=True)
    write(directory / "workbooks.json", manifest, exclusive=True)


def require_same_scope(before, after):
    bp, bs = snapshot_index(before)
    ap, ass = snapshot_index(after)
    require(before["tenant"] == after["tenant"] and before["filter"] == after["filter"], "scope_changed")
    require(set(bp) == set(ap) and set(bs) == set(ass), "identity_set_changed")
    for key in bs:
        require(bs[key][0]["spuId"] == ass[key][0]["spuId"], "sku_parent_changed")
    return bp, bs, ap, ass


def claim(plan_path, batch_id, preflight):
    plan_path = Path(plan_path)
    plan = read(plan_path)
    validate_plan(plan)
    matches = [b for b in plan["batches"] if b["id"] == batch_id]
    require(len(matches) == 1, "unknown_batch")
    bp, before = snapshot_index(plan["baseline"])
    pp, current = snapshot_index(preflight, allow_partial=True)
    require(preflight["tenant"] == plan["tenant"] and preflight["filter"] == plan["filter"]
            and preflight["total"] == plan["baseline"]["total"], "scope_changed")
    require(set(pp).issubset(bp) and set(current).issubset(before), "preflight_outside_scope")
    for spu in pp:
        require({s["skuId"] for s in pp[spu]["skus"]} == {s["skuId"] for s in bp[spu]["skus"]},
                "preflight_incomplete_spu")
    require(set(matches[0]["sku_ids"]).issubset(current), "preflight_missing_target_sku")
    for key in matches[0]["sku_ids"]:
        require(before[key] == current[key], "preflight_changed_replan_required")
    manifest = read(plan_path.parent / "workbooks.json")
    require(manifest["plan_sha256"] == plan["plan_sha256"], "workbook_plan_changed")
    workbook = plan_path.parent / f"{batch_id}.xlsx"
    require(hashlib.sha256(workbook.read_bytes()).hexdigest() == manifest["files"][batch_id], "workbook_changed")
    intent = {"batch": batch_id, "tenant": plan["tenant"], "filter_sha256": digest(plan["filter"]),
              "plan_sha256": plan["plan_sha256"], "workbook_sha256": manifest["files"][batch_id],
              "sku_ids": matches[0]["sku_ids"], "mode": "only_master", "state": "pending_verify",
              "at": datetime.now(timezone.utc).isoformat()}
    write(plan_path.parent / f"{batch_id}-intent.json", intent, exclusive=True)
    return intent


def verify(plan, final):
    validate_plan(plan)
    bp, before, ap, after = require_same_scope(plan["baseline"], final)
    planned = {e["sku_id"]: e for e in plan["entries"]}
    issues, events = [], []
    for spu in bp:
        if [s["skuId"] for s in bp[spu]["skus"]] != [s["skuId"] for s in ap[spu]["skus"]]:
            issues.append({"spu_id": spu, "reason": "sku_order_changed"})
        if {k: v for k, v in bp[spu].items() if k != "skus"} != {k: v for k, v in ap[spu].items() if k != "skus"}:
            issues.append({"spu_id": spu, "reason": "protected_product_changed"})
    for key, (product, sku) in after.items():
        old = before[key][1]
        if key not in planned:
            if old != sku:
                issues.append({"spu_id": product["spuId"], "sku_id": key, "reason": "non_target_changed"})
            continue
        if {k: v for k, v in old.items() if k != "suggestPrice"} != {k: v for k, v in sku.items() if k != "suggestPrice"}:
            issues.append({"spu_id": product["spuId"], "sku_id": key, "reason": "protected_sku_changed"})
        state, value = price_state(sku)
        target = planned[key]["price"]
        obj = sku.get("suggestPrice") or {}
        extra_price = bool(obj.get("areaSuggestPriceList") or (obj.get("tenantSuggestPrice") or {}).get("channelSuggestPriceList"))
        if state != "present" or value != target or extra_price:
            issues.append({"spu_id": product["spuId"], "sku_id": key, "reason": "price_not_verified", "actual": value, "expected": target})
        events.append({"spu_id": product["spuId"], "product_name": product["name"], "channel": "牵牛花",
                       "field_id": f"sku.{key}.headquarters_retail_price", "field_name": "总部零售价",
                       "before": "(空值)", "planned": f"CNY {target}",
                       "readback": f"CNY {value}" if value is not None else "(空值)",
                       "result": "verified_complete", "source_strategy": "source_store_verified_archive"})
    blocked_spu = {i["spu_id"] for i in plan["blocked"]}
    bad_spu = {i["spu_id"] for i in issues} | blocked_spu
    for event in events:
        if event["spu_id"] in bad_spu:
            event["result"] = "blocked" if event["spu_id"] in blocked_spu else "pending_verify"
    def empty_counts(products):
        flags = [[price_state(s)[0] != "present" for s in p["skus"]] for p in products.values()]
        return {"spu": sum(any(row) for row in flags), "sku": sum(sum(row) for row in flags)}
    before_counts, after_counts = empty_counts(bp), empty_counts(ap)
    return {"schema": "qnh-headquarters-price-verification-v1", "plan_sha256": plan["plan_sha256"],
            "complete": not issues and not plan["blocked"] and after_counts["sku"] == 0,
            "before_empty": before_counts, "after_empty": after_counts,
            "planned_sku": len(planned), "preserved_non_target_sku": len(before) - len(planned),
            "issues": issues, "blocked": plan["blocked"], "audit_events": events}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("plan")
    for name in ("baseline", "source", "output-dir"):
        p.add_argument("--" + name, required=True)
    p.add_argument("--batch-size", type=int, default=5000)
    p = sub.add_parser("claim")
    for name in ("plan", "batch", "preflight"):
        p.add_argument("--" + name, required=True)
    p = sub.add_parser("verify")
    for name in ("plan", "final", "output"):
        p.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        if args.action == "plan":
            result = build_plan(read(args.baseline), read(args.source), args.batch_size)
            write_plan(result, args.output_dir)
            print(json.dumps({"planned_sku": len(result["entries"]), "blocked_sku": len(result["blocked"]),
                              "batches": [{"id": b["id"], "rows": len(b["sku_ids"])} for b in result["batches"]]}))
        elif args.action == "claim":
            result = claim(args.plan, args.batch, read(args.preflight))
            print(json.dumps({"batch": result["batch"], "state": result["state"], "sku_count": len(result["sku_ids"])}))
        else:
            result = verify(read(args.plan), read(args.final))
            write(args.output, result)
            print(json.dumps({k: v for k, v in result.items() if k != "audit_events"}, ensure_ascii=False))
            return 0 if result["complete"] else 2
    except (ContractError, FileExistsError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
