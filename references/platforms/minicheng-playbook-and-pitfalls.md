# mini橙 (MiniCheng) 平台商品治理实战操作规程与防坑指南

本文档总结了在 mini橙 2.0（澜橙数字门店中台：`mini.guodongcheng.cn`）进行数千至数万级商品全量渠道属性治理（美团属性、淘宝闪购属性）过程中的全链路业务原理、识别与填充算法、底层避坑指南、极速高并发优化策略以及实战中必须遵守的硬性业务契约。

---

## 一、系统架构与鉴权会话（Architecture & Auth Session）

### 1.1 平台技术栈与接口网关
- **前端门户**：`https://mini.guodongcheng.cn/`（Vue 2 + Element UI + Vuex + vue-router）
- **后端网关**：`https://emallopen.guodongcheng.cn/merchant_api/`
- **鉴权契约**：标准 HTTP Header `Authorization: Bearer mini_<jwt_token>`
- **安全特点**：
  - 无需前端 V8 动态反爬签名（无 H5guard / A9 等高复杂度加密锁）；
  - 接口网关吞吐极高，天然支持并发 API 调用；
  - 核心治理接口为标准 RESTful JSON 或 `x-www-form-urlencoded`。

### 1.2 零人工输入的 CDP 免登 Token 提取
在实战生产环境中，商家往往已在本地 Chrome 中扫码登录 mini橙后台。通过 Chrome DevTools Protocol (CDP, 如 `127.0.0.1:9223`) 建立连接，无需输入账号密码或短信验证码，秒级自动提取有效登录态：

```javascript
import { chromium } from 'playwright-core';

export async function getMiniChengAuth(cdpPort = 9223) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap(c => c.pages());
  const miniPage = pages.find(p => p.url().includes('mini.guodongcheng.cn'));
  if (!miniPage) {
    throw new Error('未找到已打开 mini.guodongcheng.cn 的浏览器标签页');
  }
  const token = await miniPage.evaluate(() => localStorage.getItem('token'));
  if (!token) throw new Error('localStorage 中未检测到 Authorization Token，请先登录后台');
  return { browser, miniPage, token };
}
```

---

## 二、如何精确识别需要填写的内容（Identification & Schema Discovery）

要实现“100% 满属性覆盖、零漏项”，治理引擎必须精准穿透平台类目树，识别哪些属性是必填、哪些是可选、每个属性接受何种数据格式与选项字典。

### 2.1 渠道类目推导（Category Recommendation）
mini橙支持针对多渠道分别绑定后台类目。在治理前，首先基于商品的条形码（UPC）与商品名称，通过官方类目推荐接口获取最匹配的叶子类目：
- **端点**：`POST /product/cat/recommendCat`
- **载荷**：`upcCode=<upc>&name=<productName>&channelCode=<MEI_TUAN | E_BAI>`
- **返回值**：返回推荐的叶子类目列表，按匹配度降序排列。提取置信度最高的 `catId` 与 `catName`。

### 2.2 渠道属性骨架获取（Attribute Schema Query）
美团外卖与淘宝闪购在 mini橙后台具有不同的属性元数据接口：
1. **美团外卖属性元数据**：
   - **端点**：`POST /product/cat/queryMtCatAttrList`
   - **参数**：`catId=<美团类目ID>`
   - **返回结构**：包含 `attrId`, `attrName`, `isRequired`, `attrValueType`, `valueList`（候选字典 `[{ valueId, valueText }]`）。
2. **淘宝闪购（饿了么）属性元数据**：
   - **端点**：`POST /product/cat/queryStoreEleCatAttrList`
   - **参数**：`storeCode=<门店编码>&catId=<闪购类目ID>`
   - **返回结构**：包含 `propId`, `propText`, `isRequired`, `valueType`, `valueList`。

### 2.3 官方 AI 智能属性推荐（Official AI Recommendation）
mini橙官方提供了大模型与规则驱动的 AI 属性推荐接口，置信度极高，应作为第一填充优先级：
- **端点**：`POST /product/cat/aiRecommendCatAttr`
- **参数**：`catId=<类目ID>&productName=<商品名称>&channelCode=<MEI_TUAN | E_BAI>&storeCode=<门店编码>`
- **返回结构**：包含官方识别出的属性推荐值映射 `[{ attrId / propId, recommendValue, valueId }]`。

