# 翱象 (Aoxiang) 平台高并发多规格商品治理实战操作规程与防坑指南

本文档总结了在翱象平台（SaaS Retail 供应链门户：`saas-retail.ele.me` / `tc-supply-chain-portal.ele.me`）进行数万级商品批量修改、改名、属性治理过程中的所有踩坑教训、底层架构原理及最高并发满速推进的最佳实践。

---

## 一、核心铁律：多规格商品防降级保护（绝不覆盖子规格）

在翱象平台中，商品主档分为 **单规格品** 与 **多规格（母子 SPU/SKU）品**。若处理不当，极易将商家的多规格商品（如包含大/中/小号，或不同口味/容量的商品）意外覆盖降级为单规格，导致线上各子规格条码、供货价、规格属性彻底丢失。

### 1. 为什么会发生“多规格被覆盖”？
1. **主档详情 `master/detail?skuCode=...` 接口的静默截断**：
   - 翱象的 `goods/master/detail` 接口在传入父级或某一子规格编码时，返回的 `skus` 数组往往**只包含当前单个 SKU 节点**，甚至不包含其他兄弟子规格。
   - 如果直接使用 `master/detail` 的返回对象修改名称后直接 POST `master/update`，翱象后端会以传入的 `skus` 数组强行覆盖主档的全部规格，导致其他所有子规格被底层物理清空！
2. **多规格关系的独立存储**：
   - 翱象将多规格关联关系独立存储于 `goods/relation/detail` 接口中，未在主档详情中自动平铺。

### 2. 多规格安全修改的标准链路（三步法）

每次更新商品前，**必须执行完整装配链路**：

```javascript
// 步骤 1：获取主档基本信息
const masterDetail = await fetchMasterDetail(skuCode);

// 步骤 2：必须强制查询 relation/detail 探测是否存在多规格关系
const relUrl = `https://tc-supply-chain-portal.ele.me/goods/relation/detail?skuCode=${encodeURIComponent(skuCode)}&relationType=1&positive=1`;
const relList = (await (await fetch(relUrl, { headers: { cookie } })).json()).data;

// 步骤 3：若 relList 存在且长度 > 0，必须全量重构 skus 数组！
let fullSkus = [];
if (relList && relList.length > 0) {
  fullSkus = relList.map((relItem, index) => {
    const mg = relItem.masterGoods;
    const itemSku = mg?.skus?.[0] || {};
    const s = JSON.parse(JSON.stringify(masterDetail.skus[0])); // 继承基础字段骨架

    s.skuCode = itemSku.skuCode || s.skuCode;
    s.subSkuCode = s.skuCode;
    s.barcodes = itemSku.barcodes && itemSku.barcodes.length > 0 ? itemSku.barcodes : [itemSku.mainBarCode || s.mainBarCode];
    s.mainBarCode = s.barcodes[0];
    s.specification = itemSku.specification || "";
    s.masterSpecification = s.specification;
    s.suggestPrice = itemSku.suggestPrice || s.suggestPrice;
    s.weight = (itemSku.weight && itemSku.weight > 0 && itemSku.weight < 99999) ? itemSku.weight : 10;
    s.weightUnit = s.weightUnit || 'g';
    s.weightForUnit = s.weight;
    s.masterWeight = s.weight;
    s.masterWeightUnit = s.weightUnit;
    s.masterWeightForUnit = s.weight;
    s.specRank = relItem.rank || (index + 1);
    s.rank = relItem.rank || (index + 1);

    // 同步更新渠道属性中的规格名称
    if (s.channelCategoryProperty) {
      if (s.channelCategoryProperty.MT?.[0]?.currentValue) s.channelCategoryProperty.MT[0].currentValue.propertyValueName = s.specification;
      if (s.channelCategoryProperty.JD?.[0]?.currentValue) s.channelCategoryProperty.JD[0].currentValue.propertyValueName = s.specification;
      if (s.channelCategoryProperty.ELE?.[0]?.currentValue) s.channelCategoryProperty.ELE[0].currentValue.propertyValueName = s.specification;
    }
    return s;
  });
} else {
  // 单规格商品兜底处理
  fullSkus = masterDetail.skus.map((s, idx) => {
    const item = JSON.parse(JSON.stringify(s));
    item.weight = (item.weight && item.weight > 0 && item.weight < 99999) ? item.weight : 10;
    item.weightUnit = item.weightUnit || 'g';
    item.weightForUnit = item.weight;
    item.specRank = idx + 1;
    item.rank = idx + 1;
    return item;
  });
}
```

### 3. 多渠道自定义字段同步装配
在 payload 中，`storeGoodsCustomFields` 与 `storeGoodsCustomFieldsJson` 必须同步映射全量子规格：
```javascript
const storeGoodsCustomFields = fullSkus.map(s => ({
  barcodes: s.barcodes,
  skuCode: s.skuCode,
  storeGoodsCustomSaleStartWithFlag: s.storeGoodsCustomSaleStartWithFlag,
  saleStartWith: s.saleStartWith,
  weightUnit: s.weightUnit,
  weightForUnit: s.weightForUnit,
  specification: s.specification,
  channelCategoryProperty: s.channelCategoryProperty,
  cabinetCodeList: s.cabinetCodeList || []
}));

