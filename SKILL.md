---
name: qnh-fill-channel-unavailable
description: 通过优先复用空闲隔离 Chrome/CDP/noVNC、必要时新建会话，批量处理牵牛花“渠道不可售”商品或指定 SPU 清单，复用项目博查解析与正式专项图提示词，100% 物化渠道类目属性，逐条保存、结构回读、断点续跑，输出标准命名的完整 Excel 审计并把新问题回灌为下次可复用策略。用户要求登录远程窗口后跑商品信息填充、渠道属性全填、资质图、不可售治理或复用跨账号经验时使用。
---

# 牵牛花渠道不可售商品直连治理

## 目标

在用户手动登录牵牛花后，直接控制隔离 Chrome。冻结用户指定筛选结果，逐商品读取平台报错，用可追溯证据填字段并保存；不调用浏览器插件、原点操作台或业务数据库。

完成标准不是“接口返回成功”，而是：

1. 每次更新都回读对应商品并核对目标字段。
2. 重新查询原筛选条件，记录已退出和仍在列表的商品。
3. 输出字段级 CSV/XLSX，包括修改前后、证据、提交状态、回读状态和未解决原因。

## 必须遵守

- 浏览器必须使用隔离 profile、独立调试端口和 loopback 绑定；用户只通过 SSH 隧道访问 noVNC/CDP。
- 登录、短信、扫码和验证码由用户完成。不要读取或输出 Cookie、签名、Authorization、验证码或完整受保护请求头。
- 不编造品牌、产地、厂名厂址、生产许可证、CCC、化妆品备案/注册号、医疗器械资质、进口资质或任何法定图片。
- 资质图优先复用同一商品已有图片；也可使用牵牛花图库的完整标题查询结果，但必须通过商品词、型号/规格冲突门和 OCR/人工目视证据。无证据就留为阻塞项。
- 不生成或冒充 CCC、医疗/化妆品注册备案、检验报告、公章等官方材料；已有真实监管材料仍可按证据复用。
- 默认作用于全部门店；若商品参加活动，保留活动关系并选择“更新商品”，不静默跳过。
- 不以按钮点击、HTTP 200 或业务码成功代替回读验证。
- 先做 5–10 条 PoC，验证 100% 后再全量；全量必须有 checkpoint，可从中断处继续。
- 每个商品保存并回读后必须立即关闭它的“商品主档编辑”内部标签；失败或 dry-run 留证后也关闭。任何时刻不得累积商品编辑标签，避免页面组件和图片占满内存。
- 默认采用“CDP 页面上下文接口自动化”：复用已登录页面自己的受保护请求能力调用牵牛花正式商品详情、图库与更新接口，不调用项目插件、业务数据库或绕过登录的后台接口。只有定位页面契约或处理接口未覆盖字段时才短暂打开 UI。

## 工作流

每次任务首先完整阅读 [standard-task-contract.md](references/standard-task-contract.md)。默认先发现由本 Skill 管理的既有隔离浏览器并做只读空闲审计；存在健康、身份可核验且没有运行中/待续传任务的会话时直接复用，并把原隧道命令和登录网址交给用户。只有用户明确要求新开，或旧会话正在执行任务、存在待续传副作用、身份不明、登录失效、进程/端口不健康时才新建。任务完成必须按该合同做全量 100% 结构复核、标准 Excel 命名和新问题回灌。

每个新账号开始前必须完整阅读 [run-contract-541.md](references/run-contract-541.md) 和
[thread-928-empirical-contract.md](references/thread-928-empirical-contract.md)，把其中的执行阶段、会话身份硬绑定、
槽位映射、博查/生图路由、物化三面证据、审核反馈和集合口径作为本次 run manifest 的固定合同。不要从历史账号
复制 profile、Cookie、端口、provider 任务号、SPU 清单或写回收据；只复用低敏规则、脚本和提示词来源。
用户提供 SPU 清单并要求“渠道类目属性 100% 填满”时，还必须完整阅读
[channel-attribute-contract-v2.md](references/channel-attribute-contract-v2.md)，按字段类型结构而不是页面非空字符串验收，
并把平台“记录不存在”单独列入源表审计。

### 1. 选择或建立隔离浏览器

每次新任务默认优先复用由本 Skill 启动的空闲隔离 Chrome profile、CDP 和 noVNC。复用前必须只读确认：端口和进程健康、当前没有运行中的插件/直连任务、没有未完成的 provider/upload/save/write-intent/pending-verify 续传责任、没有仍持有的任务租约或批次进程。任一证据未知都视为非空闲，不抢占该会话。用户明确要求新开时不做复用选择。

复用只限浏览器登录窗口；每个任务仍必须新建 run-dir，并重新执行 `preflight`、冻结 manifest、创建 checkpoint 和审计表。不得继承旧任务 SPU、租户数据、provider receipt、write intent、保存收据或完成结论。用户在空闲窗口切换牵牛花账号后，必须以新 `preflight` 身份为准；tenant/store/profile/CDP 任一不一致时零写入。

没有合格空闲会话时，按 [operations.md](references/operations.md) 新建独立浏览器：

推荐直接启动：

```bash
bash scripts/start_qnh_browser.sh \
  --display 132 --cdp-port 9292 --vnc-port 5992 --novnc-port 6092
```

脚本就绪后会打印 noVNC 地址、CDP 地址和 SSH 隧道模板。把隧道命令交给用户，
等待用户明确说已登录后再继续。

登录后先执行：

