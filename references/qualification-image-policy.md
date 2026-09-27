# 资质图统一策略

资质图限制的唯一机器事实源是
[`scripts/qualification_image_policy.json`](../scripts/qualification_image_policy.json)。禁止在生成器、任务构建器、
写回器或任务合同里另建一份类型、关键词、预算、批量、并发或槽位限制。说明文档只解释字段，不复制具体取值。

## 在哪里增删

- `scope`：平台与任务模式能力状态。
- `external_call_default_budgets`：合同创建时的外部调用默认预算；预算为 0 时必须由本次合同显式授权。
- `generation`：批量、并发、job 必填项、允许生图类型、虚假欺诈内容禁用词/正则和 provider 幂等规则（严格单次生成、跨渠道双向复用）。
- `asset_builders`：正式资产类型、审核命中词、排除词、槽位、pictureType、必查文字，以及配料营养/GTIN/3C/医疗器械门。
- `authentic_evidence`：真实材料下载与 OCR 的大小、超时、并发和候选上限。
- `candidate_selection`：专项图候选审计关键词和候选抓取并发。
- `post_generation_gates`：制品、上传回执、SHA256、目视和条码门。
- `writeback`：允许写回的生成类型、上传回执、旧值一致性、去重、实时槽位数量和缺失槽位合成规则。
- `channel_equivalence_mappings`：48 种特殊图槽位归并为 7 大物理实质类，定义美团（100）与饿了么（200）的双向等价映射、单次生成与跨渠道强制复用规则。

新增一个生成图型时，同时更新 `generation.allowed_picture_types`、
`writeback.allowed_generated_picture_types`，并按需要增加 `asset_builders` 与 `writeback.synthetic_missing_slots`。
删除图型时执行相反操作。两个允许类型集合必须完全一致；构建器类型必须是其子集，否则策略加载即失败。

生成允许类型集合包含 `[3, 4, 5, 6, 7, 8, 10, 13, 15]`，支持 3C认证证书 (4) 与医疗器械注册证/备案凭证 (10) 的正规模板图生成。
虚假伪造或欺诈性内容（如明确伪造证书、假冒公章、虚假报告等）禁止进入生成链路。
严格遵守同一商品同一物理类型严禁多次生成，按 `(tenant_scope, spu_id, physical_category)` 保持唯一幂等并跨渠道双向强制复用挂载。

## 修改后的发布门

每次策略变更都必须升级 Skill 版本并新增或更新回归样例，然后运行：

```bash
python3 quick_validate.py
npm test
git diff --check
```

新策略是合同指纹的一部分。运行中的合同遇到策略文件变化会返回 `skill_fingerprint_mismatch`；必须新建 run-dir，
不能把新旧策略混在同一次平台写入中。
