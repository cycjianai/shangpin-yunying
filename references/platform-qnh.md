# 牵牛花模块

- `platform_adapter=qnh`
- 渠道类目与属性一体化治理：`implemented`；入口与合同见 `channel-attribute-contract-v2.md`（v3 生产版），核心执行器见 `scripts/platforms/qnh/execute_category_and_recommendation_cleaning.mjs`。严格执行“空类目官方推荐先行 → 官方属性推荐全采纳 → 跨渠道事实继承与规则库兜底 → 3并发安全签署保存”。
- 总部零售价按货盘补齐：`runtime_guided`；入口 `tasks/qnh-headquarters-price-fill.md`，只修改主档，不能套用门店活动调价。
- 资质图：`implemented`，入口与合同见 `thread-928-empirical-contract.md`、`error-playbook.md`、`field-safety.md`；
  所有限制的唯一机器事实源见 `qualification-image-policy.md`。
- 搬品历史失败重试：`implemented`，入口与合同见 `copy-history-retry-contract-v1.md`。

牵牛花模块拥有 QNH H5guard、tenant 身份、列表/详情/保存接口、Chrome 扩展 transport 和专项图槽位合同。
不得把这些协议用于美团、翱象或淘宝闪购直连平台。

属性与资质图必须冻结为两个独立任务模式、run-dir 和完成口径；属性任务外部调用预算为 0，资质图任务不得顺带修改
普通属性。两类任务都必须映射到统一运营 Excel Schema，不得输出不同模板。不可售 one-pass 是牵牛花现有附加模式，
不扩散为其他平台的默认任务类型。
实战规范：大批量属性治理禁用逐页打开编辑页的低效路径，统一使用基于 CDP 签名的 3 并发异步 Worker 执行器，兼顾安全与吞吐。
搬品失败重试只复用原点搬品助手自己的新增链路，并用牵牛花主档独立回读验收；九项旧→新映射是内部证据，最终交付
仍映射到统一 7 表，不再另造专用工作簿。

牵牛花 403、H5guard/A9、Cookie/页面身份、成本同步、保质期、受管 Chrome 或健康检查属于条件工程维护轨道；完整
阅读 `qnh-protected-request-maintenance-v1.md`，并以当前项目 `docs/agent-rules/qnh-protected-request.md` 为仓库权威真源。
入口修复不得改变上述商品治理完成口径，也不得把服务端受管请求上下文传播到当前标签页扩展通道。
