# 牵牛花模块

- `platform_adapter=qnh`
- 渠道类目与属性一体化治理：`implemented`；入口与合同见 `channel-attribute-contract-v2.md`（v3 生产版），核心执行器见 `scripts/platforms/qnh/execute_category_and_recommendation_cleaning.mjs`。严格执行“空类目官方推荐先行 → 官方属性推荐全采纳 → 跨渠道事实继承与规则库兜底 → 3并发安全签署保存”。
- 总部零售价按货盘补齐：`runtime_guided`；入口 `tasks/qnh-headquarters-price-fill.md`，只修改主档，不能套用门店活动调价。
- 资质图：`implemented`，入口与合同见 `thread-928-empirical-contract.md`、`error-playbook.md`、`field-safety.md`；
  所有限制的唯一机器事实源见 `qualification-image-policy.md`。
- 搬品历史失败重试：`implemented`，入口与合同见 `copy-history-retry-contract-v1.md`。

## 核心架构与实战规范：全链路复用【多标签页分布式签名 + 多并发 Worker】

牵牛花平台所有涉及**商品信息修改、属性治理、类目补齐、调价、状态同步与改写**的功能，**必须统一复用经过 38,000+ SPU 生产级验证的高效架构：【4 标签页分布式签名 + 12 并发 Worker】**。

### 1. 架构原理与角色分工
* **Tabs（浏览器标签页 = 4）➔ 分布式防伪签名收银台**：
  牵牛花所有敏感修改接口均依赖前端风控签名（`window.H5guard.sign`），受限于 Chrome V8 引擎单线程特性，单个标签页容易产生签名锁竞争。开辟 **4 个独立 Tabs**，签名通道吞吐量提升 4 倍。
* **Concurrency（并发 Workers = 12）➔ 异步流水线工人**：
  在 Node.js 中并行维持 12 个独立 Worker，每个 Worker 负责单个 SPU 的全流程（查详情 ➔ 官方类目推荐 ➔ 官方属性推荐 ➔ 事实继承与规则全量回填 ➔ 派发签名 ➔ 保存）。
* **黄金配比（3:1）**：
  实测每 3 个 Worker 共享 1 个签名 Tab，使 Chrome 签名窗口持续饱和运转且不排队，同时避免打爆牵牛花服务端网关 Socket 连接池（并发 > 14 时单件延迟会从 2.3s 激增至 6.6s，吞吐量反而暴跌 38%）。

### 2. 性能与安全性指标
* **端到端跑速**：稳定达到 **250 ~ 300 SPU/分钟**（单商品仅需 ~2.3 秒，较传统打开编辑页提速 50 倍）；
* **安全合规**：100% 成功率，0 失败（Fail: 0），0 验证码，0 平台风控降级；
* **断点续跑机制**：必须配置 Checkpoint 机制（如每 50 件落盘），支持意外中断后毫秒级无缝断点续跑。

牵牛花模块拥有 QNH H5guard、tenant 身份、列表/详情/保存接口、Chrome 扩展 transport 和专项图槽位合同。
不得把这些协议用于美团、翱象或淘宝闪购直连平台。

属性与资质图必须冻结为两个独立任务模式、run-dir 和完成口径；属性任务外部调用预算为 0，资质图任务不得顺带修改
普通属性。两类任务都必须映射到统一运营 Excel Schema，不得输出不同模板。不可售 one-pass 是牵牛花现有附加模式，
不扩散为其他平台的默认任务类型。
搬品失败重试只复用原点搬品助手自己的新增链路，并用牵牛花主档独立回读验收；九项旧→新映射是内部证据，最终交付
仍映射到统一 7 表，不再另造专用工作簿。

牵牛花 403、H5guard/A9、Cookie/页面身份、成本同步、保质期、受管 Chrome 或健康检查属于条件工程维护轨道；完整
阅读 `qnh-protected-request-maintenance-v1.md`，并以当前项目 `docs/agent-rules/qnh-protected-request.md` 为仓库权威真源。
入口修复不得改变上述商品治理完成口径，也不得把服务端受管请求上下文传播到当前标签页扩展通道。

