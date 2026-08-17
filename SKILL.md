---
name: qnh-fill-channel-unavailable
description: 以版本化平台适配器、任务模式、原生接口写回、独立回读、精确 Excel Schema 和机器完成门，管理牵牛花、美团、翱象、淘宝闪购四个平台的属性信息、资质图与不可售治理任务；当前已实现模块按能力表失败关闭。用户要求当前已登录平台做属性 100% 填充、资质图治理、不可售一次过、标准运营审计表、断点续跑或复用跨平台经验时使用。
---

# 多平台商品渠道治理 v3.8.0

## 不可跳过的第一步

仓库更新或同步 GitHub 前，完整阅读 [repository-governance.md](references/repository-governance.md)。远端只允许保留
`main`；平台差异通过文件模块管理，不通过长期 Git 分支管理。

先阅读 [platform-module-map.md](references/platform-module-map.md)，再只加载当前平台对应的一个模块文件。
先冻结唯一 `platform_adapter` 与任务模式。不要把本 Skill 当作可以任意组合的能力清单：

- 当前页面/请求主机为牵牛花时，`platform_adapter=qnh`；完整阅读 [platform-qnh.md](references/platform-qnh.md) 和
  [task-mode-contract-v3.md](references/task-mode-contract-v3.md) 和
  [standard-task-contract.md](references/standard-task-contract.md)，再走下述 QNH 合同与固定动作入口。
- 当前页面为美团商家平台时，`platform_adapter=meituan`；完整阅读 [platform-meituan.md](references/platform-meituan.md)。
- 当前页面为翱象时，`platform_adapter=aoxiang`；完整阅读 [platform-aoxiang.md](references/platform-aoxiang.md)。
- 当前页面为淘宝闪购商家平台时，`platform_adapter=taobao_flash`；完整阅读
  [platform-taobao-flash.md](references/platform-taobao-flash.md)。

模块状态不是完成能力：标记为 `planned` 的平台/任务必须零写入并报告缺少适配器，禁止借用其他平台 writer 冒充实现。

在任何商品详情读取、外部调用或平台写入前完成该冻结。以下 `qnh_task_contract.py` 路由与合同命令只适用于
`platform_adapter=qnh`。其他平台必须使用各自模块注册的路由器与 writer。

使用确定性路由器：

```bash
python3 scripts/qnh_task_contract.py route --request-text "$REQUEST_SUMMARY"
```

路由结果为 `ambiguous_mode` 时暂停副作用并让用户明确范围。模式只允许以下四种：
用户提供表格/Excel/CSV 中的 SPU 并要求“信息填充/补齐信息”时，若没有不可售、图片或插件的明确目标，按 `channel_attributes_only` 路由；不要再把这类请求当作模式缺失。

- `channel_attributes_only`：指定 SPU 的渠道类目属性 100% 结构填充。
- `unavailable_one_pass`：逐 SPU 审核原因治理并追踪是否退出不可售。
- `qualification_images_only`：只处理用户指定的专项/资质图片槽位。
- `plugin_attribute_fill`：运行或优化插件自己的属性填充链路，不改走 CDP 直连冒充插件结果。

用户提供 SPU Excel/CSV 时，先用固定脚本生成只读 manifest；再创建不可变合同：

```bash
python3 scripts/qnh_task_contract.py create \
  --run-dir "$RUN_DIR" \
  --source-manifest "$MANIFEST" \
  --source-xlsx "$SOURCE_XLSX" \
  --request-text "$REQUEST_SUMMARY"
```

用户只给当前筛选列表时，先保存路由结果，只允许执行身份预检和只读清单冻结；得到 manifest 后立即创建
`task-contract.json`，随后通过固定动作启动器重新执行并记录 `session_preflight`。在合同创建前不得读取详情、
建议、审核原文，不得 OCR、调用外部服务、上传或保存。

## 条件引用：不要加载无关模式

- `channel_attributes_only`：完整阅读
  [channel-attribute-contract-v2.md](references/channel-attribute-contract-v2.md) 和
  [excel-schema-v1.md](references/excel-schema-v1.md)。翱象适配器还必须完整阅读
  [aoxiang-channel-contract-v1.md](references/aoxiang-channel-contract-v1.md)。不要读取或执行不可售错误矩阵、媒体、
  OCR、博查和生图流程。
- `unavailable_one_pass`：`platform_adapter=meituan` 时以完整的
  [platform-meituan.md](references/platform-meituan.md) 为唯一平台合同，并保持其模块状态门；
  `platform_adapter=qnh` 时完整阅读
  [run-contract-541.md](references/run-contract-541.md)、
  [thread-928-empirical-contract.md](references/thread-928-empirical-contract.md)、
  [error-playbook.md](references/error-playbook.md)、
  [field-safety.md](references/field-safety.md) 和
  [operations.md](references/operations.md)。
