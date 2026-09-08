from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import prepare as p

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts"))
from core.operations_contract import normalize_event


def sku(key, spec="1瓶", barcode=None, price=None):
    return {"skuId": key, "specName": spec, "upcList": [barcode or key],
            "suggestPrice": None if price is None else {"tenantSuggestPrice": {"unifiedSuggestPrice": price}},
            "basicPrice": "0.0", "baseSalePrice": None, "externalCode": None, "onlineStatus": 1}


def product(key, title, skus):
    return {"spuId": key, "tenantId": "tenant-demo", "name": title, "skus": skus}


def baseline():
    products = [product("p1", "饮料", [sku("0001234567890123456789", barcode="001234")]),
                product("p2", "纽扣", [sku("s2", "小号"), sku("s3", "大号")]),
                product("p3", "已有价格", [sku("s4", price="0.00")])]
    return {"tenant": "tenant-demo", "filter": {"labelInfoList": [{"labelTypeId": "type-demo", "labelList": [{"labelId": "tag-demo"}]}]},
            "complete": True, "total": 3, "products": products}


def source():
    return {"version_id": "source-demo", "complete": True, "total_products": 2, "total_skus": 3,
            "rows": [{"native_product_id": "a", "native_sku_id": "a1", "title": "饮料", "specification": "1瓶", "barcode": "001234", "price": "16.0000"},
                     {"native_product_id": "b", "native_sku_id": "b1", "title": "纽扣", "specification": "小号", "barcode": "000234", "price": "0.40"},
                     {"native_product_id": "b", "native_sku_id": "b2", "title": "纽扣", "specification": "大号", "barcode": "000345", "price": "0.50"}]}


def materialize(plan):
    result = copy.deepcopy(plan["baseline"])
    values = {x["sku_id"]: x["price"] for x in plan["entries"]}
    for product in result["products"]:
        for item in product["skus"]:
            if item["skuId"] in values:
                item["suggestPrice"] = {"tenantSuggestPrice": {"unifiedSuggestPrice": values[item["skuId"]]}}
    return result


