# 美团直连模块

- `platform_adapter=meituan`
- 属性信息：`planned`
- 资质图：`planned`

这里的“美团”指直接登录美团商家平台，不是牵牛花中的美团渠道。未冻结美团页面身份、原生详情/保存接口、字段 schema、
图片槽位、保存后独立回读和完成门前，固定零写入；不得调用 QNH writer 或把 QNH 的 `channelId=100` 当成美团直连适配器。

实现任一任务时单独增加该任务的 reader、planner、writer、readback、validator、checkpoint 与低敏回归，再把总表状态改为
`implemented`。
