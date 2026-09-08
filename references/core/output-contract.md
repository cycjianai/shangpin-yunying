# 统一输出内容合同

机器唯一真源是 [`scripts/operations_workbook_schema.json`](../../scripts/operations_workbook_schema.json)。本合同约束
单元格内容；[Excel Schema](../excel-schema-v1.md) 约束工作表、表头和指标顺序。平台和任务模块只能提供数据，不能拥有
自己的表格格式。

## 固定行模型

所有商品操作都先映射为同一字段级事件：

```text
SPU编码、商品名称、渠道、字段ID、字段名、执行前、计划值、最终回读值、结果、来源策略
```

- 一行只表达一个可独立回读的字段、SKU 字段、图片槽位、状态或身份映射。
- 多字段完整对象保存仍拆成多条审计事件，但共享同一次 mutation/readback 证据。
- 多 SKU 商品每个 SKU 字段各占一行；SKU 身份写入规范化 `字段ID`，不得只记录 SPU 汇总。
- 没有修改的商品进入 `SPU清单`，写明执行前已满足、最终独立回读通过；不要伪造字段变化行。
- 平台不存在的商品同时保留在 `SPU清单` 与 `平台不存在`，不计入平台现存完成率分母。

## 字段 ID 命名空间

只允许下列稳定前缀；动态平台字段或对象 ID 放在后缀中，ID 原文按文本保留：

| 业务对象 | `字段ID` 规范 | `字段名` 示例 |
|---|---|---|
| 渠道属性 | `channel_attribute.<channel>.<field_id>` | 包装方式 |
| 商品主档 | `product.<field>` | 商品名称 |
| SKU 主档 | `sku.<sku_id>.<field>` | 店内码 |
| 价格 | `price.<sku_id>.<original|activity|target|effective>` | 最终有效价 |
| 活动 | `activity.<activity_id>.<status|membership|price>` | 活动状态 |
| 店内分类 | `category.store_path` | 店内分类完整路径 |
| 平台类目 | `category.platform_path` | 平台类目完整路径 |
| 媒体 | `media.<main|detail>.<sequence>` | 主图 01 |
| 资质/专项图 | `qualification.<slot_id>.<sequence>` | 背签 01 |
| 审核与集合 | `review.<reason|scope_state|rescan_state>` | 审核退出状态 |
| 搬品映射 | `copy_mapping.<target_spu_id|target_sku_id|target_barcode>` | 目标 SKU ID |
| 门店迁移 | `migration.<target_spu_id|target_sku_id|asset|field_group>` | 目标 SPU ID |
| 身份证据 | `identity.<platform|store|spu|sku|activity>` | 平台 SKU ID |

`<channel>` 固定使用 `meituan`、`eleme`、`qnh`、`aoxiang`、`taobao_flash` 或平台当前返回且已登记的稳定
channel code；不得使用随语言变化的临时中文近义词作为 ID。

平台有稳定字段/槽位 ID 时必须原文保留为文本。只有旧制品确实只提供中文字段名而没有稳定 ID 时，才允许共享 helper
对 NFKC 后原文生成固定 SHA-256 短后缀；中文原名继续完整写在 `字段名`，各平台不得自行发明拼音或另一种哈希规则。

## 固定值词汇

`执行平台` 固定为：`牵牛花`、`美团`、`饿了么`、`翱象`、`淘宝闪购`。

`任务类型` 固定使用机器 ID：

- `channel_attributes_only`
- `unavailable_one_pass`
- `qualification_images_only`
- `plugin_attribute_fill`
- `copy_history_retry`
- `headquarters_price_fill`
- `price_push`
- `product_editing`
- `medical_device_store_migration`

`结果` 只能使用统一业务终态：

- `verified_complete`
- `verified_no_change`
- `missing_on_platform`
- `waiting_platform_review`
- `manual_evidence_required`
- `pending_verify`
- `blocked`
- `failed`

阶段值如 `accepted`、`uploaded`、`provider_ready`、`readback_verified` 只能进入事件证据或摘要，不能写成最终结果。
`最终回读通过项数` 统计 `verified_complete`、`verified_no_change` 和 `waiting_platform_review` 的字段物化行；其中
`waiting_platform_review` 只代表独立回读通过，仍计入最终问题而不计入最终合同通过商品。

`来源策略` 只能使用机器 Schema 中的 canonical ID。需要保留平台原始细节时写进低敏事件证据，不在该列发明近义词。

## 值的统一显示

- `null`、空字符串和空列表在“执行前”写 `(空值)`；确实不适用写 `不适用`，两者不得混用。
- SPU、SKU、条码、店内码、活动 ID、证书编号和其他标识一律为文本；不得出现科学计数法或自动去掉前导零。
- 金额统一写 `CNY 12.34`；策略与比较使用 `Decimal`，不能用二进制浮点决定价格路由。
- 数值和单位用单个空格，如 `500 ml`、`30 day`；平台原始单位另存证据，不混入规范化比较值。
- 布尔值固定为 `是`、`否`；未知不是 `否`，写 `待确认` 并使用非成功终态。
- 多值写紧凑 JSON 数组并保留业务顺序，如 `["url-1","url-2"]`；不能用逗号拼接造成歧义。
- 时间使用带时区 RFC 3339；交付日期和文件名按 `Asia/Shanghai`。
- 平台 code 与消息统一为 `reason_code｜低敏消息`；没有 code 时使用稳定本地原因码。

## 各任务如何进入同一表

- 总部零售价补齐：`sku.<sku_id>.headquarters_retail_price`，来源策略 `source_store_verified_archive`；只代表主档建议价，不代表门店或渠道终端有效价。
- 调价：每个 SKU 分别记录写前原价/活动价、目标价、回读有效价和活动状态。
- 商品编辑：每个 SKU 或 SPU 字段分别记录，完整对象保存不合并成“编辑成功”一行。
- 医疗器械迁移：源 SPU 为 `SPUID`；目标 ID、分类、属性、销售、店内码和各媒体角色分别审计。
- 资质图：槽位 ID 进入 `字段ID`，槽位显示名进入 `字段名`，URL 只写低敏标识或内容哈希。
- 不可售：整改字段与审核集合复扫分开成行，物化成功不能冒充审核退出。
- 搬品重试：旧 SPU 为 `SPUID`；目标 SPU、目标 SKU、目标条码分别三行或按多 SKU 展开，不交专用九列表。

## 机器门

新平台或任务应先生成 canonical operations payload，再使用共享导出器：

```bash
python3 scripts/core/export_operations_workbook.py \
  --input "$OPERATIONS_PAYLOAD" --output "$OUTPUT_XLSX"

python3 scripts/core/validate_operations_workbook.py \
  --workbook "$OUTPUT_XLSX" --output "$VALIDATION_JSON"
```

平台专用 exporter 只可作为兼容入口，仍须读取同一个 JSON Schema 并通过共享 validator。Schema、字段 ID、固定词汇、
SPU 集合、审计对账或值格式任一失败时不得交付。