### 2.4 属性分类解析与多形态适配规则
属性元数据中存在多种数据类型，引擎必须根据 `attrValueType`（美团）与 `valueType`（闪购）进行精确映射：
1. **单选下拉属性（Select / Enum）**：
   - `attrValueType === 1` 或 `"1"` / `valueType === 1`；
   - 必须从 `valueList` 中匹配唯一的合法 `valueId` 和 `valueText`。严禁随意填写不在字典列表中的字符串，否则前端渲染与网关校验均会报错。
2. **多选属性（Multiple Select / Checkbox）**：
   - `attrValueType === 2` 或 `"2"` / `valueType === 2`；
   - 提取字典列表中匹配的多个选项，组装为数组或逗号分隔结构。
3. **纯文本 / 数字输入框（Input Text / Number）**：
   - `attrValueType === 3` 或 `"3"` / `valueType === 3`；
   - 填入清洗后的字符串或数值（如净含量、型号、面料成分等）。
4. **单位 / 复合属性（Compound Unit Attribute）**：
   - 如酒精度（`≥4.3%vol`）、麦汁浓度（`9.5°P`）、保质期（`360天` 或 `12个月`）；
   - 必须通过格式解析器规范单位后缀与数值范围，不可填入不合规文本。

### 2.5 智能兜底推导字典与 100% 满属性策略
当官方 AI 未能提供推荐值时，必须通过商品标题（`productName`）与上下文规则进行智能推导，绝不留白：
- **品牌（Brand）**：
  - 第一步：提取标题中的书名号/中括号内容（如 `【云南白药】` -> 品牌：`云南白药`）；
  - 第二步：提取标题空格前的第一个词；
  - 第三步：在类目选项列表 `valueList` 中模糊匹配；
  - 第四步：若选项中均无匹配，**强制对齐字典中的“通用” / “其他” / “无品牌” / “other/其他”**，并提取其对应的 `valueId`。
- **产地（Origin）**：
  - 美团外卖属性：对齐为 `中国`（`valueId: 100000050` 等相应字典项）；
  - 淘宝闪购属性：对齐为 `中国大陆` 或 `中国`。
- **保质期（Shelf Life）**：
  - 从标题中提取数字（如“保质期12个月”）；
  - 饮料/啤酒/零食常规默认推导为 `270` 或 `360` 天；若为天数字段则填数字，若为下拉框则匹配合规选项。
- **包装方式（Packaging）**：
  - 从标题匹配关键词：“袋装”、“瓶装”、“盒装”、“罐装”、“散装”、“包”，对齐候选字典。
- **规格 / 净含量（Specification / Net Content）**：
  - 提取正则 `(\d+(\.\d+)?)\s*(ml|g|kg|l|毫升|克|千克|升|片|支|个)`，填入对应净含量和规格框。
- **面料成分 / 材质（Fabric / Material）**：
  - 服装针织类对齐“聚酯纤维100%”或“棉”；日用塑料类对齐“PP”或“硅胶”。
- **适用人群（Target Audience）**：
  - 优先从标题识别“儿童”、“婴儿”、“学生”、“老人”；未注明时统一对齐“成人”或“通用”。

---

## 三、如何规范填充与提交保存（Payload Assembly & Storage Contract）

### 3.1 商品实体更新端点
- **端点**：`POST /store/product/updateProductDetail`
- **Header**：`Authorization: Bearer <token>`, `Content-Type: application/json`

### 3.2 完整请求载荷组装范式
在提交保存时，必须保留原有商品的所有关键主档属性（如价格、条码、原图等），仅对美团属性与淘宝闪购属性实施针对性写入：

```javascript
const updatePayload = {
  // 1. 基础商品与门店标识（原值透传）
  storeCode: currentStoreCode,
  productCode: rawDetail.productCode,
  productName: rawDetail.productName,
  upcCode: rawDetail.upcCode,
  unit: rawDetail.unit,
  minStockNum: rawDetail.minStockNum,
  storageCondition: rawDetail.storageCondition || '常温',
  
  // 2. 渠道类目映射（原值或智能推荐值透传）
  mtCatId: rawDetail.mtCatId || recommendedMtCatId,
  eleCatId: rawDetail.eleCatId || recommendedEleCatId,
  
  // 3. 美团渠道属性（必须为 JSON 序列化字符串）
  mtCatAttr: JSON.stringify(assembledMtCatAttrArray),
  
  // 4. 淘宝闪购渠道属性（必须双轨同时提交！）
  eleCatPropertyList: assembledEleCatPropertyList, // 标准对象数组
  eleCatAttr: JSON.stringify(assembledEleCatAttrArray), // 字符串数组，必须包含 propId！
  
  // 5. SKU 规格列表（必须清洗重量，原样保留条形码与价格）
  skuList: rawDetail.skuList.map(sku => ({
    ...sku,
    // 强制重量合规校验：必须 > 0
    weight: (sku.weight && Number(sku.weight) > 0) ? Number(sku.weight) : 10,
    costPrice: sku.costPrice,
    sellPrice: sku.sellPrice,
    memberPrice: sku.memberPrice
  })),
  
  // 6. 资质图原值隔离保护（严格禁止修改）
  specialPictureList: rawDetail.specialPictureList || [],
  eleSpecialPictureList: rawDetail.eleSpecialPictureList || []
};
```

