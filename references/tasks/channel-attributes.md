# 任务分支：渠道属性填充

目标是冻结清单中平台现存商品的全部目标渠道属性满足当前字段类型、候选和复合结构合同，并在保存后全量独立回读；
不是“页面非空”或“保存请求成功”。

## 平台叶子

- 牵牛花：完整读取 [渠道属性结构合同](../channel-attribute-contract-v2.md)。QNH 原生请求、签名和 writer 只属于 QNH。
  - **门店自定义隔离与原值保护红线**：在主档 `tenant/update/v2` 保存时，`coverageRequest.fieldCoverageInfoList` **严格仅限包含渠道类目属性字段（`mt_channel_category_property`、`elm_channel_category_property`、`jd_channel_category_property`）**，**绝对禁止传入 `{ field: 'spu_name', coverToStore: 1 }` 或 `{ field: 'picture', coverToStore: 1 }`**（否则会触发 `主档级联更新` 静默抹平门店自定义名称与自定义主图！）。凡开启了门店自定义（`customizedNameFlag: true` 或 `customizedPicFlag: true`）的门店商品，必须单独按该门店自定义信息调 `/qnh-gw3/api/product/store/update` 维护，严禁将其强制改为“跟随总部”。严禁塞入 `6f244c5f...` / `064b297f...` 等通用占位图，严禁触碰任何价格与上下架状态。
- 翱象：完整读取 [翱象渠道属性合同](../aoxiang-channel-contract-v1.md)。`MT/ELE` 值按目标结构重新物化。
- 美团、饿了么、淘宝闪购直连：能力表为 `planned` 时固定零写入。

纯确定性填充的 OCR、媒体、Web、模型、provider 和上传预算为 0。用户明确要求语义纠错时，仅使用当前适配器注册的
证据化纠错路径，模型答案必须映射到当前候选并经本地审计。

## 统一输出映射

- `字段ID=channel_attribute.<channel>.<platform_field_id>`。
- `执行前` 保留真实旧结构；空值写 `(空值)`，结构非法不能简化为空。
- `计划值` 与 `最终回读值` 使用同一规范化序列化。
- 通过为 `verified_complete`，写前已合法且终读通过为 `verified_no_change`。
- 最终全量结构问题必须为 0；保存成功率不能冒充属性完成率。