```bash
node scripts/qnh_direct.mjs preflight \
  --cdp "http://127.0.0.1:$CDP_PORT" --run-dir "$RUN_DIR"
```

确认用户指定 CDP、实际 profile、当前租户/店铺、页面 URL、登录状态和 run-dir 全部属于同一会话，
并落盘 `session_identity.json`。任一不符时，本会话已读取的数量和集合全部标记无效，上传、保存均零发送；
不能拿另一隔离 Chrome 的统计回答当前账号。发现扩展注入、租户不符或登录失效时立即暂停，不提交。
开始批次前先清理历史遗留的商品编辑标签，只保留“首页”和“商品主档”：

```bash
node scripts/qnh_direct.mjs close-edit-tabs \
  --cdp "http://127.0.0.1:$CDP_PORT" --run-dir "$RUN_DIR"
```

核对输出中的 `remaining_count` 必须为 0。后续 UI 检查和保存命令会在每个 SPU 完成后关闭对应标签；若关闭失败，停止继续打开下一商品。

### 2. 冻结任务清单

保持用户当前筛选条件，抓取全部分页并生成不可变 manifest：

```bash
node scripts/qnh_direct.mjs freeze --run-dir "$RUN_DIR"
node scripts/qnh_direct.mjs details \
  --run-dir "$RUN_DIR" --manifest "$MANIFEST" --limit 0
node scripts/qnh_direct.mjs recommendations \
  --run-dir "$RUN_DIR" --details "$DETAILS"
```

记录商品总数、SPU 去重数、筛选 URL 和 SPU ID 哈希。后续所有更新只允许命中此 manifest。
若用户提供原始 Excel/CSV，先保存只读副本和 SHA256；终态同时维护“平台当前全集、原始 manifest 交集、
运行期新增”三个集合，不用总数相减代替 SPU 集合差。
Excel 尾部格式可能把 `max_row` 虚增到 1048576；使用 `build_spu_manifest_from_xlsx.py` 按实际非空单元格读取，禁止把格式行计入任务量：

```bash
python3 scripts/build_spu_manifest_from_xlsx.py \
  --xlsx "$SOURCE_XLSX" --output "$RUN_DIR/manifest-source.json"
```
列表 `page-size` 只能取 1–100；平台对更大值可能静默返回空清单，禁止用放大页大小规避分页。
异步审核导致翻页过程中 total 变化时，默认冻结器失败关闭。只读复扫可显式传
`--allow-dynamic-total true` 保存去重候选，但必须连续取得两份 SPU 哈希一致的快照后才可作为统计或
下一轮 manifest；单次动态快照、0 条快照或仅 total 相同都不能作为终态。

详情读取完成后立即生成逐 SPU 审核原文与策略矩阵：

```bash
python3 scripts/build_error_strategy_matrix.py \
  --details "$DETAILS" \
  --output-prefix "$RUN_DIR/qnh-error-strategy"
```

处理任何审核原因前阅读 [error-playbook.md](references/error-playbook.md)。未知原文先进入
`manual_review`，不要用相似原因的处理方式盲目保存。

运行前确认本机已有 Node.js、Playwright Core、Python 3、Pillow、Tesseract
（含 `chi_sim`）与 openpyxl；缺失依赖只安装到当前用户环境，不改项目插件。

### 3. 按证据优先级生成计划

按以下顺序取值，后者不能覆盖更强证据：

1. 平台报错中明确给出的候选值或官方推荐值。
2. 同一商品在其他渠道已经保存的完全等价属性。
3. 商品标题、规格名、SKU 重量/单位、已有主图和详情图中的明确事实。
4. LLM 只用于在页面提供的候选选项中消歧；必须能引用商品现有事实，禁止生成新的合规事实。

平台推荐仍必须检查字段对齐和包装冲突：报错字段与推荐字段错位时不写；推荐“碗装”而标题或现有值是“盒装”等冲突时不写。
若当前值已经与平台建议完全相同，记录 `no_change`，不为了触发审核重复保存；继续处理同一审核原文中的图片、条码或其他真实缺口。

先完成全量详情、官方候选、同 SPU 图片和条码证据采集，再为每个 SPU 合并成一份
`one-pass` 计划。计划应一次性包含所有有证据的字段，优先覆盖：

- 渠道普通属性和类目属性。
- 商品名称与卖点中的平台明确问题；只允许删除违规/夸大内容或补入现有品牌、规格事实。
- SKU 规格名称与标题中明确一致的包装、容量或数量。
- 经 GTIN 校验并有精确商品证据的 SKU 条码。
- 同 SPU 主图、详情图及目视通过的专项/资质图。

同一商品正常情况下只提交一次、回读一次。探索期或审核返回新增原因时才建立后续修订批次，
不得为了等审核而反复保存同一内容。

运行保守规则计划：

```bash
python3 scripts/build_plans.py \
  --details "$RUN_DIR/details-541.json" \
  --recommendations "$RUN_DIR/official-recommendations-541.json" \
  --run-dir "$RUN_DIR/planning"
```

具体可填/不可猜边界见 [field-safety.md](references/field-safety.md)。

### 4. 先做 PoC

从食品、日百、3C、服饰等不同类型各取样，共 5–10 条。先 dry-run，审查计划，再提交：

```bash
node scripts/qnh_direct.mjs apply-direct-plan \
  --run-dir "$RUN_DIR" --plan "$PLAN" --dry-run

node scripts/qnh_direct.mjs apply-direct-plan \
  --run-dir "$RUN_DIR" --plan "$PLAN"
```

