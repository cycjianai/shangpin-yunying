# 任务分支：不可售一次过治理

先冻结原始目标集合、全部审核原文和用户要求治理的集合。每个 SPU 将普通字段、标题/SKU、主图、详情图、专项图和
监管阻塞合并成唯一 one-pass 计划；字段物化、平台复审和退出目标集合分别统计。

## 平台叶子

- 牵牛花：读取 [541 合同](../run-contract-541.md)、[错误路由](../error-playbook.md) 和
  [字段安全](../field-safety.md)；出现历史槽位/物化反例时才加读 `thread-928-empirical-contract.md`。
  - **牵牛花不可售治理六大铁律**：① **门店自定义隔离（严禁强制改为跟随总部）**：存在门店自定义（`customizedNameFlag: true` / `customizedPicFlag: true`）的门店必须按门店粒度调 `/qnh-gw3/api/product/store/update` 独立维护其自定义名称、主图与分类，严禁传 `customizedNameFlag: false` / `customizedPicUrlListFlag: false`，严禁在主档发送 `spu_name` / `picture` 的 `coverToStore: 1` 级联覆盖自定义门店；② **图片原值保护**：永久禁用 `6f244c5f...` / `064b297f...` 等通用占位图与图库模糊搜图替换原主图；③ **禁止跨品类篡改**：严禁将缺资质商品改成“便当盒/保温杯”类目或“海尔”品牌；④ **非调价任务价格零触碰**（`storePrice` / `unifiedOnlinePrice` / `sellingPrice` 100% 原值保留）；⑤ **上下架与渠道发布状态保护**（禁止下架 `2` 改上架 `1`，禁止删除渠道 `-1`）；⑥ **写前强制落盘主档与全门店 `store/detail` 快照**。
- 美团：读取 [美团直连不可售模块](../platform-meituan.md)。它使用美团官方运行时和完整表单，不能借用 QNH writer；严格遵循 40 大实战治理规则（审核页 `&oldVersion=true` 路由锁定、视图模型 `normalAttributesValueMap` 四段编译、前端 Walle `g0` 实时质检、分品类权威 3C 三码合一、类目品牌库 `attrValueSug` 动态检索、`ie.A_` 锁定类目迁移与 `ignoreSuggestCategory` 软拦截豁免、`effectType=5` 无法售卖与 `effectType=2` 影响流量双队列联合扫描、非必填 `required: false` 点名属性靶向修复与“其他”选项纠偏、动态 `valueType: 10` 结构化组装、按需 69 码修复及 `req(36515).jt` 资质图上传）。
- 翱象（“不符合渠道规则” `tabType: HAS_ERROR` / 铺品异常）：读取 [翱象渠道属性合同](../aoxiang-channel-contract-v1.md) 与 [翱象实战防坑指南](../platforms/aoxiang-playbook-and-pitfalls.md)，严格执行四道多规格防降级硬门禁与四级梯队 0 空白填充。
- 饿了么、淘宝闪购直连：能力表为 `planned` 时零写入。

用户说“完成 N 条”时，N 是最终 `verified_cleared` 配额，不是计划、提交、上传、保存或字段回读数。证照图缺口按
[`upstream-image-generation.md`](../upstream-image-generation.md) 的上游生图链路补齐；仅平台侧经营资质/禁售类缺口进入
`manual_evidence_required`。

## 统一输出映射

- 整改字段按其正常命名空间记录；审核原文用 `review.reason`，集合复扫用 `review.scope_state`。
- 字段已回读但未退出审核集合为 `waiting_platform_review`；只有物化、保护和稳定复扫都通过才是 `verified_complete`。
- `SPU清单` 同时写执行前全部原因、本次实际整改、回读和最终集合状态。
