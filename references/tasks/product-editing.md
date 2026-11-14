# 任务分支：商品信息与店内码编辑

- 美团（`runtime_guided`）：完整读取 [美团商品编辑、快照新增与整店清空](../meituan-product-editing.md)。涵盖单品修改、全量快照/货盘批量新增复制（`batchSaveHqTags` + `uniSave` + 无条码 `allowUpcEmpty: "true"` + 三级自愈降级）以及已授权门店整店商品与两级店内分类树清空（`webpackChunkpackage_list` 下 `batchDeleteWithSpu` + 先二级子分类后一级父分类逆序 `_R(type: 2)`）。
- 翱象（`implemented`）：完整读取 [翱象实战防坑指南](../platforms/aoxiang-playbook-and-pitfalls.md)，使用 `scripts/aoxiang_high_concurrency_product_engine.mjs` 执行，强制通过多规格四道防降级硬门禁。
- 牵牛花（门店商品与主档商品维护红线）：若涉及牵牛花商品名称、主图或分类维护，必须严格区分**总部主档**与**门店自定义商品（`customizedNameFlag: true` / `customizedPicFlag: true`）**——严禁将门店自定义强制改为“跟随总部”，也严禁在主档用 `coverToStore: 1` 级联覆盖自定义门店的名称或图片；有自定义的门店必须单独调用 `/qnh-gw3/api/product/store/update` 按该门店当前自定义信息维护。
- 饿了么等其他平台：未注册独立 writer，不得套用美团或翱象保存链。

先生成只读匹配账本；名称只能辅助识别，最终按稳定 SPU/SKU、旧店内码/条码和明确规格唯一匹配。保存若为完整 SPU：

1. 执行时重新读取最新完整对象。
2. 在最新 SKU 列表按稳定 SKU ID 找目标行，只修改用户授权字段。
3. 同一 SPU 的多个来源行合并成一次保存；同一 SPU 单写者。
4. 运行当前页面正式预校验、影响检查和实际保存能力。
5. 丢弃提交对象，重新读取详情并逐 SKU 回读；`403/429` 或列表异常立即暂停新任务领取。

## 统一输出映射

- SPU 字段：`product.name`、`product.description` 等。
- SKU 字段：`sku.<sku_id>.specification`、`sku.<sku_id>.barcode`、`sku.<sku_id>.store_code`。
- 真正修改且回读一致为 `verified_complete`；写前已是目标并终读一致为 `verified_no_change`。
- 匹配冲突、未匹配和未知写入逐条保留，不得被成功率吞掉。