- `qualification_images_only`：完整阅读
  [thread-928-empirical-contract.md](references/thread-928-empirical-contract.md)、
  [error-playbook.md](references/error-playbook.md)、
  [field-safety.md](references/field-safety.md) 和
  [operations.md](references/operations.md)。只处理用户点名槽位。
- `plugin_attribute_fill`：完整阅读
  [channel-attribute-contract-v2.md](references/channel-attribute-contract-v2.md)；同时遵守项目 `AGENTS.md`、
  `docs/pitfalls.md` 和插件 1→10→100 实机门。不得修改无关稳定功能。

## 固定动作启动器

合同创建后，禁止直接运行规划器、writer、validator 或导出器。每一步都必须通过：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" \
  --action ACTION_ID -- COMMAND ...
```

启动器校验模式、动作权限、固定脚本路径、命令 token、调用预算和冻结 SHA256，并将低敏终态写入
`task-action-ledger.jsonl`。不要在 run-dir 创建临时替代规划器或 Excel 导出器；完成门要求必需动作均有
canonical 成功记录。

插件 UI、Web/博查或 provider 等没有本地可执行脚本的动作，必须先受模式预算允许，并在动作结束后用
`qnh_task_contract.py record-external --receipt RUN_DIR内低敏收据`登记；纯渠道属性模式预算为 0，因此这些动作
会在调用前失败关闭。付费 submit 仍须先经过业务源幂等 claim，`record-external` 不能代替 provider 幂等门。

合同和 Skill 指纹可随时复核：

```bash
python3 scripts/qnh_task_contract.py verify \
  --contract "$RUN_DIR/task-contract.json"
```

运行中任何 Skill、引用合同或固定脚本哈希变化都停止当前 run；新版本必须新建 run-dir 和合同。

## 浏览器与身份

用户明确要求复用当前已登录的普通 Chrome 时，优先使用 Codex Chrome 扩展对该精确牵牛花标签页的受限 CDP 能力，
不得再以原始远程调试连接触发 Chrome 全浏览器授权弹窗。扩展路径固定导入
`scripts/qnh_chrome_extension_engine.mjs`，只在当前工具调用链中运行；禁止把扩展能力转发成后台通用 CDP 端口。
扩展动作完成后用同 Skill 的 `qnh_extension_receipt.py` 校验引擎指纹、run-dir 内制品及 SHA256，并通过
`run_task_action.py` 记入原动作 ID。它仍必须取得列表页原生请求、精确编辑页 detail、页面/SPU/tenant 三方一致、
一次保存和独立回读；不得因复用现有 Chrome 放宽完成门。该路径不读取 Cookie、localStorage、sessionStorage 或密码。
扩展身份的 `browser_transport` 固定为 `chrome_extension_current_tab`；它没有可复用的原始 CDP 端口，`cdp_url`
使用 `chrome-extension-current-tab://scoped` 作为受限传输标记，完成门不得因此要求用户再次点击远程调试授权。

扩展写入按宿主工具时限拆成可落盘的小窗口，每个窗口目标控制在 60 秒内；最终详情读取也使用 `offset/limit` 续写
同一输出文件，不用一次长调用赌全量完成。工具调用超时后禁止猜测并重发该批：先读取 checkpoint，再做独立全量回读。
若超时把任务标签留在精确编辑 route，且后续捕获报告 paused document response，只关闭这个任务遗留的牵牛花编辑
标签（不关闭其他业务标签），在同一已登录 Chrome 打开新的牵牛花列表标签并重新 claim，然后按 checkpoint 续跑。

默认优先复用本 Skill 已启动且只读证明空闲的隔离 Chrome/CDP/noVNC。旧会话有运行中或待续传任务、
provider/upload/save/write-intent/pending-verify、租约、身份未知或进程不健康时不得抢占。只有用户明确要求新开，
或没有合格空闲会话时，才通过 `scripts/start_qnh_browser.sh` 新建。
跨平台运行时先从 `QNH_PLAYWRIGHT_CORE_PATH` 加载 Playwright，其次使用当前 Node 可执行文件同级的本地依赖，最后保留 Linux 标准路径兼容。编排器使用 `QNH_NODE_BIN` 或当前 `PATH` 中的 Node，不得假设所有主机都有 `/usr/bin/node`。
macOS 新建会话时同样必须使用独立 `--user-data-dir` 和 loopback-only CDP，保留当前普通 Chrome 不动；禁止从普通 profile 复制 Cookie 或登录数据。macOS 没有 noVNC，用户直接在新窗口登录。

所有新 Chrome 和 QNH 批处理必须经 `/home/saas/repo/tools/runtime_stability/run_bounded_automation.sh`
或已接入该入口的 Skill 脚本进入受管 cgroup；禁止在 `ssh.service` 裸跑高并发进程。资源不足只延后新任务，
不停止其他浏览器或业务进程。