每条必须满足：提交业务成功、目标字段回读一致、非目标字段未被清空、门店覆盖正确。任何一条不满足时停止全量并修正规则。

### 5. 全量执行并断点续跑

```bash
scripts/run_qnh_batch.sh apply-direct-batch \
  --run-dir "$RUN_DIR" \
  --index "$RUN_DIR/planning/plans-official/index.json" \
  --batch-name attributes \
  --concurrency 2
```

批量保存只能通过 `run_qnh_batch.sh` 启动；它会先检查主机可用内存、swap-in 和 automation slice，资源不足时只拒绝新批次，并把新进程限制在独立 cgroup。当前 15 GiB 主机默认以 2 个独立 SPU 并发执行；只有用户对具体任务明确授权并满足本 Skill“自适应并发合同”时，才允许在绝对上限 10 内逐片提速。单个 SPU 内的读取、保存、回读必须串行。每个 SPU 保存独立结果文件，并更新 checkpoint。进程中断后重复同一命令；只跳过已有且回读验证成功的商品。单条失败只记录，不阻断其他商品。每批记录整批吞吐、单商品平均耗时和 P95，准确率按回读通过率计算；未经显式授权和新的资源证据不得为了旧吞吐目标提高并发。

需要批量预演时必须显式传 `--dry-run`。预演只生成 `*-preview.json`，检查点状态只能是
`previewed/no_change`；不得生成 `*-result.json`，也不得把 `previewed` 计入保存成功数。

吞吐考核以整批墙钟耗时除以商品数为准，不把提前生成计划、平台异步审核时间混入单商品保存耗时。
并发只发生在不同 SPU 之间；同一 SPU 永远执行 `读详情 → 合并修改 → 保存 → 回读`。
若平台出现 429、风控、登录失效或回读不一致，自动降低并发或暂停，不用增加重复提交来追求速度。

### 6. 补齐渠道类目、渠道品牌、店内分类与红星属性

渠道类目为空时，不要在级联下拉框中猜末级类目。复用页面“使用推荐”的正式合同：

```bash
node scripts/qnh_direct.mjs build-category-completion-plans \
  --cdp "http://127.0.0.1:$CDP_PORT" \
  --run-dir "$RUN_DIR" --details "$DETAILS" \
  --concurrency 10 --label channel-category-completion
```

执行器调用当前页面的 `channelCategory/batchRecommend` 取得官方推荐，再用
`channelCategory/property/batchQuery` 获取该推荐类目的完整属性模板。推荐值、类目 code/path、
属性模板必须属于同一渠道和当前 SPU；没有官方推荐就阻塞，不能随便选一个看似接近的渠道类目。
先对跨渠道 5–10 条 PoC 做保存和回读，再按不同 SPU 并发 10 全量。

店内分类只在当前商品为空时补当前租户实时接口返回的真实分类 ID。用户允许任意分类时，优先使用
平台的“未分类”或同等默认分类；保存后回读分类 ID 和名称。不得复用其他租户的历史分类常量。

渠道品牌必须使用当前渠道品牌库返回的真实选项 ID。京东品牌为空且用户明确要求“无品牌”时，也必须
先实时查询京东渠道品牌库并命中当前账号的“无品牌”选项，再写 ID 和名称；不能只写自由文本。
对标题已明确品牌的饿了么等渠道，可运行：

```bash
node scripts/qnh_direct.mjs build-channel-brand-completion-plans \
  --cdp "http://127.0.0.1:$CDP_PORT" \
  --run-dir "$RUN_DIR" --details "$DETAILS" \
  --channel 200 --concurrency 10 --label channel-brand-completion
```

只有标题/同 SPU 证据与官方品牌库唯一精确命中时才可写；多个候选、别名不唯一或库中无该品牌时阻塞。

红星属性按平台属性模板中的 `isRequired` 判定，不按截图位置或字段名列表写死。可从官方推荐、
同 SPU 其他渠道等价值、标题和 SKU 中提取逐字事实；尺寸、数量、功率等结构化模板必须保留模板的
固定部分和单位，保存后按平台归一化格式回读。厂名厂址、许可证、CCC、型号、材质、功率等标题或
真实包装没有明确给出的内容仍然阻塞。每个 SPU 把类目、品牌、店内分类、普通属性和图片修改合并为
一次最终保存；若前一步已经精确回读一致，后续修订不得重复提交该字段。

### 7. 补足主图最低数量

牵牛花主图最低数量按页面当前要求执行；实测为至少 3 张。先读取同 SPU 主图和详情图，
不足时调用牵牛花图库完整标题查询。不得直接采用查询首图，必须做商品词、型号、长度、
容量、包装形态和用途冲突门；重复的“售后/提示”通用图不能凑数。先做 5 条 PoC，再全量：

```bash
node scripts/qnh_direct.mjs build-gallery-plans \
  --cdp "http://127.0.0.1:$CDP_PORT" \
  --run-dir "$RUN_DIR" --details "$DETAILS" \
  --label gallery-min3

scripts/run_qnh_batch.sh apply-direct-batch \
  --cdp "http://127.0.0.1:$CDP_PORT" \
  --run-dir "$RUN_DIR" \
  --index "$RUN_DIR/gallery-min3/index.json" \
  --batch-name gallery-min3-save --concurrency 2
```