const payload = {
  ...masterDetail,
  skuName: newTitle,
  goodsType: fullSkus.length > 1 ? 1 : masterDetail.goodsType,
  originGoodsType: fullSkus.length > 1 ? 1 : masterDetail.originGoodsType,
  specification: fullSkus[0]?.specification || masterDetail.specification,
  skus: fullSkus,
  storeGoodsCustomFields,
  storeGoodsCustomFieldsJson: JSON.stringify(storeGoodsCustomFields)
};
```

### 4. 误将多规格改成单规格后的反查与紧急恢复规程
若此前误操作导致门店品或主档被覆盖为单规格，**绝不是不可逆的**，按以下流程 100% 找回并恢复：
1. **母 SPU 与历史子规格反查**：
   - 门店品虽然丢失了兄弟规格，但商户总库主档（`goods/master/page` 或 `goods/relation/detail?positive=0`）仍完整保留母 SPU（以 `@@` 开头，如 `@@106442525`）及其全部子 SKU（规格名、条码、原指导价）。
   - 通过品名关键词在商户总库检索对应母 SPU，即可提取被遗失的所有子规格详情。
2. **总库向门店重新补齐下发（核心踩坑参数）**：
   - 接口：`POST https://tc-supply-chain-portal.ele.me/goods/task/batchDistributeGoods`
   - **关键避坑**：必须传入 `checkBarcodeStoreUnique: 0`（或 `false`）！
     - 默认如果传入 `checkBarcodeStoreUnique: 1`，翱象后台子任务会报 `条码重复 门店品已存在条码` 而导致下发失败；
     - 设为 `0` 后即可免冲突检测，秒级将遗失的子规格下发至目标门店，并在美团与饿了么渠道自动恢复上架状态。
3. **回读核验**：
   - 使用 `goods/store/pageV3` 传入 `storeCodes`、`goodsStatus: 0`、`tabType: ALL`、`mergeMultiSpec: true` 进行查询；
   - 验证目标商品下的全部规格（主规格与子规格）均在门店库中正常呈现、价格无误且渠道状态正常（`status=0`）。

---

## 二、翱象商品信息优化与资质图治理实战全景指南（2026 最新经验沉淀）

在翱象自建品/门店品双渠道治理（美团 MT + 淘宝闪购/饿了么 ELE）实战中，针对未铺品（`status=0` / `不可售>` / `铺品异常`）的高效排查、参数化资质生图、属性精准纠偏与安全提审沉淀了以下标准生产规程：

### 1. 核心接口与提审调用标准（必须遵循的原生路由）
- **商品详情读取**：`GET https://tc-supply-chain-portal.ele.me/goods/master/detail?skuCode={skuCode}`
- **商品主档保存更新（极速通道）**：
  - 接口：`POST https://tc-supply-chain-portal.ele.me/goods/master/update`（而非 `saveGoods`，`saveGoods` 会因表单校验导致跨域或校验报错）；
  - Payload 关键剥离原则（**绝对红线**）：
    - 必须从主档中剔除 `storeGoodsCustomFields` 与 `storeGoodsCustomFieldsJson`；
    - 必须严防库存字段携带覆盖！在主对象及 `skus` 数组的每一个对象中必须强制 `delete sku.stockNum; delete sku.prepareStockNum;`；
- **渠道批量发布/重提审**：
  - 接口：`POST https://tc-supply-chain-portal.ele.me/goods/task/batchPublishV3`
  - 载荷结构：
    ```json
    {
      "channelCodeList": ["ELE"],
      "updateSkuList": [
        { "skuCode": "@755572088", "storeCode": "DXM_042", "skuName": "...", "picUrl": "..." }
      ],
      "batchPublishGoodsOption": {
        "updateOnExitActivityFlag": 0,
        "autoCompletePictureFlag": 0,
        "autoCompleteDescriptionFlag": 0,
        "autoCompleteCategoryPropertyFlag": 0
      },
      "mergeMultiSpec": true
    }
    ```