class PriceFillTests(unittest.TestCase):
    def test_unique_variant_matches_and_existing_zero_preserved(self):
        plan = p.build_plan(baseline(), source())
        self.assertEqual([x["price"] for x in plan["entries"]], ["16.00", "0.40", "0.50"])
        self.assertEqual([x["method"] for x in plan["entries"]], ["name_spec_barcode", "name_spec", "name_spec"])
        result = p.verify(plan, materialize(plan))
        self.assertTrue(result["complete"])
        self.assertEqual(result["before_empty"], {"spu": 2, "sku": 3})
        self.assertEqual(result["after_empty"], {"spu": 0, "sku": 0})
        self.assertEqual(result["preserved_non_target_sku"], 1)
        for event in result["audit_events"]:
            normalize_event(event)

    def test_duplicate_same_price_is_not_unique(self):
        data = source()
        extra = dict(data["rows"][1], native_sku_id="b3")
        data["rows"].append(extra)
        data["total_skus"] += 1
        plan = p.build_plan(baseline(), data)
        self.assertEqual(plan["blocked"][0]["reason"], "ambiguous_source")
        self.assertFalse(p.verify(plan, materialize(plan))["complete"])

    def test_real_barcode_conflict_and_variant_mismatch(self):
        data = baseline()
        data["products"][1]["skus"][0]["upcList"] = ["999999"]
        plan = p.build_plan(data, source())
        self.assertEqual(plan["blocked"][0]["reason"], "physical_barcode_conflict")
        data = baseline()
        data["products"][0]["skus"][0]["specName"] = "10瓶"
        plan = p.build_plan(data, source())
        self.assertEqual(plan["blocked"][0]["reason"], "source_not_found")

    def test_no_implicit_price_rounding_or_missing_default(self):
        for bad in [None, "NaN", "Infinity", "-1", "0", "0.001", "100000", 0.4]:
            data = source()
            data["rows"][0]["price"] = bad
            with self.subTest(bad=bad):
                plan = p.build_plan(baseline(), data)
                self.assertEqual(len(plan["blocked"]), 1)

    def test_regional_prices_and_unknown_fields_fail_closed(self):
        data = baseline()
        data["products"][0]["skus"][0]["suggestPrice"] = {"tenantSuggestPrice": {"unifiedSuggestPrice": None,
            "channelSuggestPriceList": [{"channel": "channel-demo", "price": "4"}]}}
        plan = p.build_plan(data, source())
        self.assertEqual(plan["blocked"][0]["reason"], "regional_or_channel_price_present")
        for mutate in [lambda d: d.update(complete=False), lambda d: d.update(total=4),
                       lambda d: d["products"][0].update(tenantId="other-tenant"),
                       lambda d: d["products"][0]["skus"][0].pop("suggestPrice"),
                       lambda d: d["products"][0]["skus"][0].update(skuId=123),
                       lambda d: d["products"][0]["skus"].append(copy.deepcopy(d["products"][0]["skus"][0]))]:
            data = baseline()
            mutate(data)
            with self.assertRaises(p.ContractError):
                p.build_plan(data, source())

    def test_canary_respects_smaller_template_limit_and_no_spu_split(self):
        plan = p.build_plan(baseline(), source(), 2)
        self.assertEqual([len(b["sku_ids"]) for b in plan["batches"]], [2, 1])
        self.assertEqual(plan["batches"][0]["sku_ids"], ["s2", "s3"])
        p.validate_plan(plan)

    def test_official_workbook_and_claim_are_immutable(self):
        from openpyxl import load_workbook
        plan = p.build_plan(baseline(), source())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "run"
            p.write_plan(plan, root)
            book = load_workbook(root / "canary.xlsx")
            rows = list(book.active.values)
            self.assertEqual(len(rows), 4)
            self.assertEqual(rows[1], ("0001234567890123456789", "16.00", None))
            self.assertEqual(book.active["A2"].data_type, "s")
            def attempt():
                try:
                    p.claim(root / "plan.json", "canary", baseline())
                    return "claimed"
                except FileExistsError:
                    return "blocked"
            with ThreadPoolExecutor(2) as pool:
                self.assertEqual(sorted(pool.map(lambda _: attempt(), range(2))), ["blocked", "claimed"])
            with self.assertRaises(FileExistsError):
                p.write_plan(plan, root)
            (root / "canary.xlsx").write_bytes(b"changed")
            with self.assertRaisesRegex(p.ContractError, "workbook_changed"):
                p.claim(root / "plan.json", "canary", baseline())

    def test_partial_preflight_covers_batch_without_claiming_full_rescan(self):
        plan = p.build_plan(baseline(), source())
        partial = baseline()
        partial["complete"] = False
        partial["products"] = partial["products"][:2]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "run"
            p.write_plan(plan, root)
            self.assertEqual(p.claim(root / "plan.json", "canary", partial)["state"], "pending_verify")
        with self.assertRaisesRegex(p.ContractError, "snapshot_incomplete"):
            p.verify(plan, partial)
        partial["products"][1]["skus"].pop()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "run"
            p.write_plan(plan, root)
            with self.assertRaisesRegex(p.ContractError, "preflight_incomplete_spu"):
                p.claim(root / "plan.json", "canary", partial)

    def test_preflight_and_plan_drift_prevent_claim(self):
        plan = p.build_plan(baseline(), source())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "run"
            p.write_plan(plan, root)
            fresh = materialize(plan)
            with self.assertRaisesRegex(p.ContractError, "preflight_changed"):
                p.claim(root / "plan.json", "canary", fresh)
            fresh = baseline()
            fresh["filter"] = {"other": "scope"}
            with self.assertRaisesRegex(p.ContractError, "scope_changed"):
                p.claim(root / "plan.json", "canary", fresh)
        plan["entries"][0]["price"] = "999.00"
        with self.assertRaisesRegex(p.ContractError, "plan_changed"):
            p.validate_plan(plan)

    def test_accepted_is_not_verified_and_protected_changes_fail(self):
        plan = p.build_plan(baseline(), source())
        result = p.verify(plan, baseline())
        self.assertFalse(result["complete"])
        self.assertTrue(all(e["result"] == "pending_verify" for e in result["audit_events"]))
        final = materialize(plan)
        final["products"][2]["skus"][0]["suggestPrice"]["tenantSuggestPrice"]["unifiedSuggestPrice"] = "9.00"
        self.assertFalse(p.verify(plan, final)["complete"])
        final = materialize(plan)
        final["products"][1]["skus"][0]["upcList"] = ["bad-barcode"]
        result = p.verify(plan, final)
        self.assertFalse(result["complete"])
        self.assertTrue(all(e["result"] != "verified_complete" for e in result["audit_events"] if e["spu_id"] == "p2"))
        final = materialize(plan)
        final["products"][1]["skus"].reverse()
        self.assertFalse(p.verify(plan, final)["complete"])
        final = materialize(plan)
        final["products"][1]["skus"][0]["skuId"] = "different-sku"
        with self.assertRaisesRegex(p.ContractError, "identity_set_changed"):
            p.verify(plan, final)


if __name__ == "__main__":
    unittest.main()
