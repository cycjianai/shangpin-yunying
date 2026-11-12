# 牵牛花模块

- `platform_adapter=qnh`
- 渠道类目与属性一体化治理：`implemented`；入口与合同见 `channel-attribute-contract-v2.md`（v6 全量属性拉满·双通道两阶段继承·药械合规推导与售后避坑版），核心规则引擎见 `scripts/platforms/qnh/required_property_rules.mjs`，执行器见 `scripts/platforms/qnh/execute_mass_spu_cleaning.mjs`。严格执行“空类目官方推荐先行 → 官方属性推荐优先采纳（保护原有非‘其他’真实值） → 双通道两阶段别名网络继承与药械合规推导 → 剩余空白语义与安全兜底补齐 (0空白，赠品承诺除外) → 【4 Tabs + 12 并发】满速分布式签署保存（主档 `coverToStore: 1` 严格仅限纯渠道类目属性字段，严禁级联覆盖门店自定义名称与图片）”。
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

---

## 渠道类目属性全量填充与合规推导实战体系（v6 架构）

在对美团闪购（100）和饿了么（200）渠道属性进行治理时，必须完整应用以下经实战检验的核心机制（统一封装于 `scripts/platforms/qnh/required_property_rules.mjs`）：

### 1. 两阶段双通道继承（Two-Pass Dual-Channel Pipeline）
* **Pass 1（官方推荐归集与单渠道首轮点选）**：
  - 调用 `queryRecommendDynamicInfoAndWeight` 获取美团与饿了么官方条码推荐；
  - 只要官方推荐存在真实值（非“其他/无品牌”），100% 优先采纳；
  - 同步扫描各渠道已有属性（非空且有效），构建美团事实库（`map100`）与饿了么事实库（`map200`）。
* **Pass 2（全网同构别名继承与空白深度拉满）**：
  - 基于 `ALIAS_GROUPS` 别名网络，优先查对向渠道（跨渠道事实），次查本渠道同义字段（同渠道事实）；
  - 解决“美团有真实注册证号，饿了么因字段名称微调（如 `注册证编号/备案凭证编号` vs `备案编号/注册证号` vs `产品技术要求编号`）而留白”的历史顽疾，实现两渠道真实资质无损互通。

### 2. 药械与计生品类合法合规推导铁律
* **《产品技术要求编号》**：二类医疗器械（如避孕套/安全套）的《产品技术要求编号》在法定监管上原则与《医疗器械注册证编号》（如 `鲁械注准20162180063`）完全一致，双向继承互通；
* **境内/进口与代理人判定**：注册证前缀省份简称（`鲁/粤/浙/京/沪...械注准`）直接判定为境内国产器械，因此 `是否进口: 否`、`国产/进口: 国产`；境内器械无需外国代理人，`进口医疗器械代理人名称` 与 `代理人名称` 规范填入 **`不适用`**；
* **材质与禁忌症强关联**：材质/标题为“天然乳胶”时，禁忌症联动推导行业金标准 **`乳胶过敏者禁用`**；
* **分类标准**：饿了么分类单选精准对标 **`二类医疗器械`**；美团对应 **`避孕套`** / **`安全套`**；
* **规格提取**：标称大小规范填入 **`52mm`** 或 **`标准(宽度52±2mm)`**。

### 3. 售后防纠纷赠品否定契约（Dispute-Free Gift Guard）
* **最高商业红线**：严禁选择要赠送的选项，绝不向买家做出无法履约的额外赠品承诺；
* **负向否定优先**：涉及赠品/礼赠/配件属性，优先匹配否定项（`无赠品`、`普通包装`、`不支持礼盒包装`、`否`、`不赠`、`无吸管`、`无餐具` 等）；
* **全肯定承诺坚决留白**：若某赠品属性的所有候选项**全部为肯定的赠送承诺**（例如仅有 `['赠勺子', '赠吸管']` 或 `['赠礼袋', '礼盒包装']`），**坚决留空（不填）**，宁缺毋滥，严禁虚假承诺引发买家索赔；
* **区分包装用途与赠品承诺**：商品本身的用途（如包装耗材的 `用途` 选项 `[送老师, 送朋友, 送客户]`）属于商品本身的适用场景，不拦截；仅拦截向买家附送实物的赠送承诺。