用户完成登录后运行 `session_preflight`，把实际 profile、CDP、tenant/store、route、可见租户名、run-dir
写入 `session_identity.json`。身份任一冲突时零详情读取、零外部调用、零上传、零保存。不要输出 Cookie、签名、
Authorization、验证码或完整受保护请求头。

### 4.2.0 / 4.2.4 / 4.3.0 强制兼容门

协议版本只能来自当前文档的原生成功请求，不得按账号、租户、历史缓存或错误文案猜测。列表页必须先捕获当前
`/unifiedGoods/tenant/spu-list` 文档原生 `POST /qnh-gw3/api/product/tenant/page-query` 的 HTTP 2xx 和已知
`csecversion`，随后才允许按同一冻结版本发自定义 query。4.2.0 与 4.2.4 旧合同永久保留；发现 4.3.0 时只作
增量收敛，禁止版本轮盘和 403 后换版本。

4.3.0 同租户详情与官方建议属于 query-only，可在已冻结的列表页 profile 上按目标 SPU 和最终请求体逐次精确签名；
不得用该共享页执行 mutation。写入必须逐 SPU 打开精确 `/unifiedGoods/tenant/edit?spu=目标`，先取得当前文档原生
`POST /qnh-gw3/api/product/tenant/detail` HTTP 2xx，并同时核对页面 SPU、请求体 `spuId` 与目标完全一致。之后每个 endpoint 都由页面内
`H5guard.sign(exact URL + POST + exact body)` 单独签名；a9 有明文版本时必须与 URL 相等，opaque a9 只因本次
精确直签而可继承冻结版本。任一页面、SPU、endpoint、method、版本或签名不匹配均零发送。

编辑页原生证据不得依赖 Playwright/CDP 在刷新后再次读取 response body；Chrome 可能已释放该 resource。原生阶段只冻结当前
document、精确 route/SPU、detail POST、body `spuId` 和 HTTP 2xx；随后必须立刻用同页精确 H5guard 签名 detail 再读业务正文，
并对 HTTP/业务码/SPU/tenant 做正式校验。原生证据失败仍然发生在 mutation 前且不得保存。

4.3.0 列表 query-only 并发上限固定 5（仅同一页面内 fetch，不新开标签）。写回必须使用独立编辑页池：同一 SPU
始终单飞，不同 SPU 在用户对当前任务明确授权后按 `2→4→6→8→10` 渐进放量；每个 worker 页只处理一个当前
SPU，取得精确原生 detail 证据后完成一次保存和独立回读，再关闭该商品内部编辑标签后复用 worker 页。不得在共享
列表页 mutation，也不得为每个 SPU 永久新建页面。新 Skill 版本不得复用
旧 run-dir、合同或 checkpoint。正式扩量前必须通过自动协议矩阵、当前账号 5 条只读门和 2 条一次保存+独立回读门。
受管 mutation 进程自身 RSS 达到 1.6 GiB或宿主 `MemAvailable` 低于 5 GiB时必须 checkpoint 后回收；外层 cgroup
继续固定 `MemoryHigh=2.5G/MemoryMax=3.2G`。不得把 7 GiB 作为 15 GiB 宿主的无条件回收阈值，否则会在健康
234 MiB 进程上形成单商品重启风暴。

当 4.3.0 精确编辑页冷启动成为主要耗时时，先通过固定动作 `probe_exact_editor_frames` 做 5–10 条只读实验：在
当前列表页内创建同源、不可见、不可聚焦的精确 SPU frame，只接受 frame 自身的原生 detail 与本次精确
H5guard 签名证据，随后立即回收；整个实验 platform mutation 固定为 0，顶层 URL 和页面数量必须不变。只有
顺序 5 条 100% 后才允许最多 5 路再测 5 条；并发实验也必须 100% 通过，才允许为下一版本提出 frame writer。
只读签名成功本身不授权保存，真实写入仍须新合同与
1→2→10 保存/独立回读门。禁止直接恢复历史列表页 mutation。

2026-08-13 当前 4.3.0 账号实测：顺序 frame 5/5，但 5 路仅 2/5；降至 2 路虽 5/5，整批墙钟约 84 秒，
平均约 16.9 秒/SPU，慢于现有精确编辑页核心保存链。因此同页 frame 只保留诊断能力，不得自动升级为属性 writer。
不要用“能签名”推断“列表页可安全保存”，也不要以 frame 替换现有精确编辑页合同。后续账号只有重新通过顺序与
并发门且端到端墙钟明确优于现链，才允许另立版本继续 1→2→10 mutation canary。