---

## 四、重大避坑指南与深度踩坑总结（Pitfalls & Gotchas）

这是在数千个商品实战治理中摸索出的**核心经验血泪史**，任何一条疏漏都会直接导致治理失败或页面渲染异常。

### ⚠️ 避坑 1：Vue 前端美团属性空白陷阱（类型失真与选项未对齐）
- **现象**：调用接口返回 HTTP 200 保存成功，后台数据库也存入了数据；但人工在浏览器进入商品编辑页时，**美团属性的所有下拉框依然全部显示为空白**！
- **底层根因**：
  1. mini橙后端返回的类目属性定义中，`attrValueType` 是**字符串类型**（如 `"1"`）而非数值 `1`。如果在组装逻辑中使用了强类型严格等于判断 `attr.attrValueType === 1`，条件将直接判定为 false，导致没有赋给合法的 `valueId`，回退成了 `{ valueId: "" }`。
  2. mini橙前端 Vue 组件在渲染美团属性时，`detailShowAttr()` 方法执行如下校验：
     ```javascript
     valueList.some(e => e.valueId === item.valueId)
     ```
     如果传入的 `valueId` 为空或者与类目候选字典对不上，Element UI 的 `el-select` 无法找到匹配的 Option，直接将前端表单字段 `attrForm[item.attrId]` 置空！
- **避坑解法**：
  - 强制对属性类型做数值转换：`const vType = Number(attr.attrValueType)`；
  - 单选下拉属性必须在 `attr.valueList` 中匹配真实的 `valueId` 并同时写入 `valueId` 与 `valueText`。

### ⚠️ 避坑 2：Vue 前端淘宝闪购属性空白陷阱（双轨结构缺失 propId）
- **现象**：美团属性已能正常渲染，但**淘宝闪购（饿了么）属性在 Vue 前端 UI 上全部呈现空白输入框**。
- **底层根因**：
  - 淘宝闪购属性在 mini橙底层需要**双轨结构同步存储**：
    - `eleCatPropertyList`：给后端持久化储存的对象数组；
    - `eleCatAttr`：给前端 Vue 界面绑定的 JSON 字符串！
  - mini橙 Vue 前端组件的 `detailShowEle()` 源码逻辑深度依赖每个属性对象中的 **`propId`**：
    ```javascript
    // 前端 Vue 解析源码示意
    JSON.parse(eleCatAttr).forEach(t => {
      this.eleForm[t.propId] = t.valueId ? t.valueId : t.valueText;
    });
    ```
    如果只提交了 `eleCatPropertyList`，或者在 `eleCatAttr` 字符串中只保存了 `{ name, value }` 而**缺失了 `propId`**，前端的 `this.eleForm` 将完全无法接收到任何 Key，导致页面视觉上所有闪购属性框空空如也！
- **避坑解法**：
  必须同时在 payload 中装配两个字段，且 `eleCatAttr` 必须序列化为携带 `propId` 的对象数组：
  ```javascript
  const eleCatAttr = eleCatPropertyList.map(item => ({
    propId: Number(item.propId),
    propText: item.propText,
    valueId: item.valueId || null,
    valueText: item.valueText || ""
  }));
  payload.eleCatPropertyList = eleCatPropertyList;
  payload.eleCatAttr = JSON.stringify(eleCatAttr);
  ```

### ⚠️ 避坑 3：Windows 运营台账 EBUSY 文件锁陷阱
- **现象**：在数千件商品批量治理运行期间，用户经常会直接用 Excel 双击打开正在写入的 `minicheng_operation_table.csv` 查看进度。此时 Windows 系统会对文件加持排他性独占锁（Exclusive Lock），导致 Node.js 写入报错：
  `Error: EBUSY: resource busy or locked, open '...minicheng_operation_table.csv'`，导致批量任务异常闪退。
