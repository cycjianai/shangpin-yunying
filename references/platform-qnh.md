# 牵牛花模块

- `platform_adapter=qnh`
- 渠道类目与属性一体化治理：`implemented`；入口与合同见 `channel-attribute-contract-v2.md`（v5 门店自定义隔离与原值保护版），核心执行器见 `scripts/platforms/qnh/execute_mass_spu_cleaning.mjs`。严格执行“空类目官方推荐先行 → 官方属性推荐优先采纳（保护原有非‘其他’真实值） → 剩余空白语义与规则库二次补齐 (0空白) → 【4 Tabs + 12 并发】满速分布式签署保存（主档 `coverToStore: 1` 严格仅限纯渠道类目属性字段，严禁级联覆盖门店自定义名称与图片）”。
- 总部零售价按货盘补齐：`runtime_guided`；入口 `tasks/qnh-headquarters-price-fill.md`，只修改主档，不能套用门店活动调价。
- 资质图：`implemented`，入口与合同见 `thread-928-empirical-contract.md`、`error-playbook.md`、`field-safety.md`；
  所有限制的唯一机器事实源见 `qualification-image-policy.md`。
- 搬品历史失败重试：`implemented`，入口与合同见 `copy-history-retry-contract-v1.md`。

---

## 🔴 门店自定义商品（Store-SPU）隔离保护与六大防坑铁律（强制执行）

> [!CAUTION]
> **严禁强制把门店自定义改为“跟随总部”，也严禁在主档对含自定义门店的 SPU 发送 `spu_name` / `picture` 的 `coverToStore: 1`！**

1. **门店自定义识别与按店独立维护铁律（最高优先级）**：
   - 在牵牛花中，同一主档 SPU/SKU 在不同门店可开启独立自定义（`customizedNameFlag: true`、`customizedPicFlag: true` / `customizedPicUrlListFlag: true`、自定义门店分类 `mainFrontCategoryList`），不同门店甚至可能用同一 SKU 售卖不同品牌/不同款式的商品。
   - **绝对禁止**在门店更新接口 `POST /qnh-gw3/api/product/store/update` 中将 `customizedNameFlag` 或 `customizedPicUrlListFlag` 从 `true` 改为 `false`（即严禁将自定义强制改为“跟随总部”）。
   - **绝对禁止**在主档更新接口 `POST /qnh-gw3/api/product/tenant/update/v2` 中对存在门店自定义的商品传递 `{ field: 'spu_name', coverToStore: 1 }`、`{ field: 'product_name', coverToStore: 1 }`、`{ field: 'picture', coverToStore: 1 }` 或 `{ field: 'pic_url_list', coverToStore: 1 }`——一旦传入，牵牛花后台 `主档级联更新` 会无条件将所有门店的 `customizedNameFlag` / `customizedPicFlag` 静默重置为 `false` 并用总部主档覆盖全店！
   - **正确维护方式**：
     * **已开启自定义的门店（`customizedNameFlag: true` 或 `customizedPicFlag: true`）**：必须**单独按该门店维度**调用 `POST /qnh-gw3/api/product/store/update`，显式传 `customizedNameFlag: true`、`customizedPicUrlListFlag: true`，严格按照该门店当前的自定义名称、自定义主图（`picInfoList`）、自定义分类去维护，绝不允许改为跟随总部后在主档统一修改！
     * **未开启自定义的门店**：跟随总部主档维护；若同一 SPU 下既有自定义门店又有未自定义门店，主档 `coverageRequest.fieldCoverageInfoList` 严禁包含 `spu_name` / `picture` 的 `coverToStore: 1`。
2. **主图、详情图与特殊图原值 100% 保护铁律**：
   - 永久禁用 `6f244c5f3cb8b26399bbf31116c40de81422507.png`、`064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png` 等通用说明/占位图；
   - 严禁用 `query-pics-by-sku-name` 或标品库（`retailsp`）模糊搜图结果替换商家原有主图；严禁将 `pictureExample` 示例图写入 `mtSpecialPictureList` / `elmSpecialPictureList`；
   - 详情图 `picContentList` 为空且确需补齐时，仅允许复用当前商品（或当前门店）自身已有主图，且禁止发送 `{ field: 'picture', coverToStore: 1 }`。
3. **严禁跨品类改名/改类目/改品牌规避资质拦截**：
   - 遇到医疗器械、成人用品、3C 认证或超经营范围拦截时，严禁把类目改为 `便当盒 / 保温杯 / 厨房储物器皿` 或把品牌改为 `海尔`；必须原样保留商品信息并转 `manual_block`。
4. **非调价任务价格零触碰铁律**：
   - 非专项调价任务中，主档 `erpInfo.sellingPrice` 及各门店 SKU 的 `storePrice`、`unifiedOnlinePrice`、`channelOnlinePriceList` 必须 100% 原值透传，严禁因“价格同步失败/低于起购价”擅自改价。
5. **售卖状态与渠道发布状态原值保护铁律**：
   - 100% 保留各门店 SKU 原有的 `spuSaleStatus`、`saleStatus`、`onlineStatus`（`1`/`2`）及 `onlineChannels`；严禁将已下架（`2`）改上架（`1`），严禁将已发布渠道置为 `-1`。