4.3.0 列表 query-only 遇到浏览器 `Failed to fetch/NetworkError` 时，只允许在同一冻结 profile 下等待 500ms、
重新对同一精确请求签名并重试 1 次，同时记录低敏 retry 事件；第二次失败立即停止。该规则严禁用于 upload/save 等
mutation，未知写结果仍只允许独立回读，不得自动重复 final save。
读取官方建议时，如当前详情明确出现渠道 200 的空品牌 type-4 合同，固定读取一次平台“无品牌”候选并保存低敏回执；
不得由计划器猜测品牌编码，也不得因缺少回执直接抛出未分类异常。

每个商品完成、失败或 dry-run 留证后立即关闭其“商品主档编辑”内部标签；常驻只保留首页、商品主档和最多 10 个
可回收 worker 页。不得为每个 SPU 累积页面。当前 15 GiB 主机默认批量并发 2；只有用户对当前任务明确授权并满足
50-SPU 分片、2 商品 canary、RSS/宿主门、外部看门狗和全量补差时，才能按合同自适应提速。自适应模式先同时跑 2
条，健康完成数达到 2/10/20/30 时才允许升到 4/6/8/10；宿主可用内存低于 7/6.5/6/5.5 GiB 时分别压到
8/6/4/2，低于 5 GiB 或联合资源达到硬门时 checkpoint 后回收。同一任务若 4 路已降至 2 路，而 2 路仍触发
回收，控制器必须继续粘滞降为 1 个可复用热 worker；禁止用“最小并发必须为 2”制造每 3–5 条一次的冷启动风暴。
自适应任务降至 1 个 worker 后，允许在 Node RSS 低于 1.6 GiB 时逐商品执行显式 GC，以保持同一编辑页和同一
短进程持续工作；并发大于 1 时仍禁止同步 GC，避免另一响应物化期间发生堆抖动。summary 必须记录 GC 次数与耗时。
同一单 worker 完成保存和独立回读后，还必须通过该页面专属 CDP session 执行 renderer 垃圾回收，再复用页面；
并发大于 1、未发生平台工作或页面已关闭时禁止执行。renderer GC 失败只记录并交给资源门决定是否软回收，不能
把已回读成功的商品改成失败，也不能因此重复保存。

`--concurrency 10` 只是允许控制器探索的配置上限，不是“实际稳定 10 并发”的证明。对外只能报告本轮
checkpoint 中真实启动并成功完成的峰值。当前 15 GiB 宿主的 4.3.0 编辑写回应先探测 2，4 只允许短时探测；
4 worker 一旦出现 renderer 内存抬升、原生详情超时或宿主门触发，立即退回 2；若 2 仍触发回收，再退回 1 个
长驻热页。任何压力降档后都禁止继续升到 6/8/10，更不得把配置值 10 写成实际并发 10。

2026-08-13 的 1547-SPU 全量实测进一步冻结默认选择：同一 Chrome 多编辑页、两个独立分片进程并行，以及隐藏
frame 并发都没有优于单个长驻热编辑页；双分片还把宿主可用内存压到约 5 GiB，并把单项推高到约 43 秒，因此
canary 一旦不更快或出现任一失败就立即停止。当前账号的最快稳定路线固定为“列表页最多 5 路只读 + 单个热编辑页
mutation + 最多 50 SPU 持久分片 + 分片完成后回收页面/进程 + 最终全量回读只补 residual”。本轮 1246 个初始计划
中 1243 个首轮回读通过、3 个编辑页超时；独立全量复读精确定位同 3 个 residual，3/3 一次保存并回读，第二轮
1547/1547 结构问题为 0。首轮 failed/unknown 绝不立即重发，必须以独立回读后的实际结构问题决定是否补写。

性能汇报必须至少包含总墙钟、源 SPU 数、`总墙钟/源SPU`、各阶段耗时、实际稳定 worker 数和配置上限，并明确
区分。不得用含 checkpoint 跳过行的 item P50、按钮点击间隔或配置 `--concurrency` 冒充端到端速度。本轮完整链路
（详情、建议、规划、预演、保存、两轮全量验证、Excel）总墙钟 4:47:21.604，1547 条端到端均值约 11.15 秒/SPU；
这是当前 4.3.0、15 GiB 宿主的可复现实测基线，不承诺跨账号恒定。

## 翱象 `channel_attributes_only` 固定快速路径

翱象平台只复用当前用户已经登录的 Chrome 页面。以当前诊断页的 `planId/storeCode/channelCode/type` 冻结只读清单，
分页最大 100，先记录顶层 `total` 与 2118 等基线数量；不得把 `data.total` 当作总数。目标 writer 固定为
`scripts/aoxiang_channel_engine.js`，它只填美团 `MT` 与淘宝闪购/饿了么 `ELE` 的渠道属性，禁止修改价格、库存、
上下架、图片、活动状态或其他商品主档字段。渠道类目默认不可改；若当前类目与标题明确冲突并直接产生无关的监管属性，
只允许用当前渠道树中语义唯一的叶子类目做逐商品 `exact_obsolete_category_repair`，旧/新 ID、路径和回读必须入审计。

