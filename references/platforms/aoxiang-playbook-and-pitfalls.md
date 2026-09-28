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

---

## 二、特殊编码与数据异常踩坑处理指南

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
