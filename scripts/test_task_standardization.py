"""
【业务说明书：牵牛花 Skill - 任务标准化黄金样例校验脚本】
建立时间：2026年
核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
1. 纯渠道属性任务必须锁定 channel_attributes_only，OCR、博查、Web、生图和图片上传预算为零。
2. 最终结构问题不为零、Excel Schema 漂移或 Skill/脚本哈希漂移时禁止宣称完成。
3. 只有固定动作、完整 SPU 终态、独立全量验证和标准工作簿全部通过才允许 complete=true。
4. 交付链接只能来自 execution 运行的机器交付门；只读复核表不得冒充执行结果。
"""

from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import Workbook, load_workbook

from qnh_task_contract import (
    MODE_ALLOWED_ACTIONS,
    append_ledger,
    contract_digest,
    read_json,
)


ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
PYTHON = sys.executable


def run(*args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        [str(arg) for arg in args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != expected:
        raise AssertionError(
            f"command exit {completed.returncode}, expected {expected}: {args}\n"
            f"stdout={completed.stdout[-2000:]}\nstderr={completed.stderr[-2000:]}"
        )
    return completed


def manifest_payload() -> dict:
    return {
        "products": [
            {"spu_id": f"90000000000000000{index:02d}"}
            for index in range(1, 11)
        ]
    }


def final_details(manifest: dict) -> dict:
    products = []
    for index, item in enumerate(manifest["products"], start=1):
        products.append(
            {
                "spu_id": item["spu_id"],
                "title": f"黄金样例商品{index}",
                "detail": {
                    "spuChannelInfoList": [
                        {
                            "channelId": 100,
                            "categoryCode": "golden-category",
                            "categoryProperties": [
                                {
                                    "attrId": "packing",
                                    "attrName": "包装方式",
                                    "attrValueType": 1,
                                    "attrValueList": [
                                        {"attrValueId": "1", "attrValue": "独立装"}
                                    ],
                                    "customValue": [
                                        {"attrValueId": "1", "attrValue": "独立装"}
                                    ],
                                }
                            ],
                        }
                    ]
                },
            }
        )
    return {"products": products}


def record_fixture_actions(contract: dict) -> None:
    for action in (
        "session_preflight",
        "read_details_initial",
        "build_channel_plans",
        "read_details_final",
    ):
        append_ledger(
            contract,
            {
                "task_mode": contract["task_mode"],
                "requested_action": action,
                "outcome": "succeeded",
                "exit_code": 0,
                "elapsed_ms": 1,
                "budget_key": None,
                "units": 0,
                "canonical_script": contract["canonical_executors"][action]["script"],
                "canonical_script_sha256": contract["canonical_executors"][action][
                    "script_sha256"
                ],
                "fixture": True,
            },
        )


def main() -> int:
    results: dict[str, object] = {}
    skill_source = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    governance_source = (ROOT / "references" / "repository-governance.md").read_text(
        encoding="utf-8"
    )
    module_map_source = (ROOT / "references" / "platform-module-map.md").read_text(
        encoding="utf-8"
    )
    meituan_source = (ROOT / "references" / "platform-meituan.md").read_text(
        encoding="utf-8"
    )
    operations_schema = json.loads(
        (SCRIPTS / "operations_workbook_schema.json").read_text(encoding="utf-8")
    )
    assert "远端只允许保留\n`main`" in skill_source
    assert "只有 `origin/main` 包含目标提交且远端仅剩 `main` 才算同步完成" in governance_source
    for adapter in ("qnh", "meituan", "aoxiang", "taobao_flash"):
        assert f"`{adapter}`" in module_map_source
    for task_mode in (
        "channel_attributes_only",
        "qualification_images_only",
        "unavailable_one_pass",
        "copy_history_retry",
    ):
        assert f"`{task_mode}`" in module_map_source
    results["single_main_and_platform_module_contract"] = True
    for marker in (
        "资质图 `qualification_images_only`：`planned`",
        "optimizedInfoList",
        "lackQuaInfo",
        "issueText",
        "categoryAttrValueMap[].options[].selected",
        "cpvGuidePicList",
        "wmPoiId + spuId + quaPicType",
        "provider_task_id",
        "needAudit/submitAudit",
        "saveType=2",
        "auditSource=1",
        "product-governance-operations-workbook-v1",
        "默认 4、上限 6",
        "只能 dry-run 或小样本",
    ):
        assert marker in meituan_source, marker
    results["meituan_unavailable_contract_frozen"] = True
    assert operations_schema["schema_version"] == "product-governance-operations-workbook-v1"
    assert operations_schema["sheets"] == [
        "执行汇总", "SPU清单", "字段级审计", "平台不存在",
        "最终结构复核", "问题与策略回灌", "性能与外部调用统计",
    ]
    assert operations_schema["headers"]["SPU清单"] == [
        "SPUID", "执行前缺失/无效字段", "本次实际填充及最终回读",
    ]
    for script_name in (
        "export_multiplatform_channel_workbook.mjs",
        "validate_multiplatform_channel_workbook.mjs",
    ):
        assert "operations_workbook_schema.json" in (
            SCRIPTS / script_name
        ).read_text(encoding="utf-8")
    results["unified_operations_workbook_schema"] = True
    with tempfile.TemporaryDirectory(prefix="qnh-skill-golden-") as tmp:
        run_dir = Path(tmp)
        manifest = manifest_payload()
        manifest_path = run_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        details_path = run_dir / "details-full-c001-final-10.json"
        details_path.write_text(
            json.dumps(final_details(manifest), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (run_dir / "session_identity.json").write_text(
            json.dumps(
                {
                    "ok": True,
                    "tenant_id": "golden-tenant",
                    "tenant_name": "黄金测试租户",
                    "browser_transport": "chrome_extension_current_tab",
                    "cdp_url": "",
                    "profile_dir": str(run_dir / "profile"),
                    "page_url": "https://qnh.meituan.com/",
                    "page_route": "/unifiedGoods/tenant/spu-list",
                    "run_dir": str(run_dir),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        routed = run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "route",
            "--request-text",
            "只需要把对应SPU的渠道类目属性全部填写完，目标100%填充率",
        )
        route_payload = json.loads(routed.stdout)
        assert route_payload["task_mode"] == "channel_attributes_only"
        results["route_channel_only"] = True

        for request in (
            "使用这个skill，对这个表里的spu进行信息填充，然后给我汇报表",
            "把Excel中的SPU补齐信息",
            "对SPU清单进行信息填充",
        ):
            routed_fill = run(
                PYTHON,
                str(SCRIPTS / "qnh_task_contract.py"),
                "route",
                "--request-text",
                request,
            )
            fill_payload = json.loads(routed_fill.stdout)
            assert fill_payload["task_mode"] == "channel_attributes_only"
            assert fill_payload["reason"] == "spu_table_information_fill_goal"
        results["route_spu_table_information_fill"] = True

        ambiguous = run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "route",
            "--request-text",
            "处理一下这些商品",
        )
        assert json.loads(ambiguous.stdout)["task_mode"] == "ambiguous_mode"
        results["route_ambiguous_fails_closed"] = True

        for request, expected_mode in (
            ("处理当前渠道不可售全部商品并逐条看审核报错", "unavailable_one_pass"),
            ("对不可售表里的SPU进行信息填充", "unavailable_one_pass"),
            ("只处理这些SPU的配料营养图和背签图", "qualification_images_only"),
            ("直接用插件跑商品属性全平台填充并验收", "plugin_attribute_fill"),
            ("把原点搬品助手历史记录里失败的36个商品重新新增到主档", "copy_history_retry"),
        ):
            routed_mode = run(
                PYTHON,
                str(SCRIPTS / "qnh_task_contract.py"),
                "route",
                "--request-text",
                request,
            )
            assert json.loads(routed_mode.stdout)["task_mode"] == expected_mode
        results["route_all_modes"] = True

        qualification_case = run_dir / "qualification-unified-workbook"
        qualification_case.mkdir()
        fixture_documents = {
            "initial-manifest.json": {
                "products": [{"spu_id": "fixture-qualification-spu", "title": "资质图样例", "issue_text": ["缺少背签图"]}]
            },
            "initial-details.json": {"products": [{"spu_id": "fixture-qualification-spu", "detail": {}}]},
            "final-manifest.json": {"products": []},
            "final-details.json": {"products": [{"spu_id": "fixture-qualification-spu", "detail": {}}]},
            "planning-index.json": {"rows": [{"spu_id": "fixture-qualification-spu", "status": "ready"}]},
        }
        for filename, document in fixture_documents.items():
            qualification_case.joinpath(filename).write_text(
                json.dumps(document, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        qualification_output = qualification_case / "qualification-report"
        run(
            PYTHON,
            str(SCRIPTS / "export_ledger.py"),
            "--run-dir", str(qualification_case),
            "--initial-manifest", str(qualification_case / "initial-manifest.json"),
            "--initial-details", str(qualification_case / "initial-details.json"),
            "--final-manifest", str(qualification_case / "final-manifest.json"),
            "--final-details", str(qualification_case / "final-details.json"),
            "--planning-index", str(qualification_case / "planning-index.json"),
            "--output-prefix", str(qualification_output),
            "--task-mode", "qualification_images_only",
            "--tenant-name", "统一模板测试租户",
        )
        qualification_book = load_workbook(qualification_output.with_suffix(".xlsx"))
        assert qualification_book.sheetnames == operations_schema["sheets"]
        for sheet_name in operations_schema["sheets"]:
            assert [cell.value for cell in qualification_book[sheet_name][1]] == operations_schema["headers"][sheet_name]
        qualification_summary = {
            qualification_book["执行汇总"].cell(row, 1).value: qualification_book["执行汇总"].cell(row, 2).value
            for row in range(2, qualification_book["执行汇总"].max_row + 1)
        }
        assert qualification_summary["任务类型"] == "qualification_images_only"
        results["qualification_workbook_uses_unified_schema"] = True

        run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "create",
            "--run-dir",
            str(run_dir),
            "--source-manifest",
            str(manifest_path),
            "--request-text",
            "只需要把对应SPU的渠道类目属性全部填写完，目标100%填充率",
        )
        contract_path = run_dir / "task-contract.json"
        contract = read_json(contract_path)
        assert all(value == 0 for value in contract["external_call_budgets"].values())
        assert "orchestrate_channel_task" in MODE_ALLOWED_ACTIONS["channel_attributes_only"]
        assert "apply_prepared_barrier_batch" in MODE_ALLOWED_ACTIONS["channel_attributes_only"]
        assert all(
            "apply_prepared_barrier_batch" not in actions
            for mode, actions in MODE_ALLOWED_ACTIONS.items()
            if mode != "channel_attributes_only"
        )
        assert all(
            "orchestrate_channel_task" not in actions
            for mode, actions in MODE_ALLOWED_ACTIONS.items()
            if mode != "channel_attributes_only"
        )
        assert contract["canonical_executors"]["orchestrate_channel_task"][
            "script"
        ] == "scripts/run_channel_attributes_task.py"
        assert "scripts/qnh_extension_receipt.py" in contract["canonical_executors"][
            "session_preflight"
        ]["alternate_scripts"]
        session_path = run_dir / "session_identity.json"
        extension_receipt = run_dir / "chrome-extension-preflight-test.receipt.json"
        extension_receipt.write_text(
            json.dumps(
                {
                    "schema": "qnh-chrome-extension-receipt-v1",
                    "run_dir": str(run_dir),
                    "command": "preflight",
                    "dry_run": False,
                    "outcome": "succeeded",
                    "engine_sha256": hashlib.sha256(
                        (SCRIPTS / "qnh_chrome_extension_engine.mjs").read_bytes()
                    ).hexdigest(),
                    "artifacts": [
                        {
                            "path": str(session_path),
                            "sha256": hashlib.sha256(session_path.read_bytes()).hexdigest(),
                        }
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "session_preflight",
            "--",
            PYTHON,
            str(SCRIPTS / "qnh_extension_receipt.py"),
            "preflight",
            "--receipt",
            str(extension_receipt),
        )
        results["chrome_extension_receipt_guard"] = True
        run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "guard",
            "--contract",
            str(contract_path),
            "--action",
            "orchestrate_channel_task",
            "--script",
            str(SCRIPTS / "run_channel_attributes_task.py"),
        )
        run(PYTHON, str(SCRIPTS / "run_channel_attributes_task.py"), "--help")
        orchestrator_source = (SCRIPTS / "run_channel_attributes_task.py").read_text(
            encoding="utf-8"
        )
        extension_source = (SCRIPTS / "qnh_chrome_extension_engine.mjs").read_text(
            encoding="utf-8"
        )
        assert "chrome-extension-current-tab://scoped" in extension_source
        results["chrome_extension_scoped_identity"] = True
        direct_source = (SCRIPTS / "qnh_direct.mjs").read_text(encoding="utf-8")
        for required in (
            '"--dry-run-count", type=int, default=5',
            '"concurrency_must_be_between_1_and_10"',
            '"QNH_DIRECT_ADAPTIVE_APPROVED": "1"',
            "MAX_MUTATION_WINDOW = 50",
            "MAX_RESOURCE_DEFERRALS = 240",
            "RESOURCE_DEFERRAL_SECONDS = 15",
            "MAX_PREFLIGHT_ATTEMPTS = 3",
            "allowed_exit_codes=(0, 75, 76, 77, 143)",
            '"mutation_window_resource_deferred"',
            '"mutation_window_checkpoint_reused"',
            '"stage_checkpoint_reused"',
            "details_snapshot_complete",
            "recommendation_snapshot_complete",
            "plan_snapshot_complete",
            "run_plan_batches",
            '"--offset"',
            "MAX_RESIDUAL_ROUNDS = 3",
            'raise RuntimeError("dry_run_canary_incomplete")',
            '"completion_gate"',
            '"validate_workbook"',
        ):
            assert required in orchestrator_source
        for required in (
            "before_detail_read",
            "save_request",
            "readback_detail",
            "stage_timings",
            "runtimePeakBrowserWorkerRssBytes",
            "runtimePeakCombinedRssBytes",
            "prewarmQnhWorkerPage",
            "bootstrapQnhWorkerPool",
            "editorPoolBootstrap",
            "resolveInitialRuntimeConcurrency",
            "one_item_editor_warm_canary",
            "runtimeCompletedCount",
            "applyPreparedBarrierBatch",
            "createPreparedSaveBarrier",
        ):
            assert required in direct_source
        run("node", str(SCRIPTS / "test_qnh_batch_resume.mjs"))
        run("node", str(SCRIPTS / "test_qnh_worker_prewarm.mjs"))
        run("node", str(SCRIPTS / "test_qnh_phase_barrier.mjs"))
        results["dry_run_resume_and_worker_prewarm"] = True
        results["continuous_orchestrator_scope_and_timing"] = True

        assert "modified_ns = path.stat().st_mtime_ns" in (
            SCRIPTS / "export_standard_channel_fill_workbook.py"
        ).read_text(encoding="utf-8")
        exporter_source = (
            SCRIPTS / "export_standard_channel_fill_workbook.py"
        ).read_text(encoding="utf-8")
        for required in (
            '"--history-run-dir"',
            "verified_history_spus",
            'glob("full-c*-residual-plans/audit.json")',
            'name.startswith("save-")',
            'glob("channel-plans/audit.json")',
            'glob("details-final*.json")',
            "历史 run-dir 租户不一致",
        ):
            assert required in exporter_source
        run(PYTHON, str(SCRIPTS / "test_chrome_extension_artifacts.py"))
        results["chrome_extension_artifact_conventions"] = True
        planner_source = (
            SCRIPTS / "build_channel_contract_v2_plans.py"
        ).read_text(encoding="utf-8")
        assert "渠道 200 缺少本次任务的无品牌精确编码查询回执" in planner_source

        sample_source = run_dir / "sample-source.json"
        sample_source.write_text(
            json.dumps(
                {
                    "products": [
                        {"spu_id": f"sample-{index:02d}", "title": f"样例{index}"}
                        for index in range(30)
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        sample_exclude = run_dir / "sample-exclude.json"
        sample_exclude.write_text(
            json.dumps(
                {"products": [{"spu_id": f"sample-{index:02d}"} for index in range(10)]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        sample_output = run_dir / "sample-output.json"
        run(
            PYTHON,
            str(SCRIPTS / "select_spu_sample.py"),
            "--input",
            str(sample_source),
            "--output",
            str(sample_output),
            "--count",
            "20",
            "--exclude-manifest",
            str(sample_exclude),
        )
        sample_ids = [item["spu_id"] for item in read_json(sample_output)["products"]]
        assert sample_ids == [f"sample-{index:02d}" for index in range(10, 30)]
        results["deterministic_20_spu_sample"] = True

        blocked = run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "guard",
            "--contract",
            str(contract_path),
            "--action",
            "scan_media",
            "--script",
            str(SCRIPTS / "scan_media.py"),
            "--units",
            "1",
            expected=2,
        )
        assert "scope_violation" in blocked.stderr
        results["ocr_media_scope_guard"] = True

        altered = copy.deepcopy(contract)
        altered["skill_file_sha256"]["SKILL.md"] = "0" * 64
        altered["contract_fingerprint_sha256"] = contract_digest(altered)
        altered_path = run_dir / "altered-contract.json"
        altered_path.write_text(
            json.dumps(altered, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        mismatch = run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "verify",
            "--contract",
            str(altered_path),
            expected=2,
        )
        assert "skill_fingerprint_mismatch" in mismatch.stderr
        results["skill_hash_guard"] = True

        record_fixture_actions(contract)
        validation_path = run_dir / "channel-contract-validation.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "validate_channel_contracts",
            "--",
            PYTHON,
            str(SCRIPTS / "validate_channel_contracts.py"),
            "--details",
            str(details_path),
            "--output",
            str(validation_path),
        )

        date_prefix = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%m%d")
        workbook_path = run_dir / f"{date_prefix}黄金测试租户10.xlsx"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "export_workbook",
            "--",
            PYTHON,
            str(SCRIPTS / "export_standard_channel_fill_workbook.py"),
            "--run-dir",
            str(run_dir),
            "--manifest",
            str(manifest_path),
            "--tenant-name",
            "黄金测试租户",
            "--output",
            str(workbook_path),
            "--task-contract",
            str(contract_path),
            "--validation",
            str(validation_path),
        )
        summary_path = workbook_path.with_suffix(".summary.json")
        coverage_path = workbook_path.with_suffix(".coverage.json")

        workbook_validation_path = run_dir / "workbook-validation.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "validate_workbook",
            "--",
            PYTHON,
            str(SCRIPTS / "validate_standard_channel_fill_workbook.py"),
            "--contract",
            str(contract_path),
            "--manifest",
            str(manifest_path),
            "--workbook",
            str(workbook_path),
            "--summary",
            str(summary_path),
            "--output",
            str(workbook_validation_path),
        )

        completion_path = run_dir / "task-completion-gate.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "completion_gate",
            "--",
            PYTHON,
            str(SCRIPTS / "qnh_completion_gate.py"),
            "--contract",
            str(contract_path),
            "--manifest",
            str(manifest_path),
            "--validation",
            str(validation_path),
            "--workbook",
            str(workbook_path),
            "--summary",
            str(summary_path),
            "--coverage",
            str(coverage_path),
            "--workbook-validation",
            str(workbook_validation_path),
            "--output",
            str(completion_path),
        )
        assert read_json(completion_path)["complete"] is True
        results["golden_10_spu_completion"] = True

        handoff_path = run_dir / "workbook-handoff.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(contract_path),
            "--action",
            "handoff_workbook",
            "--",
            PYTHON,
            str(SCRIPTS / "qnh_workbook_handoff_gate.py"),
            "--contract",
            str(contract_path),
            "--workbook",
            str(workbook_path),
            "--summary",
            str(summary_path),
            "--completion",
            str(completion_path),
            "--workbook-validation",
            str(workbook_validation_path),
            "--output",
            str(handoff_path),
        )
        assert read_json(handoff_path)["ready"] is True
        results["execution_workbook_handoff_gate"] = True

        wrong_workbook = run_dir / f"{date_prefix}错误来源租户10.xlsx"
        wrong_workbook.write_bytes(workbook_path.read_bytes())
        wrong_handoff = run(
            PYTHON,
            str(SCRIPTS / "qnh_workbook_handoff_gate.py"),
            "--contract",
            str(contract_path),
            "--workbook",
            str(wrong_workbook),
            "--summary",
            str(summary_path),
            "--completion",
            str(completion_path),
            "--workbook-validation",
            str(workbook_validation_path),
            "--output",
            str(run_dir / "wrong-workbook-handoff.json"),
            expected=1,
        )
        assert "summary_workbook_path_mismatch" in wrong_handoff.stdout
        results["wrong_run_workbook_handoff_rejected"] = True

        validation_contract = copy.deepcopy(contract)
        validation_contract["task_role"] = "validation_only"
        validation_contract["contract_fingerprint_sha256"] = contract_digest(
            validation_contract
        )
        validation_contract_path = run_dir / "validation-only-contract.json"
        validation_contract_path.write_text(
            json.dumps(validation_contract, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        validation_handoff = run(
            PYTHON,
            str(SCRIPTS / "qnh_workbook_handoff_gate.py"),
            "--contract",
            str(validation_contract_path),
            "--workbook",
            str(workbook_path),
            "--summary",
            str(summary_path),
            "--completion",
            str(completion_path),
            "--workbook-validation",
            str(workbook_validation_path),
            "--output",
            str(run_dir / "validation-only-handoff.json"),
            expected=1,
        )
        assert "validation_only_workbook_not_delivery_eligible" in validation_handoff.stdout
        results["validation_only_workbook_handoff_rejected"] = True

        bad_workbook = run_dir / f"{date_prefix}黄金坏表租户10.xlsx"
        workbook = load_workbook(workbook_path)
        workbook["字段级审计"].title = "字段修改明细"
        workbook.save(bad_workbook)
        bad_schema = run(
            PYTHON,
            str(SCRIPTS / "validate_standard_channel_fill_workbook.py"),
            "--contract",
            str(contract_path),
            "--manifest",
            str(manifest_path),
            "--workbook",
            str(bad_workbook),
            "--summary",
            str(summary_path),
            expected=1,
        )
        assert "sheet_order_mismatch" in bad_schema.stdout
        results["excel_schema_drift_guard"] = True

        bad_validation = run_dir / "bad-validation.json"
        payload = read_json(validation_path)
        payload["products_with_issues"] = 1
        payload["issue_count"] = 1
        bad_validation.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        bad_export = run(
            PYTHON,
            str(SCRIPTS / "export_standard_channel_fill_workbook.py"),
            "--run-dir",
            str(run_dir),
            "--manifest",
            str(manifest_path),
            "--tenant-name",
            "黄金测试租户",
            "--output",
            str(run_dir / f"{date_prefix}残差测试租户10.xlsx"),
            "--task-contract",
            str(contract_path),
            "--validation",
            str(bad_validation),
            expected=1,
        )
        assert "禁止导出100%工作簿" in bad_export.stderr
        results["residual_issue_completion_guard"] = True

        source_case = run_dir / "source-workbook-case"
        source_case.mkdir()
        source_manifest = source_case / "manifest.json"
        source_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        source_details = source_case / "details-full-c001-final-10.json"
        source_details.write_text(
            json.dumps(final_details(manifest), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        source_audit_dir = source_case / "full-c001-plans"
        source_audit_dir.mkdir()
        source_audit_dir.joinpath("audit.json").write_text(
            json.dumps(
                {
                    "fields": [
                        {
                            "spu_id": manifest["products"][0]["spu_id"],
                            "channel_id": 100,
                            "attr_id": "packing",
                            "attr_name": "包装方式",
                            "old_value": "",
                            "new_value": "独立装",
                            "source": "current_category_safe_default",
                        }
                    ]
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        source_xlsx = source_case / "用户源表.xlsx"
        source_book = Workbook()
        source_sheet = source_book.active
        source_sheet.title = "商品清单"
        source_sheet.append(["SPUID", "旧B列", "旧C列"])
        for index, item in enumerate(manifest["products"], start=1):
            source_sheet.append(
                [
                    item["spu_id"],
                    "历史执行前记录" if index == 1 else "",
                    "历史已填字段记录" if index == 1 else "",
                ]
            )
        relation_sheet = source_book.create_sheet("销售规格信息")
        relation_sheet.append(["组合关系", "保留值"])
        relation_sheet.append(["样例", "不得丢失"])
        source_book.save(source_xlsx)

        history_case = run_dir / "verified-result-only-history"
        history_case.mkdir()
        source_case.joinpath("session_identity.json").write_text(
            json.dumps({"tenant_id": "source-tenant"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        history_case.joinpath("session_identity.json").write_text(
            json.dumps({"tenant_id": "source-tenant"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        history_case.joinpath("legacy-save-result.json").write_text(
            json.dumps(
                {
                    "spu_id": manifest["products"][1]["spu_id"],
                    "tenant_id": "source-tenant",
                    "verified": True,
                    "before": {"title": "历史结果回退样例"},
                    "requested_changes": [
                        {
                            "field_path": "channel.100.包装方式",
                            "attr_id": "packing",
                            "old_value": [],
                            "new_value": ["独立装"],
                            "source": "verified_result_fallback_fixture",
                        }
                    ],
                    "verification": [
                        {
                            "field_path": "channel.100.包装方式",
                            "expected": ["独立装"],
                            "actual": ["独立装"],
                            "verified": True,
                        }
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        run(
            PYTHON,
            str(SCRIPTS / "qnh_task_contract.py"),
            "create",
            "--run-dir",
            str(source_case),
            "--source-manifest",
            str(source_manifest),
            "--source-xlsx",
            str(source_xlsx),
            "--request-text",
            "只需要把对应SPU的渠道类目属性全部填写完，目标100%填充率",
        )
        source_contract_path = source_case / "task-contract.json"
        source_contract = read_json(source_contract_path)
        record_fixture_actions(source_contract)
        source_validation = source_case / "channel-contract-validation.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(source_contract_path),
            "--action",
            "validate_channel_contracts",
            "--",
            PYTHON,
            str(SCRIPTS / "validate_channel_contracts.py"),
            "--details",
            str(source_details),
            "--output",
            str(source_validation),
        )
        source_output = source_case / f"{date_prefix}源表测试租户10.xlsx"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(source_contract_path),
            "--action",
            "export_workbook",
            "--",
            PYTHON,
            str(SCRIPTS / "export_standard_channel_fill_workbook.py"),
            "--run-dir",
            str(source_case),
            "--manifest",
            str(source_manifest),
            "--tenant-name",
            "源表测试租户",
            "--output",
            str(source_output),
            "--task-contract",
            str(source_contract_path),
            "--validation",
            str(source_validation),
            "--source-xlsx",
            str(source_xlsx),
            "--history-run-dir",
            str(history_case),
        )
        source_schema = source_case / "workbook-validation.json"
        run(
            PYTHON,
            str(SCRIPTS / "run_task_action.py"),
            "--contract",
            str(source_contract_path),
            "--action",
            "validate_workbook",
            "--",
            PYTHON,
            str(SCRIPTS / "validate_standard_channel_fill_workbook.py"),
            "--contract",
            str(source_contract_path),
            "--manifest",
            str(source_manifest),
            "--workbook",
            str(source_output),
            "--summary",
            str(source_output.with_suffix(".summary.json")),
            "--source-xlsx",
            str(source_xlsx),
            "--output",
            str(source_schema),
        )
        source_result = load_workbook(source_output)
        assert source_result.sheetnames == [
            "执行汇总", "SPU清单", "字段级审计", "平台不存在",
            "最终结构复核", "问题与策略回灌", "性能与外部调用统计",
        ]
        assert "销售规格信息" not in source_result.sheetnames
        assert "历史执行前记录" in source_result["SPU清单"]["B2"].value
        assert "字段名=包装方式" in source_result["SPU清单"]["B2"].value
        assert "历史已填字段记录" in source_result["SPU清单"]["C2"].value
        assert "最终值=独立装" in source_result["SPU清单"]["C2"].value
        assert "字段名=包装方式" in source_result["SPU清单"]["B3"].value
        assert "最终值=独立装" in source_result["SPU清单"]["C3"].value
        assert source_result["字段级审计"].max_row == 3
        results["verified_result_history_fallback"] = True
        results["unified_workbook_topology_and_history_preserved"] = True

    output = {"passed": all(results.values()), "checks": results}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