先冻结 `fill_strategy`：首次安全补齐用 `deterministic_fill`；用户指出已有值不合理、平台红框/范围提示未识别，或重检后
仍有大量“需手动修改”时，改为 `evidence_semantic_correction`。纠错模式仍然只改 MT/ELE 渠道属性，但允许读取同商品
标题、规格、详情图 OCR、当前字段候选/范围/平台匹配提示，并用模型在当前精确候选中判断。完整规则见
[aoxiang-channel-contract-v1.md](references/aoxiang-channel-contract-v1.md)。不得把模型输出直接提交；先运行
`aoxiang_deepseek_semantic_planner.mjs` 的本地物化校验，再用 `aoxiang_audit_semantic_overrides.mjs` 独立审计。

正式写入前固定通过：1 条 UI 原生 canary、1 条直接接口 canary、50 条只读覆盖、10 条多品类实写并独立回读。
冻结后使用经同品证据复核的平台匹配值、已存在跨渠道等价事实、标题/规格明确事实与非监管安全默认，复合字段必须按目标
渠道的值类型和单位候选重新物化。监管编号、功率、型号等不得凭空生成；缺少精确事实时先进入 blocker，残差只能由
同品事实、平台候选、标题/规格或中性包装/铭牌回指规则收敛，并在字段审计中标明来源。
`supportExtend=1` 且候选为空的下拉不是无候选：按翱象原生转换合同提交空 ID 与规格原文。实物图、检测报告或吊牌中
有逐字事实时，只能通过逐 SKU `evidenceOverrides` 注入合法候选，并记录证据说明；不得把该覆盖扩散到其他商品。

保存必须发送平台当前原生完整商品 payload，`updateOnExitActivityFlag=0`；同一商品 mutation 只发送一次。无论保存
响应成功、失败还是未知，均重新 GET 商品详情并逐字段比较 ID、名称、类型与复合结构；mutation 失败不得自动重发。
并发从 1 起步，连续健康波次按 `1→2→4→6` 提升；429、请求失败或 P95 恶化立即降档。每轮导出
`aoxiang-channel-fill-checkpoint-v1`，新一轮只处理非 `verified/verified_no_change` 残差。

纠错模式不得盲用 `matchValue`：必须先做只读扫描，逐项排除与标题/规格冲突的推荐（例如瓶装→罐装、预包装→散装、
单件容量写成整箱总量、容量写入浓度）。只有与同品标题、规格、OCR 或已验证跨渠道事实交叉一致的值才标记为
`platform_match_validated`。纠错模式只写审计通过且确实变化的字段，其他现值必须原样保留；用 `evidenceOverridesOnly=true` 与
`allowPartialEvidence=true` 生成 `verified_partial` 回读结果。空覆盖、非法候选 ID、平台范围外数值、容量/重量误作浓度、
证据说明含“通常/常识/推断/推测/默认/疑似/OCR 误差”以及没有同商品明确证据的监管事实必须阻断。本轮纠错的事实字段和普通候选语义字段都使用至少 0.8 置信门；平台真实事实若超出当前 schema（例如真实酒精度 13，但字段最大值为 10），
不得夹到 10 或伪造；保留原值并记录平台 schema blocker。模型请求按批次写 call checkpoint，续跑只补失败批次。

诊断列表是异步快照。批量保存后调用平台原生 `POST /goods/check/reCheck2`，请求体仅含当前 `storeCode`，再轮询
`GET /goods/check/getReCheckTime` 与诊断分页；重检未完成时不得把旧残量当作新的真实缺项重复写入。
`getReCheckTime=0` 或诊断 `total=0` 都可能是重检启动后的瞬时缓存，不代表清零。下一轮 residual 只能来自至少 60 秒内
连续 3 次相同的非瞬时分页总数与稳定 SKU 集合；任一次出现 `0→部分值→另一值` 都重新开始稳定窗口。

最终必须把 2118 等冻结清单合并成单一 checkpoint，所有商品状态只能是 `verified` 或
`verified_no_change`，再用平台诊断 API 全量复读，确认属性问题 `problemType=4` 为 0。诊断页仍可能存在无图文等非属性
问题；不得把它们误报为本属性任务失败，也不得越权治理。

运营表使用平台中立导出器，并保持与牵牛花相同工作表顺序：执行汇总、SPU清单、字段级审计、平台不存在、
最终结构复核、问题与策略回灌、性能与外部调用统计。只能从最终 checkpoint 导出：

