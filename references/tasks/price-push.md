# 任务分支：美团/饿了么调价推送

平台范围仅为当前能力表允许的美团或饿了么。两者都属于 `runtime_guided`：历史端点和方法名只用于搜索当前代码与
Network，真实写入前必须取得当前授权页面的成功请求证据、单 SKU canary 和独立回读。

完整业务状态机见 [价格任务状态机](../business-state-machine.md)。平台细节按路由只读一个：

- 美团：[美团调价分支](../meituan.md)
- 饿了么：[饿了么调价分支](../eleme.md)

## 固定业务路由

1. 冻结 task、平台、门店、SKU、策略版本和 `target_price`；价格使用 `Decimal` 或最小货币单位。
2. 读取当前原价、活动参与、活动价、状态和可确认终端价；多规格必须唯一 SKU。
3. `target > original`：下线会压低终端价的可管理活动，再改目标 SKU 原价。
4. `target == original`：下线目标 SKU 的可管理活动；无活动才是 `noop`。
5. `target < original`：保持原价，以唯一可管理活动或本批共享活动承接折扣。
6. 写响应只记阶段状态；在有界物化窗口独立回读目标 SKU 的原价、活动与终端价。
7. 超时/断线先回读；共享活动创建/追加必须锁定并有确定性幂等键。

## 统一输出映射

每个 SKU 至少产生：

- `price.<sku_id>.original`
- `price.<sku_id>.target`
- `price.<sku_id>.activity`
- `price.<sku_id>.effective`
- `activity.<activity_id>.status`（无活动时 ID 用 `none`）

金额统一为 `CNY 12.34`。`结果=verified_complete` 只在最终有效价精确等于目标价且活动关系正确时使用；写前已满足并
重新读回为 `verified_no_change`。报告中的成功、失败、跳过、未知必须与逐 SKU 行对账。
