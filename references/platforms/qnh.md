# 牵牛花平台适配器入口

只在当前页面/请求主机明确属于牵牛花时使用。牵牛花的 tenant、H5guard/A9、协议版本、Chrome 扩展 transport、reader、
writer 和回读器不得复用于其他平台。

## 可复用快速进入流

1. 优先复用本 Skill 管理且只读证明空闲的会话；用户明确要求当前普通 Chrome 时，只 claim 精确牵牛花标签页。
2. 冻结当前可见租户、tenant/store、route、profile/transport、run-dir 和页面 fence；身份冲突时零详情读取、零写入。
3. 从当前文档原生成功请求确认协议与签名画像；禁止 403 后轮盘切换 `4.2.0/4.2.4/4.3.0`。
4. query-only 可复用已冻结列表页；mutation 必须精确绑定目标 SPU 编辑页，同一 SPU 单飞。
5. 保存响应后用正式详情 reader 独立回读；未知写结果只回读，不自动重复 final save。

平台基础边界见 [牵牛花模块](../platform-qnh.md)。只有出现协议、403、成本同步或保质期工程问题时，才加载
[受保护请求维护合同](../qnh-protected-request-maintenance-v1.md)。

## 功能分支

- 渠道属性：`implemented`；按路由器加载 `tasks/channel-attributes.md`。
- 不可售一次过：`implemented`；加载 `tasks/unavailable-one-pass.md`。
- 资质/专项图：`implemented`；加载 `tasks/qualification-images.md`。
- 插件属性填充：`implemented`，但必须实际运行插件，不能用直连结果冒充。
- 原点搬品历史失败重试：`implemented`；只处理用户点名原结果中的失败成员。
- 调价与通用商品编辑：本适配器未注册，固定零写入。