保存后回读主图 URL 集合并确认数量达到最低要求。图库来源和完整标题查询词写入审计，
不要把“完整标题查询命中”表述为“同 SPU 已验证”。

### 8. 处理真实资质图

正式扫描或生图前先按实时 `pictureType + title + description + numLimit` 做专项图槽位审计。
已验证的默认映射为：3 包装标签/参数、4 3C/品质、5 配料营养、6 纺织使用说明、7 吊牌/洗唛、
8 背签、13 尺寸图。背签不得写入 3 号包装槽；发现已有同 SPU 制品落错槽时复用原 URL 迁移到正确槽位，
不重新生图、不重复上传。完整合同见 [thread-928-empirical-contract.md](references/thread-928-empirical-contract.md)。

先扫描同一商品自身图片：

```bash
python3 scripts/scan_media.py \
  --details "$RUN_DIR/details-541.json" \
  --run-dir "$RUN_DIR" \
  --workers 4
```

OCR/Tesseract 并发固定不超过 4；10 workers 已实测会导致 CPU 饱和与超时。除同 SPU 图片外，
可先快照牵牛花图库完整标题候选，再用四路 OCR 自动生成严格计划：

```bash
node scripts/qnh_direct.mjs snapshot-special-picture-candidates \
  --cdp "http://127.0.0.1:$CDP_PORT" \
  --run-dir "$RUN_DIR" --details "$DETAILS" \
  --concurrency 10 --label special-picture-candidates

python3 scripts/build_authentic_special_picture_plans.py \
  --candidates "$RUN_DIR/special-picture-candidates.json" \
  --run-dir "$RUN_DIR" --label authentic-special-picture \
  --workers 4 --offset 0 --limit 10
```

大批量 OCR 默认按 10 SPU 小分片串行，并共享 `--cache-dir`；每片使用独立
`--index-name`。40 SPU 单进程已实测可能触发执行器 SIGTERM，不能依赖长进程最后一次性落盘。
只有标题商品词、图片类型关键词与型号/规格均通过的候选才可写。

如需人工复核，逐张目视候选，并把确认与当前 SPU、规格和资质类型完全一致的 URL
写入 `reviewed-allowlist.json`，再生成媒体计划：

```bash
python3 scripts/build_media_plans.py \
  --details "$RUN_DIR/details-541.json" \
  --media-evidence "$RUN_DIR/media-scan/media-evidence.json" \
  --reviewed-allowlist "$RUN_DIR/reviewed-allowlist.json" \
  --output-dir "$RUN_DIR/planning-media"

scripts/run_qnh_batch.sh apply-direct-batch \
  --run-dir "$RUN_DIR" \
  --index "$RUN_DIR/planning-media/index.json" \
  --batch-name media-reviewed --concurrency 2
```

没有目视审核白名单时，脚本不会自动绑定任何资质图。营养成分图必须同时清晰展示配料与营养信息；CCC、备案号、注册号等必须完整识别并符合格式；包装信息图必须是包装标签本身，不能拿证书图片代替。候选不充分时标记“缺少真实材料”，不上传占位图。

OCR 未命中不等于图片无效。对当前同 SPU 图片和完整标题图库候选，可在人工目视确认后补充严格计划，
但审计必须写清可见的品牌、口味、规格、条码、执行标准或资质编号；品牌、型号、容量、包装形态任一冲突
都必须否决。配料与营养信息允许在同一专项图槽位上传多张互补图片，前提是槽位 `numLimit` 允许、
所有图片均为同一精确商品，且最终图片集合共同完整覆盖配料表和营养成分表。一个槽位连续加入多张图时，
回读验证只以最后一条目标集合为准；若旧执行器把中间集合也与最终集合比较而误报失败，必须读取结果文件
确认最终实际集合，再执行一次幂等计划并得到 `no_change=true`，不得重复保存或删除已经物化的图片。
审核原文明确缺 3C、包装标签、背签、配料营养或纺织图，但详情接口返回
`mtSpecialPictureList=null`/缺对应槽位时，媒体扫描器可按审核原文合成“只读扫描需求”，继续检查当前
SPU 的主图、详情图和已有专项图。该合成项只用于发现证据，绝不等于平台已提供可写槽位；除已明确支持的
尺寸图/配料营养兼容外，执行器不得据此创建 3C、备案、医疗或其他法定资质槽位。

用户要求复用项目现有资质图接口和提示词时，只能调用正式
`product_fill_special_picture_prompt` 与 `qnh_main_image_art` 合同：背签使用唯一 canonical 五项提示词，
其他类型保留当前模板；必须绑定同一精确商品的真实参考图或已核验事实，并持久化业务幂等键、
provider、调用类型和 `provider_task_id`。已拿到上游任务号后只能查询原任务，不能因超时、提示词变化或
进程中断自动重提。配料、营养、厂名厂址和尺寸图生成后还要 OCR/目视逐字对照参考事实；CCC、检验报告、
医疗器械、化妆品备案等法定材料只能复用真实材料，禁止用生图或兜底值伪造证照、注册号、厂家或营养数据。

独立 CDP 治理需要直接调用已配置上游时，先建立只含有证据生成项的 job manifest，再运行：

```bash
PYTHONPATH="/home/saas/repo/backend" \
  /home/saas/repo/backend/venv/bin/python \
  scripts/run_safe_special_picture_generation.py \
  --jobs "$SAFE_GENERATION_JOBS" \
  --output-dir "$RUN_DIR/safe-special-generation" \
  --single-provider-submit \
  --concurrency 2
```

