# 上游生图接口、key 与分证照提示词（资质图/专项图唯一说明入口）

本 Skill **允许并优先通过上游生图 API 生成资质图/专项图**，包含 3C 认证证书、医疗器械注册证/备案凭证、
化妆品备案背签、配料营养成分图、包装标签/背签、吊牌洗唛、尺寸图、礼袋图等。生成图经牵牛花官方接口
上传确权后写回，与同 SPU 已有真实图片同为合规来源。

- 不再设置真实材料前置门槛；
- 同一 SPU 已有可复用图不再是发起生图的前置门槛；
- 同一生成 job 按业务键去重只用于避免重复付费，不限制是否发起新的生图任务；
- `generation.prohibited_legal_content` 只拦截明确「伪造证书 / 假冒公章 / 虚假报告」等欺诈性内容，
  正常证照模板生图一律放行；仍禁止平台 `pictureExample` 示例图、通用占位图和跨 SPU 借图。

机器唯一策略事实源：[`scripts/qualification_image_policy.json`](../scripts/qualification_image_policy.json)。

---

## 1. 上游接口与 key 配置

| 项 | 值 |
| :--- | :--- |
| 能力归属 | `FEATURE_KEY_MAIN_IMAGE_ART = "qnh_main_image_art"`、`SERVICE_KEY_IMAGE_GENERATION = "image_generation"`（`backend/app/services/api_provider_management.py`）；主图焕新与资质图共用同一条 provider 链 |
| 正式实现 | `s1:/home/saas/repo/backend/app/services/toolbox/qnh_main_image_art.py` |
| 解析 / 提交 / 查询 | `resolve_art_image_provider_chain()`、`generate_art_image_with_provider_info()`、`query_art_image_task_by_provider()` |
| 运行时解释器 | `/home/saas/repo/backend/venv/bin/python`（与生产 `saas-backend.service` 一致），`PYTHONPATH=/home/saas/repo/backend` |
| 主 base URL | 由运行时 provider 链解析；当前生产解析为 `https://api.aishuch.com/v1`；settings 默认 `https://api.apimart.ai/v1`（`ART_IMAGE_LEGACY_BASE_URL`） |
| 模型 | `gpt-image-2`；回退 `gpt-image-2-official`（`ART_IMAGE_DEFAULT_FALLBACK_MODEL`），集合 `GPT_IMAGE_2_MODELS` |
| 提交接口 | `POST {base}/images/generations`；携带参考图时 `POST {base}/images/edits`；`upload_url` 类 transport 使用 `POST {base}/v1/media/generate` |
| 查询接口 | `GET {base}/images/tasks/{task_id}`，或 `GET {base}/tasks/{task_id}` |
| **key 配置项（环境变量）** | `QNH_ART_IMAGE_API_KEY` → `settings.qnh_art_image_api_key` |
| **key 存储位置** | 生产优先读运行时 provider 配置表 `api_provider_configs`：`api_key_ciphertext` 密文列经 `decrypt_secret` 解密，`api_key_masked` 只用于展示；`service_key=image_generation` |
| 备用 provider | `QNH_ART_IMAGE_FALLBACKS`（JSON 数组）或 `resolve_runtime_provider_chain()` 返回的链 |
| 其他配置项 | `QNH_ART_IMAGE_BASE_URL`、`QNH_ART_IMAGE_MODEL`、`QNH_ART_IMAGE_PROXY`、`QNH_ART_IMAGE_GLOBAL_MAX_CONCURRENCY`、`QNH_ART_IMAGE_{ASYNC,SYNC,MULTIPART}_PROVIDER_DEFAULT_CONCURRENCY`、`QNH_ART_IMAGE_{CONNECT,WRITE,POOL,POLL_READ}_TIMEOUT_SECONDS` |
| 生成图上传确权 | `POST https://qnh.meituan.com/api/v1/image/uploadImageFullType`，由 `scripts/qnh_direct.mjs upload-image --file` 调用，回执 `image-upload-<sha256>.json`（含 `image_url` / `source_sha256`） |