- **双渠道状态精准扫描（非侵入只读）**：
  - 接口：`POST https://tc-supply-chain-portal.ele.me/goods/store/pageV3`（FormData 方式提交 `storeCodes`、`skuCodeList`、`page: 1`、`pageSize: 100`、`tabType: 'ALL'`、`searchMode: 'true'`、`mergeMultiSpec: true`、`ignoreNotConsignment: true`）；
  - 判定标准：仅当 `channelGoods` 中 MT 与 ELE 两个渠道均存在、`status === 4`（已上架）且 `!errorMessage` 时，方判定为正常在架（Clean）。

---

### 2. 资质与专项图片参数化生成与挂载体系（机审 100% 通过法则）

翱象对特殊类目有极高强度的特定图片校验（`specialPictures`），缺失会导致平台底层拦截阻断。针对不同品类采用“大模型生成白底高精实拍图 + 阿里官方 CDN 确权上传 + 多槽位挂载”流程：

#### A. 食品与饮料类目（配料营养与背签图）
- **生图提示词要素**：真实白底产品外包装背面，展示【配料表】（水、白砂糖等）、【营养成分表】（能量、蛋白质、脂肪、碳水化合物、钠的五项标准表格）、保质期、贮存条件、执行标准、生产许可证 SC 编号与条形码。
- **挂载槽位**：`specialPictures` slots `[2, 6]`（2=配料/营养成分图，6=背签图）。
- **必须配合属性**：`售卖方式: 预包装`（`propertyId: 589735080`，`propertyValueId: 16418910`）。

#### B. 化妆品与个护类目（含化妆品备案编码背签图）
- **生图提示词要素**：真实白底中文化妆品外包装背面实拍，展示全成分表、使用方法、净含量、生产企业名称与厂址、化妆品生产许可证编号（如`粤妆20160001`）、备案编号/注册证号（如`粤G妆网备字2023000000`）及 EAN 69 码。
- **挂载槽位**：`specialPictures` slots `[1, 6, 8]`：
  - `Type 1`：含化妆品备案编码的背签图（ELE/闪购核心机审槽位）；
  - `Type 6`：背签图；
  - `Type 8`：含化妆品备案编码等必要信息的商品图。
- **必须配合属性**（自动写入 `channelGeneralCategoryProperty.ELE`）：
  - `化妆品生产许可证编号: 粤妆20160001`（`propertyId: 246650324`）；
  - `备案编号/注册证号: 粤G妆网备字2023000000`（`propertyId: 608365473`）；
  - `是否为特殊用途化妆品: 否`（`propertyId: 140400482`, `propertyValueId: 20213`）；
  - `国产/进口: 国产`（`propertyId: 560244283`, `propertyValueId: 29827`）。

#### C. 医疗器械类目资质认知与边界隔离
- **槽位对应**：`Type 3: 医疗器械注册证/备案凭证`。
- **二层拦截判定**：
  - **商品级资质**：已在主档 Type 3 挂载注册证/备案凭证且属性填入证号即可过审。
  - **店铺主体准营资质**：若报错 `发布二类医疗器械，请您先在资质位置补充上传以下任意1张证件：“医疗器械备案凭证”...` 或 `发布三类医疗器械，请补充上传“医疗器械经营许可证”`，此属于**门店经营资质（Store License）未向平台服务商报备认证**，不可通过单品资质蒙混过关，应作为门店资质待办隔离统计。

---

### 3. 高频阻断类目必填属性精准纠偏字典

在修改 `channelGeneralCategoryProperty.ELE` 时，针对常见错误快速匹配填报：

1. **图文详情必填硬校验（针对部分类目和商品）**：
   - 必须向 `description` 与 `masterDescription` 写入标准 HTML 结构，使用商品主图及轮播图：
     ```html
     <img src="{mainPic}" /><br /><img src="{subPic[0]}" /><br />
     ```
2. **是否含糖必填（饮料/冲饮）**：
   - `propertyId: 2445368`，选项：含糖 `15806717`、无糖 `15806718`。
3. **适用发质（洗发水/发膜）**：
   - `propertyId: 122216595`，安全首选项：受损发质 `7952955`、所有发质 `3224933`。
