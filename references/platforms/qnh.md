# 牵牛花平台适配器入口

只在当前页面/请求主机明确属于牵牛花时使用。牵牛花的 tenant、H5guard/A9、协议版本、Chrome 扩展 transport、reader、
writer 和回读器不得复用于其他平台。

---

## 🔴 牵牛花六大血泪教训与硬性熔断铁律（所有信息维护任务前置必读）

> [!CAUTION]
> **任何牵牛花商品信息修复、属性填充、不可售治理、图片维护或批量操作，必须 100% 遵守以下六大铁律，严禁再次引发覆盖门店自定义、篡改价格、替换原图或跨品类篡改事故！**

### 铁律一：【门店自定义商品隔离保护与按店独立维护铁律——严禁强制改为“跟随总部”】
1. **业务本质（为什么严禁把自定义改为跟随总部）**：
   - 在牵牛花的多门店主档架构中，同一个主档 SPU/SKU 下挂接的不同门店，支持开启门店级自定义（`customizedNameFlag: true` 门店自定义名称、`customizedPicFlag: true` / `customizedPicUrlListFlag: true` 门店自定义图片、门店自定义前台分类 `mainFrontCategoryList` 等）。
   - 在实际商家运营中，**同一个 SPU/SKU 在不同门店往往具有不同的商品名称、商品主图、属性信息，甚至在不同门店指代完全不同品牌或不同款式的实物商品**（例如：总部主档 SPU 为 `南极人 枕头`，但 `古镇店` 实际自定义为 `红豆家纺 枕头`，`三水店/伦教店` 实际自定义为 `海澜之家 枕头`）。如果按“同一主档维护同一套名称/图片并级联全店”的思维操作，必然造成全门店商品信息大面积错乱！
2. **两大隐蔽覆写陷阱（绝对禁止触犯）**：
   - **致命陷阱 1A（门店接口关闭自定义）**：调用门店商品更新接口 `POST /qnh-gw3/api/product/store/update` 时，若传入 `customizedNameFlag: false` 或 `customizedPicUrlListFlag: false`，会强制将门店自定义商品重置为“跟随总部”，直接抹杀门店原本独立的商品名称与主图。
   - **致命陷阱 1B（主档 `tenant/update/v2` 的 `coverToStore: 1` 静默级联抹平门店自定义——最隐蔽！）**：调用主档更新接口 `POST /qnh-gw3/api/product/tenant/update/v2` 时，一旦 `coverageRequest.fieldCoverageInfoList` 含有 `{ field: 'spu_name', coverToStore: 1 }`、`{ field: 'product_name', coverToStore: 1 }`、`{ field: 'picture', coverToStore: 1 }` 或 `{ field: 'pic_url_list', coverToStore: 1 }`（哪怕初衷只是想同步主档详情图 `picContentList`！因为牵牛花的 `field: 'picture'` 会同时级联覆盖主图与详情图！），牵牛花后台异步 `主档级联更新` 消费者会**无视各门店原本的 `customizedNameFlag: true` / `customizedPicFlag: true`，强行将全量门店的自定义开关静默重置为 `false`（跟随总部）并用总部主档名称/图片覆盖所有门店**，且门店操作日志仅记录 `主档级联更新`，不出现 `关闭门店自定义` 字样！
3. **强制分流维护规程（区别处理主档与自定义门店）**：
   - **第一步（写前探测门店自定义状态）**：对任何 SPU 发起名称、图片、品牌或门店级异常修复前，必须先通过 `POST /qnh-gw3/api/product/store/page-query` 或 `POST /qnh-gw3/api/product/store/detail` 检查该 SPU 下所有门店的 `customizedNameFlag` 与 `customizedPicFlag`：
   - **第二步（已自定义门店 ➔ 单独按门店自定义信息维护）**：凡某门店 `customizedNameFlag === true` 或 `customizedPicFlag === true`，**必须以该门店为单位独立调用 `POST /qnh-gw3/api/product/store/update` 进行维护**，在请求体中显式保持 `customizedNameFlag: true`、`customizedPicUrlListFlag: true`，并严格按照该门店当前自定义的名称、主图（`picInfoList`）、分类（`mainFrontCategoryList`）去维护该门店信息，**严禁将其改为“跟随总部”再去总部主档优化**！
   - **第三步（未自定义门店 ➔ 跟随总部主档维护，且严禁连坐覆盖自定义门店）**：仅当门店未开启自定义时，才继承总部主档信息；若同一 SPU 下同时存在“自定义门店”与“未自定义门店”，主档 `tenant/update/v2` 的 `coverageRequest.fieldCoverageInfoList` **严禁包含 `spu_name`、`product_name`、`picture`、`pic_url_list` 的 `coverToStore: 1`**（主档 `coverToStore: 1` 仅允许用于无冲突的纯渠道类目属性字段 `mt_channel_category_property` / `elm_channel_category_property` / `jd_channel_category_property`）。