该脚本按商品、图片类型、提示词和参考图生成稳定本地收据；一旦记录 `provider_task_id`，
后续只查询原任务，不重新 submit。只有尺寸等已有明确事实且绑定当前 SPU 参考图的项目可进入此直连生成。
3C、备案、注册证、医疗器械、检验报告和公章材料会在提交前硬阻断。
`--single-provider-submit` 是付费批次的默认硬门：一个业务 job 只选择一个 provider 并只产生一次
submit；该 provider 提交失败、查询超时、制品目视不通过或平台审核未退出，都不能自动切换 provider
或再次付费生成。必须保留原业务键、provider 和任务号，后续只 query 原任务或转人工处理。
生成成功后必须人工目视检查是否新增了未核验功能、尺寸、材质、认证或营销信息；存在任何新增事实时把
收据标为 `validation_rejected`，不得上传，也不得为了换结果自动再次付费提交。

食品配料/营养专项图也可进入该链路，但必须先取得同一精确 SPU 的真实标签图，并使用以下提示词主体：

```text
商品名称：{商品名称}
商品主图：{商品主图}
当前类目需上传清晰完整的商品配料、营养成分表和条码图片，建议上传电子扫描图或平面设计图；若实拍图片，建议对关键信息特写拍摄，保证文字清晰、背景整洁。
```

随后追加硬约束：仅对真实标签参考图做高清化和平面排版，只输出配料表、营养成分表和已核验条码三块，
逐字保留配料与营养数值；看不清的内容不生成，不新增厂商、厂址、许可证或其他标签事实。`expected_text_tokens` 至少包含
“配料/营养成分表”、两项可见营养数值和已核验 GTIN。先做 5–10 条 PoC；每条只允许一个稳定 job、
一次 submit。逐图对照真实标签和商品主档：条码冲突、数值变化、错别字、字段错位、或新增任何未核验
法定信息时立即 `validation_rejected`。实测清晰排版图仍可能生成错误条码或把公司名写入地址字段，
视觉清晰绝不能替代事实核验。

主档 GTIN 只可在“审核仅缺配料/营养图、单 SKU、标题/SKU/包装件数一致、校验位有效且无冲突证据”时
用于当前 SPU 专项图排版，并标明来源为 QNH 主档现值。生成后必须识别回同一 GTIN；任何条码、件数、
净含量或多 SKU 冲突都立即阻塞，不能把主档值表述为图片或 GS1 已核验。

上传生成制品后，使用 `qnh_direct.mjs upload-image` 保存本地文件哈希、字节数和牵牛花图片 URL 回执，
再通过 `special_picture_uploaded` 写入并逐槽位精确回读。平台偶尔会在实时审核原文明确报
“缺少尺寸图”，但商品详情未下发 13 号尺寸图槽位；此时执行器只允许为 `picture_type=13`、
`picture_title=尺寸图` 构造最小槽位，而且必须同时满足实时审核原文命中、上传回执匹配和目视事实核验。
该兼容绝不扩展到包装标签、CCC、医疗、化妆品、检验报告或其他法定资质。

正式生图不能只看“任务 ready”。生成制品进入上传计划前必须提供逐 SPU 的
`visual-validation.json`，状态只能是 `accepted` 或 `rejected`。调用
`build_generated_picture_plans.py --visual-validation ...` 后，只有 `accepted` 才能进入
保存计划；品牌、规格、包装件数、尺寸、配料文字、营养数值、条码或法定事实任一不一致都必须
`validation_rejected`。通用包装标签/背签/尺寸提示词即使排版清晰，也可能编造高度、厂家、
许可证或条码，不能批量直写。尺寸图仅在标题或 SKU 已明确给出精确尺寸时允许使用事实约束提示词，
生成后仍要目视逐项一致；同一业务键拿到 `provider_task_id` 后永远只 query 原任务，不为换图重复 submit。

批量正式提示词必须先做 5–10 个跨槽位 PoC，以事实一致而非上游 ready 或暂时出队决定是否扩量。
PoC 制品新增任何未核验事实时停止扩量；保留已受理收据，不为摊薄成本继续 submit。

官网参数存在区域版本差异时，同一 SPU 当前包装、铭牌或详情参数图优先于全球站参数。保存后仍要继续
逐图复核；若发现电压、插头、线长、容量或条码等区域冲突，立即用当前 SPU 的更具体证据纠正，并把
“外部官网候选 → 同 SPU 证据覆盖”的全过程写入审计。型号相同不代表不同地区的 GTIN、电压和包装相同。

目视与文字核验通过后，独立 CDP 可直接把本地制品上传到牵牛花图库，并把返回 URL 与上传回执绑定后写入
指定专项图槽位：

```bash
node scripts/qnh_direct.mjs upload-image --run-dir "$RUN_DIR" --file "$ARTIFACT"
node scripts/qnh_direct.mjs apply-direct-plan --run-dir "$RUN_DIR" --plan "$PLAN" --dry-run
node scripts/qnh_direct.mjs apply-direct-plan --run-dir "$RUN_DIR" --plan "$PLAN"
```

计划使用 `special_picture_uploaded`，必须包含 `picture_type`、`picture_title`、`url`、
`upload_receipt_path`、`expected_old_urls` 和事实证据。执行器只接受上传回执中的
`https://*.meituan.net` URL，保存后仍逐槽位精确回读。