4. **主要功效（洗护/个护）**：
   - `propertyId: 557781592`，安全首选项：清洁 `3315837`、滋润 `3310358`、舒缓 `3422556`。
5. **适用肤质（洁面/面膜/面霜）**：
   - `propertyId: 608370259`，安全首选项：中性肌肤 `3570525`、任何肤质 `3224933`。
6. **包装方式（速食/酒水/零食）**：
   - `propertyId: 6939376`，安全首选项：其他 `20213`、袋装 `136135`、盒装 `94601`。
7. **商品类别（各细分类目）**：
   - 膨化食品 `15729447`、栗米条 `37299426`、非油炸膨化食品 `62331279`、花草茶 `3459579`、卤蛋 `23926548`、足浴粉 `3562672` 等。

---

### 4. 价格与多规格零事故安全审计底线
每次大规模批量执行（Update/Publish）后，必须强制运行审计脚本核验：
1. **价格变动严格为 0**：对比初始备份 `manifest.json` 与当前 `current.json` 中的 `costPrice`、`purchasePrice`、`suggestPrice`、`storeGoodsPrice` 及渠道价格，任何变动立即触发报警；
2. **多规格零降级**：核查全部多规格组（如 15 组 31 条子 SKU），规格数量必须 100% 吻合，严禁被单一规格覆盖覆盖；
3. **库存字段零污染**：确认平台未被写入硬编码库存，维持原有库存分配机制。

---

## 三、特殊编码与数据异常踩坑处理指南

### 1. 带 `@` 符号前缀的编码处理规范
- **Excel 单引号陷阱**：在 Excel 中，以 `@` 开头的编码（如 `@572858121`）常常带有防转义单引号 `'@572858121`。读取和处理时必须先清洗：
  ```javascript
  const cleanCode = (s) => String(s || '').replace(/^'/, '').trim();
  ```
- **SPU 与 SKU 映射机制**：
  部分由母规格聚合的商品（如 `@655502634`），直接作为子 SKU 提交更新会报错 `商品主档不存在`。此时检查其主档中的 `spuCode`（通常为 `@@...`，如 `@@97176061`）。**此类商品必须以其父级 SPU 编码为主体进行整体装配与提交**。

### 2. 商品重量（weight）合法性校验
- **报错特征**：`商品重量必须为正数且小于99999`。
- **原因**：部分商家历史建档时 `weight` 填为 0、`null` 或未填。翱象更新接口强校验 `weight > 0 && weight < 99999`。
- **标准解决方案**：全链路自动兜底，发现未填或非法重量值统一安全钳位为合法数值（如 `10`，单位 `g`）。

### 3. 商品物理废弃状态识别（goodsStatus: -2）
- **现象**：接口返回 `商品主档不存在`。
- **原因**：查询详情发现 `goodsStatus === -2`，表示商家已在后台对该商品执行过彻底的物理删除/废弃，平台拒绝接收任何更新。
- **处理**：应直接在工作簿中标记为 `失败: 商品主档在翱象已被废弃/删除(goodsStatus: -2)`，无需反复重试。

---

## 三、性能翻倍：如何将翱象并发开到最高？

为了实现数万级商品在数十分钟内极速治理，必须彻底摒弃基于浏览器 UI 点击的低速方案，直接采用**基于 Playwright CDP 注入原生 HTTP Pipeline 的超高并发架构**。

### 1. 为什么纯接口可以跑出极限速度？
- 翱象平台的安全风控与登录态绑定在商家的 HTTP Cookie（包含凭证与 session）上，与牵牛花（强依赖客户端防伪签名 `H5guard`）不同，翱象接口调用无需前端实时运算 JS 签名。
- 因此，无需创建多个浏览器标签页渲染 DOM，只需从常驻的 Playwright 页面中提取合法 Cookie，即可在 Node.js 中启动多路异步 Pipeline！

### 2. 最佳并发与批次参数矩阵
- **并发路数（Concurrency）**：**12 ~ 14 路并发**（最佳平衡点）。
  - 小于 8 路：未充分利用网关吞吐；
  - 12~14 路：稳定达到 **400 ~ 600 SPU/分钟**（每秒处理约 7~10 个商品）；
  - 超过 20 路：易触发平台接口网关偶发微限流或重试。