```bash
node scripts/export_multiplatform_channel_workbook.mjs \
  --checkpoint "$RUN_DIR/checkpoint-final.json" \
  --platform-name 翱象 --store-name "$STORE_NAME" \
  --skill-version "$(cat VERSION)" \
  --contract-fingerprint "$CONTRACT_FINGERPRINT" \
  --preview-dir "$RUN_DIR/workbook-previews" \
  --output "$OUTPUT_XLSX"

node scripts/validate_multiplatform_channel_workbook.mjs \
  --checkpoint "$RUN_DIR/checkpoint-final.json" \
  --workbook "$OUTPUT_XLSX" \
  --output "$RUN_DIR/workbook-validation.json"
```

## 牵牛花 `channel_attributes_only` 固定快速路径

这个模式默认处理用户“指定 SPU + 渠道类目属性全部填满”的请求。目标是平台现存 SPU 最终结构问题为 0，
不是处理不可售、图片或资质。

硬预算固定为：OCR、媒体扫描、条码扫描、博查、Web、LLM、provider submit/query、图片上传全部为 0。
动作白名单之外的请求必须由启动器返回 `scope_violation`。禁止运行 `build_error_strategy_matrix.py`、
`scan_media.py`、`scan_barcodes.py` 或任何专项图脚本。

合同创建后优先用一次连续编排器执行，避免把 canonical 步骤拆成多轮对话工具调用：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action orchestrate_channel_task -- \
  python3 scripts/run_channel_attributes_task.py \
  --contract "$RUN_DIR/task-contract.json" --manifest "$MANIFEST" \
  --cdp "$CDP_URL" --profile-dir "$PROFILE_DIR"
```

编排器只调用下列既有固定动作，不拥有独立 writer。默认并发仍为 2；用户明确授权当前任务提速时可传
`--concurrency 10`，这只是配置上限。4.3.0 每个最多 50 SPU 的独立进程必须从首商品单飞起步，首条成功后才按
2→4→6→8→10 渐进放量，并同时观察 Node RSS、相对浏览器基线新增的 renderer RSS、宿主可用内存、失败数和
P95；任何压力只允许单调降档或回收当前进程。工作页创建必须串行预热，仅屏蔽 image/media/font，不能屏蔽脚本、
样式、H5guard 或接口。初次预演固定最多 5–10 条；每轮保存后全量回读，最多允许三轮基于新详情的 residual。
每个商品结果必须包含写前详情、计划物化、保存请求、保存后等待、独立回读、验证和持久化的低敏毫秒计时。
长尾未定位前不得新增 mutation 自动重试。

长任务必须支持同一 run-dir 的阶段级断点续跑：完整且SPU集合精确一致的初始详情、官方建议和计划目录直接复用；
保存窗口 checkpoint 已覆盖全部选中SPU的 verified/no_change 时不得再次启动 Node/浏览器。此复用只限同一冻结合同，
不得跨 run-dir 搬运计划或 checkpoint。外层执行器超时后，先等待仍在运行的受管短进程落定，再从同一 run-dir 续跑。

worker 预热的硬门只包含列表页导航完成与本页 H5guard 可直接签名；`#multiple-nav-tabs` 等可选 SPA 标签壳不得作为
预热硬门。真正的 mutation 门仍是目标 SPU 精确编辑 route、原生 detail POST、body `spuId` 和 profile 三方一致，
随后每个 endpoint 精确重签。dry-run checkpoint 中 `previewed` 是可复用终态，`failed` 因无平台副作用只补检失败项；
正式 mutation 的 `failed/unknown` 仍必须先独立回读，绝不自动重发 final save。

4.3.0 每个短批进程在创建真实商品 worker 前固定创建一个无商品绑定的引导页：按相同资源屏蔽规则进入列表页、
等待 H5guard 后静置 10 秒，随后关闭。引导页只暖加载 SPA 代码，不读取目标商品、不保存，也不占用 worker 池。
禁止把首个真实 SPU 当作隐式引导项；否则首商品可能没有原生 detail，而后续商品正常，重试时会永久卡首商品。
引导页关闭后，第一个真实 SPU 仍必须单飞；只有它取得精确原生 detail 并完成本次 dry-run/保存回读后，才允许升到
2 并发，随后沿用 2/10/20/30 个真实完成项的 4/6/8/10 阶梯。不得在首个真实商品阶段同时启动两个编辑路由。
任一短批只要出现 `runtimePressureObserved=true`，即使未达到硬回收，也必须把当前任务后续批准上限粘滞为
`max(1, 本批真实峰值-2)`；不得只在 `runtimeMemoryPressureStop=true` 时才记住压力，导致下一分片重复冲高。
当共享 admission 因 75/76/77 拒绝新进程时，编排器只做 15 秒资源延后并重试原 checkpoint，不计为商品失败、
不重放已验证保存，也不得为了通过准入而关闭其他任务或业务进程。预检因 SPA 原生请求偶发未捕获时最多原 profile
重试 3 次，任一次成功即继续；身份、租户、协议或签名明确冲突仍立即失败关闭。

按以下顺序执行：

