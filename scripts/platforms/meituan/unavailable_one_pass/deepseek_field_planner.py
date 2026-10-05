#!/usr/bin/env python3
"""Plan conservative Meituan field repairs with DeepSeek; this script never writes platform data."""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path


SYSTEM = """你是美团闪购商品审核修复规划器。只根据给出的商品名称、规格、审核意见、属性当前值和候选项提出修复，不得编造品牌、规格、重量、证书编号、类目或商品事实。
输出严格 JSON：{"items":[{"spu_id":"...","confidence":"high|medium|low","reason":"...","plan":{"name":"可选","spec":"可选","weight":{"value":数字,"unit":"g|kg|ml|L"},"attributes":[{"attr_name":"必须与输入完全相同","values":["必须逐字来自候选项"]}]},"blocked":["原因"]}]}。
规则：
1. 只有证据唯一且无歧义时 confidence=high；否则不填对应字段并写 blocked。
2. 多规格商品不得用一个重量覆盖所有 SKU；此时不输出 weight。
3. 名称修复必须保留原商品身份，只能补入输入中已有的品牌/品名/规格/重量或移除明确冲突片段。
4. 属性值必须逐字来自该属性 options；没有明确证据不得猜。
5. 不规划商品类目修改，不规划资质、备案、证书或图片内容。
6. 规则35（零赠送铁律）：凡属性涉及赠品/开瓶器/吸管/餐具/杯子/礼袋/礼盒/封口夹/提供礼品包装等，绝对严禁选择'是/赠送/有赠品/赠开瓶器/赠礼袋'等肯定赠送项，必须强制选择明确否定项（'否/不赠送/无/普通包装'等）；若候选项全部为赠送含义，则绝对不规划该属性。
7. plan 中没有动作时返回空对象。"""


def call_deepseek(items: list[dict]) -> dict:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("DEEPSEEK_CHAT_MODEL", "deepseek-chat").strip()
    if not key:
        raise RuntimeError("DEEPSEEK_API_KEY_missing")
    body = json.dumps({"model": model, "temperature": 0, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps({"products": items}, ensure_ascii=False)}]}).encode()
    request = urllib.request.Request(f"{base}/chat/completions", data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read())
    return json.loads(payload["choices"][0]["message"]["content"])


def validate(item: dict, source: dict) -> tuple[dict, list[str]]:
    plan = item.get("plan") if isinstance(item.get("plan"), dict) else {}
    blocked = list(item.get("blocked") or [])
    valid = {}
    if plan.get("name"):
        name = str(plan["name"]).strip()
        if 6 <= len(name) <= 120:
            valid["name"] = name
        else:
            blocked.append("名称长度不合法")
    sku_list = source.get("sku_list") or []
    if plan.get("spec"):
        if len(sku_list) == 1:
            valid["spec"] = str(plan["spec"]).strip()
        else:
            blocked.append("多规格商品禁止统一覆盖规格")
    if isinstance(plan.get("weight"), dict):
        weight = plan["weight"]
        if len(sku_list) == 1 and isinstance(weight.get("value"), (int, float)) and weight.get("value", 0) > 0 and str(weight.get("unit")) in {"g", "kg", "ml", "L"}:
            valid["weight"] = {"value": weight["value"], "unit": str(weight["unit"])}
        else:
            blocked.append("重量证据或规格条件不满足")
    source_attrs = {str(attr.get("attr_name")): set(map(str, attr.get("options") or [])) for attr in source.get("attrs") or []}
    attrs = []
    for attr in plan.get("attributes") or []:
        name = str(attr.get("attr_name") or "").strip()
        values = [str(value) for value in attr.get("values") or []]
        if name in source_attrs and values and all(value in source_attrs[name] for value in values):
            is_gift_attr = bool(re.search(r"赠|送|附赠|配赠|开瓶器|杯子|吸管|餐具|封口夹|礼袋|礼盒|赠品|礼赠|提供礼品包装|提供礼赠包装", name, re.IGNORECASE))
            has_affirmative = any(
                re.search(r"^(?:是|有|赠送|赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|带吸管|带餐具|带杯套|礼盒包装|礼盒装|定制礼盒装|礼盒|礼袋装)$", v) or
                (re.search(r"赠|送|带|配|礼袋|礼盒", v) and not re.search(r"不|无|非|普通|常规|环保|免", v))
                for v in values
            )
            if is_gift_attr and has_affirmative:
                blocked.append(f"违反规则35零赠送铁律:{name}={values}")
            else:
                attrs.append({"attr_name": name, "values": values})
        else:
            blocked.append(f"属性候选不精确:{name}")
    if attrs:
        valid["attributes"] = attrs
    if str(item.get("confidence")) != "high":
        blocked.append("模型置信度不足，未授权自动写回")
        valid = {}
    return valid, list(dict.fromkeys(blocked))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--details", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=12)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    details = {str(row["spu_id"]): row for row in json.loads(Path(args.details).read_text(encoding="utf-8"))}
    wanted = {str(row["spu_id"]): row for row in manifest.get("products", []) if any(issue.get("field_name") in {"商品名称", "类目属性", "重量", "规格名称", "商品类目"} for issue in row.get("issues", []))}
    sources = []
    for spu_id, product in wanted.items():
        detail = details.get(spu_id, {})
        sources.append({"spu_id": spu_id, "name": detail.get("name") or product.get("name"), "issues": product.get("issues", []), "sku_list": detail.get("sku_list", []), "attrs": detail.get("attrs", []), "audit_reject_info": detail.get("audit_reject_info"), "audit_suggest_category": detail.get("audit_suggest_category")})
    output_path = Path(args.output)
    partial_path = output_path.with_suffix(output_path.suffix + ".partial")
    planned_by_id = {}
    if partial_path.is_file():
        planned_by_id = {str(item["spu_id"]): item for item in json.loads(partial_path.read_text(encoding="utf-8")).get("items", [])}
    size = max(1, min(args.batch_size, 20))
    for start in range(0, len(sources), size):
        batch = [source for source in sources[start:start + size] if source["spu_id"] not in planned_by_id]
        if not batch:
            continue
        response = call_deepseek(batch)
        by_id = {str(item.get("spu_id")): item for item in response.get("items", [])}
        for source in batch:
            raw = by_id.get(source["spu_id"], {"spu_id": source["spu_id"], "confidence": "low", "plan": {}, "blocked": ["模型未返回"]})
            plan, blocked = validate(raw, source)
            planned_by_id[source["spu_id"]] = {"spu_id": source["spu_id"], "confidence": raw.get("confidence", "low"), "reason": str(raw.get("reason") or ""), "plan": plan, "blocked": blocked}
        partial_path.write_text(json.dumps({"schema": "meituan-deepseek-field-plan-v1-partial", "items": list(planned_by_id.values())}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    planned = [planned_by_id[source["spu_id"]] for source in sources]
    output_path.write_text(json.dumps({"schema": "meituan-deepseek-field-plan-v1", "items": planned}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"items": len(planned), "high_confidence_with_actions": sum(bool(item["plan"]) for item in planned)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
