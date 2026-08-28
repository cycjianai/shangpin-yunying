# 饿了么平台适配器入口

本适配器指直接登录饿了么商家后台，不是翱象中 `ELE` 渠道字段。当前仅调价为 `runtime_guided`；商品编辑和渠道属性
writer 尚未注册，固定零写入。

## 可复用快速进入流

1. 冻结当前授权商家页、登录节点、门店、seller、商品接口 store、活动接口 store 和会话健康证据。
2. 从当前 mtop 成功请求确认 endpoint、签名、序列化和运行时 token；历史方法名只用于定位。
3. 分开映射登录 ID、`storeId`、`sellerId`、`wid/eleId`、custom ID、UPC、item、SKU 和活动参与 ID。
4. 多规格按唯一 SKU 操作；定位不到或多匹配时跳过，不能退化为修改整个 SPU。
5. 活动异步物化使用有界延迟回读；创建、追加或修改的 success 响应只表示待验真。

调价时加载 `tasks/price-push.md` 与 [饿了么调价线索](../eleme.md)。不得把美团完整 SPU 保存、活动 ID 或店内码
模型套入本适配器。
