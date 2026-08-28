# 翱象平台适配器入口

只在当前页面属于翱象（如 `saas-retail.ele.me` / `tc-supply-chain-portal.ele.me`）时使用。翱象中的 `MT`、`ELE`
是被管理渠道，不等于美团或淘宝闪购直连适配器。

## 可复用快速进入流

1. 复用当前已登录 Chrome，冻结 `planId/storeCode/channelCode/type`、门店可见名和诊断清单。
2. 通过原生诊断、详情、类目属性和保存接口建立当前商品事实，不读取或搬运浏览器凭证。
3. writer 只替换目标渠道属性，发送当前完整商品 payload；价格、库存、图片、上下架和非目标字段受保护。
4. mutation 只发送一次，随后重新 GET 详情逐字段回读；异步重检稳定前不以瞬时 0 宣称清零。
5. 默认单热 writer，只有端到端 canary 更快且资源健康时按 `1→2→4` 升档。

渠道属性为 `implemented`，加载 `tasks/channel-attributes.md` 与 [翱象详细合同](../aoxiang-channel-contract-v1.md)。
资质图和不可售直连模式均为 `planned`。
