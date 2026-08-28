---
name: multiplatform-product-operations
description: 为已授权的牵牛花、美团、饿了么、翱象和淘宝闪购商家后台路由并执行商品治理；覆盖渠道属性、不可售、资质图、调价、商品编辑、医疗器械整店迁移和失败搬品重试。按“当前平台 + 单一任务”渐进加载平台适配器与任务合同，所有商品执行结果统一映射到同一 7 表 Excel Schema。
---

# 多平台商品运营自动化

这个入口只负责路由和共享硬约束。不要预读整个 `references/`，也不要把一个平台的登录态、签名、请求、
writer、回读器或成功判断用于另一个平台。

只处理用户已授权的账号、门店和正常运营动作。不得绕过登录、验证码、人工验证、风控或平台规则；外部写入必须来自
用户对当前任务的明确授权，不能从“看看、分析、诊断”推断。

## 渐进加载：每次必须这样开始

先运行轻量路由器；它只返回本次应读的文件，不加载文件正文：

```bash
python3 scripts/route_skill.py \
  --request-text "$REQUEST_SUMMARY" \
  ${CURRENT_PAGE_URL:+--page-url "$CURRENT_PAGE_URL"} \
  --intent auto
```

1. 路由成功后，严格按 `load_order` 逐个完整读取；不要读取同级其他平台或任务文件。
2. `optional_references` 只有在其触发条件实际出现时才读取。
3. `ambiguous_platform` 或 `ambiguous_task` 时，在任何商品详情读取、外部调用或平台写入前暂停并确认唯一范围。
4. `planned` 表示没有生产 writer，固定零写入；`runtime_guided` 表示必须用当前页面成功证据现场确认端点和载荷；
   `implemented` 也仍须通过当前身份、canary、独立回读和完成门。

显式平台或任务已知时可用 `--platform`、`--task`，但它们只冻结路由，不扩大用户授权。

## 共享执行合同

实际商品执行必须读取路由器返回的以下共享合同：

- [统一业务成功合同](references/unified-business-success-contract-v1.md)：保存受理不等于成功；只有独立回读、非目标保护和
  适用集合复扫通过，才进入统一终态。
- [全平台资源合同](references/runtime-resource-contract-v1.md)：先准入，默认单热 writer，仅在同量端到端 canary 更快且
  资源健康时按 `1→2→4` 升档，4 为硬上限。
- [统一输出内容合同](references/core/output-contract.md) 与
  [Excel 精确 Schema](references/excel-schema-v1.md)：从第一条事件开始使用统一字段、状态和来源词汇。

纯解释、静态审查或只读诊断只读平台/任务参考；没有真实执行证据时不得声称平台任务已跑通。

## 统一表格是全局硬约束

凡商品任务需要表格交付，唯一 Schema 为 `scripts/operations_workbook_schema.json`：

1. 固定且仅有 7 张表：`执行汇总`、`SPU清单`、`字段级审计`、`平台不存在`、`最终结构复核`、
   `问题与策略回灌`、`性能与外部调用统计`。
2. 所有平台、所有商品任务使用完全相同的工作表顺序、表头、汇总指标、字段顺序、状态值、来源策略和空值写法。
3. 调价、迁移、图片和搬品的差异只映射为统一的 `字段ID/字段名/执行前/计划值/最终回读值`；平台模块不得新增专属列。
4. `copy_history_retry` 的九项映射只是内部证据，必须进入统一字段级审计，**不得另交专用 9 列工作簿**。
5. 所有 ID、条码、SKU、SPU 和店内码按文本保存；金额使用 `Decimal` 和明确币种/单位；不适用填 `不适用`，不得留空。
6. 导出后必须通过共享内容 validator、当前平台完成门和同一 execution run 的 handoff gate，才可交付链接。

## 不可破坏的共同约束

- 当前页面、当前 Network/运行时成功证据和独立平台读回优先于历史端点与经验参数。
- 在写入前冻结唯一 `platform_adapter`、`task_mode`、门店/租户、商品集合和身份 fence。
- SPU/SKU/活动/图片槽位不唯一时失败关闭，禁止按名称或数组位置猜。
- 同一 SPU 的完整对象保存必须单写者；写后超时或未知结果先回读，不盲重发。
- 法定证照、CCC、备案、注册、许可、检验报告和公章只接受真实可核验证据，不能生成或猜测。
- Cookie、token、Authorization、签名、验证码和手机号不得进入普通日志、工作簿或交付物。
- 平台能力状态、执行终态和表格口径不可互相冒充；`HTTP 2xx`、`success`、上传完成或模型输出都不是完成。
- 发生故障时才读取 [调试与阶梯放量](references/debugging-and-rollout.md)，先分类证据再改变实现或并发。

## 受保护请求工程维护轨道

只有牵牛花 403、H5guard/A9、Cookie/页面身份、成本同步或保质期兼容任务才读取
[维护合同](references/qnh-protected-request-maintenance-v1.md)。该轨道修复请求入口，不得把请求成功冒充商品治理完成。

## 仓库维护（仅更新或同步本 Skill 时读取）

完整读取 [仓库治理](references/repository-governance.md)。远端只允许保留
`main`；不要为平台或任务建立长期分支。普通平台执行不加载本节。

## 冲突裁决

平台事实与动作语义按“当前平台独立回读/浏览器成功证据 > 当前平台适配器与任务合同 > 历史接口线索”裁决；
授权、安全、资源硬门和统一输出格式始终由共享合同约束，平台分支不得覆盖。高风险假设无法验证时失败关闭并保留续跑状态。