- **避坑解法**：
  在导出台账时使用 `try-catch` 捕获 EBUSY 异常，并自动降级写入备用文件：
  ```javascript
  try {
    fs.writeFileSync(primaryCsvPath, csvContent, 'utf-8');
  } catch (err) {
    if (err.code === 'EBUSY') {
      const fallbackPath = primaryCsvPath.replace('.csv', '_latest.csv');
      fs.writeFileSync(fallbackPath, csvContent, 'utf-8');
      console.warn(`[File Lock Guard] 主台账被 Excel 独占，已安全降级写入: ${fallbackPath}`);
    } else {
      throw err;
    }
  }
  ```

### ⚠️ 避坑 4：商品重量非正数校验拦截（`重量必须为正数`）
- **现象**：部分轻小件商品（如美妆小样、饰品、胶带）在线下录入时重量为 `0` 或留空。调用 `updateProductDetail` 时，mini橙后端会返回：`code: 500, message: "重量必须为正数"`，导致整件商品更新失败。
- **避坑解法**：
  在装配 `skuList` 时，强制进行重量合规归一化：
  ```javascript
  const weight = Number(sku.weight);
  sku.weight = (weight && weight > 0) ? weight : 10; // 默认合规兜底 10g
  ```

### ⚠️ 避坑 5：商品已在门店删除或条码跨品冲突
- **现象**：
  - 报错 1：`queryProductDetail failed: 未查询到此商品！`；
  - 报错 2：`[3328196889]规格已存在于其它商品中`。
- **底层根因**：
  - 报错 1 是因为商品在批量任务启动前已被操作人员从门店物理删除，但仍残留于某些历史缓存列表；
  - 报错 2 是因为该商品的子规格条形码在线下与其他独立商品的条形码重复绑定，mini橙唯一性索引校验阻断保存。
- **避坑解法**：
  在治理流水线中捕获这两种异常，标记为“不可操作数据冲突”，记录于 Ledger 中并记录详细原因，绝不能让单个脏数据阻塞整体数千件商品的批量治理大盘。

### ⚠️ 避坑 6：规则 35 赠品礼盒全量否定契约（绝不虚假承诺，零赠送铁律）
- **红线规定（最高铁律：绝不向消费者承诺任何额外赠品，mini橙与美团/牵牛花规范完全一致）**：
  任何涉及“是否提供礼品包装”、“是否赠送开瓶器/杯子/吸管/餐具/封口夹/礼袋”等属性：
  - **严禁**误选为“提供礼赠包装”、“赠开瓶器”、“赠一次性纸杯”、“赠封口夹”、“礼袋装”或“定制礼盒装”；
  - **必须**强制选择明确否定项（如 `普通包装`、`非礼盒装`、`不赠送`、`不赠`、`不赠杯子`、`无吸管`、`无餐具`、`无礼袋`、`无`、`否`），杜绝诱导消费者造成虚假宣传与线下门店履约索赔！
- **AI 推荐拦截与前置覆盖机制**：
  官方 `aiRecommendCatAttr` 或已有类目推荐常带有“赠开瓶器”、“赠一次性纸杯”等肯定项。引擎必须在采纳 AI 推荐值**之前**与**之后**均设立双重拦截关卡：
  ```javascript
  // 前置拦截：若属性属于赠送类，直接从候选字典锁定否定项
  if (isGiftOrGiveawayAttr(propName)) {
    const negOpt = resolveNegativeGiftOption(prop.propertyValues || [], propName);
    if (negOpt) val = negOpt.valueData || negOpt.value;
  }
  // 后置拦截：若 AI 返回了肯定项，强制篡改为否定项
  if (isGiftAffirmativeValue(val)) {
    const negOpt = resolveNegativeGiftOption(prop.propertyValues || [], propName);
    val = negOpt ? (negOpt.valueData || negOpt.value) : (prop.required ? '普通包装' : null);
  }
  ```

### ⚠️ 避坑 7：资质图隔离原则（Zero-Qualification Modification）
- **红线规定**：
  当任务约定为“只填写美团属性和淘宝闪购属性”时，**严禁修改 `specialPictureList` 与 `eleSpecialPictureList`**。必须完全透传原始快照中的图片 URL，绝不能擅自清空、重新生成或添加水印。

### ⚠️ 避坑 8：单位缺失与裸数字洗脱陷阱（Unit Standardization Matrix）
- **现象**：
  部分商品在后台虽然填写了净含量（如 `97`、`500`）或保质期（如 `270`、`365`），但在前台或审核视角被判定为“未填写单位”或“数据不完整”。
