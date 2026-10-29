# 翱象平台适配器入口

只在当前页面属于翱象（如 `saas-retail.ele.me` / `tc-supply-chain-portal.ele.me`）时使用。翱象中的 `MT`（美团）、`ELE`（淘宝闪购/饿了么）、`JD`（京东到家）是被管理渠道，不等于各平台直连适配器。

## 核心能力与实战指南

1. **商品高速批量改名与编辑**：`implemented`，完整避坑指南与底层机制详见 [翱象平台实战与多规格防坑指南](aoxiang-playbook-and-pitfalls.md)。
2. **多规格防覆盖四道代码级硬门禁（最高红线）**：
   - **门禁一（改前全门店 + 全实体仓快照强备份）**：修改主档（`POST /goods/master/update`）会影响商户下**所有门店与实体仓**。动工前必须先调 `GET /merchant/warehouse/listAll` 查清全部门店及实体仓（`warehouseCode`）映射，遍历全部门店调用 `POST /goods/store/pageV3` 落盘全量主规格及 `multiSubGoods` 子规格的 `stockNum`（库存）与 `cabinetCodeList`（独立库位）。无全店快照严禁发起任何写操作。
   - **门禁二（100% 无条件调用 `relation/detail` + 严禁静默降级）**：子规格为纯数字编码（如 `691090469`）时，`goods/master/detail` 返回的 `goodsType` 恒为 `0`（而非 `1`）！因此**绝对禁止**用 `if (detail.goodsType === 1)` 或 `if (code.startsWith('@'))` 作为前置条件，必须对 100% 商品无条件调用 `GET /goods/relation/detail?skuCode=...&relationType=1&positive=1`（若 `spuCode` 以 `@@` 开头则同步查母 SPU）；接口异常重试后仍失败必须直接 `throw` 中止，严禁 `catch { return null }` 静默走单规格分支！
   - **门禁三（`master/update` 发送前 `assertMultiSpecSafe` 物理熔断断言）**：强制断言 `payload.skus.length >= expectedSkuCount`，凡 `spuCode` 以 `@@` 开头或原含多个子规格而 `payload.skus.length <= 1` 的，立即抛出 `FATAL_MULTI_SPEC_DOWNGRADE_BLOCKED` 物理阻断请求发送。
   - **门禁四（首单多规格金丝雀 Canary 独立回读门禁）**：批量放量前必须先单独挑 **1 个多规格商品** 试跑并回读 `pageV3`，确认子规格数量（`multiSubGoods.length`）、各店库存（`stockNum`）与各子规格独立库位（`cabinetCodeList`）100% 零丢失后，方可拉起 12~14 路并发满速推进。
3. **渠道属性全量 0 空白治理与不符合渠道规则（`HAS_ERROR`）修复**：`implemented`，完整合同见 [翱象渠道属性合同](../aoxiang-channel-contract-v1.md) 与 [翱象实战防坑指南](aoxiang-playbook-and-pitfalls.md)。必填（`needFlag === 1`）与非必填（`needFlag === 0`）一律按四级梯队（官方“使用推荐” `matchValue` ➔ 原有真实非“其他”值保护与跨渠道继承 ➔ 标题/规格语义提取 ➔ Skill 规则库安全兜底）全量填满，做到页面 0 空白。
4. **资质图与商品信息优化直连闭环**：`implemented`，通过 `POST /media/image` 上传合规资质图并挂载 `specialPictures` 槽位，配合 `POST /goods/master/update` 与 `POST /goods/task/batchPublishV3` 极速提审。

## 可复用快速进入流

1. 复用当前已登录 Chrome（自动兼容 9222/9223 等调试端口），先执行**门禁一**完成全门店与实体仓拓扑盘点及写前全量快照备份。
2. 通过原生诊断、主档详情、多规格关联（`relation/detail`）、类目属性推荐（`matchChannelCategoryPropertyV3`）建立商品事实。
3. Writer 提交 `POST /goods/master/update` 前，强制剥离 `stockNum`、`prepareStockNum`、`cabinetCode`、`cabinetCodeList`、`storeGoodsCustomFields`、`storeGoodsCustomFieldsJson`、`sourceStoreCode`、`sourceStoreName`、`currentStoreCode`、`extendsAttributes` 并设 `skipPublishStore: true`，杜绝跨门店串店与库存库位污染。
4. 严格通过**门禁四（首单多规格 Canary 独立回读）**后开启 12~14 路并发；全部完成后独立回读 `goods/store/pageV3` 核验多规格完整性、库存与库位零变动。
5. 遇到已废弃商品（`goodsStatus: -2`）直接标记异常，跳过无效重试。
