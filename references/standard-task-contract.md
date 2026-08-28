# 标准化任务外壳

本合同由 `qnh-task-contract-v3.5.0` 约束。每个 run 必须先冻结唯一 `task_mode`；模式之外的阶段不得因为
“同一个 Skill 也支持”而启动。全部 canonical 动作通过 `run_task_action.py`，最终交付必须通过对应机器完成门。

## 1. 会话启动

- 用户明确要求复用当前普通 Chrome 时，先以 Chrome 扩展精确 claim 已登录的牵牛花标签页；该传输只允许当前标签页
  范围 CDP，不得要求用户批准原始远程调试，也不得转发为通用后台 CDP。扩展执行结果必须走 canonical receipt 校验。
- 每次新的用户任务触发本 Skill，默认先发现本机由本 Skill 管理的隔离浏览器。若存在健康且确认空闲的会话，直接复用其 profile、display、CDP、VNC/noVNC 登录窗口并发送原 SSH 隧道命令和登录地址；不要为了“新任务”自动再开浏览器。
- 空闲必须由只读证据确认：没有运行中/可恢复中的插件或直连任务，没有非终态 batch/checkpoint，没有 provider/upload/save/write-intent/pending-verify 续传责任，没有活跃任务租约或仍在工作的执行进程。查询失败、证据缺失、身份冲突或多个候选无法唯一选择时均不得抢占。
- 只有用户明确要求新开，或所有旧会话均忙碌、不健康、登录失效、身份不明时，才创建新的 profile、display、CDP、VNC 和 noVNC；全部仅监听 loopback。
- 无论复用还是新建，每个任务都必须新建 run-dir、manifest、checkpoint 和审计表。复用时只继承登录窗口，绝不继承旧任务 SPU、租户数据、provider receipt、write intent、保存收据或完成结论；`preflight` 必须重新证明当前 tenant/store/name/profile/CDP 一致。
- 用户没有明确要求原点账号时，只打开牵牛花，不打开原点或插件页面。
- `copy_history_retry` 只复用当前牵牛花页中已加载的原点搬品助手；原失败清单来自用户点名的下载记录，不打开其他原点账号页。

## 2. 100% 完成口径

五个平台先统一遵守 [统一业务成功合同](unified-business-success-contract-v1.md)。平台适配器负责产生可信的身份、
写前事实、写回收据、独立回读和范围复扫证据；共享核心只消费这些证据，不解释平台响应，也不替平台选择字段值。
本节其余条目是 QNH `channel_attributes_only` 对该共同合同的具体映射。

- 目标始终是源清单中“平台当前存在”的全部 SPU 的全部渠道类目属性满足类型结构合同，而不是页面非空、保存 HTTP 200 或本轮修改项通过。
- 先冻结源清单并去重；平台明确返回记录不存在的 SPU 单列 `missing_on_platform`，保留在 Excel，但从平台现存填充率分母剔除。
- 最终必须重新读取所有平台现存 SPU 并运行 `validate_channel_contracts.py`。仅当 `products_with_issues=0` 且 `issue_count=0` 才能报告现存商品填充率 100%。
- 若有合同问题，按最终详情建立 residual 计划并复核全量；不得用成功请求数或抽样结果推断 100%。法定证照仍只允许真实材料，不能为了数字填伪造值。
- 保存交付率、最终结构填充率、法定证据覆盖率和不可售审核退出率是四个独立指标；任何一个指标不得冒充另一个。
- `channel_attributes_only` 的 OCR、媒体、条码、博查、Web、模型、provider 和图片上传预算固定为 0；发现相关动作或制品时完成门失败。

## 3. 经验反馈闭环

每次任务都维护问题登记表，至少记录：新报错/数据形状、触发条件、错误策略、根因、修正规则、PoC 证据、全量回归结果。遇到现有 Skill 未覆盖的问题时必须完成：

```text
保存低敏反例 → 定位字段/接口合同 → 制定可泛化规则 → 加入脚本或参考合同
→ 增加验证/回归样例 → quick_validate → 才能作为任务经验交付
```

只把跨账号可复用的低敏规则写入 Skill；禁止写 Cookie、签名、密钥、tenant、SPU、任务号或上传回执。临时网络故障和单商品事实不应升级成全局规则。

已验证门禁：`preflight` 必须原子写入 `session_identity.json`，并至少包含当前可见租户名/ID、CDP、run-dir、页面 URL/route、H5guard 状态和时间。只有事件日志而没有身份文件时不得开始详情读取或写入。

已验证反馈：批量保存状态为 `failed` 时先对整批做独立详情复读；若字段已物化则不重提，只对结构验证仍失败的 SPU 生成 residual 计划。一次保存失败数不能直接等同最终未完成数。

已验证性能门：全量官方建议读取若连续样本退化到 10 秒/商品以上，且已有跨类目 PoC 证明当前类目模板与默认矩阵能通过结构合同，则停止该只读慢链，后续直接按模板计划并以全量回读/residual 保证 100%。停止慢查询不允许放宽候选 ID、expected-old 或最终验证。

已验证扩量门：同一计划器、writer 和租户连续三个 300-SPU 批次 dry-run 100% 通过且每批最终全量结构问题为 0 后，后续批次可省略重复 dry-run；计划器未知类型仍失败关闭，保存继续使用 expected-old，且每批全量复读、结构验证和 residual 不得省略。

