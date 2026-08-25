# 证据、结果 Schema 与完成门

## ID 账本

按可得信息保存并注明来源：

- 平台、业务门店 ID、登录节点 ID、商品接口门店 ID、活动接口门店 ID；
- seller/account/wid/ele 等账号实体 ID；
- `store_code`、custom/outer ID、UPC/barcode；
- item/SPU ID、SKU ID、活动参与 ID；
- activity ID、type/subtype/status、归属与批次键；
- 映射证据的接口、响应时间和 `trace_id`。

不要把不同命名的 ID 自动视为相同；映射必须来自当前平台响应或当前代码的明确转换。

## 脱敏 JSONL

第三方请求每个 attempt 至少记录：

- `trace_id`、`job_id`、`task_id`、SKU 业务键；
- platform、store、operation、method、URL path；
- query/body 的脱敏结构摘要与稳定 hash；
- 必要 headers 的名称和脱敏摘要，不记录原始 Cookie/token/signature；
- start/end、耗时、HTTP 状态、平台 code、响应摘要；
- retry classification、attempt、lock/worker 信息；
- 写入结果是 `accepted`、`rejected` 还是 `unknown`。

秘密字段用不可逆摘要或固定占位符；导出前再次扫描 Cookie、Authorization、token、手机号等敏感值。

## 逐 SKU 结果

至少输出：

- platform、store、task/job、SKU 级身份；
- strategy/action、写前原价/活动价/终端价；
- `target_price`、提交的原价/活动价；
- 写接口响应摘要和平台 activity ID；
- 读回原价/活动价/终端价、活动状态；
- `truth_source`：证明最终状态的独立接口和匹配键；
- status：success/failed/skipped/unknown；
- reason code、warning、attempts、duration、trace ID。

价格字段同时保留币种和单位，避免“分/元”混淆。

## 完成门

同时满足才可宣称批次闭环：

- 失败类型由证据命名，未知项明确保留；
- 浏览器/后端信任边界和当前实现已被证明，而非猜测；
- 单 SKU 与历史失败 SKU 已按同一真值路径验证；
- 选定阶梯在定义的通过门下完成；
- 每个成功 SKU 都有前价、目标价、后价和 `truth_source`；
- 无未处理的 `unknown` 写入；
- 停止/续跑不会重复创建活动或重复改已成功 SKU；
- 日志和报告已脱敏；
- 人工验证、未覆盖活动类型、未证明的更高并发等剩余风险已明确。

如果只有代码静态审查或文档证据，只能说“实现/设计已检查”，不能说“平台推送已跑通”。如果没有当前平台环境，不得把历史 endpoint 可用性写成已验证事实。

## 建议交付摘要

```text
范围：平台 / 门店 / task / SKU 数
模式：审查 / 诊断 / 实现 / 实际推送
预检：通过或失败证据
结果：success / failed / skipped / unknown
验真：读回接口、匹配键、物化窗口
并发：写 / 验真 / 锁内实际串行度
首个失败：分类、trace_id、根因或仍缺证据
剩余风险：人工步骤、未验证假设、放量上限
```
