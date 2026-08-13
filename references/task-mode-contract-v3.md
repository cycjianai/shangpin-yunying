# QNH 任务模式合同 v3

合同 ID：`qnh-task-contract-v3.3.4`。

## 1. 先路由，后读取

每个新 run 必须先由 `scripts/qnh_task_contract.py create` 冻结唯一 `task_mode`。模式冻结前只允许发现空闲浏览器、创建空 run-dir 和读取用户源清单；不得读取商品、扫描图片、调用外部服务或写平台。

路由优先级如下：

1. 用户明确说“只/仅填写渠道类目属性、指定 SPU 属性 100% 填满”时固定为 `channel_attributes_only`。
2. 用户明确要求处理“不可售、下架、审核报错、从不可售列表退出”时固定为 `unavailable_one_pass`。
3. 用户明确说“只处理资质图/专项图/配料营养图/背签/包装标签/尺寸图/吊牌洗唛”时固定为 `qualification_images_only`。
4. 用户明确要求运行或修改插件的商品属性功能时固定为 `plugin_attribute_fill`，不得偷换为 CDP 直连批处理。
5. 同时命中多个模式且没有“只/仅”限定时返回 `ambiguous_mode`，在用户明确范围前零商品读取、零外部调用、零平台写入。

`task_mode` 在同一 run-dir 内不可修改。用户扩大范围时必须新建 run-dir 和新合同；旧 run 的收据、计划、checkpoint 与动作日志不得迁移。

## 2. 模式能力矩阵

| 模式 | 固定目标 | 允许阶段 | 明确禁止阶段 |
|---|---|---|---|
| `channel_attributes_only` | 平台现存 SPU 的渠道类目属性结构问题为 0 | 身份预检、源清单、详情/模板/建议、确定性计划、dry-run、保存、独立回读、全量结构验证、标准 Excel | 不可售原因矩阵、OCR、图片/条码扫描、博查、Web 搜索、LLM/生图、图片上传、专项图、不可售复扫 |
| `unavailable_one_pass` | 按逐 SPU 审核原文处理并区分物化与审核退出 | `run-contract-541`、错误矩阵、普通字段、合规图片、审核反馈闭环 | 跨 SPU 猜事实、伪造法定材料、重复 provider submit、重复 final save |
| `qualification_images_only` | 只处理用户指定的图片槽位 | 槽位审计、同 SPU 证据、正式提示词、一次 submit、上传、保存、槽位回读 | 普通字段全量补齐、不可售原因扩张、法定证照生图、无预算 provider submit |
| `plugin_attribute_fill` | 运行/验收插件自己的商品属性链路 | 插件任务、1→10→100 实机门、字段回读、内存与交付率验证 | 改走 CDP 直连替代插件、修改无关插件功能、复用直连并发模型 |

`channel_attributes_only` 的硬预算永远是：`ocr=0`、`media_scan=0`、`barcode_scan=0`、`bocha=0`、`web_search=0`、`llm=0`、`provider_submit=0`、`provider_query=0`、`image_upload=0`。即使这些能力在同一 Skill 中存在，也不得调用。

## 3. 固定执行器

所有模式动作必须通过：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" \
  --action ACTION_ID -- COMMAND ...
