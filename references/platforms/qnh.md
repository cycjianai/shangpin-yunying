# 牵牛花平台适配器入口

只在当前页面/请求主机明确属于牵牛花时使用。牵牛花的 tenant、H5guard/A9、协议版本、Chrome 扩展 transport、reader、
writer 和回读器不得复用于其他平台。

## 可复用快速进入流

1. 优先复用用户当前已登录且可合法使用的牵牛花会话，核对账号、门店和实际占用；普通 Chrome 扩展只 claim 精确牵牛花标签页。会话来源不是永久权限条件。
2. 冻结当前可见租户、tenant/store、route、profile/transport、run-dir 和页面 fence；身份冲突时零详情读取、零写入。
3. 从当前文档原生成功请求确认协议与签名画像；禁止 403 后轮盘切换 `4.2.0/4.2.4/4.3.0`。
4. query-only 可复用已冻结列表页；完整对象编辑必须精确绑定目标 SPU 编辑页，同一 SPU 单飞。
   当前官方总部价格批量导入按其独立任务合同绑定租户、目标 SKU 清单与批次文件，不需要为每个商品打开编辑页；
   这不授权共享列表页直接发送完整对象更新。
5. 保存响应后用能完整表达目标字段的正式 reader 独立回读；总部零售价可按同标签全量列表逐 SKU 回读，
   列表字段缺失、结构未知或保护字段不足时才补精确详情。未知写结果只回读，不自动重复 final save。

平台基础边界见 [牵牛花模块](../platform-qnh.md)。只有出现协议、403、成本同步或保质期工程问题时，才加载
[受保护请求维护合同](../qnh-protected-request-maintenance-v1.md)。

## 功能分支

- 主图品牌水印扫描：`runtime_guided`，只读；加载 `tasks/qnh-watermark-scan.md`，使用可配置文字/图案规则和视觉复核，输出 SPU 清单。

- 渠道属性：`implemented`；按路由器加载 `tasks/channel-attributes.md`。
- 不可售一次过：`implemented`；加载 `tasks/unavailable-one-pass.md`。
- 资质/专项图：`implemented`；加载 `tasks/qualification-images.md`。
- 插件属性填充：`implemented`，但必须实际运行插件，不能用直连结果冒充。
- 原点搬品历史失败重试：`implemented`；只处理用户点名原结果中的失败成员。
- 搬品冲突回退复核：`runtime_guided`；只处理映射表中明确标记名称/条码变化的行，仅在原任务证明末尾追加 `1` 时按该策略回退，只读比对并回填已确认的结果列。
- 门店旧新 SKU 替换迁移：`runtime_guided`；按冻结映射把新主档 SKU 覆盖到门店，迁移库存、库位、供应商和渠道状态，删除旧商品后确保新商品上架；删除前核对授权集合及非目标规格保护。
- 总部零售价按货盘补齐：`runtime_guided`；加载 `tasks/qnh-headquarters-price-fill.md`，优先现场确认的官方 Excel 导入。
- 门店/活动调价与通用商品编辑：本适配器未注册，固定零写入。