平台明确报“缺少图片详情”且当前详情图为空时，可把同一 SPU 的现有主图复用为详情图；最多复用前 5 张。不得跨 SPU 取图，也不得把普通主图当成包装标签、尺寸图、配料营养图或法定资质图。

已存在且真实的专项图可通过 `build-special-picture-mirror-plans` 重新提交到全部门店；
使用 `tenant_edit_v424` 更新契约，并以顶层专项图精确回读加保存请求契约作为验证证据。
平台可能把渠道容器归一化掉，不能因此把已精确回读的顶层专项图误判为失败。
若商品关联美团医药标品库，页面可能提示商家无法编辑部分信息。此类商品即使详情接口顶层
`mtSpecialPictureList` 回读有 URL，编辑页仍可能显示空槽；页面选择图片后点击保存也可能因标品库限制
零发送，刷新后图片消失。必须重新打开编辑页确认图片可见，并确认页面实际发出了保存请求，才能记为
“已上传完成”；否则归类为标品库资料受限，不能用顶层回读或页面临时预览冒充成功。

### 9. 条码证据

对明确包含条码报错的 SPU，先并发扫描它自己的主图、详情图和专项图：

```bash
python3 scripts/scan_barcodes.py \
  --details "$DETAILS" \
  --manifest "$MANIFEST" \
  --media-cache "$RUN_DIR/media-cache" \
  --output "$RUN_DIR/barcode-scan.json" \
  --workers 4
```

自动写入必须同时满足：

1. 条码来自同一 SPU 图片，或来自能够逐字匹配品牌、完整品名和精确规格的权威公开证据。
2. 只接受 GTIN-8/12/13/14，校验位必须正确。
3. 单 SKU 与候选条码映射唯一；计划中保存 `evidence_url` 或同 SPU 图片证据。
4. 保存后回读 `sku.<id>.upc_list` 与计划值完全一致。

搜索结果中的近似型号、不同容量、不同颜色或不同地区版本不能作为证据。不得把 SKU ID、
商品编码或随机数字当条码。

仅当平台明确允许“此商品没有条形码”且以下条件全部满足时，才可在单 SKU 计划中使用
`sku_no_upc_fields`：

1. 商品是无明确品牌、型号和独立零售包装的通用商品；食品、饮料、化妆品、医疗器械及明确品牌商品禁止兜底。
2. 至少 3 张同 SPU 图片均成功读取，经条码扫描无有效 GTIN，并完成人工目视复核。
3. 以完整标题、可见规格和外观特征精确网页检索，未找到唯一同款条码；多品牌相似款不能互相借用条码。
4. 当前错误条码是 SKU 内部号、商品内部码或其他明显非 GTIN 值；计划写入准确的
   `sku_id`、`expected_old_upc_list`、`scanned_image_count` 和审计证据。
5. 保存时同时清空 `upcList`/`goodsUpcList`、设置 `customizeNoUpcCode=1`，并逐项回读确认。

上述条件缺一时保持阻塞；不能为了清单数字把“扫描未命中”直接解释为“商品确实无条码”。
如果保存后出现新的品牌、型号、规格或零售包装冲突证据，必须立即停止该策略，并用写前审计快照
受限执行 `sku_restore_upc_fields` 恢复原状态；回滚要求当前值仍精确等于本轮写入结果，禁止覆盖
用户或平台在此后的其他修改。

若用户在同一任务中明确授权对“平台审核明示条码非法”的商品使用牵牛花原生“此商品没有条形码”
兜底，可以采用受限的扩展合同，但不生成或猜测任何 GTIN：

1. 仍须逐 SPU 全量扫描主图、详情图和专项图，至少 3 张读取成功且没有校验位有效 GTIN。
2. 当前 SKU 条码全部不符合 GTIN-8/12/13/14 规则；已有任一有效 GTIN 时必须阻塞。
3. 计划记录 `expected_old_upc_list`、扫描张数和 `user_authorized_no_upc_fallback_after_same_spu_scan`，
   保存时精确设置平台原生无条码标志并清空两个条码集合。
4. 先 5–10 条 PoC，再以不同 SPU 并发 10 执行；保存后逐 SKU 精确回读，并等待 5–10 分钟复扫。
5. 受理成功或暂时退出都不代表商品事实已核实；后续发现真实 GTIN 或包装冲突时，按写前快照有条件恢复。

该合同实测 108 条保存与回读 108/108，延迟审核后 94 条退出不可售；其余继续按平台新原因处理，
不得为了退出数量写随机条码。

### 9.1 普通字段与主图质量反馈合同

品牌、功率/型号、互斥标题线索、尺寸 OCR、标题长度和主图纯重排的经验规则见
[thread-928-empirical-contract.md](references/thread-928-empirical-contract.md) 第 4 节。核心门禁是：只用当前
tenant 的真实选项 ID 与同 SPU 明文事实；冲突字段阻塞；保存后做 expected-old 与精确回读。

### 10. 最终核验与导出

重新打开最初筛选 URL，再次执行 `freeze` 与 `details`：

```bash
node scripts/qnh_direct.mjs freeze --run-dir "$RUN_DIR" --label final
node scripts/qnh_direct.mjs details \
  --run-dir "$RUN_DIR" --manifest "$FINAL_MANIFEST" --limit 0 --label final

python3 scripts/export_ledger.py \
  --run-dir "$RUN_DIR" \
  --initial-manifest "$INITIAL_MANIFEST" \
  --initial-details "$INITIAL_DETAILS" \
  --final-manifest "$FINAL_MANIFEST" \
  --final-details "$FINAL_DETAILS" \
  --planning-index "$RUN_DIR/planning/plans-official/index.json" \
  --output-prefix "$RUN_DIR/qnh-change-ledger"
```