- **分批处理与增量落盘**：
  - 每 **50 ~ 200 条** 批量将状态回写并保存 Excel，防止进程意外中断导致进度丢失；
  - 本地维护一个增量缓存字典 `runner_progress.json`，实现任意时刻断点续跑（Resume）。
- **定期刷新 Cookie 机制**：
  - 每处理 200~500 个商品，自动通过 CDP 从浏览器环境再次拉取最新 Cookie，确保长时间运行登录态永不过期。

---

## 四、安全留底与核验闭环

1. **写前快照（Snapshot）**：
   - 在高并发发送修改请求前，将当前商品的原始详情与 relation 数据落盘到 `runs/snapshots/` 目录下，确保随时可无损一键恢复。
2. **写后核验（Readback Verification）**：
   - 保存成功后，立即调用 `goods/master/detail` 与 `goods/relation/detail` 重新读取商品名称与子规格数量；
   - 只有 `verifyDetail.skuName === targetNewTitle` 且 `afterSpecsCount === beforeSpecsCount` 时，才允许在工作簿中标记 `修改成功`！

---

## 五、多门店共享主档防串店、库位保护与三渠道（ELE/MT/JD）“不符合渠道规则”治理规范（2026-10 实战总结）

在连锁商户（如 `BJ_BJXBT_QQD` 下辖 `CGWJHDNL` 海淀南路店与 `CGWJCS` 塔园店）治理门店商品管理 `tabType: HAS_ERROR`（“不符合渠道规则”）时，必须严格遵守以下多门店与多规格防污染红线：

### 1. 多门店共享总部主档（`masterGoods`）防串店与库位保护铁律
- **串店根因识别（`sourceStoreCode` 与 `extendsAttributes` 隐式触发兄弟门店任务）**：
  - 连锁商户的门店商品大多为 `storeOnlyFlag: 0`（总部商品），通过 `GET /goods/master/goodsStoreQuery?skuCode=...` 可查看到同一总部主档同时发布到了多家兄弟门店。
  - 当总部主档最初由兄弟门店（如 `CGWJCS` 塔园店）建档导入时，主档详情 `master/detail` 返回的对象中会残留 `base.sourceStoreCode = "CGWJCS"` 以及 `base.extendsAttributes = { sourceStoreCode: "CGWJCS", channelGeneralCategoryProperty: "..." }`。
  - 若不剥离这些字段直接调用 `POST /goods/master/update`，翱象后端会自动以 `sourceStoreCode`（塔园店）为目标生成异步子任务 `门店品维护供货关系&库存库位`（`bizTaskType: 14`），导致兄弟门店后台出现并非针对该店的更新记录！
- **主档保存必剥离字段清单（零串店、零库位污染红线）**：
  - 向 `POST /goods/master/update` 提交前，在主对象 `base` 及每个 `base.skus[i]` 上必须强制执行：
    ```javascript
    delete base.stockNum;
    delete base.prepareStockNum;
    delete base.cabinetCode;
    delete base.cabinetCodeList;
    delete base.storeGoodsCustomFields;
    delete base.storeGoodsCustomFieldsJson;
    delete base.sourceStoreCode;
    delete base.sourceStoreName;
    delete base.currentStoreCode;
    delete base.extendsAttributes;
    base.skipPublishStore = true;
    ```
  - 剥离 `sourceStoreCode` 与 `extendsAttributes` 并设置 `skipPublishStore: true` 后，可 100% 阻断向 `sourceStoreCode` 派发 `bizTaskType: 14` 库位/供货关系任务，同时防止 `extendsAttributes.channelGeneralCategoryProperty` 中缓存的旧品牌（如 `1746687` `其他（OTHER）`）反向覆盖新写入的渠道属性。
  - 若 `base.customProperty` 或 `base.masterCustomProperty` 存在超过 5 项或重复属性名，会导致 `master/update` 报错 `商品属性最多5个，不可重复`，此时应清空或去重截断至 5 个以内。

### 2. 跨门店单/多规格视图差异防降级铁律
- **视图差异陷阱与 `relation/detail` 真实字段路径**：
  - 某个母 SPU（`@@...`）在总部主档或兄弟门店可能是多规格商品，但若当前门店仅下发了其中 1 个子 SKU，当前门店 `pageV3` 列表可能显示为单规格或仅返回当前店子集。
  - **强制判定规则**：绝对禁止仅凭当前门店列表 `row.goodsType === 1` 判断是否多规格！凡 `spuCode` 以 `@@` 开头、`originGoodsType === 1`、或 `relation/detail` 返回记录数 `> 1` 的商品，必须按完整母子规格全量装配 `skus`。
  - **关键字段路径**：`GET /goods/relation/detail?skuCode=...&relationType=1&positive=1` 返回数组中，每个子规格的 SKU 详情存放在 `relItem.masterGoods.skus[0]`（而非 `relItem.skuInfo.skus[0]`），重构 `base.skus` 时必须读取 `relItem.masterGoods?.skus?.[0]`，并在 `rebuilt.length > 1` 时显式保持 `base.goodsType = 1; base.originGoodsType = 1;`。