### 铁律二：【主图、详情图与特殊图原值 100% 保护铁律】
- **永久禁用通用占位图**：严禁在主图（`picUrlList` / `picInfoList`）或详情图（`picContentList`）中塞入 `6f244c5f3cb8b26399bbf31116c40de81422507.png`、`064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png` 等“温馨提示/售后说明”通用占位图。
- **严禁图库模糊搜图替换原主图**：严禁调用 `/qnh-gw3/api/product/tenant/query-pics-by-sku-name` 或标品库（`retailsp`）模糊匹配图片去覆盖替换商家原本已有的主图。
- **严禁把平台示例图写入特殊图**：严禁把 `pictureExample` 里的示例图 URL 写入 `mtSpecialPictureList` 或 `elmSpecialPictureList`。
- **详情图为空时的唯一合规复用方式**：若渠道强制要求 `picContentList` 非空且当前为空，仅允许原样复用**当前商品（或当前门店商品）自身已有的主图 URL**，且严禁在主档发送 `{ field: 'picture', coverToStore: 1 }` 冲掉自定义门店主图。

### 铁律三：【严禁跨品类改名、篡改类目或篡改品牌规避资质拦截】
- 遇到医疗器械（创可贴、体温计、雾化器、避孕套、隐形眼镜护理液等）、成人用品、3C 强制认证商品、超经营范围商品或 `300105` 等校验拦截时，**绝对严禁通过删改正常商品名、将渠道类目篡改为 `便当盒 / 保温杯 / 厨房储物器皿`、或将品牌篡改为 `海尔` 等方式强行绕过校验**！
- 凡属商家经营资质缺失、禁售品或缺少真实法定证照的商品，必须 **100% 保持原商品名、原类目、原品牌、原规格不变**，直接归入 `manual_block` / `manual_evidence_required` 交由人工处理。

### 铁律四：【非调价任务价格字段（`storePrice` / `unifiedOnlinePrice` / `sellingPrice`）零触碰铁律】
- 在一切非专项调价任务（包括不可售修复、渠道属性填充、铺品异常治理、图片维护）中，主档 `erpInfo.sellingPrice` 以及各门店 SKU 的 `storePrice`、`unifiedOnlinePrice`、`channelOnlinePriceList` 属于**绝对禁区，必须 100% 原值透传**。
- 即使平台报出“美团闪购价格同步失败”、“低于起购价”或“价格异常”，也严禁脚本擅自改价，必须在报告中保留原价并列出异常原因交由人工决策。

### 铁律五：【门店售卖状态（`spuSaleStatus` / `saleStatus`）与渠道发布状态原值保护铁律】
- 更新主档或门店商品时，必须 100% 保持各门店、各 SKU 原有的 `spuSaleStatus`、`saleStatus`、`onlineStatus`（`1` 或 `2`）及 `onlineChannels`。
- **严禁将原本已下架（`2`）的商品擅自改为上架（`1`）**，也**严禁在构造 `storeSkuChannelList` 时将已发布渠道置为 `-1`（删除渠道发布）**。

### 铁律六：【写前全量快照（主档 + 全门店 `store/detail`）强制落盘与门店更新接口精确载荷契约】
- **写前双层全量快照必做**：任何批量写入前，不仅要将主档 `tenant/detail` 完整落盘，凡涉及门店级商品或含自定义门店的 SPU，必须先将全部关联门店的 `POST /qnh-gw3/api/product/store/detail` 完整响应（含完整 `picInfoList` URL 数组、`spuName`、`customizedNameFlag`、`customizedPicFlag`、`mainFrontCategoryList`、`storeSkuList` 价格与上下架状态）落盘保存，严禁只存图片张数 `picCount`！
- **牵牛花门店级接口关键字段契约**：
  1. `POST /qnh-gw3/api/product/store/detail` 返回的门店图片位于 `data.picInfoList`（`[{ picUrl, isDelete }]`）与 `data.originPicUrlMapping`，而非顶层 `picUrlList`；
  2. `POST /qnh-gw3/api/product/store/update` 顶层 Payload **必须携带** `operateType: 2, actCheckType: 1, source: 2, adjustStock: { entityId: sd.storeId, entityType: sd.storeEntityType || 1, comment: 'WEB-门店商品详情调整库存', skuList: [] }`，否则服务端会报 `"门店商品库存信息不能为空"` 拒绝保存；
  3. 门店更新自定义图片时必须传 `picUrlList`（完整 URL 数组）+ `customizedPicUrlListFlag: true`；更新自定义名称时必须传 `spuName` + `customizedNameFlag: true`。