- 对比起始 manifest 与终态 manifest，并分别输出平台当前全集、原始目标交集和运行期新增集合。
- 将“已提交且回读正确”和“已退出不可售列表”分开统计。
- 对仍不可售商品按缺少资质、平台候选不足、活动/审核、系统错误等分类。
- 导出 CSV 与 XLSX。每个字段占一行，至少包含 SPU、商品名、问题、字段路径、旧值、新值、证据来源、提交方式、提交结果、回读结果、时间、未解决原因。
- XLSX 还必须包含全量商品终态、已完成 SPU、剩余原因分类、并发性能、自评与统计口径工作表。
- 按 [standard-task-contract.md](references/standard-task-contract.md) 生成最终文件名：

```bash
python3 scripts/standard_output_name.py \
  --tenant-name "$TENANT_NAME" --spu-count "$SOURCE_UNIQUE_SPU_COUNT" \
  --output-dir "$RUN_DIR"
```

  日期取 Asia/Shanghai 交付日，租户名取本次身份预检，数量取源清单唯一 SPU 数。B/C 列、执行汇总和字段级审计必须由最终事实重算。
- 交付前检查本轮 `问题与策略回灌`；若出现 Skill 未覆盖的数据形状或失败模式，先把可泛化的低敏规则、脚本验证和回归样例更新到 Skill 并运行 `quick_validate.py`。

平台保存后会异步重新审核，通常数分钟，慢时可达 1–2 小时。保存回读成功只证明字段已经物化，
不能立即视为已退出不可售列表。先导出当前审核快照；用户再次要求复查时重新 `freeze/details`，
只对平台返回的新原因生成增量计划，不重复提交已经回读一致的字段。

最终汇报必须给出确切数量，不把“提交成功”写成“不可售已清零”。

## 脚本说明

- `scripts/qnh_direct.mjs`：CDP 会话、清单冻结、详情与推荐读取、页面/直连提交、回读验证和批次 checkpoint。
- `scripts/run_qnh_batch.sh`：所有未来 `apply-direct-batch` 的唯一入口；经主机 admission 和 systemd cgroup 启动 Node，固定 2560 MiB old-space，默认并发上限 2；显式任务级自适应授权才可使用受保护的更高档位。
- `scripts/qnh_runtime_limits.mjs`：纯并发解析与未受管批处理失败关闭合同；不得在此加入平台读取、签名或写入逻辑。
- `scripts/qnh_adaptive_concurrency.py`：显式任务的低敏资源/交付反馈控制器；只决定下一分片并发并记录观测，不读取商品或调用平台。
- `scripts/build_spu_manifest_from_xlsx.py`：忽略 Excel 尾部格式虚高行，按实际非空 SPU 去重并生成源清单 manifest。
- `scripts/build_channel_contract_v2_plans.py`：读取当前租户详情与可选官方建议，按字段类型、当前类目候选、同 SPU 事实和已验证默认矩阵生成完整渠道属性计划及字段审计；通过 `QNH_RUN_DIR`、`QNH_DETAILS_PATH`、`QNH_RECOMMENDATIONS_PATH`、`QNH_PLAN_OUTPUT_DIR` 指定本轮证据和输出，禁止复用旧租户候选回执。
- `scripts/qnh_direct.mjs build-category-completion-plans`：调用当前页面官方类目推荐和属性模板接口，生成渠道类目补全计划。
- `scripts/qnh_direct.mjs build-channel-brand-completion-plans`：查询当前渠道品牌库，只为标题事实唯一精确命中的商品生成品牌计划。
- `scripts/qnh_direct.mjs close-edit-tabs`：关闭全部遗留“商品主档编辑”内部标签；UI 处理还会逐 SPU 自动关闭对应标签并验证无残留。
- `scripts/start_qnh_browser.sh`：经主机 admission 和独立 cgroup 启动隔离、禁扩展、loopback-only 的 Chrome/CDP/noVNC 会话并输出隧道模板；资源不足时不得绕回 `ssh.service` 直接启动。
- `scripts/build_plans.py`：从平台明确建议、跨渠道已有值、标题与 SKU 事实生成保守计划。
- `scripts/build_store_category_plans.py`：用当前租户实时店内分类回执为缺失商品生成 expected-old 受控计划。
- `scripts/build_title_fact_attribute_plans.py`：从标题、SKU 和同渠道模板提取逐字事实，补安全的红星属性并保留结构化单位。
- `scripts/build_safe_guide_jobs.py`：只为标题已有明确事实的选择/使用说明槽位建立生成 job；法定材料和无事实尺寸失败关闭。
- `scripts/scan_media.py`：下载同一商品图片、OCR、按资质要求做严格证据匹配并缓存结果。
- `scripts/scan_barcodes.py`：只扫描条码报错 SPU 的同商品图片，执行 GTIN 校验并输出候选证据。
- `scripts/build_no_upc_fallback_plans.py`：在平台明示非法条码、同 SPU 全图扫描和 expected-old 门禁下，生成用户明确授权的原生无条码兜底计划。
- `scripts/build_media_plans.py`：把同一商品已有详情图补为主图，或把严格 OCR 通过的同商品图片绑定到对应资质图槽位。
- `scripts/build_main_image_reorder_plans.py`：把人工目视选定的同 SPU 清晰图片调整为首图，保持图片全集不变并精确校验顺序。
- `scripts/build_formal_asset_jobs.py`：从实时审核原文建立背签、包装标签、尺寸和纺织图候选任务，并按既有 provider 收据跳过已受理业务键；任务候选不等于允许上传。
- `scripts/build_formal_nutrition_jobs.py`：为明确缺配料/营养图的商品建立正式提示词候选，并在生成前执行唯一 GTIN 与既有 provider 收据门禁。
- `scripts/run_safe_special_picture_generation.py`：一次 submit、持久化 provider 任务号并只查询原任务；禁止法定证照类提示词进入生成链路。
- `scripts/build_generated_picture_plans.py`：绑定正式生图制品、上传回执、条码核验和逐 SPU 目视结论；未通过目视验证的制品失败关闭。
- `scripts/build_authentic_special_picture_plans.py`：以最多四路 OCR 从同 SPU/完整标题图库中生成严格专项图计划，支持 offset、limit、共享缓存和分片 index。
- `scripts/export_ledger.py`：汇总页面/直连结果、证据、终态原因和性能，导出字段修改明细 CSV 及多工作表 XLSX。
- `scripts/standard_output_name.py`：按交付日、实时租户名称和源清单唯一 SPU 数生成标准 Excel 路径。
- `scripts/export_standard_channel_fill_workbook.py`：从 manifest、最终详情分片、字段审计和保存 checkpoint 生成标准 B/C 列及完整多工作表交付日志。