```

启动器会同时验证：模式是否允许、命令是否命中固定脚本/子命令、脚本 SHA256 是否等于合同冻结值、调用预算是否足够，并将低敏终态写入 `task-action-ledger.jsonl`。禁止在 run-dir 临时创建替代规划器、writer、validator 或 Excel 导出器；禁止直接运行固定脚本绕过动作日志。

纯渠道属性模式固定使用：

- `build_spu_manifest_from_xlsx.py`
- `qnh_direct.mjs` 的预检、详情、建议、单计划 dry-run/保存与最终详情读取子命令
- `qnh_direct.mjs probe-exact-editor-frames` 的 5–10 条同页精确 frame 只读能力实验；平台 mutation 固定为 0
- `qnh_direct.mjs apply-prepared-barrier-batch` 的精确编辑页预热屏障、集中保存、统一回读实验；仅限用户明确授权提速、
  1–10 条 ready 计划、资源门通过且每个 SPU 拥有独立编辑页时使用
- `build_channel_contract_v2_plans.py`
- `run_qnh_batch.sh`
- `validate_channel_contracts.py`
- `standard_output_name.py`
- `export_standard_channel_fill_workbook.py`
- `validate_standard_channel_fill_workbook.py`
- `qnh_completion_gate.py`
- `run_channel_attributes_task.py`：把上述动作连续编排；它本身不得复制 writer、放宽验证或直接绕过 `run_task_action.py`。

未知字段形状只能先修正上述 canonical 计划器/验证器并增加回归；不得用 run-local 脚本绕过。

## 4. Manifest 与版本指纹

`task-contract.json` 至少冻结：

- `skill_version`、`contract_version`、`excel_schema_version`
- `task_mode`、路由证据、用户请求摘要 SHA256
- 源清单类型、文件 SHA256、唯一 SPU 数和 SPU 集合 SHA256
- allowed/forbidden actions、外部调用预算、完成必需动作
- Skill、引用合同、固定脚本和 UI metadata 的逐文件 SHA256
- 整份合同的 `contract_fingerprint_sha256`

每个动作和最终交付前必须重新校验这些哈希。运行中 Skill 或固定脚本发生变化时返回 `skill_fingerprint_mismatch`，不得混用前后两个版本继续写。

## 5. 机器完成门

`channel_attributes_only` 只有同时满足以下条件才能标记完成：

1. 源清单唯一 SPU 全部进入唯一终态；平台不存在单列，现存数与不存在数之和等于源数。
2. 最终全量详情验证 `products_with_issues=0` 且 `issue_count=0`。
3. 所有本轮修改字段都有最终独立回读值；无修改 SPU 也在最终全量验证中通过。
4. 必需动作全部通过固定启动器成功记录；动作日志不存在禁止动作或预算超限。
5. run-dir 不存在当前模式禁止的 OCR、媒体、条码、博查或 provider 制品。
6. Excel 通过精确 Schema 与内容对账。
7. 合同和所有固定文件版本指纹仍与任务开始时一致。

保存请求成功率、回读修改字段成功率和结构填充率必须分开统计；只要最终结构问题不为 0，就只能报告 `partial/blocked`，不能写“100%完成”。

## 6. 多协议执行合同

- 列表 profile 只接受当前列表文档原生 `POST page-query` 的 HTTP 2xx 证据，可冻结 4.2.0、4.2.4 或 4.3.0。
- 4.3.0 同租户详情/建议 query-only 可复用已冻结列表页并按目标请求逐次精确签名；mutation 只接受当前精确 SPU 编辑页原生 `POST detail` 的 HTTP 2xx、页面 SPU 与 body `spuId` 三方一致证据。
- 列表 query-only 只允许同一页面内最多 5 个 fetch，不创建商品标签；mutation 对同一 SPU 始终单飞。用户明确授权
  当前任务提速后，不同 SPU 必须使用相互独立的精确编辑页 worker，按 2→4→6→8→10 渐进放量并受宿主内存门约束。
- 每个自定义请求必须对最终 URL、POST 方法和最终 body 直接调用 H5guard；明文 a9 版本必须等于 URL 版本，opaque a9 只接受本次精确直签。
- 4.2.0/4.2.4 旧路径继续保留；未知版本、错 endpoint、错页面、错 SPU、第二次不一致和 HTTP 403 后改版一律失败关闭。
- 4.3.0 每个 worker 逐 SPU 单飞并及时关闭内部编辑标签；worker 页可以复用但不得跨并发商品共享。首次进入目标页时
  必须在导航前安装原生 detail 监听，一次 `goto` 即取证，禁止先导航再 reload 的重复往返。升级 Skill 后必须新建
  run-dir 和 3.2 合同，通过协议自动测试、5 条只读和 2 条写回门才可扩量。
- worker 列表页预热只硬等当前页 H5guard；可选的 `#multiple-nav-tabs` 壳可能在新标签中不挂载，不得因此等待45秒
  或判任务失败。安全边界由随后精确 SPU 编辑页原生 detail 证据承担，任何证据不完整仍然零保存。
- 每个 4.3.0 短批进程必须先完成一次无商品绑定、完成即关闭的 10 秒 SPA 引导页，再创建真实 worker。引导页不读
  目标商品且不得进入保存路径；其唯一目的，是避免短进程第一个冷 worker 在路由器未就绪时吞掉首个真实 SPU。
- 引导页之后的第一个真实 SPU 固定单飞；成功完成后才开放2并发，再按2/10/20/30个真实完成项升到4/6/8/10。
  首商品没有精确 detail 时批次失败关闭，不得用第二个并发商品替它暖机。
- 进程内任何资源降档都必须输出 `runtimePressureObserved`；外层观察器同时消费软降档与硬回收，把后续任务上限
  粘滞为 `max(1, peak-2)`。4→2 后若 2 路仍触发回收，固定转为 1 个长驻热 worker；资源短暂恢复不得抹掉该上限。
- shared admission 返回 75/76/77 表示本轮尚未启动平台执行。连续编排器必须延后后原 checkpoint 续跑，不把它计入
  商品失败或无进展轮次，也不得终止其他任务换取资源。
- dry-run 的 `previewed` checkpoint 必须原地复用，`failed` 只重试失败项；正式 mutation 的 failed/unknown 继续
  等待独立回读。不得反向重跑 dry-run 已通过项并永久跳过失败项。
- 渠道 200 的空品牌 type-4 合同只允许使用同次平台只读查询得到的“无品牌”精确编码回执；禁止猜编码，缺回执时明确阻塞。
- 计划器缺少上述回执时必须返回可审计的明确原因，不能泄漏为 `StopIteration` 或让整批无原因崩溃。
- 长任务恢复时，完整详情、建议、计划与已完成窗口只能在同一合同/run-dir内复用；已完成窗口必须零启动、零页面、零保存。
- `channel_attributes_only` 在 4.3.0、约 15 GiB 宿主上的默认 winner 为单个长驻热编辑页；多编辑页、同 Chrome
  双分片和 frame 并发只能先做小 canary，任一失败、宿主可用内存接近 5 GiB或端到端均值不优于单热页即停止。
  配置上限仍可保留为探索门，但后续正式分片必须粘滞采用本轮实测最快且零失败的实际 worker 数。
- 初始 mutation 的 `failed/unknown` 不得在下一分片自动重发。先完成独立全量详情读取和结构验证，只为仍有问题的
  精确 SPU 建 residual；residual 成功后必须再次全量读取，最终问题为 0 才完成。
- 性能统计固定以编排器总墙钟和源清单唯一 SPU 为主口径，并同时列出阶段墙钟、实际 worker 峰值与配置上限；
  checkpoint 跳过行、保存按钮间隔和控制器配置不得当作平均处理速度。