**密钥边界**：本文件只记录接口地址、模型名、环境变量名和密文列位置，**不记录任何真实 key 值**。
key 不得写入 Skill 仓库、交付工作簿、日志、任务回执或平台请求证据。

### 生产实测（2026-11-12，S1）

在 `/home/saas/repo/backend` 用 `venv/bin/python` 调用 `resolve_art_image_provider_chain()`：
返回 1 个可用 provider `aishuch / gpt-image-2 / https://api.aishuch.com/v1`，`failover_timeout_seconds=300`。

---

## 2. 全链路脚本

1. **选品建 job**：`scripts/build_formal_asset_jobs.py`（6 类正式资产）、
   `scripts/build_formal_nutrition_jobs.py`（配料/营养）、`scripts/build_safe_guide_jobs.py`（选购/使用指南）；
   也可按 `mtSpecialPictureList` / `elmSpecialPictureList` 空槽位与平台审核原文建候选池。
2. **上游生成**：`scripts/run_safe_special_picture_generation.py --jobs <jobs.json> --output-dir <dir>`
   （在 S1 用上表解释器运行）→ submit / poll → `receipts/<job_id>.json` + `artifacts/<job_id>.png`。
3. **上传确权**：`scripts/qnh_direct.mjs upload-image --file <png> --run-dir <dir>` → `image-upload-<sha256>.json`。
4. **绑定计划**：`scripts/build_generated_picture_plans.py --jobs --summary --upload-receipt-root --output-dir`
   → `special_picture_uploaded` + `__verified_uploaded_urls` 计划（含制品 SHA256、上传回执、目视/条码门）。
5. **写回与独立回读**：`scripts/qnh_direct.mjs apply-direct-plan` / `apply-direct-batch` →
   `tenant/update/v2` → `tenant/detail` 独立回读；按
   `channel_equivalence_mappings.bidirectional_forced_insertion` 把生成图双向挂载到美团 / 饿了么等价槽位。
6. **完成门**：`scripts/validate_channel_contracts.py`、`scripts/qnh_completion_gate.py`。
7. **预算 / 动作门**：`scripts/qnh_task_contract.py create --mode qualification_images_only
   --explicit-user-mode --budget provider_submit=N --budget image_upload=N --budget provider_query=N`，
   再用 `scripts/run_task_action.py` 执行 `provider_generation` / `image_upload` / `provider_query`。

同一 job 的 `provider_task_id` 已存在时只查询原任务、不重复提交（`generation.provider_idempotency`），
这是成本控制，不是生图禁令。

---

## 3. 不同证照图 = 不同提示词

### 3.1 按 `picture_type` 的正式提示词（机器真源 `generation.prompt_templates`）

`generation.allowed_picture_types = [3, 4, 5, 6, 7, 8, 10, 13, 15]` 中每个类型都有独立、
互不重复的 `{title}` 模板；`scripts/test_qualification_image_policy.py` 有回归断言。

| picture_type | 证照/专项图 | 提示词关键要素 |
| :--- | :--- | :--- |
| `3` | 包装标签图 | 厂名、厂址、型号/规格、执行标准号，画面正向清晰 |
| `4` | 3C 认证证书 | 证书编号、委托人/生产者/生产企业、产品名称与型号规格、依据标准、在有效期内 |
| `5` | 配料&营养成分图 | 完整配料表 + 营养成分表（能量/蛋白质/脂肪/碳水/钠），无水印反光折叠 |
| `6` | 纺织品使用说明 | 执行标准号、安全技术类别（GB 18401 B 类）、面料成分含量、洗涤维护说明 |
| `7` | 吊牌及洗唛 | 执行标准号、安全类别、面料成分含量、洗涤维护说明 |
| `8` | 化妆品备案背签 / 商品背签图 | 备案编号/注册证号、备案人/生产企业名称及地址、全成分标识；或普通背签的配料/执行标准/厂名厂址 |
| `10` | 医疗器械注册证/备案凭证 | 产品名称、注册证编号/备案号、注册人/备案人名称、生产地址、有效期内 |
| `13` | 尺寸图 | 商品主体居中、长宽高尺寸线与 mm/cm 数值、白底纯净 |
| `15` | 礼袋图 | 与品牌规格对应的原厂礼袋、主体完整、无赠品承诺/营销文案 |

