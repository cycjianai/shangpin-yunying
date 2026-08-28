# 任务分支：搬品历史失败重试

仅适用于牵牛花原点搬品助手。完整读取 [失败重试合同](../copy-history-retry-contract-v1.md)。从用户点名原结果的
`错误明细` 冻结“新增失败”旧 SPU；成功行、其他下载记录和当前页面其他商品永久排除。

先做 1 条 manifest 成员 canary。插件结果只表示候选映射，必须从当前牵牛花主档按目标 SPU/SKU 独立回读目标条码。
未知结果先下载精确结果并回读，不能重复点击“新增”。任务外重复主档另开清理任务，删除前重新取得用户确认。

## 统一输出映射

- 旧 SPU 作为 `SPUID`。
- `copy_mapping.target_spu_id`、`copy_mapping.target_sku_id`、`copy_mapping.target_barcode` 分别记录；多 SKU 逐行展开。
- 所有 ID 和条码为文本，终态使用统一结果词汇。
- 九项内部映射证据不得导出为专用九列表，只能进入统一七表。
