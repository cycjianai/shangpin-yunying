# 翱象平台适配器入口

只在当前页面属于翱象（如 `saas-retail.ele.me` / `tc-supply-chain-portal.ele.me`）时使用。翱象中的 `MT`、`ELE`
是被管理渠道，不等于美团或淘宝闪购直连适配器。

## 核心能力与实战指南

1. **商品高速批量改名与编辑**：`implemented`，完整避坑指南与底层机制详见 [翱象平台实战与多规格防坑指南](aoxiang-playbook-and-pitfalls.md)。
2. **多规格防覆盖铁律**：翱象 `goods/master/detail` 返回单条规格，**更新前必须强制调用 `goods/relation/detail` 组装完整 `skus` 数组**，严禁只传单条主档 SKU，否则会导致系统覆盖清空全部子规格！
3. **极速高并发执行**：采用 Playwright CDP 连接浏览器提取原生 Cookie，通过 `scripts/aoxiang_high_concurrency_product_engine.mjs` 开启 **12 ~ 14 路原生并发**，吞吐可达 **400 ~ 600 SPU/分钟**。
4. **属性信息**：`implemented`，完整合同见 `aoxiang-channel-contract-v1.md`。
5. **资质图和不可售直连模式**：`planned`。

## 可复用快速进入流

1. 复用当前已登录 Chrome（CDP 端口 9223），冻结 `planId/storeCode/channelCode/type`、门店可见名和诊断清单。
2. 通过原生诊断、详情、类目属性和保存接口建立当前商品事实，不读取或搬运浏览器凭证。
3. writer 修改商品时，必须保留原商品的多规格结构、真实供货价、条码、重量及渠道分类属性。
4. mutation 后重新 GET 详情与 relation 逐字段回读核验；只有回读核验一致才在工作簿中标记成功。
5. 遇到已废弃商品（`goodsStatus: -2`）直接标记异常，跳过无效重试。
