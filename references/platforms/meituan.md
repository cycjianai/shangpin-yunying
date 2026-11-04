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
- 商品名称/规格/条码/店内码编辑与全量快照新增：`runtime_guided`（全量复制/保存成熟协议）；加载 `tasks/product-editing.md` 与 [美团商品编辑与快照新增保存](../meituan-product-editing.md)。
- 医疗器械整店迁移：`runtime_guided`；加载 `tasks/medical-device-store-migration.md`，不得走闪购 payload。
- 闪购不可售治理：`implemented`；加载 `tasks/unavailable-one-pass.md` 与 [美团直连模块](../platform-meituan.md)。
- 独立渠道属性与独立资质图模式：当前为 `planned`；不可借用不可售 writer 冒充实现。

## 全量商品保存与快照极速新增核心规程（uniSave 协议）

1. **会话级注入环境**：必须依附已登录美团闪购后台（`shangoue.meituan.com`）的 Chrome 实例（端口 `9222`+），严禁外挂 HTTP 直接调用（防 Yoda 滑块拦截）。
2. **两阶段操作流程**：
   - 第一阶段：调 `POST /reuse/sc/product/hqcc/w/batchSaveHqTags` 创建目标门店两级店内分类体系，并通过 `/tagList` 建立 `原分类 -> 新分类tagId` 映射；
   - 第二阶段：组装标准 `uniSave` 表单，在页面 `#hashframe` 上下文通过原生 `fetch` 并发推流。
3. **关键数据防护**：
   - 无条码 SKU 必须在 `commonProperty` 中注入 `{"allowUpcEmpty": "true"}`；
   - 新增商品必须将快照中的 `spuId/skuId/id` 清零，严禁沿用老店主键；
   - 图片 URL 清除 `@500w_500h...` 等 CDN 裁剪后缀。
4. **三级容错自愈引擎**：
   - 优先以 Rich 完整参数提交；
   - 遇类目属性校验错误自动剥离 `categoryAttrMap="{}"` 降级重试；
   - 遇视频/导购图错误自动剥离 `video="{}"` 重试；
   - 遇并发写入/频繁锁执行 1~3s 指数退避，确保万级商品零卡死。