6. **写前双层全量快照（主档 + 全门店 `store/detail`）与门店更新载荷契约**：
   - 写前必须落盘主档 `tenant/detail` 与全部关联门店的 `store/detail`（完整保存 `picInfoList` URL 数组、`spuName`、`customizedNameFlag`、`customizedPicFlag`、`storeSkuList` 价格与上下架状态）；
   - `store/detail` 返回图片字段为 `picInfoList`（`[{ picUrl, isDelete }]`）；`store/update` 顶层必须携带 `operateType: 2, actCheckType: 1, source: 2, adjustStock: { entityId: sd.storeId, entityType: sd.storeEntityType || 1, comment: 'WEB-门店商品详情调整库存', skuList: [] }`。

---

## 核心架构与实战规范：全链路复用【多标签页分布式签名 + 多并发 Worker】

牵牛花平台所有涉及**商品信息修改、属性治理、类目补齐、调价、状态同步与改写**的功能，**必须统一复用经过 38,000+ SPU 生产级验证的高效架构：【4 标签页分布式签名 + 12 并发 Worker】**。

### 1. 架构原理与角色分工
* **Tabs（浏览器标签页 = 4）➔ 分布式防伪签名收银台**：
  牵牛花所有敏感修改接口均依赖前端风控签名（`window.H5guard.sign`），受限于 Chrome V8 引擎单线程特性，单个标签页容易产生签名锁竞争。开辟 **4 个独立 Tabs**，签名通道吞吐量提升 4 倍。
* **Concurrency（并发 Workers = 12）➔ 异步流水线工人**：
  在 Node.js 中并行维持 12 个独立 Worker，每个 Worker 负责单个 SPU 的全流程（查详情 ➔ 官方类目推荐 ➔ 官方属性推荐 ➔ 事实继承与规则全量回填 ➔ 派发签名 ➔ 保存）。
* **黄金配比（3:1）**：
  实测每 3 个 Worker 共享 1 个签名 Tab，使 Chrome 签名窗口持续饱和运转且不排队，同时避免打爆牵牛花服务端网关 Socket 连接池（并发 > 14 时单件延迟会从 2.3s 激增至 6.6s，吞吐量反而暴跌 38%）。

### 2. 性能与安全性指标
* **端到端跑速**：稳定达到 **250 ~ 300 SPU/分钟**（单商品仅需 ~2.3 秒，较传统打开编辑页提速 50 倍）；
* **安全合规**：100% 成功率，0 失败（Fail: 0），0 验证码，0 平台风控降级；
* **断点续跑机制**：必须配置 Checkpoint 机制（如每 50 件落盘），支持意外中断后毫秒级无缝断点续跑。

### 3. 闪电内存过滤流式治理引擎（Zero-Detail Streaming Memory-Filter Engine）
在面对数万级（30,000 ~ 50,000+ SPU）全店全量排查、合规清洗、非赠送修正或指定异常字段大范围治理时：
* **核心瓶颈**：严禁对全量商品无差别逐一调用 `tenant/detail` 详情接口，否则数万次网络调用将耗时数小时；
* **底层架构突破**：牵牛花分页接口 `page-query?pageSize=100` 原生已在内存中完整返回了每个 SPU 的 `spuChannelInfoList`（含各渠道已绑类目、属性骨架及已选 `customValue`）；
* **极速流水线实现**：
  1. 通过 4 Tabs 分布式流式分页（每批 4 页 400 SPU 并行拉取），在内存中以 **6,000 ~ 8,000 SPU/分钟** 的极速穿透全店主档（38,924 件仅需 3.5 分钟）；
  2. **纯内存精准判定**：仅对内存中命中字段异常、违规中括号、赠品勾选的商品才触发 `detail` 深度加载与 `update/v2` 提交保存；
  3. **渠道属性级联与门店自定义硬隔离**：主档保存仅允许对纯渠道类目属性字段（`mt_channel_category_property` / `elm_channel_category_property` / `jd_channel_category_property`）携带 `coverToStore: 1`；**严禁在主档携带 `spu_name`、`product_name`、`picture` 或 `pic_url_list` 的 `coverToStore: 1` 冲掉门店自定义名称或图片**！凡开启自定义的门店（`customizedNameFlag: true` 或 `customizedPicFlag: true`），必须单独调 `/qnh-gw3/api/product/store/update` 按该门店当前自定义信息独立维护；
  4. **异步渠道激活**：以每批 20 SPU 批量触发 `generalMultiSelectPush` 同步至各大渠道；
  5. 整体治理效率较传统模式提升 15 倍以上，无效网络请求减少 85% 以上。

牵牛花模块拥有 QNH H5guard、tenant 身份、列表/详情/保存接口、Chrome 扩展 transport 和专项图槽位合同。
不得把这些协议用于美团、翱象或淘宝闪购直连平台。

属性与资质图必须冻结为两个独立任务模式、run-dir 和完成口径；属性任务外部调用预算为 0，资质图任务不得顺带修改
普通属性。两类任务都必须映射到统一运营 Excel Schema，不得输出不同模板。不可售 one-pass 是牵牛花现有附加模式，
不扩散为其他平台的默认任务类型。
搬品失败重试只复用原点搬品助手自己的新增链路，并用牵牛花主档独立回读验收；九项旧→新映射是内部证据，最终交付
仍映射到统一 7 表，不再另造专用工作簿。

牵牛花 403、H5guard/A9、Cookie/页面身份、成本同步、保质期、受管 Chrome 或健康检查属于条件工程维护轨道；完整
阅读 `qnh-protected-request-maintenance-v1.md`，并以当前项目 `docs/agent-rules/qnh-protected-request.md` 为仓库权威真源。
入口修复不得改变上述商品治理完成口径，也不得把服务端受管请求上下文传播到当前标签页扩展通道。