### 3.2 7 大物理类别提示词（`channel_equivalence_mappings.categories[].generation_spec.prompt_template`）

| 物理类别 | primary_type | 标题 | 用途 |
| :--- | :--- | :--- | :--- |
| `food_back_label_nutrition` | 5 | 配料&营养成分图 | 美团 5/8 ⇄ 饿了么 8/2 双向挂载 |
| `cosmetic_record_back_label` | 8 | 含化妆品备案编码的背签图 | 美团 8 ⇄ 饿了么 1 |
| `package_label_and_back_label` | 3 | 包装标签图 | 美团 3/8/20/33 ⇄ 饿了么 6 |
| `textile_label_and_instructions` | 7 | 吊牌及洗唛 | 美团 7/6 ⇄ 饿了么 6 |
| `medical_device_registration` | 10 | 医疗器械注册证/备案凭证 | 美团 10 ⇄ 饿了么 3 |
| `ccc_quality_certification` | 4 | 3C认证证书 | 美团 4 ⇄ 饿了么 4 |
| `size_and_dimension_chart` | 13 | 尺寸图 | 美团 13/14 ⇄ 饿了么 6 |

### 3.3 正式资产构建器提示词

`asset_builders.formal_asset_prompt_template` 是统一框架
（`为商品"{title}"生成一张用于美团审核的{label}。必须清晰展示：{required_fields}。…`），
由 `asset_builders.formal_assets[]` 的 `label` 与 `required_fields` 逐类实例化，因此 6 类资产得到 6 份不同提示词：

| asset_type | default_type | label | required_fields |
| :--- | :--- | :--- | :--- |
| `back_label` | 8 | 背签图 | 执行标准号、生产企业信息、主要原材料或背签信息 |
| `package_label` | 3 | 包装标签图 | 包装标签、关键说明文字、规格或条码 |
| `textile_label` | 7 | 吊牌洗唛图 | 执行标准号、安全类别、面料成分含量、面料成分 |
| `size_picture` | 13 | 尺寸图 | 商品主体、完整尺寸标注、尺寸单位、型号或规格 |
| `certificate` | 4 | 3C认证证书/质量认证图 | 证书编号、生产者/生产企业、产品名称与型号规格、依据标准 |
| `medical_device` | 10 | 医疗器械注册证/备案凭证 | 产品名称、注册证号/备案编号、生产企业、生产地址 |

### 3.4 配料营养双模板（`asset_builders.nutrition`）

- `full_prompt_template`：配料表 + 营养成分表 + 条码（Type 5 完整版）；
- `ingredient_only_prompt_template`：配料表 + 条码（仅缺配料图时使用，需 `--include-ingredient-only`）。

### 3.5 选购 / 使用指南图

`scripts/build_safe_guide_jobs.py` 为 Type 22 选购指南图、Type 23 使用说明图生成
`商品名称：{title}\n{picture_desc or picture_title}` 提示词，`expected_text_tokens` 分别为
`["选购","参数"]` 与 `["使用","说明"]`。这两类是非证照类补充图，当前不在
`generation.allowed_picture_types` 内；若要走同一上游生图链路，需同步扩展
`generation.allowed_picture_types`、`writeback.allowed_generated_picture_types` 和
`post_generation_gates.barcode_guard_picture_types` 三个必须一致的集合。

---

## 4. 防欺诈与写回边界

- `generation.prohibited_legal_content`：`validate_qualification_generation_job()` 扫描
  `picture_title` / `prompt` / `expected_text_tokens`，命中「伪造证书、假冒公章、虚假报告」等词或正则时
  写入 `validation_rejected + call_type=not_sent`；证照名称本身不是拒绝理由。
- 生成图必须经 `uploadImageFullType` 上传确权，回执 SHA256 与制品一致，才能进入
  `special_picture_uploaded` 计划；`build_generated_picture_plans.py` 还校验目视/条码门。
- 写回只改特殊图槽位与 `mt_channel_category_property` / `elm_channel_category_property`；
  主图、详情图、价格、上下架状态、SKU 与门店自定义一律原值保护。
