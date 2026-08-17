#!/usr/bin/env python3
from deepseek_field_planner import validate
from evidence_discovery import infer_jobs, score


source = {
    "sku_list": [{"spec_name": "500g"}],
    "attrs": [{"attr_name": "口味", "options": ["原味", "草莓味"]}],
}
plan, blocked = validate(
    {
        "confidence": "high",
        "plan": {
            "weight": {"value": 500, "unit": "g"},
            "attributes": [{"attr_name": "口味", "values": ["原味"]}],
        },
    },
    source,
)
assert not blocked
assert plan["weight"] == {"value": 500, "unit": "g"}
assert plan["attributes"][0]["values"] == ["原味"]

bad, blocked = validate(
    {"confidence": "high", "plan": {"attributes": [{"attr_name": "口味", "values": ["模型编造"]}]}},
    source,
)
assert not bad
assert blocked

jobs = infer_jobs({"issues": [{"field_name": "商品图片", "comment": "商品缺少配料&营养成分图"}]})
assert jobs[0]["img_type"] == 5
assert score(5, "配料 水 白砂糖 营养成分表 能量 蛋白质 脂肪", jobs[0]["requirement"])[0]
assert not score(5, "配料 水 白砂糖", jobs[0]["requirement"])[0]
print('{"ok":true,"tests":8}')
