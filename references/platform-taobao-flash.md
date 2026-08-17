# 淘宝闪购直连模块

- `platform_adapter=taobao_flash`
- 属性信息：`planned`
- 资质图：`planned`

这里的“淘宝闪购”指直接登录淘宝闪购商家平台，不是牵牛花或翱象中的渠道字段。未冻结直连平台身份、原生详情/保存
接口、属性 schema、图片槽位、保存后独立回读和完成门前，固定零写入；不得借用 QNH 或翱象 writer。

实现任一任务时单独增加该任务的 reader、planner、writer、readback、validator、checkpoint 与低敏回归，再把总表状态改为
`implemented`。
