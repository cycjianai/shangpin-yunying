# 翱象模块

- `platform_adapter=aoxiang`
- 属性信息：`implemented`，完整合同见 `aoxiang-channel-contract-v1.md`。
- 资质图：`planned`

翱象属性模块只使用翱象页面与 `tc-supply-chain-portal.ele.me` 原生接口，writer 固定为翱象 adapter；禁止调用 QNH
H5guard、tenant 合同或编辑页 writer。淘宝闪购/饿了么在此处是翱象管理的渠道，不等于淘宝闪购直连平台适配器。

属性模块必须使用统一运营 Excel Schema。资质图在槽位 schema、真实证据、上传接口、保存回读和完成门全部建立前
固定零写入，不得因属性模块已实现而推断图片能力；未来实现后仍使用同一 Excel 模板。