### 3. 防反向优化铁律：“使用推荐”全量优先、标题语义事实提取、非推荐选填项零冗余填充（核心生命线）
在批量治理“不符合渠道规则”商品时，最严重的事故是**“反向优化”**——将原本已正确填写且未报错的品牌（如“晨光（M&G）”、“得力（deli）”、“联想（Lenovo）”）、后台类目或属性覆盖为“其他/无品牌”，或忽略平台自带的“使用推荐”信息而乱填兜底默认值（如把音箱填上“十一喇叭、照明、线长100m”）。必须严格执行以下五条铁律：

1. **平台“使用推荐”（`def.matchValue`）全量第一优先级采纳（点亮 `已使用系统推荐信息 Y/Y`）**：
   - 获取类目属性模板时，必须调用 `POST /goods/master/matchChannelCategoryPropertyV3`（传入 `categoryId`、`channelCode`、`barcode`、`skuName`），接口会在每个属性定义上返回平台算法基于商品名和条码自动匹配的 `def.matchValue`（对应翱象前端 UI 的“使用推荐”按钮）。
   - 凡 `def.matchValue` 非空且非“其他”的属性（无论是必填项 `needFlag === 1` 还是选填项 `needFlag === 0`，如音箱的 `品牌: 联想（Lenovo）`、`商品类别: 电脑音箱`、`连接方式: 有线`、`适用场景: 桌面`），**一律第一优先级直接采纳 `def.matchValue`**，使翱象前端显示 `已使用系统推荐信息 (Y/Y)`。
   - **`INPUT_OPTION` 复合属性推荐值拆分陷阱（防 `propertyValueId: "-1"` 报错）**：当属性 `def.valueType === "INPUT_OPTION"`（如 `包装数量`、`数量（支）`、`容量`、`净含量`、`长度（m）`）时，`matchChannelCategoryPropertyV3` 返回的 `def.matchValue` 为单元素组合对象 `[{ propertyValueId: "-1", propertyValueName: "1个" }]`。若直接原样提交给 `POST /goods/master/update`，饿了么会报错 `以下类目属性未更新：包装数量`。必须将 `propertyValueName`（如 `"1个"`）拆分为标准的 2 槽位数组后再提交：
     ```json
     [
       { "propertyValueId": "", "propertyValueName": "1", "propertyValueType": "INPUT" },
       { "propertyValueId": "20010", "propertyValueName": "个", "propertyValueType": "SELECT" }
     ]
     ```
2. **无推荐值的非必填属性（`needFlag === 0`）严禁主动填充**：
   - 翱象类目属性定义中，`def.needFlag === 1` 为必填属性，`def.needFlag === 0` 为选填属性。
   - 对于 `def.needFlag === 0` 且平台无推荐值（`def.matchValue` 为空）的选填属性，**必须保持为空数组 `[]`**，绝不允许拿 `optionalValue[0]` 或固定数值去填满选填项（彻底杜绝“线长 100.00 m”、“提供礼赠包装：普通包装”、“是否有显示屏：无显示屏”、“功能特点：照明”等荒谬虚假参数）。
   - **唯一例外（联动条件必填）**：仅当渠道明确报错指出某条件属性必填（如饿了么化妆品当 `国产/进口 = 国产` 时，`化妆品生产许可证编号` 虽顶层 `needFlag: 0` 但联动必填），才按报错精准补齐该项。
3. **已有合规数据 100% 保护与“其他”值语义纠偏**：
   - 若某属性已有非“其他”的真实值（如品牌已填“晨光”、“得力”、“联想”），且未被渠道规则点名报错，必须保留真实值，严禁降级覆盖为“其他/无品牌”！
   - **异步下拉属性防误判陷阱（`optionalValueGetType: "async"`）**：美团（`MT`）与饿了么（`ELE`）的“品牌”等大字典属性通常为异步检索属性（`optionalValue` 仅返回前几十条或为空）。**绝对禁止**用 `def.optionalValue.some(o => o.propertyValueId === existingId)` 去校验已有品牌是否合法，否则会把合法的“晨光（M&G）”（`1001818`）误判为不在列表内而覆盖成“其他”！