- **底层根因**：
  1. **淘宝闪购序列化剥离单位**：在淘宝闪购（`eleCatPropertyList`）处理包含 `options` 的结构属性时，历史代码常执行 `valText = num`，将单位从文本中剥离，导致前台和 `eleCatAttr` 只呈现纯裸数字 `97` 或 `500`；
  2. **缺少自动单位推导补全**：若 AI 或原始数据返回裸数字，未结合商品标题与品类特征推导物理单位（液体对应 `ml`、固体对应 `g`、保质期对应 `天`）。
- **避坑解法与标准化单位矩阵**：
  | 属性类型 | 目标字段名 | 规范格式与单位 | 示例 | 默认兜底 |
  |---|---|---|---|---|
  | 净含量 / 容量 | `净含量`, `单件净含量`, `总净含量`, `单规格容量` | 数字 + `g`/`ml`/`kg`/`L` | `97g`, `500ml`, `1.5L` | 液体 `500ml` / 固体 `100g` |
  | 包装件数 / 数量 | `数量`, `个数`, `片数`, `抽数`, `双数`, `支数`, `盒数` | 整数 + `只`/`个`/`片`/`抽`/`双`/`支`/`盒` | `1只`, `20只`, `10片`, `100抽` | 收纳袋等推导 `1只`（Type 10 模板: option 605），日用品 `1个` |
  | 保质期 | `保质期` | 整数 + `天` | `270天`, `365天`, `1095天` | 食品 `270天` / 日化 `1095天` |
  | 啤酒麦汁浓度 | `麦汁浓度` | 浮点/整数 + `°P` | `8°P`, `10.5°P` | `8°P`（Type 10 模板: option 501） |
  | 酒精度 | `酒精度`, `酒精含量` | `≥` + 浮点 + `%vol` | `≥4.3%vol`, `≥13%vol` | `≥4.3%vol`（Type 10: option 500） |
  | 线缆长度 | `线长`, `电源线长`, `全长` | 浮点 + `m` (限制 0-5m) | `1.5m`, `1.8m` | `1.5m`（Type 10: option 702） |
  | 丝袜厚度 | `丹尼数` | 整数 + `D` | `80D`, `120D` | `80D` |
  | 家纺/配件尺寸 | `尺寸` | 长 + 宽 + `cm`/`mm` | `150cm*200cm`, `280mm` | `150cm*200cm` |

### ⚠️ 避坑 9：非服饰品类误打棉面料陷阱（Type 10 Fabric Scoping）
- **现象**：
  在美团类目属性中，啤酒的 `麦汁浓度`、`酒精度`、杯子的 `主杯容量`、数据线的 `线长` 被错误填充为 `棉100%`。
- **底层根因**：
  美团后台对复合结构属性统一标定为 `attrValueType === 10`。早期的泛化逻辑直接使用 `if (attrValueType === 10 || attrName === '面料成分') val = '棉100%'`，盲目将所有 Type 10 复合属性当成服装面料处理。
- **避坑解法**：
  建立严格的品类物理边界判定 `isClothingCategory(title, catPath)`：
  只有当品类或标题明确包含服装家纺（`服装|内衣|睡衣|外套|卫衣|裤|袜|T恤|裙|泳衣|保暖衣|文胸|毛衣|大衣|风衣|服饰|家纺|床单|被套|毛巾`）时，才允许注入棉/聚酯纤维；其他非服饰复合属性必须严格路由至专用结构体（麦汁浓度 `501 °P`、酒精度 `500 %vol`、容量 `300 mL`、线长 `702 m`）。

---

## 五、如何达到最快速度处理填写任务（High-Throughput Optimization）

### 5.1 架构升级：Headless REST API 代替 DOM 点击
- **传统方式**：通过 Puppeteer/Playwright 模拟人工点击输入框、选择下拉列表，单品耗时 15 ~ 30 秒。处理 4,600+ 商品需 20 ~ 38 小时，极易因网络卡顿或弹窗报错崩溃。
- **极速方案**：直接提取 Bearer Token，通过纯 HTTP REST 接口与 mini橙后端交互。单品耗时仅 30 ~ 50 毫秒，4,600+ 商品全量治理、快照与验证仅耗时 **3 ~ 5 分钟**，效率飞跃提升 **300+ 倍**！

