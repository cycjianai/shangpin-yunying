# 任务分支：不可售一次过治理

先冻结原始目标集合、全部审核原文和用户要求治理的集合。每个 SPU 将普通字段、标题/SKU、主图、详情图、专项图和
监管阻塞合并成唯一 one-pass 计划；字段物化、平台复审和退出目标集合分别统计。

## 平台叶子

- 牵牛花：读取 [541 合同](../run-contract-541.md)、[错误路由](../error-playbook.md) 和
  [字段安全](../field-safety.md)；出现历史槽位/物化反例时才加读 `thread-928-empirical-contract.md`。
- 美团：读取 [美团直连不可售模块](../platform-meituan.md)。它使用美团官方运行时和完整表单，不能借用 QNH writer。
- 翱象、饿了么、淘宝闪购直连：能力表为 `planned` 时零写入。

用户说“完成 N 条”时，N 是最终 `verified_cleared` 配额，不是计划、提交、上传、保存或字段回读数。监管材料缺失进入
`manual_evidence_required`，不能为凑数生成。

## 统一输出映射

- 整改字段按其正常命名空间记录；审核原文用 `review.reason`，集合复扫用 `review.scope_state`。
- 字段已回读但未退出审核集合为 `waiting_platform_review`；只有物化、保护和稳定复扫都通过才是 `verified_complete`。
- `SPU清单` 同时写执行前全部原因、本次实际整改、回读和最终集合状态。
