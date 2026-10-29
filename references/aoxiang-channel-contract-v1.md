# 翱象渠道属性与不符合渠道规则治理合同 v2（全量 0 空白 + 多规格四道硬门禁版）

## 1. 适用范围与核心目标

本合同适用于已登录翱象平台（`saas-retail.ele.me` / `tc-supply-chain-portal.ele.me`）的渠道属性全量填充与门店商品“不符合渠道规则”（`tabType: HAS_ERROR`）修复。覆盖渠道：

- `ELE`：淘宝闪购/饿了么；
- `MT`：美团闪购；
- `JD`：京东到家（当商户开通京东到家且存在渠道规则报错时同步治理）。

> [!IMPORTANT]
> **核心原则 1（全量 0 空白拉满，拒绝仅填必填）**：
> 与 [渠道类目与属性一体化执行合同 v4](channel-attribute-contract-v2.md) 完全对齐——**不仅要填写必填项（`needFlag === 1`），所有非必填项（`needFlag === 0`）也必须按四级梯队全部回填，做到页面 0 空白！**
>
> **核心原则 2（多规格防覆盖四道代码级硬门禁）**：
> 严禁任何主档更新（`POST /goods/master/update`）将多规格商品覆盖降级为单规格！所有脚本与引擎必须强制执行**四道代码级物理熔断门禁**（全门店写前快照 ➔ 100% 无条件查询 `relation/detail` 且失败即抛错熔断 ➔ 发送前 `assertMultiSpecSafe` 数量硬断言 ➔ 首单多规格 Canary 独立回读验真）。

---

## 2. 多规格防降级与防串店四道代码级硬门禁（最高红线）

1. **门禁一（改前全门店 + 全实体仓快照强备份）**：
   - 修改总部主档（`master/update`）会联动影响商户下**所有门店与实体仓**。
   - 动工前必须先调用 `GET /merchant/warehouse/listAll` 获取全部门店及关联实体仓 `warehouseCode`，遍历全部门店调用 `POST /goods/store/pageV3` 落盘所有商品及 `multiSubGoods` 子规格的 `stockNum`（库存）与 `cabinetCodeList`（独立库位）。未生成全门店快照前，代码严禁发起任何写请求。
2. **门禁二（100% 无条件调用 `relation/detail` + 严禁静默降级）**：
   - 在 `goods/store/pageV3` 中，多规格商品的主行 `skuCode` 常为第一个子规格的纯数字编码（如 `691090469`），此时调用 `GET /goods/master/detail?skuCode=691090469` 返回的 `goodsType` **恒为 `0`（而非 `1`）**！
   - **绝对禁止**用 `if (detail.goodsType === 1)` 或 `if (skuCode.startsWith('@'))` 作为是否查询 `relation/detail` 的前置条件！必须对 100% 商品无条件请求 `GET /goods/relation/detail?skuCode=...&relationType=1&positive=1`；若 `detail.spuCode` 以 `@@` 开头且首次返回不足，必须再用 `detail.spuCode` 二次查询 `relation/detail`。
   - 若 `relation/detail` 请求超时或报错，重试 3 次后仍失败**必须直接 `throw Error` 中止该商品更新**，绝对禁止 `catch { return null }` 静默落入单规格分支！
3. **门禁三（`master/update` 发送前 `assertMultiSpecSafe` 数量硬断言）**：
   - 计算期望子规格数：`expectedSkuCount = Math.max(detail.skus.length, relList.length, row.multiSubGoods?.length || 0, spuCode.startsWith('@@') ? 2 : 1)`。
   - 只要 `payload.skus.length < expectedSkuCount`，或 `spuCode.startsWith('@@') && payload.skus.length <= 1`，立即抛出 `FATAL_MULTI_SPEC_DOWNGRADE_BLOCKED` 物理阻断请求发送！
   - 同时在提交 `POST /goods/master/update` 前，必须从主对象及每个子 SKU 中强制剥离 `stockNum`、`prepareStockNum`、`cabinetCode`、`cabinetCodeList`、`storeGoodsCustomFields`、`storeGoodsCustomFieldsJson`、`sourceStoreCode`、`sourceStoreName`、`currentStoreCode`、`extendsAttributes` 并设 `skipPublishStore: true`，彻底阻断向兄弟门店派发 `bizTaskType: 14` 库位/供货关系任务。
4. **门禁四（首单多规格金丝雀 Canary 独立回读验真）**：
   - 任何批量任务放量前，必须先单独挑 **1 个多规格商品** 执行更新，随后调用 `POST /goods/store/pageV3` 独立回读，验证其 `multiSubGoods.length`、各门店 `stockNum`、各子规格 `cabinetCodeList` 100% 无损后，才允许解锁 12~14 路并发批处理。

---

## 3. 全量属性（必填 + 非必填）四级物化梯队与防反向优化规则

调用 `POST /goods/master/matchChannelCategoryPropertyV3` 获取当前类目属性模板后，对**每一个属性（包含 `needFlag === 1` 必填项与 `needFlag === 0` 非必填项）**按以下四级梯队顺序物化：

