# 美团平台分支

这里的接口和方法名来自一份已走通项目的历史记录，用于搜索当前代码和比对浏览器 Network，不保证平台当前仍保持相同名称、参数或签名版本。每次实施都以当前授权商家页成功请求和平台回读为准。

## 上下文与身份

常见门店上下文包括 Cookie、`wm_poi_id`、`acct_id`；商品入口常用店内码 `store_code`，但写入前仍应从平台查询结果确认真实 SKU ID、活动参与行和门店归属。空店内码、生成的 `mtcode_...` 或平台查不到的编码不能进入写入候选。

维护以下映射：业务门店 ID、登录节点/账号 ID、平台门店 ID、`store_code`、SPU/item ID、SKU ID、活动 ID、活动类型与状态。不要用商品名做身份。

## 浏览器上下文与动态签名

出现 `mtgsig`、`h5guard`、`a6/a9`、`csecversion`、空 `x-forbid-reason` 或后端 `403` 时：

1. 证明同一接口在当前真实商家页 Network 中成功。
2. 在同一已登录 origin/route 的页面上下文做只读探针。
3. 对比 URL、query、body、Cookie 作用域、必要安全头、签名版本和生成时机。
4. 若只有页面上下文能通，让授权自动化通过页面内请求或受控浏览器上下文获得当次请求能力；不要复制一份平台 JS 到 Node 后假定等价。

使用真实上下文不是绕过风控。不得规避验证码或人工挑战；遇到挑战即暂停。

## 写前预检

从真实候选抽一个 `store_code`：

- 查询商品主档，确认门店、店内码、SKU ID、当前原价；
- 查询折扣活动行，确认接口可访问及当前参与状态；
- 若两条只读路径任一失败，先分类会话、签名、ID 或平台错误，不进入批量写。

## 价格动作

### 提高原价

先取消会继续压低终端价的目标 SKU 折扣参与行，再修改该 SKU 主档原价。回读主档与活动行，确认活动不再生效且终端价等于目标价。

### 恢复原价

目标价等于当前原价时，下线目标 SKU 的折扣参与行；没有活动则 `noop`。必须读回活动已下线和终端价已恢复。

### 设置折扣价

- 已有唯一、可管理的折扣行：目标一致则回读确认；不一致则修改活动价。
- 修改被价格区间等业务规则拒绝：记录原响应；只有业务允许且能安全补偿时，才下线旧参与行并重新确保目标折扣。
- 无折扣行：优先追加到本批共享活动；尚无共享活动时只创建一次。
- 创建/追加返回成功后，等待活动上线及 SKU 参与行物化，再验真。

## 历史实现搜索线索

| 历史方法 | 历史端点片段 | 用途 |
| --- | --- | --- |
| `query_product_by_store_code()` | `reuse/sc/product/retail/r/searchListPageNew` | 店内码查商品与原价 |
| `update_original_price()` | `reuse/sc/product/retail/w/updatePrice` | 修改主档原价 |
| `query_discount_items_by_store_code()` | `business/item/activity/query/pageList` | 查折扣活动行 |
| `query_activity_sku_info_by_store_codes()` | `business/sku/querySkuInfo` | 准备活动 SKU 入参 |
| `create_activity_with_items()` | `business/activity/uploadActivityOnline` | 新建折扣活动 |
| `append_items_to_activity()` | `business/activity/modifyActivity-v2` | 追加 SKU |
| `modify_discount_price()` | `item/activity/batch/modify/saleFood` | 修改活动价 |
| `cancel_discount_item()` | `item/activity/batch/offline` | 下线参与行 |
| `query_activity_status()` | `business/activity/queryActivityStatus` | 等待活动上线 |

历史项目曾用 `batch_discount_activity_key` 复用批次活动，并用 `verify_price_state()` 回读。当前代码名称可不同，但“批次只创建一次、参与行精确到 SKU、写后独立回读”的约束不变。

## 常见失败解释

- 前端 POST `504` 且后台仍在执行：通常是同步 HTTP 生命周期承载了长任务；改为持久化异步 job，不要把 504 直接记为 SKU 业务失败。
- 创建/追加返回成功但查不到活动行：视为未验真，进入有界物化等待；超时后保留 `unknown/failed`，不能报成功。
- 浏览器成功、脚本 `403`：优先判请求上下文不等价，不要先换算法文件或反复全量重试。