1. 从源表冻结唯一 SPU；保存源文件 SHA256。平台记录不存在单列，不从源表删除。
2. 预检身份并清理编辑标签。
3. 用 `qnh_direct.mjs details` 读取初始完整详情；可读取当前平台建议和类目模板。
4. 只用 `build_channel_contract_v2_plans.py` 生成计划。取值顺序固定为：当前合法建议 → 同 SPU 跨渠道等价值
   → 标题/SKU 明确事实 → 用户授权的安全非监管默认矩阵。
5. 先做 5–10 条 dry-run；通过后用 `run_qnh_batch.sh` 按稳定 ready 顺序和 `offset` 拆成最多 50 SPU 的窗口。
   同一 SPU 始终串行执行读详情 → expected-old 校验 → 一次保存 → 独立回读。窗口被软回收时只续跑没有终态
   checkpoint 的商品；同一窗口中已 verified/no_change 的商品不得重复保存。
6. 保存失败或结果未知时先全量回读；同一 checkpoint 的 failed 项不得盲目重试，已物化项不重发，只为最终验证
   仍有问题的 SPU 生成新 residual。连续两次没有新增终态则先放过该窗口，不能阻塞后续窗口。
7. 重新读取全部平台现存 SPU，运行 `validate_channel_contracts.py`。只要
   `products_with_issues` 或 `issue_count` 非 0，就继续 residual 或报告阻塞；不得宣称 100%。
8. 使用固定导出器、Schema validator 和完成门；三者任一非零都不得交付完成表。

批量保存示例：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action apply_batch -- \
  bash scripts/run_qnh_batch.sh apply-direct-batch \
  --run-dir "$RUN_DIR" --index "$PLAN_INDEX" \
  --offset 0 --limit 50 \
  --batch-name channel-attributes-b0001 --concurrency 2
```

用户明确要求验证“先准备、后集中保存”时，只允许使用受资源门约束的实验动作：所有精确 SPU 编辑页与内存补丁先通过
同一屏障，随后集中提交保存；所有保存请求落定后才开始独立回读。它用于分别测量预加载、保存突发和全流程墙钟，不能把
保存突发的毫秒/SPU冒充全流程平均速度。当前可用内存低于 7/8/9 GiB 时批量上限分别为 2/4/6，只有至少 9 GiB
时才允许10页；任一编辑页或补丁准备失败时整批零保存。

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action apply_prepared_barrier_batch -- \
  env QNH_DIRECT_BATCH_MANAGED=1 QNH_DIRECT_ADAPTIVE_APPROVED=1 \
  node scripts/qnh_direct.mjs apply-prepared-barrier-batch \
  --cdp "$CDP" --run-dir "$RUN_DIR" --index "$PLAN_INDEX" \
  --offset 0 --limit 2 --preload-concurrency 2 --batch-name prepared-barrier-poc2
```

全量结构验证示例：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action validate_channel_contracts -- \
  python3 scripts/validate_channel_contracts.py \
  --details "$FINAL_DETAILS" \
  --output "$RUN_DIR/channel-contract-validation.json"