渠道属性大清单的进程边界固定为每片最多 50 SPU，并由 `run_qnh_batch.sh` 把调用方请求并发收敛到宿主上限；不得因为页面目标数为 1 就恢复 100/300 条单进程写入。显式自适应模式除进程内软回收外，还必须启用任务级外部看门狗：单个 Node RSS 连续 10 秒达到 2.2GiB，或短进程墙钟达到 300 秒时，只终止该短进程，不动浏览器、主执行器和导出器。每片保存后必须独立复读，watchdog/unknown/failed 都先判定是否已经物化，再只补真实 residual，严禁盲目重放整片。源 XLSX 含多个工作薄时，导出必须传 `--source-xlsx`，保留原工作薄拓扑和数据，只补第一工作薄 B/C 列并插入审计工作薄。

用户明确允许按宿主空闲资源提速时，可为该任务单独设置 `QNH_DIRECT_ADAPTIVE_APPROVED=1` 与位于本次 run-dir 的 `QNH_ADAPTIVE_STATE_FILE`。使用 `qnh_adaptive_concurrency.py` 在50-SPU分片边界按资源与上一片交付证据执行4→6→8→10阶梯控制；默认任务仍为2，资源阈值、降档和低敏审计合同见 `references/channel-attribute-contract-v2.md`，不得在单商品写入中途切换或绕过受管 cgroup。

脚本默认不记录敏感头、Cookie 或签名。若页面接口发生变化，先用一个只读商品确认详情契约，再修改脚本并重新走 PoC。

## 插件商品属性填充的内存安全与扩量门禁

- 页面型插件执行与直连接口批处理不是同一并发模型。插件默认页面准备窗口 2、专项图窗口 4、平台写回并发 1；不得把直连接口的并发数直接换算成 Chrome 编辑页数量。
- 同一 SPU 同时最多存在 2 个精确编辑页。恢复或 `forceFresh` 前先关闭该 SPU 的旧编辑页，再至多创建 1 个；每个 item 完成后关页，任务 pipeline 终态还必须按 item 集合执行一次兜底清理。
- QNH 编辑路由可延迟约 24 秒挂载。采用约 42 秒有界等待，首次失败只在原页 reload 一次，不以反复开新标签等待页面就绪。若顶部“商品主档编辑”已是激活态但正文只有导航空壳，必须点击该内部标签自带的刷新控件并继续等待，不能重复点击激活标签或新开编辑页。
- 纯属性填充在原生详情捕获缺失时，可用页面正文精确 `SPU: <item_key>` 且“基础信息/规格信息”表单完整作为页面绑定补充；资质图、组合任务和最终平台成功不得复用此放宽。最终成功仍以精确 SPU 保存与独立字段回读为准。
- 网络连接异常、超时、服务繁忙和限流保留为 recoverable/pending_verify，并由定向 alarm 恢复；已有平台写意图、受理或结果未知时只允许查询/回读，禁止重复保存或重复付费提交。
- 普通属性补全先复用同 SPU 的已知事实：包装方式优先写模板现有“独立装”（无该选项才用“其他”），国产且标题无进口线索时渠道产地可继承“中国大陆”，跨渠道同义尺寸可复用，货号依次复用商品编码、外部编码或 SPU。`尺寸（cm）` 这类多轴自由文本必须保留 `30cm*20cm*3.2cm`，不得套用单数值单位模板误拒绝。
- 实机发布门固定为 1→10→100。每一级都记录任务成功数、最终全字段填充率、编辑页峰值、会话 Chrome RSS 和 `MemAvailable`；只有上一档 100% 交付且 100% 回读、无重复保存才进入下一档。
- 当前 15 GiB 主机的默认硬门：目标会话精确编辑页超过 2、目标 Chrome 进程组 RSS 超过约 2.6 GiB、或 `MemAvailable` 低于 3 GiB，立即停止扩量并按 checkpoint 安全恢复；不得停止其他账号或无关浏览器来掩盖本任务资源问题。