### 5.2 异步高并发 Worker 协程池
采用 Node.js 异步非阻塞架构，配置 8 ~ 12 路并发 Workers：
```javascript
async function runConcurrentPool(tasks, concurrency, workerFn) {
  let index = 0;
  const workers = Array(concurrency).fill(null).map(async () => {
    while (index < tasks.length) {
      const current = tasks[index++];
      await workerFn(current);
    }
  });
  await Promise.all(workers);
}
```

### 5.3 类目属性骨架进程内内存缓存（In-Memory Schema Cache）
全店 4,600+ 商品虽然数量庞大，但实际所属的叶子类目通常只有 100 ~ 300 个。
引擎在内存中维护 `catAttrMap = new Map()`：
- 首次遇到某一类目时调用 `queryMtCatAttrList` 与 `queryStoreEleCatAttrList`；
- 后续同类目商品直接命中内存缓存，**消除 90% 以上的重复类目网络请求**，大幅降低网关压力。

### 5.4 增量式断点续传流水账本（Resumable Ledger）
所有处理结果以增量模式实时写入 `artifacts/minicheng_progress_ledger.jsonl`：
- 脚本中途意外中断或人为终止后，重新运行时第一毫秒即从 Ledger 加载所有已成功的 `skuId` 集合并直接跳过，零重复开销。

---

## 六、用户未提到但实战中必须要做的关键硬约束（Essential Unmentioned Hard Requirements）

在大型真实商户后台操作中，除基本要求外，以下点是确保系统健壮、数据安全、可审计交付的**必备防护网**：

### 6.1 修改前 100% 全量快照留存与随时一键回滚
在调用 `updateProductDetail` 实施任何写入之前，**必须强制调用 `queryProductDetail`** 获取完整的原始商品 JSON 数据，持久化落盘至：
`artifacts/snapshots/minicheng_${storeCode}/${productCode}_${skuId}.json`
- **一键回滚脚本**：必须配套提供 `restore_product_snapshot.mjs`：
  - 单品回滚：`node restore_product_snapshot.mjs --sku-id <skuId>`
  - 整店灾备回滚：`node restore_product_snapshot.mjs --all`

### 6.2 完备的 CLI 调度矩阵
生产级治理引擎必须具备细粒度的命令行执行参数，以支持局部灰度验证与运维复核：
- `--sku <skuId>`：单品点对点定向治理，便于开发调试；
- `--scope-limit <N>`：前 N 条灰度试跑（如前 3 个、前 100 个），人工核验无误后再放开全量；
- `--page-range <start,end>`：按页码区间分段执行；
- `--concurrency <N>`：动态调整并发度（默认 8，最大 15）；
- `--force`：强制重新扫描覆盖已有记录。

### 6.3 标准 4 列表格规范（UTF-8 BOM CSV + JSON）
交付给业务人员的台账必须符合统一契约：
- **列名**：`商品名称`、`spu`、`填入内容`、`状态`
- **CSV 编码**：必须在文件开头写入 UTF-8 BOM 字符（`\uFEFF`），否则 Windows Excel 打开直接出现中文字符乱码。

### 6.4 真实浏览器 UI 抽检与截图存证（Visual Readback Verification）
仅凭服务端返回 HTTP 200 不能算作交付完成！治理引擎必须在治理结束后，随机抽取头部、中部、尾部若干个商品，在 CDP 浏览器中真实导航至商品编辑页，肉眼和截图核实 Element UI 视图上美团属性与闪购属性均已正确显示，并保存高清截图至 `scratch/` 目录供终检验收。

---

## 七、按平台分类与按需渐进加载体系（Platform Modularization）

为了防止跨平台配置污染，遵循 Skill 的**渐进式按需披露（Progressive Disclosure）**架构：
1. **平台路由入口**：`scripts/route_skill.py`
   - 识别请求中的平台标识（`mini橙`、`minicheng`、`guodongcheng.cn`）；
   - mini橙作为独立宿主平台，自动卸载下游被管理的渠道平台（美团、饿了么），独占会话上下文。
2. **机器能力表**：`scripts/capability_registry.json`
   - 注册 `minicheng` 平台适配器 `references/platforms/minicheng.md`；
   - 关联任务 `channel_attributes_only` 与 `plugin_attribute_fill`；
   - 关联叶子合同 `references/platforms/minicheng-playbook-and-pitfalls.md`。
3. **按需加载顺序**：
   - 治理请求触发时，路由器仅加载 mini橙适配器与防坑手册，严禁越界读取无关平台（如牵牛花、翱象）的私有合同，确保 Context 紧凑高效。