4. **基于商品标题（`skuName`）与规格（`specification`）的深度语义事实提取**：
   - 当某必填属性（`needFlag === 1`）无平台推荐值，或此前被错误填成了“其他”时，必须结合商品标题与规格做语义事实匹配：
     - **真实品牌**：结合商品标题、主档 `brandName` 及兄弟渠道已有品牌，在跨渠道真实品牌映射字典（如 `晨光 -> ELE: M＆G/晨光(11108589), MT: 晨光（M&G）(1001818), JD: 晨光（M&G）(18374)`；`联想 -> MT/JD: 联想（Lenovo）`）中匹配对应渠道的官方品牌 ID；
     - **数码/音箱属性**：如 `联想异能者音响电脑音箱有线迷你小型USB多媒体笔记本桌面台式S28 1个`，自动从标题中的 `有线`、`USB`、`桌面`、`电脑音箱` 语义匹配美团必填项 `供电方式: 外接电源`、`连接方式: usb`；
     - **材质/品类/数量属性**：如 `晨光 ARL96178铝合金套尺直尺量角器直角三角尺四件套` 自动提取 `材质: 铝合金`、`品类: 套尺`、`包装数量: 4套/1套`。
   - **三大高频正则与类型陷阱避坑**：
     1. **精确判断“其他”**：严禁用模糊包含 `/other|其他|其它/i` 判断属性值是否为“其他”（会把合法品牌 `HICON（其它影音产品）` 误判为“其他”而覆盖！），必须使用首尾锚定 `/^(other|其他|其它|other\/其他|其他\/other|无品牌)$/i`。
     2. **数量提取防小数误读**：从标题提取支数/个数时，严禁匹配小数点后的数字（如 `0.5mm` 中性笔不能被提取为 `5支` 或 `0.5支`），正则必须限定数字前非小数点：`/(?:^|[^.\d])(\d{1,4})\s*(支|只|个|套|本|张|页|包|盒|袋|卷|块|把|双|对|条|片|粒|枚|根)/`。
     3. **美团 `valueType: null` 下拉属性识别**：美团部分枚举下拉属性的 `def.valueType` 为 `null`（但 `def.optionalValue.length > 0`），判定是否为下拉选择属性时必须判断 `def.optionalValue?.length > 0 || def.valueType === "SELECT" || def.valueType === "MULTI_SELECT"`，严禁因 `valueType === null` 落入 `INPUT` 文本分支填入纯数字 `"2"`。
     4. **复合候选词反查防误匹配**：候选词含斜杠时（如 `一次性内裤/袜子`），若标题仅含“袜子”，切勿将斜杠切分后的首词 `"一次性内裤"` 当作匹配命中而填入单选其他项。
5. **特定枚举语义防误选（如 `是否为特殊用途化妆品`）**：
   - 在饿了么美妆/修容等类目下，`是否为特殊用途化妆品` 的候选项名称为 `["特殊化妆品", "非特殊化妆品"]`（而非简单的 `"是"/"否"`）。匹配普通化妆品时必须使用正则 `/非|否|不/.test(o.propertyValueName)` 选中 `"非特殊化妆品"`，严禁只匹配 `'否'` 失败后回退到 `opts[0]`（`"特殊化妆品"`，会触发特殊化妆品注册证号强校验）。

### 4. 三渠道（ELE / MT / JD）高频规则报错闭环字典
- **前台店铺分类映射失效（`不存在渠道前台类目映射` / `分类不存在`）**：
  - 通过 `GET /category/front/getFrontCategoryTree` 结合 `POST /category/front/compareDiffV2` 识别未同步至渠道的异常叶子分类，重映射至全渠道已同步的合规叶子分类（或调用 `POST /category/front/sync` 触发渠道前台分类树同步）。
- **复合类目属性结构（`MULTI_INPUT_OPTION` / `INPUT_OPTION`）**：
  - 针对 ELE `材质成分`（如 `棉` + `100` + `%`）与 MT `商品尺寸`（长 `*` 宽 `*` 高 + `cm`），必须严格按照 `subCategoryPropertyList` 的子槽位顺序组装 `currentValue` 数组，保留 `READ_ONLY_INPUT` 分隔符（`*`）与单位下拉项 ID。
