# Multiplatform Product Operations - Workspace Operational Rules

This repository contains multiplatform product operations, governance pipelines, and platform contracts for Meituan, Qianniuhua, Taobao Shanggou (E_BAI), JD, and MiniCheng (mini橙).

---

## 🚨 MiniCheng (mini橙) Top Ironclad Rules (必须无条件遵守)

When working on MiniCheng (mini.guodongcheng.cn / `storeCode: 33280018`) product governance or editing products, ALL AGENTS MUST unconditionally follow these hard constraints:

### 1. 单位防漏双轨铁律（Dual-Track Unit Standardization - 严禁留白与裸数字）
在 mini橙 中，“单位”存在**商品级销售单位**与**平台类目扩展属性**双层语义，必须 100% 实施双轨填充与绑定：
- **商品级销售单位（`skuList[i].unit`）**：
  - 严禁保持为空字符串 `""`！
  - 必须调用 `extractSkuUnit(title, spec)` 从标题与规格中智能提取注入：`袋`、`只`、`个`、`瓶`、`盒`、`套`、`份`、`支`、`条`、`双`、`罐`、`听`、`桶`、`箱`。
  - 示例：`5ml/袋` -> `袋`；`1个/份` -> `份` / `个`；`1套` -> `套`；`330ml/听` -> `听`。
- **美团复合属性单位（`struct_attr_template`）**：
  - Type 10 模板 sequence 1 填数字，sequence 2 **必须绑定具体单位 Option**（如数量选 `605: 只`、净含量选 `300: mL`）；
  - 确保美团 Vue 前端组件下拉框 100% 显示选中单位。
- **淘宝闪购属性单位（`eleCatPropertyList` / `eleCatAttr`）**：
  - `propertyValues.valueData` 必须保留完整物理单位（如 `5ml`、`1只`、`270天`），严禁剥离为裸数字 `5` 或 `1`。
- **标准化物理单位对照**：
  - 净含量/容量：液体必须带 `ml`/`L`，固体必须带 `g`/`kg`；
  - 物理件数/数量：必须带 `只`/`个`/`片`/`抽`/`双`/`支`/`盒`/`套`；
  - 保质期：必须带 `天`（如 `270天`、`365天`、`1095天`）；
  - 麦汁浓度 `°P`（Type 10: 501）、酒精度 `≥X%vol`（Type 10: 500）、线长 `Xm`（Type 10: 702）、丹尼数 `XD`、尺寸 `长*宽cm`。

### 2. 规则 35 零赠品铁律（Zero Affirmative Gifts - 绝不虚假承诺）
- 涉及开瓶器、杯子、吸管、餐具、封口夹、礼品包装、赠品等任何属性：
- **100% 严禁**选择肯定项（如“赠开瓶器”、“赠一次性纸杯”、“提供礼赠包装”）；
- **必须强制选择明确否定项**（`不赠送`、`普通包装`、`无赠品`、`非礼盒装`、`无吸管`、`无餐具`、`无礼袋`、`无`、`否`），杜绝门店履约索赔。

### 3. 非服饰类目面料成分隔离
- `面料成分: 棉100%` 仅允许出现在服装纺织品类（`isClothingCategory`）；
- 酒水、数码、日用等非服饰类目的复合属性（麦汁浓度、酒精度、容量、线长）严禁误填为面料棉，必须装配各自专用结构体。

### 4. 资质图绝对隔离保护（Zero Qualification Modification）
- `specialPictureList` 与 `eleSpecialPictureList` 默认透传原值快照中的图片 URL，严禁清空或缩短；本次任务明确要求补图时，允许按 [`upstream-image-generation.md`](references/upstream-image-generation.md) 的上游生图链路生成并追加新 URL。

### 5. 修改前 100% 全量快照与随时回滚
- 在调用 `updateProductDetail` 前，必须通过 `queryProductDetail` 获取完整原始商品实体，落盘至 `artifacts/snapshots/minicheng_${storeCode}/`。
- 回滚脚本：`scripts/platforms/minicheng/restore_product_snapshot.mjs`。

### 6. 网关限流保护（QPS <= 2.5）
- mini橙接口网关（`emallopen.guodongcheng.cn`）单租户上限约 2.0~2.5 QPS；
- 推荐使用 5 并发（配合 9003 指数退避重试），严禁盲目拉高至 10~12 并发避免 WAF 风控封禁。

---

## 📚 关键入口与脚本索引

- **MiniCheng 治理引擎**：[scripts/platforms/minicheng/minicheng_engine.mjs](file:///C:/Users/Administrator/multiplatform-product-operations/scripts/platforms/minicheng/minicheng_engine.mjs)
- **MiniCheng 避坑全景指南**：[references/platforms/minicheng-playbook-and-pitfalls.md](file:///C:/Users/Administrator/multiplatform-product-operations/references/platforms/minicheng-playbook-and-pitfalls.md)
- **全平台主 Skill 定义**：[SKILL.md](file:///C:/Users/Administrator/multiplatform-product-operations/SKILL.md)
