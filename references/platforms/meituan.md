# 美团平台适配器入口

先识别业务后台，不能只凭“美团”两个字选择请求：

- `yiyao.meituan.com/main/frame#/page/product/...`：买药/医疗器械商家版。
- 美团闪购/超市商品管家：调价、商品编辑、不可售治理所在的独立运行时。

两者可能都有 `wmPoiId`、SPU、SKU 和 UPC，但路由、类目、payload、保存链和验真口径不保证相同。

## 可复用快速进入流

1. 复用用户已授权且当前可见的精确商家页；冻结域名、业务后台类型、门店可见名、`wmPoiId`、页面/iframe route 和 fence。
2. 从当前页面 Network 或官方运行时找到“详情读取、预校验、影响检查、实际保存、独立回读”能力；历史端点只用于搜索。
3. 建立门店→SPU→SKU→店内码/UPC→活动/图片槽位的 ID 账本；所有标识按文本保存。
4. 完整对象保存每次从平台重读最新对象，只改授权字段；同一 SPU 单写者，跨 SPU 才允许受控并发。
5. 保存受理后丢弃内存对象，从正式详情或活动 reader 独立回读，并验证非目标字段和媒体未被覆盖。

不得把美团 Cookie、`mtgsig`、页面模块、活动端点或并发参数用于饿了么、牵牛花或翱象。

## 功能分支

- 调价推送：`runtime_guided`；加载 `tasks/price-push.md` 与 [美团调价线索](../meituan.md)。
- 商品名称/规格/条码/店内码编辑：`runtime_guided`；加载 `tasks/product-editing.md`。
- 医疗器械整店迁移：`runtime_guided`；加载 `tasks/medical-device-store-migration.md`，不得走闪购 payload。
- 闪购不可售治理：`implemented`；加载 `tasks/unavailable-one-pass.md` 与 [美团直连模块](../platform-meituan.md)。
- 独立渠道属性与独立资质图模式：当前为 `planned`；不可借用不可售 writer 冒充实现。