### 4. 字符集脱敏清洗与持久化保障
* **字符集（`characterType`）定义**：`1`: 中文, `2`: 英文, `3`: 数字, `4`: 符号。
  - `characterType: "1,2,3"` 允许中英数（仅禁止标点），严禁误判为仅英文代码！仅在属性名包含“统一社会信用代码”时填入 `91110000000000000X`；普通生产企业名称正常填中文，清洗去除标点符号；
  - `ct === "3"` 填纯数字（年份 `2026`，3C纯数字，数量纯数字）；
  - `ct === "3,4"` 营养素填 `0`，功率/电压填合理数字。
* **持久化（Durability）保障**：QNH `update/v2` 接口对于 Type 1/2（可扩展单多选）、Type 3（文本）、Type 4（自定义字典）、Type 8（日期）、Type 9（期限），**必须同步设置 `prop.originalInputValue = newValue`**，否则独立回读重新加载时自定义值会被丢弃。

### 5. 多规格京东到家（`channelId=300`）销售属性选择与全量 SKU 规格关联铁律
* **为什么必补**：多规格商品（`specType === 2` 或 `detail.skus.length > 1`）若未设置京东到家销售属性（`ch300.saleAttrList` 为空），页面京东到家销售属性框会红字报错 `请至少选择1项`，且规格列表无京东到家规格列，导致商品无法推送到京东到家渠道；
* **四步关联与保存规范**：
  1. 通过 `POST /qnh-gw5/api/v1/channelCategory/property/batchQuery` 拉取当前京东三级类目的 `data["300"][0].jdSaleAttrList`；
  2. 若 `ch300.saleAttrList` 为空，默认选择第 1 个属性（`jdSaleAttrList[0]`，如 `颜色` / `尺码` / `规格`）写入 `ch300.saleAttrList`，并设置 `ch300.skuPicSetting = 0`；
  3. 遍历 `detail.skus`（先确保 `sku.skuChannelInfoList = Array.isArray(sku.skuChannelInfoList) ? sku.skuChannelInfoList : []`），提取各 SKU 的规格名称（`sku.specName` 或美团渠道 `saleAttrValueList` 值，截断至 `<= 28` 字符并同 SPU 去重），写入每个 SKU 的 `channelId: 300` `saleAttrValueList`（`[{ attrId: Number(targetAttr.attrId), attrName: targetAttr.attrName, attrValue: specText, attrValueId: null }]`）；对已推送京东门店（`ch300.channelSpuList?.length > 0`）且已有值的存量 SKU 保持原值不变；
  4. 携带 `{ field: 'jd_channel_category_property', coverToStore: 1 }` 提交 `tenant/update/v2` 保存并经 `tenant/detail` 独立回读验证。

---

牵牛花模块拥有 QNH H5guard、tenant 身份、列表/详情/保存接口、Chrome 扩展 transport 和专项图槽位合同。
不得把这些协议用于美团、翱象或淘宝闪购直连平台。

属性与资质图必须冻结为两个独立任务模式、run-dir 和完成口径；属性任务只处理渠道属性，资质图任务按
[`upstream-image-generation.md`](upstream-image-generation.md) 的上游生图链路执行，两类任务互不顺带修改对方范围。两类任务都必须映射到统一运营 Excel Schema，不得输出不同模板。不可售 one-pass 是牵牛花现有附加模式，
不扩散为其他平台的默认任务类型。
搬品失败重试只复用原点搬品助手自己的新增链路，并用牵牛花主档独立回读验收；九项旧→新映射是内部证据，最终交付
仍映射到统一 7 表，不再另造专用工作簿。

牵牛花 403、H5guard/A9、Cookie/页面身份、成本同步、保质期、受管 Chrome 或健康检查属于条件工程维护轨道；完整
阅读 `qnh-protected-request-maintenance-v1.md`，并以当前项目 `docs/agent-rules/qnh-protected-request.md` 为仓库权威真源。
入口修复不得改变上述商品治理完成口径，也不得把服务端受管请求上下文传播到当前标签页扩展通道。