### 铁律七：【多规格京东到家（`channelId=300`）销售属性与 SKU 规格必关联铁律】
- 多规格商品（`specType === 2` 或 `detail.skus.length > 1`）在补齐京东到家渠道类目与京东品牌（`ch300.brandInfo`）的同时，**必须同步检查并补齐京东到家销售属性（`ch300.saleAttrList`）与全量 SKU 规格关联（`sku.skuChannelInfoList` 中 `channelId === 300` 的 `saleAttrValueList`）**。
- 若 `ch300.saleAttrList` 为空，页面会提示 `请至少选择1项` 且无法推送至京东到家渠道：必须调 `POST /qnh-gw5/api/v1/channelCategory/property/batchQuery` 获取该京东类目的 `jdSaleAttrList`，默认选第 1 个销售属性（`jdSaleAttrList[0]`）写入 `ch300.saleAttrList`，再将 `detail.skus` 中每个 SKU 的规格值（`sku.specName`）一一放入对应 SKU 的京东 `saleAttrValueList` 中关联，并携带 `{ field: 'jd_channel_category_property', coverToStore: 1 }` 保存后独立回读验真。

---

## 可复用快速进入流

1. 优先复用用户当前已登录且可合法使用的牵牛花会话，核对账号、门店和实际占用；普通 Chrome 扩展只 claim 精确牵牛花标签页。会话来源不是永久权限条件。
2. 冻结当前可见租户、tenant/store、route、profile/transport、run-dir 和页面 fence；身份冲突时零详情读取、零写入。
3. 从当前文档原生成功请求确认协议与签名画像；禁止 403 后轮盘切换 `4.2.0/4.2.4/4.3.0`。
4. query-only 可复用已冻结列表页；完整对象编辑必须精确绑定目标 SPU 编辑页，同一 SPU 单飞。
   当前官方总部价格批量导入按其独立任务合同绑定租户、目标 SKU 清单与批次文件，不需要为每个商品打开编辑页；
   这不授权共享列表页直接发送完整对象更新。
5. 保存响应后用能完整表达目标字段的正式 reader 独立回读；总部零售价可按同标签全量列表逐 SKU 回读，
   列表字段缺失、结构未知或保护字段不足时才补精确详情。未知写结果只回读，不自动重复 final save。

平台基础边界见 [牵牛花模块](../platform-qnh.md)。只有出现协议、403、成本同步或保质期工程问题时，才加载
[受保护请求维护合同](../qnh-protected-request-maintenance-v1.md)。

## 功能分支

- 主图品牌水印扫描：`runtime_guided`，只读；加载 `tasks/qnh-watermark-scan.md`，使用可配置文字/图案规则和视觉复核，输出 SPU 清单。

- 渠道属性：`implemented`；按路由器加载 `tasks/channel-attributes.md`。
- 不可售一次过：`implemented`；加载 `tasks/unavailable-one-pass.md`。
- 资质/专项图：`implemented`；加载 `tasks/qualification-images.md`。
- 插件属性填充：`implemented`，但必须实际运行插件，不能用直连结果冒充。
- 原点搬品历史失败重试：`implemented`；只处理用户点名原结果中的失败成员。
- 搬品冲突回退复核：`runtime_guided`；只处理映射表中明确标记名称/条码变化的行，仅在原任务证明末尾追加 `1` 时按该策略回退，只读比对并回填已确认的结果列。
- 门店旧新 SKU 替换迁移：`runtime_guided`；按冻结映射把新主档 SKU 覆盖到门店，迁移库存、库位、供应商和渠道状态，删除旧商品后确保新商品上架；删除前核对授权集合及非目标规格保护。
- 总部零售价按货盘补齐：`runtime_guided`；加载 `tasks/qnh-headquarters-price-fill.md`，优先现场确认的官方 Excel 导入。
- 门店/活动调价与通用商品编辑：本适配器未注册，固定零写入。