已验证最快路线门：不能预设“标签页越多越快”。先用相同商品数比较单热编辑页、多编辑页和独立分片的端到端墙钟、
失败率与宿主内存；任一并发方案不更快、出现原生 detail 超时或把 `MemAvailable` 压近 5 GiB，立即停止并粘滞使用
单个长驻热编辑页。2026-08-13 的 1547-SPU、4.3.0、15 GiB 实测最终采用单热页短分片，总链路均值约
11.15 秒/SPU，首轮 3 个超时只在全量回读确认仍缺字段后补写，最终 1547/1547 零结构问题。

已验证长任务续跑门：同一合同/run-dir 中已经完整落盘且通过集合哈希校验的详情、建议、计划和 mutation 窗口必须
直接复用；完成窗口在恢复时必须零启动浏览器、零打开页面、零保存。只有缺失或集合不完整的阶段允许重跑，避免长任务
因执行器时间边界反复支付全量读取与冷启动成本。

已验证恢复门：批量详情读取出现 `Failed to fetch` 且没有任何 mutation 时，可在同一 CDP、tenant、route 和 profile 下最多重试 3 次，每次间隔 5 秒；任一身份变化或连续 3 次失败则停止。该只读重试合同不得用于自动重发结果未知的保存请求。

已验证 dry-run 恢复门：预演 checkpoint 的 `previewed` 是可复用终态，后续尝试不得再次打开这些商品；`failed`
因没有平台写入可只补检失败项。正式保存 checkpoint 的 failed/unknown 语义不变，必须先全量回读再决定 residual。
新 worker 在列表页只要求 H5guard 可用；可选 SPA 标签壳不挂载不构成失败，目标编辑页的原生 detail 精确绑定才是写前硬门。
每个短批进程还必须先用一个无商品绑定、10 秒后关闭的引导页暖加载 SPA；首个真实商品不得承担冷启动探针职责。
引导页后第一个真实商品固定单飞成功，随后才允许 2 并发；只有同量 canary 更快且资源余量持续通过才允许 4 并发，
任何历史配置值都不得覆盖 4 的硬上限。

已验证品牌结构：若当前租户、当前类目的品牌属性为 `attrValueType=4`，并且当前详情同时返回空 `optionList` 与空 `attrValueList`，远端品牌查询也无候选，则这是自定义文本品牌合同，不应伪造品牌编码。使用 `customValue.attrValueId="0"` 与受长度约束的品牌文本物化，先做单商品 dry-run、保存和独立回读；只有该精确形状允许此分支，有候选列表时仍必须使用当前候选的 ID/标签。

## 4. Excel 交付合同

- 最终文件名固定为 `MMDD{牵牛花租户名称}{源清单唯一SPU数}.xlsx`，例如 `0808懒宝宝8454.xlsx`。
- 日期使用任务交付日的 Asia/Shanghai 月日；租户名称来自本次 `session_identity.json` 的当前租户可见名称，移除文件名非法字符和空白；数量使用源表去重后的 SPU 数，不使用平台现存数、修改数或成功数。
- 使用 `scripts/standard_output_name.py` 生成路径，避免人工拼错口径。
- 运营交付只包含统一 7 张工作表；不复制来源各异的其他业务工作表。B 列逐 SPU 写执行前问题，C 列写本任务实际处理内容与最终独立回读值。历史已执行记录若有可信审计，应合并而不是覆写成“无需修改”。
- 五个平台的所有商品执行任务严格使用 `product-governance-operations-workbook-v1`，包括调价、商品编辑与医疗器械迁移；工作表名称、顺序和表头见
  [excel-schema-v1.md](excel-schema-v1.md)；“至少包含”不再允许用近义工作表替代。
- 只允许平台模块注册的 canonical 导出器导出；牵牛花使用 `export_standard_channel_fill_workbook.py`，翱象使用
  `export_multiplatform_channel_workbook.mjs`，两者及未来模块必须读取同一个 `operations_workbook_schema.json`，并通过
  对应 validator。执行汇总必须由最终工作表事实重新计算，不能保留旧批次数字。
- 合同同时冻结 `task_role=execution|validation_only`。普通填写任务默认 `execution`；只有用户明确要求只读复核、
  不写入或审计时才是 `validation_only`。
- 用户下载链接只能取自 `qnh_workbook_handoff_gate.py` 输出中 `ready=true` 的精确路径。完成门通过但交付门未过，
  仍不得交付；PoC、只读复核、另一个 run 或人工按修改时间挑出的 XLSX 都不是权威执行表。
- 历史聚合审计缺项时，允许从同租户逐商品结果补齐，但每个结果必须满足顶层 verified、requested/verification
  一一对应且逐字段 verified。只有 plan、preview、保存响应或部分回读的旧文件固定拒绝，不能把“曾计划”写成“曾执行”。

`copy_history_retry` 的 9 个映射事实只作为内部执行证据，不得直接交付专用工作簿。所有 ID 与条码按文本保存；每个
目标 SPU/SKU 必须先从当前主档独立回读，再映射进统一 7 表，由 handoff 校验 Schema、工作表顺序、源 SPU 数与文件指纹。
