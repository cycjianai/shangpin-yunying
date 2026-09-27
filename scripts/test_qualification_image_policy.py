#!/usr/bin/env python3
"""Business red line: all QNH qualification-image limits come from one policy."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import build_formal_asset_jobs
import build_formal_nutrition_jobs
import build_generated_picture_plans
import build_authentic_special_picture_plans
import qnh_task_contract
from qualification_image_policy import (
    POLICY_PATH,
    QualificationImagePolicyError,
    channel_equivalence_mappings,
    load_qualification_image_policy,
    validate_qualification_generation_job,
)


ROOT = Path(__file__).resolve().parent.parent
policy = load_qualification_image_policy()
generation = policy["generation"]

assert POLICY_PATH == ROOT / "scripts" / "qualification_image_policy.json"
assert policy["schema"] == "qnh-qualification-image-policy-v1"
assert policy["scope"]["task_mode"] == "qualification_images_only"
assert set(qnh_task_contract.MODE_DEFAULT_BUDGETS["qualification_images_only"]) == set(
    qnh_task_contract.EXTERNAL_BUDGET_KEYS
)
assert all(
    value == 0
    for value in qnh_task_contract.MODE_DEFAULT_BUDGETS[
        "qualification_images_only"
    ].values()
)
assert build_formal_asset_jobs.ASSET_POLICIES is policy["asset_builders"][
    "formal_assets"
]
assert build_formal_nutrition_jobs.NUTRITION_POLICY is policy["asset_builders"][
    "nutrition"
]
assert build_generated_picture_plans.POST_GENERATION_GATES is policy[
    "post_generation_gates"
]
assert set(policy["post_generation_gates"]["barcode_guard_picture_types"]) == set(
    generation["allowed_picture_types"]
)
assert build_authentic_special_picture_plans.picture_kind(
    {"picture_type": 8, "picture_title": "背签图", "picture_desc": "含配料表"}
) == "back_label"
assert build_authentic_special_picture_plans.score_ocr(
    "ingredients",
    "配料表 营养成分表 能量 蛋白质 钠",
)[2]
assert not build_authentic_special_picture_plans.score_ocr(
    "ingredients",
    "配料表 营养成分表 能量",
)[2]
assert build_authentic_special_picture_plans.score_ocr(
    "back_label",
    "配料表 执行标准 生产许可证号 生产企业 厂址",
)[2]
assert build_authentic_special_picture_plans.score_ocr(
    "certificate",
    "中国国家强制性产品认证证书 CCC 证书编号",
)[2]
assert not build_authentic_special_picture_plans.score_ocr(
    "factory_label",
    "中国国家强制性产品认证证书 生产企业 地址 产品型号",
)[2]

valid_job = {
    "tenant_scope": "tenant-test",
    "spu_id": "123456",
    "picture_type": "13",
    "picture_title": "尺寸图",
    "prompt": "依据同一商品实物参考图制作清晰尺寸标注图",
    "reference_image_url": "https://example.invalid/reference.png",
    "evidence": "同一商品实物参考图",
    "expected_text_tokens": ["尺寸"],
}
validate_qualification_generation_job(valid_job)

prohibited_samples = [
    "伪造证书",
    "虚假报告",
    "假冒公章",
    "伪造资质",
    "假冒3C认证证",
    "伪造印章",
]
for sample in prohibited_samples:
    blocked = {**valid_job, "prompt": f"生成{sample}"}
    try:
        validate_qualification_generation_job(blocked)
    except QualificationImagePolicyError as exc:
        assert "禁止进入生成链路" in str(exc)
    else:
        raise AssertionError(f"prohibited content passed validation: {sample}")

validate_qualification_generation_job({**valid_job, "picture_type": "4", "picture_title": "3C认证证书"})
validate_qualification_generation_job({**valid_job, "picture_type": "10", "picture_title": "医疗器械注册证/备案凭证"})

try:
    validate_qualification_generation_job({**valid_job, "picture_type": "999"})
except QualificationImagePolicyError as exc:
    assert "picture_type is not allowed" in str(exc)
else:
    raise AssertionError("disallowed picture type passed generation validation")

assert len(policy["channel_equivalence_mappings"]["categories"]) >= 7
assert channel_equivalence_mappings() == policy["channel_equivalence_mappings"]
assert policy["generation"]["provider_idempotency"]["strictly_single_generation_per_spu_type"] is True
assert policy["generation"]["provider_idempotency"]["bidirectional_channel_reuse"] is True

direct_source = (ROOT / "scripts" / "qnh_direct.mjs").read_text(encoding="utf-8")
assert "./qualification_image_policy.json" in direct_source
assert "QUALIFICATION_WRITEBACK_POLICY.synthetic_missing_slots" in direct_source
assert "scripts/qualification_image_policy.json" in qnh_task_contract.build_file_fingerprints()

with tempfile.TemporaryDirectory(prefix="qualification-policy-contract-") as raw:
    temporary_root = Path(raw)
    manifest = temporary_root / "manifest.json"
    manifest.write_text(
        json.dumps({"products": [{"spu_id": "123456"}]}, ensure_ascii=False),
        encoding="utf-8",
    )
    arguments = qnh_task_contract.parser().parse_args(
        [
            "create",
            "--run-dir",
            str(temporary_root / "run"),
            "--source-manifest",
            str(manifest),
            "--request-text",
            "只处理这些SPU的资质图",
        ]
    )
    contract = qnh_task_contract.create_contract(arguments)
    frozen_policy = contract["qualification_image_policy"]
    assert frozen_policy["schema"] == policy["schema"]
    assert frozen_policy["policy_version"] == policy["policy_version"]
    assert frozen_policy["sha256"] == contract["skill_file_sha256"][
        "scripts/qualification_image_policy.json"
    ]
    qnh_task_contract.verify_contract(temporary_root / "run" / "task-contract.json")

print(
    json.dumps(
        {
            "ok": True,
            "policy_version": policy["policy_version"],
            "prohibited_regressions": len(prohibited_samples),
            "allowed_picture_types": generation["allowed_picture_types"],
        },
        ensure_ascii=False,
    )
)