### 第一梯队：平台官方“使用推荐”（`definition.matchValue`）第一优先采纳
1. **优先采纳有效推荐**：只要 `definition.matchValue` 非空、不属于伪推荐“其他”（即名称不是 `"other/其他"`、`"其他"`、`"其它"`、`"无品牌"`），且与商品标题/规格无明确冲突，无论是必填还是非必填，**100% 第一优先级采纳**（点亮前端 `已使用系统推荐信息 Y/Y`）。
2. **过滤伪推荐“其他”防覆盖真实品牌**：若 `definition.matchValue` 返回 `"other/其他"` 或 `"无品牌"`，严禁将其当成有效推荐去覆盖商品原有的真实品牌（如“联想”、“晨光”、“得力”），必须跳过并进入后续梯队！
3. **`INPUT_OPTION` 推荐值双槽位拆分（防 `propertyValueId: "-1"` 报错）**：当 `valueType === "INPUT_OPTION"`（如 `包装数量`、`容量`、`净含量`、`长度（m）`）时，`matchChannelCategoryPropertyV3` 常返回单元素组合对象 `[{ propertyValueId: "-1", propertyValueName: "1个" }]`。严禁原样提交（否则报错 `以下类目属性未更新`），必须拆分为 `[ { propertyValueId: "", propertyValueName: "1", propertyValueType: "INPUT" }, { propertyValueId: unitId, propertyValueName: "个", propertyValueType: "SELECT" } ]` 双槽位结构！

### 第二梯队：原有真实非“其他”合规值 100% 保护与跨渠道事实继承
1. **真实值保护**：若当前属性已有非空、非“其他/无品牌”的真实值（如原品牌为“联想”、“晨光”），且未被渠道规则点名报错，100% 保留原值，严禁改成“其他”。
2. **异步下拉属性（`optionalValueGetType: "async"`）防误判**：品牌等大字典属性的 `optionalValue` 仅返回前几十条或为空，**严禁**因为已有品牌 ID 不在 `optionalValue` 初始列表里就误判为失效并改写为“其他”！
3. **跨渠道等价事实继承**：同一商品在对端渠道（MT ↔ ELE）已通过推荐或主档确认的事实属性（如 `适用场景: 桌面`、`保质期: 360天`），按目标渠道 `SELECT / INPUT / INPUT_OPTION / MULTI_INPUT_OPTION` 结构转换继承。

### 第三梯队：商品标题（`skuName`）与规格（`specification`）语义事实提取
1. **品牌全词段切分匹配**：针对 `"M＆G/晨光"`、`"Deli/得力"` 等斜杠/括号复合品牌名，按 `/[\/（()）]/` 切分全部词段比对标题（严禁只取 `split('/')[0]` 漏掉中文名）。
2. **规格与物理参数精准提取**：从标题和规格中提取净含量、容量、尺寸、材质、包装方式、连接方式（有线/无线/蓝牙）、供电方式（USB/外接电源/电池）、接口类型等明确事实；提取支数/个数时正则必须排除小数点后数字（防止 `0.5mm` 被误提为 `5支`）。

### 第四梯队：Skill 规则库安全默认兜底（确保页面 0 空白，严禁乱填离谱值）
对经过前三梯队仍为空的非监管属性（含全部非必填项），严格按 [`required_property_rules.mjs`](../scripts/platforms/qnh/required_property_rules.mjs) 兜底：
1. **规则 35（礼赠包装/赠品默认否定契约）**：涉及 `提供礼赠包装 / 赠品 / 是否赠送` 等属性时，强制选定明确否定项 **`普通包装` / `无` / `否` / `不赠送`**（若候选项全为肯定赠送项则保持留空 `[]`）。
2. **规则 2（长度/线长/尺寸/传输距离/续航未标注时默认填 `0`）**：凡 `长度 / 线长 / 尺寸 / 直径 / 高度 / 传输距离 / 续航` 等属性，标题未明确标注数值时，**一律默认填 `0`（如 `线长: 0 m`，绝对禁止乱填 `100m` 等离谱数值！）**；若字段定义有 `minValue > 0`（如 `输出功率（W）` 的 `minValue: "1.0"`），则按 `minValue` 钳位填入。
3. **规则 3 & 规则 1（下拉单选/多选优先级）**：
   - `形状 / 适用场景 / 适用人群` 未明确时优先选 **`通用` / `常规` / `日常` / `成人`**；
   - 其余单选/多选下拉未明确特征时，**第一顺位选 `其他` / `其它`**，第二顺位选 `通用 / 常规 / 普通 / 标准`，第三顺位选合理基础项（如 `喇叭单元` 选 `单喇叭 / 双喇叭`，严禁盲选 `十一喇叭`；`是否为特殊用途化妆品` 选 `非特殊化妆品`），最后兜底首项。
4. **自由扩展下拉（`supportExtend: "1"` 且候选为空）**：填入 `[{ propertyValueId: "", propertyValueName: "0", propertyValueType: null }]`（规格字段填规格原文），确保前端 UI 0 空白。

---

## 4. 保存、重提审与全量独立回读验收

1. **保存与重提审**：
   - 通过 `POST /goods/master/update` 保存主档（内置四道多规格防降级硬门禁）；
   - 需要触发渠道重提审时调用 `POST /goods/task/batchPublishV3`（传 `mergeMultiSpec: true`）或 `POST /goods/check/reCheck2`。
2. **最终验收硬标准**：
   - 保存后独立回读 `GET /goods/master/detail`、`GET /goods/relation/detail` 与全门店 `POST /goods/store/pageV3`；
   - 目标商品必填与非必填属性达到 **0 空白**，原有正确品牌 **0 误改**，多规格子 SKU 数量、各门店库存（`stockNum`）与各子规格独立库位（`cabinetCodeList`）**100% 零丢失**。