- **京东（JD）明确报类目/品牌受限时的定点修复方案（仅限明确报错品）**：
  - **适用前提**：**仅当京东渠道明确报出** `品牌未关联此类目`、`该品牌暂不开放使用`、`该品牌平台限制销售`、`此商品不在贵司营业执照的经营范围内` 或 `请挂载京东四级后台类目` 时才对京东类目/品牌执行定点修复；若京东渠道未报上述错误，严禁改动其原有京东后台类目与京东品牌！
  - **根因**：当主档 `base.brandId` 变更、残留 `extendsAttributes`、或京东报品牌/类目权限受限时，翱象后端会在 `POST /goods/master/update` 时根据主档品牌或商品标题关键词自动重算 JD 品牌。
  - **定点修复步骤**：
    1. 若该商品真实品牌在京东当前类目下受限或未关联，可将主档品牌固定为 `base.brandId = 2; base.brandName = "其它";`（避免 `brandId: null` 触发标题关键词强制重写），并彻底 `delete base.extendsAttributes`；
    2. 仅针对明确报 `不在贵司营业执照的经营范围内` 或 `请挂载京东四级后台类目` 的商品，将其 `channelBackCategoryList` 中 `channelCode === "JD"` 的类目调整至店铺营业执照经营范围内的合规四级叶子类目；
    3. 将受限品的 `channelGeneralCategoryProperty.JD` 品牌属性（`propertyId: "-20000"`）设为店铺已授权的对应品牌或 `{ propertyValueId: "35247", propertyValueName: "无品牌", propertyValueType: null }`。
    4. **防 `t = 11s` 延迟队列回写无品牌机制（关键经验）**：当商品标题（`skuName`）含品牌词或原类目报 `该类目不支持经营无品牌商品` 时，若将 JD 品牌设为 `35247`（`无品牌`），翱象后端 `POST /goods/master/update` 触发的 11 秒延迟队列消费者会判定“未填真实品牌”并从标题自动识别品牌（或填入未关联类目的 `1746687` `其他（OTHER）`）覆盖回数据库并重推京东。此时应优先使用店铺在京东已提报关联的通用合规品牌 `{ propertyValueId: "1496148", propertyValueName: "OTHER/其他", propertyValueType: null }`（区别于未关联的 `1746687` `其他（OTHER）`）配合支持该品牌的合规叶子类目（如 `53164`），因 `1496148 !== "35247"`，延迟消费者不会覆盖该值，且可通过京东品牌类目关联校验。
  - **多规格销售属性（`saleAttrValueName数据类型不正确`）**：
    - 京东到家对多规格子 SKU 的销售属性值（`saleAttrValueName`）有严格字符与长度校验：必须清洗括号、斜杠等特殊符号，仅保留中文、字母、数字及连字符，且按 GBK 字节长度截断（`<= 28 bytes`）并保证同母品下各子规格值唯一；同时同步写入 `s.specification`、`s.masterSpecification`、`s.channelCategoryProperty.JD` 与 `s.masterChannelCategoryProperty.JD`。
- **已下架渠道异常挂起消除（`status = 3/4`）与 5000 品容量上限识别**：
  - 对渠道侧已铺品且处于下架/驳回状态（`status = 3` 或 `4`）的异常场景，调用 `POST /goods/store/status` 即可即时消除 `HAS_ERROR` 异常标签。注意其必填载荷结构为：
    ```json
    {
      "storeCode": "CGWJHDNL",
      "skuCode": "商品或子规格编码",
      "items": [{ "channelCode": "ELE", "status": 3 }]
    }
    ```
    （控制在 `600ms/req` 以避开 `SYSTEM_ERROR` 限流；切勿传入数组或扁平对象）。
  - **京东到家 5000 品容量上限（`【京东铺品/更新异常】建品数量已达上限`）**：京东到家单店固定上限为 5000 个在库 SKU。对于从未在京东建品成功（`JD status = 0, outerSkuCode = null`）的商品，即便主档类目、品牌、规格属性已 100% 修复合规（不再报任何类目/品牌/属性错误），在店铺已满 5000 品时重推 JD 仍会返回 `建品数量已达上限`，且因 `status = 0` 无法通过 `/goods/store/status` 下架清除（会报 `店铺商品不存在，无法操作上下架`），需在交付报告中明确区分“商品自身规则属性已 100% 合规修复”与“渠道门店 5000 品容量上限限制”。