```

## 其他模式固定边界

### `unavailable_one_pass`

按审核原文选择唯一处理路由，并合并为单 SPU one-pass 计划。保存回读与审核退出分开统计；审核等待期间不重复
保存已物化字段，不重复 provider submit。普通字段可走平台事实或项目博查合同；图片可走同 SPU 真实证据和项目
正式提示词；CCC、备案、注册证、许可证、医疗/化妆品监管材料只允许真实权威证据，查不到就阻塞。

### `qualification_images_only`

先审计实时 `pictureType/title/description/numLimit`，优先错槽迁移和同 SPU 真实图复用。只有用户点名的图片类型
能进入 job manifest。每个稳定业务键最多一次 submit；拿到 `provider_task_id` 后只 query 原任务。生成制品必须
经过品牌、型号、规格、尺寸、配料、营养、条码和法定事实目视/OCR 核验后才能上传，不能生成法定证照。

### `plugin_attribute_fill`

实际运行插件并以插件任务、平台保存和独立字段回读验收。不得用直连脚本的成功冒充插件成功。页面准备窗口、
编辑页峰值、Chrome RSS、交付率和填充率按 1→10→100 逐级验证；任一级未达到 100% 就停止扩量并修复唯一根因。

## 精确 Excel 与完成门

所有平台与任务模式必须完整阅读 [excel-schema-v1.md](references/excel-schema-v1.md)，并使用唯一机器 Schema
`scripts/operations_workbook_schema.json`。牵牛花、美团、翱象、淘宝闪购的属性信息与资质图任务必须交付完全相同的
7 张工作表、表头、汇总指标及字段顺序；每轮只允许商品、执行前值、处理值、回读值、数量、耗时和策略等数据变化。
平台模块不得增加专属工作表或改字段名，不适用指标填 0。资质图将图片槽位映射为字段 ID/名，仍进入同一字段级审计。

固定文件名为
`MMDD{实时租户名称}{源清单唯一SPU数}.xlsx`。源工作簿只读；统一回传表只生成 canonical 7 张工作表，并按 SPU
把可信历史合并进 `SPU清单` B/C；
同一逻辑任务因 Skill 字节升级而必须新建 run-dir 时，只能由导出器显式 `--history-run-dir` 合并历史。
历史目录必须与当前 `session_identity` 的 tenant ID 完全一致，且只接纳带完整
`requested_changes + verification` 的 verified 结果 SPU；禁止扫描“最新目录”或把已计划但未保存的字段写进 B/C。
旧分片的聚合 `audit.json` 可能只保留部分 SPU，或早期 PoC 使用非 canonical 审计目录。导出器必须先使用聚合审计，
再从同租户 `*-result.json` 中补齐缺失字段；结果回退仍要求顶层 `verified=true`、requested 与 verification 数量相等，
且每个 verification 都为 `verified=true`。计划文件、preview、部分回读或只有保存响应的结果一律不得进入 B/C。
旧可信记录必须合并，不得覆盖成“无需修改”。源文件只作为输入；运营交付统一生成固定 `SPU清单`，不复制其他业务
工作表，确保每个平台、每种任务的输出结构一模一样。
Chrome 扩展的完整最终快照允许命名为 `details-final*.json`，但导出器只有在其唯一 SPU 集合与冻结 manifest 精确
相等时才接纳；部分续写文件不得导出。扩展审计目录固定为 `channel-plans/audit.json` 与
`residual-round*-plans/audit.json`，保存 checkpoint 固定接纳 `save-*` 与 `residual-rN-*`，dry-run 永不计入交付性能。

固定导出：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action export_workbook -- \
  python3 scripts/export_standard_channel_fill_workbook.py \
  --run-dir "$RUN_DIR" --manifest "$MANIFEST" \
  --task-contract "$RUN_DIR/task-contract.json" \
  --validation "$RUN_DIR/channel-contract-validation.json" \
  --tenant-name "$TENANT_NAME" --output "$RUN_DIR/$(basename "$OUTPUT_XLSX")" \
  ${SOURCE_XLSX:+--source-xlsx "$SOURCE_XLSX"}
```

随后必须通过 `validate_standard_channel_fill_workbook.py`，再运行：

```bash
python3 scripts/run_task_action.py \
  --contract "$RUN_DIR/task-contract.json" --action completion_gate -- \
  python3 scripts/qnh_completion_gate.py \
  --contract "$RUN_DIR/task-contract.json" --manifest "$MANIFEST" \
  --validation "$RUN_DIR/channel-contract-validation.json" \
  --workbook "$OUTPUT_XLSX" --summary "${OUTPUT_XLSX%.xlsx}.summary.json" \
  --coverage "${OUTPUT_XLSX%.xlsx}.coverage.json" \
  --workbook-validation "$RUN_DIR/workbook-validation.json" \
  --output "$RUN_DIR/task-completion-gate.json"
```

完成门后还必须运行 `qnh_workbook_handoff_gate.py` 生成 `workbook-handoff.json`。只有 `task_role=execution`、
工作簿路径与本 run 的 summary/validator 完全一致、文件名 canonical、字段审计对账且 `ready=true` 的工作簿
才可向用户发链接。`validation_only`、PoC、抽样复核或另一个 run 的工作簿一律不得冒充本次执行结果；禁止人工
在目录里挑“最新 xlsx”。
权威工作簿必须先生成在当前 run-dir 并通过交付门；如桌面应用需要在输出目录展示，只能在 `ready=true` 后复制或
创建指向该权威文件的链接，并核对 SHA256 相同，不能把 run-dir 外文件反向送入交付门。

只有 `task-completion-gate.json` 的 `complete=true` 且 `workbook-handoff.json` 的 `ready=true` 才能报告完成。分别汇报：源 SPU、平台现存、平台不存在、
保存回读、最终结构问题、外部调用、Excel Schema 和合同指纹；不能把保存成功写成填充率 100%。

## 经验回灌

每轮维护低敏问题表：反例、触发条件、错误策略、根因、可泛化规则、PoC 和全量结果。发现新字段形状或失败模式时，
先更新 canonical 脚本/引用合同和回归样例，再运行 Skill `quick_validate.py`。不要把 tenant、SPU、Cookie、签名、
provider 任务号或单商品事实写入 Skill。

当前 run 的版本指纹必须保持冻结。若新问题必须修改 canonical 文件才能继续，先保存本轮 checkpoint 和 residual，
升级 `VERSION`、运行黄金样例与 `quick_validate.py`，再为 residual 新建 run-dir 和新合同；不得让同一合同混用两个
Skill 版本。若当前 run 已通过完成门，先交付冻结版本的结果，再把经验升级给下一次任务。
