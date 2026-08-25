# 饿了么平台分支

这里的接口和方法名是历史项目的搜索线索，不是永久 API 契约。实施前从当前代码、当前授权商家页 Network 和平台读回确认 endpoint、字段、签名与状态语义。

## ID 不是一套

登录节点 ID、活动查询 `storeId`、商品接口 `storeId`、`sellerId`、`wid/eleId` 可能代表不同实体，不能互换。商品还可能同时有 `custom_id`、UPC/barcode、item/product ID、SKU ID 和活动参与 ID。

写入前从平台读取结果建立映射。多规格商品必须按 SKU 级标识唯一定位；推荐优先级：

1. 当前活动内 `participateId == item_sku_id`；
2. SKU ID；
3. UPC/barcode；
4. item/product ID；
5. outer/custom ID。

只有在当前响应语义证实相等关系时才使用上述映射。定位不到或出现多个候选时跳过，不能退化成修改整个 SPU。

## 会话预检与健康态

缓存的 `is_valid=false` 不能单独证明 Cookie 已死。若存在当前授权浏览器上下文，先做商品详情或其他只读 API 探针：

- 探针成功：可恢复本地健康态，并持久化合法的运行时 Cookie/token 更新；
- 明确返回 `SESSION_EXPIRED`、`SID_INVALID`、需要登录或权限失败：停止剩余写入，要求重新登录或修复上下文；
- 网络、限流、ID 错误或未知业务码：按真实类别处理，不能统一翻译为 Cookie 失效。

不要跳过预检直接写平台，也不要因为一次 keepalive 失败就误杀仍有效会话。

## 写前详情

批量查询商品详情，补齐 `custom_id`、barcode/UPC、item/product ID、seller/store ID、当前原价、活动 ID/价格/状态和 SKU 列表。疑似多规格或列表页只返回 SPU 壳子时，再查询编辑详情；无法安全定位目标 SKU 就跳过。

## 价格动作

### 提高原价

先下线目标 SKU 的活动参与行，再按唯一 SKU 修改原价。单规格和多规格使用各自的安全更新载荷；不得用单规格路径覆盖多规格商品。延迟回读确认活动下线、原价和终端价。

### 恢复原价

目标价等于当前原价时，下线目标 SKU 活动参与行；无活动则 `noop`。回读参与状态和终端价。

### 设置活动价

- 已在唯一可管理活动中：修改该参与行活动价。
- 不在活动中：优先追加本批共享活动；尚无共享活动时，在锁内创建一次并持久化活动 ID。
- 创建、追加或修改成功只进入“待验真”，不能直接成功。

## 延迟批量验真

饿了么活动状态可能异步物化。写阶段可返回 `deferred_verify_payload`，验真阶段批量拉商品详情和活动参与行，再逐 SKU 判断：

- 活动 ID 与预期一致；
- SKU 参与 ID 精确匹配；
- 活动处于生效状态；
- 活动价/原价和目标关系正确；
- 平台可确认的终端价等于目标价。

采用有上限的重试窗口和退避；窗口结束仍不可确认时记 `unknown/failed`，不可用本地预期补成成功。

## 历史实现搜索线索

| 历史方法 | 历史接口 | 用途 |
| --- | --- | --- |
| `fetch_item_detail_map_by_custom_id()` | `mtop.ele.newretail.item.pagequery` | 批量查商品列表详情 |
| `_fetch_item_query_detail()` | `mtop.ele.newretail.item.query` | 查编辑详情和多规格 |
| `_update_item_price_with_result()` | `mtop.ele.newretail.item.update` | 更新单规格原价 |
| `_update_multi_sku_item_price_with_result()` | `mtop.ele.newretail.item.update` | 更新目标规格原价 |
| `create_activity_with_all_data()` | `mtop.me.ele.merchant.activity.createWithAllData` | 创建活动并加入首个商品 |
| `append_items_to_activity()` | `mtop.me.ele.merchant.activity.updateWithAllData` | 追加商品 |
| `update_activity_price_with_all_data()` | `mtop.me.ele.merchant.activity.updateWithAllData` | 修改活动价 |
| `offline_act_participates()` | `mtop.me.ele.merchant.Common.offlineActParticipates` | 下线参与行 |
| `query_act_participates()` | `mtop.me.ele.merchant.Common.queryActParticipates` | 验真活动参与状态 |

历史项目曾用 `shared_create_activity_id` 复用批次活动，并用 `finalize_deferred_push_target_price()` 完成延迟验真。名称可变化，语义约束不变。

## 常见失败解释

- `UNKNOWN_FAIL_CODE`：先查门店、seller、item、SKU、活动 ID 是否混用，而不是立即重登或换 token。
- `verify_mismatch`：先查物化延迟、参与 ID 匹配、多规格身份和读回路径；写响应 success 不能反证校验器错误。
- 小批量成功、大批量异常：优先查共享活动竞争、token/page 并发安全和平台限速；对共享活动关键段加锁。
