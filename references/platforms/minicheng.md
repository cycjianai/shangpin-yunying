# mini橙 (MiniCheng) 平台治理与操作规程 v1.0.0

## 1. 平台概述

mini橙（澜橙数字 `mini.guodongcheng.cn`）是面向即时零售/外卖到家场景的综合门店 ERP 与商品主档中台。支持多渠道（美团外卖 `MEI_TUAN`、淘宝闪购/饿了么 `E_BAI`、京东到家 `JD`、抖音小时达 `TIK_TOK`）的商品主数据管理、渠道属性配置、库存与价格同步。

### 1.1 核心网络与鉴权契约

- **前端系统**：Vue 2 + Element UI + Vuex
- **后端网关**：`https://emallopen.guodongcheng.cn/merchant_api/`
- **鉴权机制**：标准 HTTP Header `Authorization: Bearer mini_<jwt_token>`
  - 无需前端 V8 签名锁（无 H5guard 等复杂反爬插件锁），直连吞吐极高；
  - Token 可从当前已登录页面的 `localStorage.getItem('token')` 自动提取。

---

## 2. 关键接口速查表

| 功能领域 | 请求方式与端点 | 载荷格式 | 关键参数说明 |
| :--- | :--- | :--- | :--- |
| **外卖商品分页查询** | `POST /store/product/listStoreProductPro` | `x-www-form-urlencoded` | `storeCode`, `pageNumber`, `pageSize`, `minStockNum=1`, `isMultiSkuMerged=true` |
| **商品全量详情快照** | `POST /store/product/queryProductDetail` | `x-www-form-urlencoded` | `skuId`, `storeCode`（**用于修改前全字段快照留存**） |
| **官方渠道类目智能推荐** | `POST /product/cat/recommendCat` | `x-www-form-urlencoded` | `upcCode`, `name`, `channelCode` (`MEI_TUAN` / `E_BAI`) |
| **美团类目属性骨架** | `POST /product/cat/queryMtCatAttrList` | `x-www-form-urlencoded` | `catId`（返回美团属性定义、选项列表、类型等） |
| **淘宝闪购属性骨架** | `POST /product/cat/queryStoreEleCatAttrList` | `x-www-form-urlencoded` | `storeCode`, `catId`（返回淘宝闪购/饿了么属性定义） |
| **官方渠道 AI 属性推荐** | `POST /product/cat/aiRecommendCatAttr` | `x-www-form-urlencoded` | `catId`, `productName`, `channelCode`, `storeCode` |
| **商品原子保存与提审** | `POST /store/product/updateProductDetail` | `application/json` | 提交包含 `mtCatAttr` 与 `eleCatPropertyList` 的完整商品实体 |

---

## 3. 属性治理核心规则与契约

### 3.1 平台推荐第一优先级与剩余空白二次对齐

1. **官方推荐优先采纳**：
   - 美团：调用 `/product/cat/aiRecommendCatAttr`（`channelCode: "MEI_TUAN"`）；
   - 淘宝闪购：调用 `/product/cat/aiRecommendCatAttr`（`channelCode: "E_BAI"`）；
   - 官方返回的 `recommendValue` 具有最高置信度，优先提取并对齐字典选项。
2. **剩余空白智能对齐**：
   - **品牌**：优先 AI 推荐，若空提取标题前缀或书名号品牌词；若仍无匹配项，对齐选项中的“通用”/“其他”/“无品牌”；
   - **产地**：美团必须为 `中国`，淘宝闪购必须为 `中国大陆`；
   - **保质期/规格/包装方式**：根据品类与标题正则解析（如 500ml、箱装/瓶装/袋装、常温贮存）；
   - **铁律（规则 35 绝不虚假承诺赠品）**：涉及吸管/餐具/赠品/礼袋/礼品包装属性，**一律强制选择明确否定项（“否”、“无”、“不赠送”、“普通包装”）或保持留白**，坚决杜绝线下客诉。

### 3.2 资质图隔离原则（Zero-Qualification Modification）

- 当任务明确约束“只填写美团属性和淘宝闪购属性，不填写资质图”时：
  - 严禁调用任何外部商业生图模型或生成本地图；
  - 严格保留原始商品快照中的 `specialPictureList` 与 `eleSpecialPictureList`，原值透传，不作增删。

### 3.3 全生命周期快照与随时回滚契约

- **前置强制快照**：修改任一 SPU/SKU 前，必须调用 `/store/product/queryProductDetail` 获取完整原始数据，以 `${productCode}_${skuId}.json` 落盘归档至 `artifacts/snapshots/minicheng_${storeCode}/`；
- **秒级原位回滚**：提供 `restore_product_snapshot.mjs`，读取快照数据调用 `updateProductDetail`，100% 还原任意商品的全部历史字段。

---

## 4. 自动化脚本与执行范式

- **深度实战防坑指南与全流程规程**：详见 [`minicheng-playbook-and-pitfalls.md`](./minicheng-playbook-and-pitfalls.md)
  - 覆盖 Vue 前端双轨绑定铁律（美团 `attrValueType` 数值化转换与选项 `valueId` 对齐、淘宝闪购 `eleCatAttr` 强依赖 `propId` 序列化）；
  - Windows EBUSY 文件锁自动降级保护；
  - 重量 <= 0 拦截兜底规范；
  - 规则 35 赠品全量否定与资质图零改动契约。
- **治理引擎**：`scripts/platforms/minicheng/minicheng_engine.mjs`
  - 支持多路并行（10~12 并发 Workers）；
  - 内存级缓存 300+ 类目属性骨架，避免高频网络抖动；
  - 增量 Ledger 存证（`artifacts/minicheng_progress_ledger.jsonl`），支持断点续传。
  - 参数：`--concurrency <N>`，`--scope-limit <N>`，`--sku <skuId>`，`--force`。
- **快照恢复**：`scripts/platforms/minicheng/restore_product_snapshot.mjs`
  - 单品恢复：`node restore_product_snapshot.mjs --sku-id <skuId>`
  - 整店全量回滚：`node restore_product_snapshot.mjs --all`


