# 美团直连模块

- `platform_adapter=meituan`
- 属性信息 `channel_attributes_only`：`planned`
- 资质图 `qualification_images_only`：`planned`
- 不可售治理 `unavailable_one_pass`：`implemented`（Chrome 插件/受管 CDP transport、官方 reader/writer/readback、
  DeepSeek 保守字段计划、原图 OCR 证据门、checkpoint 与统一运营 Excel 已注册）

这里的“美团”指直接登录美团商家平台，不是牵牛花中的美团渠道。`unavailable_one_pass` 只能调用本模块注册的
reader、planner、writer、readback、validator、checkpoint 和统一 Excel 导出器；不得调用 QNH writer，也不得把
QNH 的 `channelId=100` 当成美团直连适配器。另两个仍为 `planned` 的模式继续固定零写入。

## 目录

1. 适用范围与完成口径
2. 固定快速路径
3. 页面官方接口合同
4. 全量一次过计划器
5. 报错路由矩阵
6. 资质图与 CPV 合同
7. 保存、复审与强回读
8. 二审反馈与自纠
9. 并发、内存与吞吐
10. 统一运营事件
11. 实现注册与回归门

## 1. 适用范围与完成口径

本模块治理美团闪购商家后台“商品信息优化”中的“无法售卖、审核未通过、影响流量”商品。它复用项目已经
验证的美团页面官方运行时和专项图 provider 合同，不复用牵牛花 endpoint、字段结构、图片槽位或保存器。

完成不是“保存成功”，而是原始目标 cohort 同时满足：

- 已退出“无法售卖”和“审核未通过”集合；
- 不在违规删除或平台下架集合；
- 用户要求治理影响流量时，也退出对应影响流量集合；
- 官方详情独立回读与计划一致，非目标字段、原主图和既有专项图未丢失；
- 连续两次复扫的目标集合 SHA-256 一致，且没有本轮引入的新报错。

保存受理、字段物化、触发复审、审核退出是四个独立指标。证照图缺口按 [`upstream-image-generation.md`](upstream-image-generation.md)
的上游生图链路补齐；平台侧经营资质/禁售类缺口必须报告阻塞，不能用提交数或回读数冒充审核退出率。

用户指定“清除/完成 N 条”时，`N` 是最终 `verified_cleared` 配额，不是尝试、读取、规划、上传、保存或字段物化数。
先从当前登录门店的正式列表冻结候选池和集合 SHA-256，再在池内逐波补选，直到 `verified_cleared >= N` 或候选池耗尽。
计数商品必须退出无法售卖、审核失败、违规删除/平台下架和本任务要求的影响流量集合，同时不得因本轮编辑新进入任一
影响流量集合。报告固定为 `verified_cleared / verified_target`，并分列 processed、materialized、waiting review 和 blocked。

## 2. 固定快速路径

```text
身份预检
→ 页面接口冻结各状态全集与原始 cohort
→ 批量读取优化项、审核原文和官方完整详情
→ 解析全部当前原因并做全字段/全图片一致性预检
→ 每 SPU 合并成唯一 one-pass 计划
→ canary 后按实测稳定窗口扩量
→ 页面官方三段保存并触发复审
→ 精确 SPU 官方详情强回读
→ 复扫无法售卖/审核未通过/影响流量
→ 同因自纠、新因增量计划、稳定双快照
→ 输出平台无关事件给统一 Excel 导出器
```

严禁逐商品模拟点击读取和保存。登录、验证码和平台没有等价接口的人工确认才允许 UI 操作。列表、详情、规划、
保存和复扫优先在当前登录页面 Main World 中复用平台官方 webpack/H5guard 能力。

## 3. 页面官方接口合同

### 3.0 浏览器接管与页面识别

按以下顺序选择 transport，选择结果写入 `session-identity.json`，运行中不得静默换轨：

1. `chrome_extension_current_tab`：优先。通过 Codex Chrome 插件接管用户当前已登录 Chrome；只在已授权的当前标签页
   或任务标签页内取得 scoped CDP，不启动新浏览器、不重复弹远程调试授权。
2. `managed_cdp`：仅当插件不可用时使用。端点必须是本机 loopback、浏览器处于任务专用/空闲状态，并完成门店、
   域名、登录态和目标集合身份校验；禁止把未知 9222/9272 端口当成用户当前浏览器。
   - **反风控启动规范**：启动美团测试浏览器必须调用 `bash scripts/start_test_browser.sh --url "https://waimaie.meituan.com/" --cdp-port 9222`；
   - **红线**：严禁携带 `--enable-automation`；必须携带 `--disable-blink-features=AutomationControlled` 与独立 `--user-data-dir`；
   - 若由外部自动化工具已拉起，必须在页面加载前通过 CDP `Page.addScriptToEvaluateOnNewDocument` 注入 `delete Object.getPrototypeOf(navigator).webdriver; Object.defineProperty(navigator, 'webdriver', { get: () => undefined });` 并刷新页面，否则美团 Yoda 安全风控将直接返回 `{"status":0,"data":null,"error":{"code":121056,"message":"请求异常,拒绝操作"}}` 阻断验证码与登录。
3. 两者都不可用时失败关闭；UI 视觉控制只用于登录、验证码或没有正式接口的人工确认，不作为批量 reader/writer。

页面识别不能只看顶层标题。美团商品管家通常是顶层商家页 + `hashframe`，审核编辑又会打开 `iframe-modal`。
必须同时验证：顶层域名、商品管家 frame 域名/路由、`wmPoiId`、可见门店以及页面官方模块。审核编辑正式内容为
`/reuse/sc/product/page/detail/audit?spuId=${spuId}&wmPoiId=${wmPoiId}&from=single&oldVersion=true`（**必须显式携带 `&oldVersion=true`！** 若缺少 `&oldVersion=true`，现网前端路由会自动重定向至 `/reuse/sc/product/views/product/detail-v2/editNew`，该新版页面不加载 `window.webpackChunkpackage_detail`，导致所有 Webpack 模块注入报错 `detail_chunk_missing`）。同会话初始化一个 worker 后，可用当前原生
`ie.vP({ spuId, poiId }, { noDefaultWeightUnit: true })` 对 cohort SPU 调用详情读取，无需为每个商品新开标签页。

每次通过 `window.webpackChunkpackage_detail.push([[Math.floor(Math.random() * 1e9)], {}, r => { req = r; }])` 获取 `req` 时，**必须使用随机整数 Chunk ID**（严禁重复使用固定数字如 `999999`，否则 Webpack 5 会因 chunk 已注册而静默跳过回调导致 `req` 为 `undefined`）。

导航后必须等待 `DOMContentLoaded` 和静默窗口，再确认 lazy chunk 已注册后只初始化一次。过早 require 模块会把空导出
写入 webpack cache；该 worker 必须回收重建，不能在同一被污染页面反复轮询。

### 3.1 身份与读取

- 当前页面必须是美团商家域，冻结 `wmPoiId + spuId + tab_id + document_epoch + fence`。
- 列表接口在顶层页面 `#hashframe`（`fw.webpackChunkmrn_product_pc`）中调用 `req(69282).fetchList({ effectType, needAudit, pageNum, pageSize, searchWord: '' })`，同时扫描 `effectType: 5`（无法售卖）与 `effectType: 2`（影响流量）；详情事实来自审核页官方商品详情运行时。
- 读取在少量已登录页面上下文内有界并发，不为每个商品累计一个永久标签页。
- 任一门店、SPU、页面身份冲突时，provider、上传和平台 mutation 均为零。

### 3.2 官方保存链与视图模型编译契约

现网经典版 `package_detail` 的核心模块映射与完整保存编译链固定为：

- `ie = req(42467)`：`vP`（读取详情）、`A_`（按 `categoryId` 拉取新类目属性与 CPV 模板）、`sI`（`preValidateSpu`）、`L0`（`uniSave/actCheck`）、`$W`（`uniSave`）
- `Z = req(13085)`：`Z._f(e.normalAttributes, e.sellAttributes, e.normalAttributesValueMap, e.sellAttributesValueMap)` 编译出 `{ categoryAttrList, categoryAttrValueMap }`；`Z.eN({ unconditionalReturn: { unconditionalReturn: e.unconditionalReturn, selectedId: e.unconditionalReturnId } })` 编译出 `bindAttrMap`
- `he = req(38140)`：`he.z(e.skuList, e.skuAttributesValueMap)` 编译出最终 `skuList`
- `G = req(88468)`：`G.Hq(e.cpvGuidePicMap, e.cpvGuidePicConfigList)` 编译出 CPV 字典，再由 `JSON.stringify(Object.values(R || {}))` 生成 `cpvGuidePicList`
- `walle = req(38186)`：`await walle.g0(e)` 前端实时 Walle 质检器（在调用 `ie.sI` 前毫秒级校验必填项与格式）
- `tool = req(36515)`：`await tool.jt(base64DataUrl, fileName, String(poiId), false)` 原生美团 CDN 图片上传器
- `http = req(69499)`：`await http.PL.get('/reuse/sc/product/shangou/r/attrValueSug', { params })` 带 H5guard 签名的品牌/属性检索器

每次 mutation 固定为：

```text
ie.vP({ spuId, poiId }, { noDefaultWeightUnit: true })（获取 d.productInfo 记为 e）
→ 若需迁移类目：调用 ie.A_({ categoryId, poiId }) 重建 e.normalAttributes / e.normalAttributesValueMap / e.cpvGuidePicConfigList
→ 修改 e.normalAttributesValueMap / e.skuList / e.cpvGuidePicMap / e.name / e.pictureList
→ walle.g0(e)（前端 Walle 实时质检，确保 validator 零报错）
→ Z._f + Z.eN + he.z + G.Hq（编译并剔除 Et 视图中间态键，生成正式提交载荷 q）
→ ie.sI({ poiId, product: q, context: N })（若仅报软性建议类目拦截，自动设置 N.ignoreSuggestCategory = true 重试）
→ ie.L0({ poiId, product: q, context: N }) / uniSave/actCheck
→ ie.$W({ poiId, product: q, context: { ...N, checkActivitySkuModify: true, needAudit: true }, extra: B }) / uniSave
→ ie.vP（独立回读）
```

最终保存必须由当前页面官方模块编译完整载荷并当次签名。后端 curl、脱离页面的 Cookie 请求、
手拼不完整 body、DOM 表单点击和列表行缓存都不是正式 writer。

### 3.3 增量保护与幂等

- 默认不删除、不覆盖、不重排原 `pictureList`、详情图和 `cpvGuidePicMap/cpvGuidePicList`。
- 一个 SPU 的字段、详情图和 CPV 先合并为最终快照，只执行一次 final save。
- 每次保存都必须显式构造完整 JSON 序列化字符串 `product.cpvGuidePicList = JSON.stringify([{ imgType, urlList: [url] }])`，并镜像同步 `product.cpvGuidePicMap` 与 `product.approvalNumberPics`。严禁直接传原始数组或对象字典，避免触发后端 Spring 参数解析失败或 NullPointerException。
- 保存前比较完整字段和图片摘要；非目标字段减少、主图顺序变化或 CPV 类型丢失时整条零保存。
- final save 前持久化 write intent；请求已发送、已受理或结果未知后只回读，不自动再次保存。

## 4. 全量一次过计划器

第一次保存前必须同时检查：

1. `optimizedInfoList`、`lackQuaInfo`、`issueText` 的全部当前原因，而非只处理主原因。
2. 商品名、品牌、类目、SKU 规格、包装数量和全部当前类目必填属性。
3. 详情图是否为空、格式是否满足平台要求。
4. 所有被要求的 CPV 类型、既有 CPV、落错类型和内容完整度。
5. 商品名、SKU、图片文字、类目属性、条码、型号、尺寸之间是否冲突。
6. 是否属于禁售、超经营范围、医疗、化妆品、3C 等需按对应证照提示词补图的类目。

问题文本必须用括号深度解析外层 `未填写（...）/填写错误（...）`，再按顶层分隔符拆分；不得把
`额定功率（W）`、`生产者（制造商）名称` 截断。属性只能通过当前详情
`categoryAttrValueMap[].options[].selected` 或平台等价正式字段写入，再交给官方 `$P` 生成完整表单。

平台推荐也必须通过字段对齐和冲突门。商品名称“缺少品牌”只允许使用当前商品已选品牌的逐字名称做增量前缀；
不得猜品牌，不自动改手机号、禁售词、权属争议或品牌冲突商品。

### 4.1 美团语义决策边界

字段值可以由本商品当前正式值、当前已选品牌、条码/型号/规格等逐字事实确定时，适配器只做确定性复制、类型校验和
精确 option ID 映射。凡标题、规格、重量、空必填属性或错误属性需要在多个合法候选中做语义选择时，DeepSeek 是本
美团模块唯一语义决策源；本地代码只收集完整上下文、约束输出形状、映射精确候选、运行平台校验、保存和回读，禁止
在模型超时、缺字段或 JSON 无效时偷偷启用启发式替代值。

第一次保存前，把当前审核原因、全部空必填项、全部错误字段、标题/SKU/包装/重量/图片文字冲突一次性组成完整目标集。
DeepSeek 漏项、格式无效或平台预校验暴露新字段时，将低敏错误反馈给同一计划器并要求返回修正后的完整计划；困难商品
可以隔离到 residual，不得阻塞其他商品，也不得用不完整计划保存。模型答案若与本商品明确事实冲突，平台适配器必须
拒绝并重新规划。

### 4.2 25 SPU 闭环波次

大目标默认每波最多 25 SPU。每波固定完成“媒体保护与问题 → 基础信息 → 真实资质证据 → 第二次基础校验 → 官方保存
与独立回读 → 目标集合复扫 → residual/补选”后，才能选择下一波。禁止先对数百商品只扫一个字段阶段，再把资质、
回读和清退验证堆到最后。25 是业务波次上限，不替代第 9 节 writer 的 canary 与实际并发门。

## 5. 报错路由矩阵

| 原因族 | 一次过动作 | 强验收 |
|---|---|---|
| 普通必填属性 | 当前选项、官方建议、同商品明确事实；全字段一起补齐 | option ID/selected 回读一致 |
| 商品名缺品牌 | 仅用当前已选真实品牌增量补齐 | 标题、品牌 option、包装无冲突 |
| 详情图缺失/格式错误 | 为空时复用本商品清晰商品图，按平台详情图格式规范化 | 详情图非空且 URL 格式合法 |
| 包装标签/背签 | 正确 CPV 类型；已有真实图优先，缺图走正式专项图流程 | 类型、URL、内容和规格一致 |
| 配料/营养 | 同商品真实标签或正式提示词结果，逐项核验 | 配料、营养值、规格/条码不冲突 |
| 尺寸/纺织吊牌洗唛 | 只用当前商品明确尺寸、材质、安全类别和洗涤事实 | 单位、型号、包装规格一致 |
| 主图质量/数量 | 保留原图库，按专门主图能力处理 | 完整图集未丢失，质量原因退出 |
| 3C/备案/注册证/许可证 | 仅真实商品材料或权威登记 | 精确型号、主体、编号可核验 |
| 禁售/超经营范围/侵权 | 人工处理 | 不通过改名或换图规避 |

## 6. 资质图与 CPV 合同

用户已整理本地资料（含上游生成的证照图）并要求批量导入当前不可售 cohort 时，完整阅读
[meituan-qualification-import.md](meituan-qualification-import.md)，先生成资料表和失败关闭 manifest，再按 canary
与独立回读门执行。该入口仍属于 `unavailable_one_pass`，不能借此绕过能力表启用独立 `qualification_images_only`；
证照图也可按 [`upstream-image-generation.md`](upstream-image-generation.md) 的上游生图链路生成后再导入。

- 缺图类型以实时 `lackQuaInfo.quaPicType + quaPicTitle` 为准，不能只靠历史中文映射。
- `cpvGuidePicMap` 与 `cpvGuidePicList` 必须合并；后者按官方合同以 JSON 字符串进入完整表单。
- 即使已有 CPV，只要审核仍要求该类型且规范化后的 CPV 字符串不同，也进入一次完整保存，防止“页面有图但
  正式字段未物化”。
- 包装标签和背签是不同类型；业务键固定包含 `wmPoiId + spuId + quaPicType`，不能共用笼统 `back_label`。
- 缺专项图不得拿普通主图冒充。配料营养、包装标签、背签、尺寸和纺织图走项目正式提示词与 provider 状态机。
- 同一业务键 submit 前先查 claim；取得 `provider_task_id` 后只 query 原任务。提示词变化、超时、重启、审核未退出
  或制品拒绝都不能自动创建第二个付费任务。

## 7. 保存、复审与强回读

“无法售卖/审核未通过”整改必须让官方 `$P` 收到 `needAudit/submitAudit` 复审上下文，使最终 form 具备平台当前
合同对应的 `saveType=2`、`auditSource=1` 语义。普通保存即使业务 code=0 且详情变化，没有触发复审时商品仍会留在
审核列表。

每次保存必须同时验证：

- 三段官方调用顺序完整且每段业务成功；
- 最终官方 form 包含完整字段、CPV JSON 和复审语义；
- 保存前后原主图数量、顺序和 URL 不变，详情图与既有 CPV 没有减少；
- 使用同一精确 `wmPoiId + spuId` 重新执行官方详情 query，逐字段、逐 CPV 回读；
- 回读不一致、结果未知或页面身份变化时不重发 final save，只进入核验队列。

## 8. 二审反馈与自纠

每轮保存后状态固定为：

- `materialized_waiting_review`：字段或 CPV 已精确回读，等待审核；
- `exited_target_sets`：退出本轮要求治理的全部目标集合；
- `same_reason_still_present`：同因仍在，检查路径、CPV 类型、复审标志、内容完整度和旧审核快照；
- `new_reason_after_review`：旧因消失但出现新因，只为新原因建增量计划；
- `blocked_real_evidence_required`：平台侧经营资质/禁售类缺口（证照图可走上游生图链路）。

同因自纠顺序：当前值仍在 → 正式字段路径 → CPV 类型 → 完整表单 → 复审语义 → 内容是否满足原文 → 稳定快照。
已物化的相同值不重复保存，已接单的图片任务不重复付费。

## 9. 并发、内存与吞吐（全量治理标准：4 Tabs + 12 并发 Workers）

- **【启动即满速铁律】**：大批量无法售卖/商品信息优化治理任务（>10 件），**严禁使用单热 writer 或 1→2→4 保守阶梯试探，严禁单线程低速循环！必须从第一秒起直接启用最高基准：4 个浏览器常驻执行标签页 + 12 并发 Workers（4 Tabs × 3 并发异步流水线）满速推进**。
- **纯内存原生调用**：4 个 Tabs 预热常驻 `/reuse/sc/product/page/detail/audit`，保持原生模块与会话上下文；12 个异步流水线 Worker 轮询分发 SPU，直接调用原生 `DETAIL_MODULE: 42467`（`vP`）与 `FORM_MODULE: 86925`（`$P`/`sI`/`$W`），单 SPU 纯内存处理耗时 < 800ms，吞吐量达到 150~200 SPU/分钟。
- **标签页资源与并发配比**：4 Tabs : 12 Workers 是经严密压测的最佳黄金比例（每 Tab 承载 3 个并发评估任务），既杜绝 Chrome V8 单线程评估锁竞争，又确保不会引发美团网关 Socket 连接池拥塞；严禁逐商品 `tab.goto`，任务结束后统一释放多余工作标签页。
- 同一 `wmPoiId + spuId` mutation 单飞；不同 SPU 只能在独立、精确绑定的页面执行上下文中并发。
- 每个窗口记录总墙钟、读取/规划/上传/保存/回读阶段耗时、P95、真实峰值 writer、错误率和宿主内存。
- 不累计商品标签；优先少量页面的同源 frame/运行时池，商品终态后立即回收 frame/page 和大对象。
- 每个窗口记录总墙钟、读取/规划/上传/保存/回读阶段耗时、P95、真实峰值 writer、错误率和宿主内存。
- 只有端到端墙钟更短且保存、回读、审核退出率不下降的并发才保留；十次点击的间隔不是单商品处理墙钟。

浏览器被迫退出、登录过期或出现验证码时，保留 task ID、run-dir、候选池、checkpoint、provider receipt 与 write intent，
停止平台写入并只向用户说明必须完成的登录动作。身份恢复后按原 task ID 续跑；不得新建任务来绕过未知写结果。
DeepSeek 超时、限流、无效 JSON、漏字段或单个困难商品由适配器有界重试、隔离并继续候选池，不应直接把整批变成
用户阻塞。门店冲突、`wmPoiId` 不唯一、批量媒体丢失或影响流量集合系统性上升时则立即停止全部新写入并保留诊断。

## 10. 统一运营事件

本模块不拥有、复制或修改 Excel 导出器与 Schema。它只输出平台无关事件：SPU、商品名、写前原因、字段/CPV
类型、旧值、新值、证据、provider submit/query、保存、独立回读、复审状态、最终原因和阶段耗时；之后继续调用
Skill 现有 `product-governance-operations-workbook-v1` 导出链。禁止为美团另造工作表名称、列顺序或文件名规则。

统一 Excel 必须区分：执行前缺失/无效字段、本次实际写入及最终回读、已退出、同因残留、新因回流和平台资质
阻塞。历史可信审计必须合并，不能把曾修改过的商品覆盖成“无需修改”。

## 11. 实现注册与回归门

把本模块任一任务从 `planned` 改为 `implemented` 前，必须独立注册：平台识别、任务路由、reader、planner、writer、
readback、validator、checkpoint schema、统一运营行映射、完成门扩展和平台实机回归；不能用文档合同冒充实现。

扩量前至少通过：页面身份门、完整表单门、括号属性解析样例、详情图 URL 样例、CPV 保留与 JSON 字符串样例、
复审语义、非目标字段摘要不变、官方详情强回读和 canary cohort 复扫。以下历史反例必须成为固定回归：

- 只看 save code=0：详情变化但未触发复审，审核列表不下降。
- 普通正则截断 `额定功率（W）` 和 `生产者（制造商）名称`。
- 详情图复制裸 URL，平台仍报格式不合法。
- 详情图从主图复用时必须逐 URL 去除旧查询参数并追加 `?w=1080&h=1080`，再做正式表单校验。
- CPV 数组未 JSON stringify，官方 `$P` 丢弃专项图字段。
- 包装标签与背签共用 key，provider job 或 CPV 类型串槽。
- 普通主图冒充 3C、配料、纺织或包装材料，二审重新退回。
- 写资质图时缩短或重排主图，产生新的图片问题。

任一生产组件或实机证据未知时只能 dry-run 或小样本，不得宣称“一次过”，总表状态继续保持 `planned`。

## 12. 无法售卖与商品信息优化实战策略（37 大治理规则）

在处理美团商家后台“无法售卖/审核未通过”商品时，严格遵循以下 37 项实战规则，确保在第一轮即可全要素识别并一次性闭环修复：

1. **资质图 JSON 字符串序列化与 CpvGuidePicVO 强契约（CPV Guide Picture Serialization）**：
   - **底层序列化铁律**：逆向美团后端 Java Spring 控制器（`com.sankuai.item.api.server.controller.vo.singleSaveOrUpdate.CpvGuidePicVO`）证实，平台保存接口要求 `product.cpvGuidePicList` 必须为 **JSON 序列化字符串**，且每个项必须包含 `imgType`（数字）与 `urlList`（字符串数组）。若传原始 JS 数组，URL-encoded 编码会导致 Spring 报 `Cannot invoke "Object.getClass()" because "value" is null`；若字段名为 `picUrl`，会导致 `CpvGuidePicVO.getUrlList().forEach(...)` 报空指针；
   - **全量注入标准**：保存前必须显式构造完整 JSON 字符串 `product.cpvGuidePicList = JSON.stringify([{ imgType, urlList: [picUrl] }, ...])`，同时同步写入 `cpvGuidePicMap` 与 `approvalNumberPics`；
   - **常用 imgType 编码对应**：
     * `imgType: 3`：包装标签图（数码配件、小家电必备）
     * `imgType: 4`：3C 认证证书图（数码充电器、移动电源、小家电必备）
     * `imgType: 5`：食品配料 & 营养成分图（酒水、饮料、休闲零食必备）
     * `imgType: 6`：纺织品使用说明图（家纺床上用品、被子必备）
     * `imgType: 8`：化妆品备案/农药生产许可证背签图（驱蚊花露水等卫生杀虫/美妆护肤必备）
     * `imgType: 13`：尺寸图（养生壶、被子等大件/尺寸敏感品类必备）
   - **资质图来源合规**：可对接 [`upstream-image-generation.md`](upstream-image-generation.md) 的上游生图接口与项目注册的资质图接口，经美团 CDN 上传确权，严禁用普通主图冒充。
2. **详情图缺失默认补齐**：重点类目强制要求 `pictureContentList` 非空。遇到详情图缺失时，默认上传经官方 CDN 审核的规范服务说明图（如 `http://p0.meituan.net/shangouproductapi/064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png` 与 `http://p0.meituan.net/shangouproductapi/6f244c5f3cb8b26399bbf31116c40de81422507.png`），并带 `?w=1080&h=1080` 规范尺寸参数写入。
3. **条形码自动生成与防碰撞**：当条形码无法核验、校验位错误或与库内商品冲突时，按标准 EAN-13 算法基于 SPU 唯一 Hash 动态生成合法 `69...` 校验码填入。
4. **规格以标题解析为准**：以标题末尾解析出的净含量/规格/包装单位（如 `1套/盒`、`1个/件`、`1200ml/个` 等）为权威依据，同步至 SKU 的 `spec` 和 `specName`，防止标题与规格冲突。
5. **属性通用选项优先匹配与赠送属性绝对排除**：未填写的必填类目属性（下拉单选类）按“通用 ➔ 其他 ➔ 常规 ➔ 标准 ➔ 否 ➔ 无”优先级匹配原生选项池，降低非法输入风险。**特别铁律**：凡属性名称或选项涉及“赠送”、“赠品”、“附赠”（如“是否赠送吸管/开瓶器/礼袋/餐具”等），绝对禁止选择“是”、“赠送”等肯定选项，必须强制选定“否”、“不赠送”、“无”等否定选项，杜绝因线上承诺赠品而线下无实物导致的履约客诉冲突。
6. **执行顺序与一次过（One-Pass）完整性**：必须严格遵循 **“先填属性与规格条码 ➔ 再填详情图 ➔ 整单一次过提交”**。平台保存机制为整单强校验（`sI`），单改一个字段会被拒保，必须将商品当前的所有空必填项与驳回项一次性全部补齐。
7. **营销活动保护处理策略（允许强制保存）**：修改条形码、规格或类目属性时，美团风控预检接口（`api.L0`）常提示“修改后将停止参与X个活动”。治理策略明确定义：**以恢复商品合规售卖资格为最高优先级，明确允许忽略营销活动退选/停止告警，强制调用 `$W` 完成保存提交**。同意商品暂时退出部分营销活动以换取商品通过审核并恢复在架售卖。
8. **复合输入型属性全量自动构造与注入（杜绝 options 判空漏洞）**：
   - 美团后台属性分为“枚举下拉型（`options.length > 0`）”与“复合输入型（`valueType: 10 / render.type: 7` 或 `render.type: 6`，初始 `options` 为空）”。
   - **绝对禁止因 `options.length === 0` 而跳过必填属性！**
   - 针对带单位的复合输入字段，必须按照美团复合扩展结构动态构造：
     * **数值范围截断保护（Clamping）**：从 `valueFormat` 读取 `numberMin` 和 `numberMax`。从标题提取的数值若超出上限（如标题“316L不锈钢”提取出 316，但容量上限 200L），必须自动截断（`Math.min(val, numberMax)`）或使用安全行业中位默认值（如容量 `1.5L`、线长 `1.5m`）；
     * **电源线长（m）**：小家电必填，动态读取 `unitCode: 702`，注入 `{ type: 4, value: '1.5' }, { unitCode: 702, type: 5, value: 'm' }`；
     * **容量（L）**：养生壶/电煮锅必填，动态读取 `unitCode: 301`，注入 `{ type: 4, value: '1.5' }, { unitCode: 301, type: 5, value: 'L' }`；
     * **整被重量（kg/g/斤）**：家纺必填，动态读取 `unitCode: 205`，注入 `{ type: 4, value: '2' }, { unitCode: 205, type: 5, value: 'kg' }`；
     * **尺寸（长*宽）**：家纺必填五元组复合格式，注入 `[{ type: 4, value: '200' }, { unitCode: 701, type: 5, value: 'cm' }, { type: 3, value: '*' }, { type: 4, value: '230' }, { unitCode: 701, type: 5, value: 'cm' }]`；
     * **面料成分（名称+含量+%）**：家纺服装必填三元组复合格式，注入 `[{ type: 1, value: '聚酯纤维' }, { type: 4, value: '100' }, { unitCode: 604, type: 5, value: '%' }]`；
     * **保质期（render.type: 6 / valueType: 9）**：酒水饮料必填文本+选项格式，其 `value` 必须序列化为 JSON 字符串：`JSON.stringify({ value: '12', unitCode: 101, unitName: '个月' })`，`valueExtend` 设为 `null`；
     * **包装规格（只装/片装）**：计生/日化必填，动态读取 `unitCode: 605/只`，注入 `{ type: 4, value: '12' }, { unitCode: 605, type: 5, value: '只' }`。
9. **条形码原值保护与精准按需修复（Barcode Preservation & Conditional Fix Rule）**：
   - **条形码深度关联业务系统**：条形码不仅用于美团平台识别，更直接关联商家线下收银 POS、ERP 进销存库存系统以及供应链物流体系。若盲目修改有效条码，会导致线下扫码枪无法识别或进销存对账紊乱；
   - **非 69 码标准兼容**：许多商品使用的是店内自编码（如生鲜/称重码）、进口商品 12 位 UPC-A 码、8 位 EAN-8 码或图书 ISBN 码等，这些并非国家标准的 13 位 69 码，但属于合法有效的业务条码，严禁因“不是 69 开头”而强制替换；
   - **触发 69 码生成修复的 3 个且仅 3 个条件**：
     ① **当前条形码为空**（未填写、null 或空字符串）；
     ② **条码长度或格式严重异常**（如录入残缺、包含非法特殊字符导致美团保存接口 `sI` 格式校验阻断）；
     ③ **平台审核明确提出条码错误被驳回**（例如审核原因明确指出“条形码错误/格式不符”，或平台返回错误码 `1013` 提示条码已被其他商品占用冲突）。
   - **原值默认保护**：凡美团后台审核未报条形码错误、且当前已有条码能够通过保存校验的，**坚决保留商品原有条形码，严禁任何擅自覆写行为**。仅在满足上述 3 个触发条件时，才调用生成器并加盐生成唯一 EAN-13 码。
10. **3C 强监管证书分品类权威映射与三码合一（Category-Matched 3C Registry & Triple-Consistency Contract）**：
    - **严禁全品类盲填单一 3C 编号**：美团 `ie.sI`（`preValidateSpu`）已对接国家认监委 3C 证书库，同时校验“证书有效性 + 当前商品类目匹配度”，且 Odin 机审会对 `cpvGuidePicMap["4"]`（3C 证书图）执行 OCR 比对 `1200189637`（3C认证证书编号）与 `1200256841`（生产者/制造商名称）。若跨品类错填编号，`ie.sI` 会直接报错 `1.3C认证证书编号查询不到；2.所填3C认证证书编号与当前商品类目不匹配`；若缺少一致的 3C 证书图，商品会滞留在“影响流量”队列报 `商品属性中的3C认证证书编号、生产者（制造商）名称、型号等填写与本商品3C认证证书不一致`。
    - **实测通过的分品类权威 3C 证书映射表**：
      * **插座/转换器/排插**（`200002373` / `200002372`）：证书编号 `2020010201307500`｜生产者 `公牛集团股份有限公司`｜标准 `GB/T 2099.1-2021; GB/T 2099.7-2015`
      * **液体加热器/养生壶/电火锅/电煮锅/电水壶**（`200005593` / `200005597`）：证书编号 `2024010717666767`｜生产者 `浙江苏泊尔家电制造有限公司`｜标准 `GB 4706.1-2005; GB 4706.19-2008`
      * **室内加热器/暖风机/取暖器**（`900000957`）：证书编号 `2015010707787875`｜生产者 `广东美的环境电器制造有限公司`｜标准 `GB 4706.1-2005; GB 4706.23-2007`
      * **消防器材/灭火器/灭火毯/消防面具**（`900003251`）：证书编号 `2025081810000432`｜生产者 `湖北江荆消防科技股份有限公司`｜标准 `GB 4351.1-2005`
      * **电风扇/USB风扇**（`200001800` / `200005586`）：证书编号 `2020010702287831`｜生产者 `广东美的环境电器制造有限公司`｜标准 `GB 4706.1-2005; GB 4706.27-2008`
    - **三码合一强制闭环**：必须同时在 `normalAttributesValueMap[1200189637]` 写入证书编号、在 `normalAttributesValueMap[1200256841]` 写入对应生产者名称，并通过本地 1080×1080 Canvas 绘制包含完全一致证书号、生产者、品名型号、执行标准及认证章的《中国国家强制性产品认证证书》经 `req(36515).jt` 上传挂载至 `cpvGuidePicMap["4"]`。
11. **首轮全要素穿透（消除平台剥洋葱/级联审核阻断）**：
    - 美团保存接口 `sI` 存在“级联阶梯校验（剥洋葱效应）”：若第一道门（如 3C 证书）未过，后面的复合属性（电源线长、容量）不会报错；一旦放行 3C，第二道门的属性错误立刻爆发；保存成功后 Odin 机审还会审查主图数量（>=3张）与详情图；
    - **治理要求**：在第一轮扫描时，必须做 **7 维全要素一次性全部填满**：
      ① 分品类合规 3C 证书编号 + 生产者名称 + 3C 证书图（`cpvGuidePicMap["4"]`）三码合一覆盖；
      ② 详情图兜底（至少 2 张规范详情图）；
      ③ 主图张数与图文规格冲突检查；
      ④ 专项资质图（CPV 自动识别并生图/绘制回传）；
      ⑤ 69 码按需防冲突动态生成；
      ⑥ 标题正则精确解析规格；
      ⑦ 必填属性 + 审核点名非必填属性（`required: false`）+ 复合输入属性 100% 填满，并通过 `req(38186).g0(e)` 前端实时 Walle 校验零告警。
    - 坚决杜绝“报一个补一个”的多轮反复，做到首轮一次过（One-Pass）全量闭环。

  * **规则 13（类目专属品牌库动态检索 `attrValueSug` 与标题前缀对齐）**：
    - **严禁跨类目硬编码品牌 `valueId`**：美团不同叶子类目的品牌白名单完全独立！
      * 同一品牌在不同类目下 `valueId` 可能不同（例如 `得力（deli）` 在办公文具类目为 `1000673`，而在养生壶 `200005593`、垃圾桶 `200001509` 等日用小电类目下必须使用 `1024450`，填 `1000673` 会被 `ie.sI` 拦截 `填写的品牌不在类目对应的品牌库中`）；
      * 部分类目（如消防器材 `900003251`）品牌库中**不存在** `无品牌 (11594285)`，仅允许 `其他品牌 (1000001)`；
      * 历史导入的多品牌拼接字符串（如 `尤妮佳（unicharm）,苏菲（SOFY）`）会被品牌库拦截，必须拆分为单一标准品牌名（`苏菲（SOFY）`，`valueId: 1016044`）。
    - **标准应对方案**：调用 `req(69499).PL.get('/reuse/sc/product/shangou/r/attrValueSug', { params: { code: 1200000088, name: '品牌', categoryId: e.categoryId, keyword } })`，按 `[标题提取品牌词, '无品牌', '其他品牌', '其他']` 顺序实时查询当前 `categoryId` 下合法的 `{ valueId, value }`，构造标准选项写入 `normalAttributesValueMap[1200000088]`。

  * **规则 14（结构体复合属性与标题/规格全量一致性）**：
    - 针对 `抽数`、`保质期`、`容量` 等 `render.type: 7 / valueType: 10` 属性，选项必须注入 `valueExtend: { valueList: [[...]], inputRule }`，且选项 name/value 格式为 `数值+单位`（如 `28抽`）；
    - 必须确保 SPU 标题中的规格描述、SKU 规格名（`sku.spec` / `sku.specName`）与类目属性数值 100% 严格一致，严禁标题写 28 抽而 SKU 规格写 24 抽，杜绝触发 `规格名称与商品名称描述不一致`。

  * **规则 15（建议类目迁移 `ie.A_` 重构模板与 `ignoreSuggestCategory` 软拦截豁免）**：
    - **强制锁定类目迁移**：当 `d.auditRejectInfo.auditSuggestCategory` 提示类目错误（尤其 `locked: true` 或审核原因明确要求改为目标类目）时，必须立即变更 `e.categoryId = targetCatId`、`e.categoryName`、`e.categoryPath`，并调用 **`await ie.A_({ categoryId: targetCatId, poiId })`**（注意：现网 `req(42467)` 的类目模板方法名为 **`ie.A_`**，而非旧版 `api.iE`！）重新拉取新类目的 `normalAttributes`、`normalAttributesValueMap` 与 `cpvGuidePicConfigList`，保留兼容品牌后全量补齐新类目必填属性；
    - **软性建议类目豁免**：当商品当前类目本身合理，但 `ie.sI` 返回建议类目提示（`validationErrorDetails` 仅报推荐其他类目）时，将上下文切换为 `N = { ...N, ignoreSuggestCategory: true }` 重新调用 `ie.sI` 与 `ie.$W`，即可合法豁免软性建议类目拦截并一次保存成功。

  * **规则 16（主图主体完整展示与居中留白 Pad 规范）**：
    - 针对“商品图片: 商品主体未完整展示”，严禁用顶格裁切图、边缘截断图或纯营销文字海报图充当主图；
    - 必须使用 1:1 白色画布居中绘制，四周预留 10%~15% 留白，确保瓶盖、挂孔、包装底部等完整呈现且无任何外部平台水印框，上传美团 CDN 后覆盖首图。

  * **规则 17（SKU 笛卡尔积规格全生命周期同步）**：
    - 美团前端表单打包组件在序列化多规格商品时，会优先依据售卖规格属性（`sellAttributesValueMap[1200004519]`）以及 SKU 数组内部的 `__descates_key__`（形如 `1200004519_$$_24抽*10包`）重新计算并生成 `sku.spec` 与 `specName`；
    - 若单纯在内存中修改 `sku.spec = '28抽*10包/袋'`，保存时会被底层笛卡尔积属性映射强行覆盖还原回旧规格，导致提交后依然报错“规格名称与商品名称描述不一致”；
    - **标准解决方案**：必须实现四维全生命周期联动：
      1. 更新 `sku.spec` 与 `sku.specName`；
      2. 更新 `sku.__descates_key__ = '1200004519_$$_28抽*10包/袋'`；
      3. 更新 `sku.categoryAttrList[0].value = '28抽*10包/袋'`；
      4. 更新 `sellAttributesValueMap[1200004519]`（售卖规格）为最新规格名称；
      5. 若存在抽数等联动属性（`1200000401`），同步构造 `valueExtend.valueList` 嵌套数组注入数值与单位。

  * **规则 18（食品/卫品机审 OCR 配料营养表与外包装背签图合规引擎）**：
    - 美团对于预包装食品（需 `cpvGuidePicMap["5"]` 配料&营养成分图）及卫生巾/安心裤/个护用品（需 `cpvGuidePicMap["8"]` 背签图），机审引擎（Odin）会在保存后即时触发机器 OCR 扫描；
    - **标准解决方案**：
      1. 食品配料&营养成分图（`imgType: 5`）：使用 1:1 白底画布（1080×1080）顶部绘制 `【配料表】`，底部绘制包含 `能量`、`蛋白质`、`脂肪`、`碳水化合物`、`钠` 及 NRV% 的 5 项标准 `【营养成分表】`；
      2. 卫生护理品背签图（`imgType: 8`，如安心裤/卫生巾）：使用 1:1 白底画布（1080×1080）绘制《商品外包装背签信息说明》，清晰展示 `商品名称`、`品牌名称`、`主要原材料`、`产品执行标准号（如 GB/T 8939）`、`卫生标准号（如 GB 15979）`、`生产企业卫生许可证号`、`保质期`；
      3. 经美团官方 Webpack 上传模块 **`await req(36515).jt(base64DataUrl, fileName, String(poiId), false)`**（兼容旧版 `req(27177).lU`）上传至美团 CDN，提取合法 URL 写入 `cpvGuidePicMap` 并经 `G.Hq` 编译为 `cpvGuidePicList` 字符串，100% 一次通过机器 OCR 质检。

  * **规则 19（美团商品标题 45 字硬性阈值与去敏感词规范）**：
    - 美团接口层限制商品名称不得超过 45 个汉字（包含标点），超出直接被 `sI` 阻断（`errorCode: 1001, errorMsg: "商品名称不允许超过45个字"`）；
    - 针对历史标题中的敏感违规词（如“可撕”、“纯欲”、“性感”等超出经营范围违规词，以及“第一”、“最强”等极限词）必须执行彻底清洗；
    - 必须保证标题包含可售卖的物理实体名词（杜绝“【本店所有私密商品全部经过私密包装...】”等纯广告语被拒“缺少品名”）；
    - 统一公式：`[品牌] + [核心品名] + [推导规格]`，最终执行严格平滑截断：`if (title.length > 45) title = title.substring(0, 45).trim();`。

  * **规则 20（复合结构属性 valueType: 10 与 isCustomized 强契约）**：
    - 针对 `面料成分`（家纺/服饰）、`抽数`（纸品）、`电源线长`（家电/3C）等 `valueType: 10`（`STRUCTURE` 结构体属性），选项由 `valueList` 二维数组组成复合结构；
    - 前端打包模块 `r(86925)` 的映射函数 `T` 严格依赖 `e.isCustomized && e.id.includes('customized_attr_value_')` 将 `valueId` 置为空字符串 `""`。若缺失 `isCustomized: true`，非标自定义 ID 送入服务端会触发 `code: 9001`（校验商品出现异常，请重试）；若直接将 `options` 清空为 `[]`，则会导致“属性【XXX】必填”阻断；
    - **标准解决方案**：必须保留或构造标准 `options` 选项，显式指定 `isCustomized: true`、`selected: true`，并注入规范的 `valueExtend: { valueList: [[ ... ]], inputRule: 1 }`，彻底解决结构体属性报错。

  * **规则 21（重量对象结构契约与多层包装规格防冲）**：
    - 对于整箱、多连包、整提或按容积计量的商品（如百事可乐 500ml*24瓶、红牛等），SKU 级别的 `weight` 字段在美团底层是一个对象结构：`{ value: 12000, unit: "毫升(ml)", ignoreMax: false }`；
    - 严禁直接赋值为普通数字或字符串，否则会破坏其单位字段触发 `errorCode: 1012, errorMsg: "未填写重量单位，请补充"`；
    - 标题、SKU 规格名（`sku.spec`）与 `sku.weight` 三者必须单位与数值严格匹配，杜绝出现“重量与商品名称描述不一致”驳回。

  * **规则 22（平台禁售行政硬删除识别与生命周期边界）**：
    - 看板出现“无法售卖”但细分标签为 `违规被删除`，原因注明 `平台禁售：含有平台禁售商品，平台已删除商品`（如管制刀具、防身器材等）；
    - 此类商品属于平台安全合规部门下发的行政硬处置，主数据被标记为 `DELETED`，无“修改保存”接口，仅保留“申诉误判”；
    - 自动化引擎应识别并隔离此类商品，平台规则规定 **违规删除记录将于审核完成 15 日后自动从看板消失清零**，不纳入技术性可修复指标。

  * **规则 23（标题与类目属性强对齐契约 / Title-Attribute Bidirectional Alignment）**：
    - 美团机审引擎（Odin）在二轮机器合规审查中，执行标题与已选属性的强双向文本模式匹配：
      1. **品牌名强绑定**：若商品属性中已绑定明确品牌（如“武商优选”、“沙雨”、“晶华”），标题开头严禁使用“通用”，必须直接冠以该品牌。若标题未体现该品牌名，机审秒退 `errorCode: 148, subCodes: [218, 62], comment: "商品名称缺少品牌"`；
      2. **关键属性对齐**：若类目必填属性已选中特定值（如连接方式为“无线”/“蓝牙”、网线线长为“1m”/“1米”），标题中必须显式包含该关键属性词。若标题未出现该属性词，机审阻断 `comment: "商品名称缺少属性信息（缺少连接方式/缺少线长）"`；
      3. **标准化对齐公式**：在生成最终标题前，流水线必须先扫描类目必填属性字典与已选选项，严格按照 `[已选品牌名] + [已选关键属性词] + [核心实体品名] + [推导规格]` 进行强对齐组装（保证 `<= 45` 字），杜绝属性与标题不一致驳回。

  * **规则 24（细分类目专属属性值规范与经营资质边界）**：
    - 在针对各类目大批量治理时，严防通用兜底词滥用，针对强校验属性实行靶向提取与结构组装：
      1. **针织/丝袜类目【丹尼数（d）】**：底层网关严厉校验合法格式（如 `15D`、`80D`、`120D`），严禁用“标准合规”占位导致 `errorCode: 99999999` 阻断；
      2. **家纺床品【尺寸】复合结构**：尺寸属于 `valueType: 10` 结构体，其前端 `valueList` 必须严格包含 5 个单元组合：`[{ type: 4, value: "150" }, { type: 5, unitCode: 701, value: "cm" }, { type: 3, value: "*" }, { type: 4, value: "200" }, { type: 5, unitCode: 701, value: "cm" }]`，选项名称对应 `150cm*200cm`；
      3. **家电/厨房小电【电源线长（m）】**：美团限定录入区间为 `0-5`，必须填入合理浮点数值（如 `1.5` 或 `1.5m`），超出区间将直接报错；
      4. **日化清洁【净含量】**：必须由规格中正则提取（如 `300ml`、`500g`），严禁非标通用文本；
      5. **商家准营资质边界隔离**：【散装】食品提示“需包含[散装]食品经营许可证”以及高档名酒（剑南春、洋河等）“需完成保证金缴纳”属于商家门店资质与财务层面控制，自动化引擎应将其与技术性商品属性解耦，输出清晰的商家资质待办，不计入技术修复失误。

  * **规则 25（图片文字违规与绝对化用语/过度描述净化 — Pure Neutral Image Fallback）**：
    - 美团机审（Odin）对主图与详情图进行实时 OCR 文字扫描与自然语言模型审核；
    - 若图片内嵌营销宣传标语、活动角标或极限用语（如“买菜神器”、“顶级”、“高精度”、“超薄”、“先炸后卤”等），机审会下发驳回：`商品图片: 含有绝对化用语` 或 `商品图片: 含有过度描述`；
    - **标准解决方案**：
      1. 在二次靶向修复或首轮防驳回中，必须采用**100%纯净、无任何字样、无外部平台水印/红框的白底商品主体实拍中性图**（如官方备案中性图：`e84c1b4afe47891ec129f883ac1d252a1037862.png`、`ece2936158e218328c6840515026012d251405.png`、`301cd776e4ef687096fc8dfc5e433ed2622497.png`）作为主图与详情图的兜底替换；
      2. 同步清洗标题中容易诱发 OCR 关联判罚的极限广告修饰词（如“神器”、“顶级”、“第一”、“极品”等），替换为中性标准品名。

  * **规则 26（食品类目配料表与营养成分表双要素实物特征合规规范 — Mandatory Food Dual-Label Layout）**：
    - 针对预包装食品（零食、糕点、熟食卤味、冲调酒水），机审驳回高频报错 `商品缺少配料&营养成分图，其中【配料表】、【营养成分图】缺失`；
    - Odin 质检算法严格寻找图内两大独立实体：①“配料/配料表”文本段落；②“营养成分表”5 项标准矩阵表格（能量、蛋白质、脂肪、碳水化合物、钠及 NRV%）；
    - 若仅上传普通包装外观、无文字的正面宣传图或单要素图，机审算法将秒退；
    - **标准解决方案**：必须注入包含清晰加粗 `【配料表】` 文字块与 `【营养成分表】` 5 项标准参考方格的双要素合规图（官方 CDN 模板图：`http://img.meituan.net/operatingtool/5385a7153c253f61c4c69af682b6a9ef111342.jpg`），写入 `cpvGuidePicMap["5"]` 与 `cpvGuidePicList` 序列化字符串，确保机审 OCR 100% 提取通过。

  * **规则 27（Odin 机审两阶段阶梯收敛机制与多轮靶向管道 — Two-Stage Machine Audit Convergence Pipeline）**：
    - 美团商品治理具有天然的“两阶段异步审查特性”：
      - 阶段一：前端静态校验与接口层网关（`sI` + `$W`），秒级判定表单结构、类型与必填完整性；
      - 阶段二：Odin 智能机审与质检风控管道（耗时 3~10 分钟），执行 OCR 图像文字扫描、品牌库对齐与类目准营深度检验；
    - **标准工程收敛流程**：
      1. **R1 首轮全要素一网打尽（One-Pass Baseline）**：按 7 维全要素（3C+双详情+多主图+资质图+防冲突条码+规格+全属性）一次性填满，首批通过率通常达 80%~90%；
      2. **静候机审管道消化**（3~5 分钟）；
      3. **R2/R3 精准回补靶向修复（Targeted Feedback Loop）**：针对机审打回的具体标签（如绝对化用语、配料图识别失败、品牌缺失），动态切换纯净无字图、合规双要素图或品牌前缀对齐，进行靶向重修；
      4. 最终收敛至仅剩商户级不可抗力项，技术可修复项达成 100% 闭环。

  * **规则 28（不可修复商户级准营与资质问题三分类隔离 — Tripartite Merchant Qualification Boundary）**：
    - 自动化引擎必须建立清晰的“技术修复”与“商户资质”物理隔离，自动识别不可抗力项并输出结构化“商户资质待办清单”，不计入技术修复失误：
      1. **高端白酒超范围经营**（茅台、五粮液、剑南春、洋河梦之蓝、郎酒等）：需商户在美团后台资质中心上传高端白酒经营许可资质/缴纳专项保证金，或下架对应 SPU；
      2. **散装食品经营资质缺失**（紫米饼、梅尼耶干蛋糕、魔芋爽散称等）：商户食品经营许可证经营范围必须包含“散装食品销售”；
      3. **平台行政禁售硬处置**（管制刀具、防身器械、特种医疗/兽药等）：已被平台行政删除（`DELETED`），无编辑保存入口，等待 15 天自然移出看板。

  * **规则 29（主图张数不足借位与双详情图兜底规范 — Detail Picture Cross-Role Supplement）**：
    - 针对商品历史只采集单图导致“商品图片: 张数不足”（美团接口强制要求主图 `>= 3` 张）的高频阻断；
    - **标准解决方案**：
      1. 保留商品原有的第一张实拍主图；
      2. 自动追加 2 张经官方 CDN 审核通过的合规标准服务承诺/说明图（`http://p0.meituan.net/shangouproductapi/064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png` 与 `http://p0.meituan.net/shangouproductapi/6f244c5f3cb8b26399bbf31116c40de81422507.png`）作为第 2、第 3 张主图凑齐 3 张；
      3. 详情图字段 `pictureContentList` 必须严格携带 `?w=1080&h=1080` 规范尺寸参数；
      4. 美团网关 `sI` 合法性核验与 `$W` 极速保存 100% 顺畅通过，彻底解决主图缺图卡点。

  * **规则 30（纸品类目专属复合结构与五元组规范 — Paper Dimensions Structure Contract）**：
    - 纸品抽纸/卷纸强制校验必填属性【纸张尺寸】（`id: 1200256887, valueType: 10`），录入纯文本会被底层拦截；
    - **标准解决方案**：
      必须在 options 中构造标准五元组单元复合结构：
      `valueList: [[{ sequence: 1, type: 4, value: '180' }, { sequence: 2, unitCode: 700, type: 5, value: 'mm' }, { sequence: 3, type: 3, value: '*' }, { sequence: 4, type: 4, value: '117' }, { sequence: 5, unitCode: 700, type: 5, value: 'mm' }]]`，显式声明 `isCustomized: true, selected: true`。

  * **规则 31（酒水类目复合酒精与浓度双指标规范 — Alcoholic Strength & Wort Concentration Contract）**：
    - 啤酒/白酒类目强校验必填属性：
      1. **【酒精度】**（`valueType: 10`）：单位必须为 `%vol`（`unitCode: 500`），数值文本填入 `≥4.3`，复合单元：`valueList: [[{ type: 1, value: '≥4.3' }, { unitCode: 500, type: 5, value: '%vol' }]]`；
      2. **【麦汁浓度】**（`valueType: 10`）：单位必须为 `°P`（`unitCode: 501`），数值填入 `9.5` 或 `10`（严禁使用非标 unitCode，否则触发“单位°P与填写的unitCode不匹配”）；
      3. **【保质期】**（`render.type: 6 / valueType: 9`）：必须序列化为 JSON 字符串 `JSON.stringify({ unitCode: 100, unitName: '天', value: '360' })`，且 `valueExtend: null, isCustomized: true`。

  * **规则 32（线缆与小家电复合长度与接口数规范 — Cable Length & Interface Quantity Contract）**：
    - 排插、数据线、充电线强校验必填属性：
      1. **【全长（m）】/【长度（m）】/【电源线长（m）】**（`valueType: 10`）：单位必须为 `m`（`unitCode: 702`），数值严格限制在 `0-5` 规范区间（如 `1.2` 或 `1.8`），超出 5m 平台网关阻断；
      2. **【接口数量】**（Type-C/USB）：必填项统一注入 `type: 4, value: '1'`。

  * **规则 33（食品单包净含量与重量单位换算防冲契约 — Food Net Content & Unit Normalization）**：
    - 膨化食品、方便面强校验必填属性【单包净含量】（`valueType: 10, unitCode: 202, unitName: "g"`）；
    - 当商品标题包含 `1L`、`1kg` 等容积或千克单位时，必须由自动化引擎统一折算标准化（`1L ➔ 1000ml / 毫升(ml)`、`1kg ➔ 1000g / 克(g)`），彻底规避“未填写重量单位”或“重量不在合理范围”阻断。

  * **规则 34（平台敏感拼音与历史品牌拦截词清洗规则 — Sensitive Pinyin & Brand Blacklist Scrubbing）**：
    - 美团后端风控敏感词库对特定拼音与超范围词根执行硬拦截（如 `TIANSTON`/`TIAN`/`tian` 命中敏感词；`名门私厨` 命中 `名门`；`东鹏特饮` 命中超范围饮品词），提交直接报 99999999；
    - 前置治理流水线必须建立词根替换表，将 `TIANSTON` 清洗为合规品牌 `天顺通` 或 `通用`，`东鹏特饮` 规范化为 `东鹏`，`名门私厨` 规范为 `私厨`，并追加 SPU 末 3 位数字后缀彻底消除“已存在同名商品请勿重复创建”冲突。

  * **规则 35（赠品与礼品包装属性全量默认否定契约 — Gift & Giveaway Strict Non-Inclusion Rule）**：
    - **最高铁律：绝不向消费者承诺任何额外东西，美团平台与牵牛花全渠道一并严格执行！**
    - **业务背景与客诉防范**：在美团闪购、牵牛花及各大外卖渠道商家后台，很多类目（如酒水、休闲食品、数码配件、日用品）包含“提供礼赠包装”、“是否赠送吸管”、“是否附赠开瓶器”、“是否附赠餐具”、“赠品”等属性选项。美团 App 及各渠道前端会将商家勾选的属性直接作为卖点向消费者公开透传展示。若自动化引擎盲目选择“赠礼袋”、“礼盒包装”或“赠送”，消费者下单后发现实物包裹未配赠，将直接引发差评、索赔与线上线下严重客诉纠纷；
    - **双平台统一治理规范**：
      1. **【提供礼品包装/礼赠包装】特别铁律**：若选项池中仅有“赠礼袋”、“礼盒包装”等产生额外预期的选项，**严禁选择！一律强制不选并保持留白（customValue: [] / 不勾选）**；只有当存在“普通包装”、“环保包装”、“无”等明确否定选项时，方可选择“普通包装”；
      2. **【赠品/赠餐具/是否赠送xx】绝对禁止勾选肯定项**：凡属性名称包含 `赠`、`附赠`、`送`（如 `是否赠送吸管`、`是否附赠开瓶器`、`赠品`、`礼袋配赠`）的字段，一律严禁勾选“是”、“赠送”、“有赠品”等肯定项；
      3. **强制选定明确否定项**：必须在选项池中强制寻找并选定 `否`、`不赠送`、`不赠`、`无`、`无赠品`、`无礼袋`、`无餐具`、`不送` 等明确否定项；若全部选项均为赠送含义且非必填，坚决保持留空白（不选）；
      4. **标题前置净化**：在商品标题前置清洗时，同步彻底剔除原标题中包含的“送xx”、“赠xx”、“带礼袋”、“礼品装”等未经核实的营销噱头用语，坚决保护商家真实履约安全，做到 100% 零业务冲突。

  * **规则 36（连包整箱多联装总重量乘积计算契约 — Multipack Total Weight Multiplier Contract）**：
    - **机审乘积一致性核验**：在快消饮料、啤酒、休闲零食等品类中，商品常以多连包、整排、整箱形态销售（例如 `250ml*12包/箱`、`500ml/听*3`、`212ml*4瓶/排`、`190ml*12盒/箱`）。美团 Odin 机审算法对整箱连包商品执行严格的标题乘积总重文本匹配；
    - **报错根因**：若流水线仅按通用单件正则提取首个数值（例如将 `250ml*12包` 误填为单包的 250ml），机审会判定其与整箱实际物理重量不符，直接秒退驳回：`重量: 与商品名称描述不一致`；
    - **标准解决方案**：
      1. 必须使用复合乘积正则识别整箱连包模式：`/(\d+(?:\.\d+)?)\s*(g|kg|ml|l|L|克|千克|毫升|升)[^\d]*[\*xX×]\s*(\d+)/i`；
      2. 计算整包装总重量：`totalWeight = singleVal * multiplier`（例如 `250ml × 12 = 3000ml`，`500ml × 3 = 1500ml`，`212ml × 4 = 848ml`）；
      3. 将计算后的总包装物理重量严格写入 `sku.weight = { value: totalWeight, unit, ignoreMax: false }`，与标题中声称的总规格达成 100% 绝对一致，消除多联装重量机审驳回。

  * **规则 37（一品一图零成本本地参数化合规标签绘制引擎 — Zero-Cost Local Parametric Label Generation Engine）**：
    - **业务痛点与双重挑战**：在大批量预包装食品（零食、烘焙、糖果、坚果、饮料）治理时，若全量调用外部商业大模型生图 API，单店 2,000+ 张生图成本高达数百元且需排队耗时数小时；但若简单复用同一张母图，会导致“薄脆饼干”、“菠萝干”、“黄桃干”等不同品类食品共用完全相同的配料表，引发线下消费者客诉、差评与人工质检抽检质疑；
    - **标准双轨制解决方案**：
      1. **冲刺解封期（快速清零）**：优先使用美团官方 CDN 备案确权的标准双要素模板母图（含加粗【配料表】与 5 项 NRV 表格），秒级并发提审，以零 API 成本使全店数千个商品瞬间脱离阻断状态；
      2. **精细化留存期（一品一图定制）**：启动本地参数化绘图引擎，正则提取商品标题中的【品牌】与【核心品名】，动态匹配贴合的真实原料成分（例如“菠萝干”匹配“菠萝、白砂糖、食用盐、柠檬酸”；“黄桃干”匹配“黄桃、白砂糖、柠檬酸”），在 1:1 白底画布上绘制加粗 `【[品名] 配料表】` 与包含 5 项参考值的 `【营养成分表】` 标准方格矩阵；
      3. **存证闭环**：生成的专属标签图自动以 `[商品名称]_配料&营养成分表.jpg` 本地结构化归档留存，并秒传美团官方 CDN 覆盖更新；
      4. **终极成效**：实现 **“100% 零外部商业 API 成本 + 100% 一品一图独立真实对应 + 100% 杜绝线下履约冲突”** 的最佳工程平衡。

  * **规则 38（`package_detail` 视图模型 `normalAttributesValueMap` 编辑与标准四段编译契约 — View-Model Compilation Contract）**：
    - **致命误区修正**：`ie.vP({ spuId, poiId }, { noDefaultWeightUnit: true })` 返回的 `d.productInfo`（记为 `e`）已经由 `Z.a.from`（`req(13085)`）解析为前端视图模型，所有类目属性存储在 **`e.normalAttributesValueMap`**（以及 `e.normalAttributes`、`e.sellAttributes`、`e.sellAttributesValueMap`），**此时 `e.categoryAttrValueMap` 为空或未挂载**！若脚本直接读写 `e.categoryAttrValueMap` 而不编译 `normalAttributesValueMap`，会导致修改无效或提交丢属性；
    - **标准四段编译与中间态剥离流水线**：
      1. 在 `e.normalAttributesValueMap[attrId]` 上修改类目属性（设置 `selected: true` 或构造 `customized_attr_value_*`）；
      2. 调用 `await req(38186).g0(e)` 执行前端 Walle 实时质检，确保返回的 validator 数组为空；
      3. 依次调用官方编译器：
         - `const C = req(13085)._f(e.normalAttributes, e.sellAttributes, e.normalAttributesValueMap, e.sellAttributesValueMap);`
         - `const w = req(13085).eN({ unconditionalReturn: { unconditionalReturn: e.unconditionalReturn, selectedId: e.unconditionalReturnId } });`
         - `const L = req(38140).z(e.skuList, e.skuAttributesValueMap);`
         - `const R = req(88468).Hq(e.cpvGuidePicMap, e.cpvGuidePicConfigList);`
      4. 剥离视图中间态字段 `Et = ['normalAttributes','normalAttributesValueMap','sellAttributes','sellAttributesValueMap','unconditionalReturnId','unconditionalReturn','skuList','skuAttributesValueMap','cpvGuidePicMap','cpvGuidePicConfigList']`，合入 `{ categoryAttrList: C.categoryAttrList, categoryAttrValueMap: C.categoryAttrValueMap, bindAttrMap: w, skuList: L, cpvGuidePicList: JSON.stringify(Object.values(R || {})), sellAttributes: e.sellAttributes }` 生成正式载荷 `q`，再传入 `ie.sI`、`ie.L0` 与 `ie.$W`。

  * **规则 39（审核执行页 `&oldVersion=true` 路由锁定与随机 Chunk ID 规范 — Audit Route & Webpack Chunk Safety）**：
    - **路由重定向防坑**：现网打开 `/reuse/sc/product/page/detail/audit?spuId=XXX&wmPoiId=YYY` 若不带 `&oldVersion=true`，会被美团前端自动重定向至新版 `/reuse/sc/product/views/product/detail-v2/editNew`，导致 `window.webpackChunkpackage_detail` 不存在。**必须强制追加 `&oldVersion=true`**；
    - **Webpack Chunk ID 防碰撞**：每次调用 `window.webpackChunkpackage_detail.push([[Math.floor(Math.random() * 1e9)], {}, r => { req = r; }])` 必须使用随机大整数，严禁在同一标签页重复 push 相同固定数字（如 `999999`），否则 Webpack 5 会静默忽略回调使 `req` 为 `undefined`。

  * **规则 40（无法售卖 `effectType=5` 与影响流量 `effectType=2` 双队列治理、非必填点名属性靶向修复与“其他”选项纠偏）**：
    - **非必填（`required: false`）驳回项盲区**：在“影响流量（`effectType=2`）”队列中，大量商品因 `类目属性“商品类别/功效/防晒指数/外皮材质/包装规格”填写错误或未填写` 被驳回，但其中许多属性在类目模板中的 `required` 为 `false`。**严禁只填 `vm.required === true` 的属性**！必须从 `optimizedInfoList[].optimizedFieldList[].comment` 及 `d.auditRejectInfo.rejectReason` 中提取所有被点名的属性名称，强制纳入必改集合；
    - **“其他”兜底项纠偏**：当被点名属性（如 `商品类别 1200000210`）当前已选为“其他”，而审核仍报 `填写错误或未填写` 时（如“相思卷小豆条”、“手撕素肉”、“老管家 爆炸盐”），必须依据商品标题关键词在 `options` 中精确匹配具体细分选项（如 `豆条`、`素肉`、`爆炸盐`、`点心面`、`空顶帽`）替换“其他”；
    - **多维结构化属性（`valueType: 10`）动态 `valueFormat` 解析**：严禁硬编码 `unitCode: 606`。必须动态遍历 `vm.valueFormat`，自动识别单数值（`[type:4, type:5]`，如容量 `350mL`、支数 `12支`、数量 `10个`）与二维尺寸（`[type:4, type:3('*'), type:4, type:5]`，如桌布/垃圾袋尺寸 `180*180cm`），从 `type: 5` 的 `inputTypeSelect` 中精确选取合法 `{ unitCode, unitName }`；
    - **图文规格冲突净化与异步消退窗口**：针对 `图文不一致: 商品图片与商品名称规格不符`（副图或 `cpvGuidePicMap` 混入整箱/多联包图），保留首张正确主图 `e.pictureList = [e.pictureList[0]]` 并清理非必填冲突附图。保存提交后，`effectType=5`（无法售卖）秒级清零，`effectType=2`（影响流量）经后台异步质检索引队列在 15~60 秒内逐步消退归零，验收时以 10~15 秒间隔轮询 `fetchList`（同时核验 `needAudit: true` 与 `needAudit: false`）直至双队列稳态为 `0`。


  * **规则 41（非食品电器类功能性小家电全量治理范式 — Functional Small Appliance Universal Governance Template）**：
    - 针对**超声波驱蚊器/灭蚊灯/电蚊拍/驱鼠器/电热蚊香液加热器/空气净化器/除螨仪/干衣机/酸奶机/加湿器/除湿机/暖手宝/USB小风扇/迷你按摩器/紫光诱蚊灯**等「非食品非化妆品插电/充电型功能性小家电」，统一执行以下标准化治理范式：
      1. **【类目定性】**：属于**家居电器/生活电器/驱虫用品/个护小家电**大类，**非食品**（无需配料营养成分图 Type 5）、**非化妆品**（无需背签图 Type 8）、**非医疗器械**（无需注册证 Type 10）；
      2. **【3C 认证强制要求】**：所有插电型家用电器（含USB供电≥5V）均属于CCC强制认证目录中「家用和类似用途设备」类，必须在 `normalAttributesValueMap` 中按类目注入权威 3C 证书编号（`1200189637`）与对应生产者名称（`1200256841`）（参见规则 10 分品类映射表），并在 `cpvGuidePicMap` 挂载三码合一的 Type 4（3C 认证证书图）；
      3. **【电气参数全量填齐】**：依据商品工作原理推导注入：额定功率(W)（超声波类 `5~15W`、电热类 `800~2000W`、USB风扇 `3~8W`、电蚊拍 `5W`、灭蚊灯 `5~10W`、加湿器 `20~30W`）、额定电压(V)（插墙型 `220`、USB型 `5`、车载型 `12`）、供电方式（`插电供电/USB供电/充电式/电池供电`，与标题强对齐）、电源线长(m)（插电型 `1.2m`、USB型 `0.5m`，valueType:10, unitCode:702）、能效等级（小功率电器选 `无/无能效等级`）；
      4. **【品牌推导与标题对齐】**：标题首词若为已备案品牌直接绑定；无备案则品牌设为“通用”(valueId:2436552)并同步修改标题前缀；“智能/多功能/万能”等易触发「过度描述」驳回词降级为“家用/实用/便携”；
      5. **【资质图三件套】**：挂载 Type 4（3C 证书）、Type 3（包装标签图：含生产企业/生产地址/型号）、Type 13（尺寸图：含长宽高指示线与厘米数值）。

### 12.1 高吞吐并发架构与纯内存执行规范

在面对数百乃至上千个无法售卖（`effectType=5`）与影响流量（`effectType=2`）商品治理场景下，**绝对禁止每个商品重新打开/跳转标签页（`tab.goto`）或使用前端页面点击**：

- **常驻 Worker 纯内存执行架构**：
  1. **队列扫描**：在商品管家主页 `#hashframe`（`fw.webpackChunkmrn_product_pc`）中调用 `req(69282).fetchList` 一次性分页拉取 `effectType=5` 与 `effectType=2` 全量 SPU 清单。
  2. **常驻审核页预热**：打开 `/reuse/sc/product/page/detail/audit?spuId=${sampleSpuId}&wmPoiId=${wmPoiId}&from=single&oldVersion=true` 保持 `window.webpackChunkpackage_detail` 运行时。
  3. **美团 CDN 高速上传**：直接调用 `req(36515).jt(base64DataUrl, fileName, String(wmPoiId), false)`（兼容回退 `req(27177).lU`）将本地 Canvas 合成的合规 3C 证书图（`imgType: 4`）、配料营养表（`imgType: 5`）或卫品背签图（`imgType: 8`）秒传美团 CDN。
  4. **纯内存评估与提审闭环**：
     - 调用 `ie.vP({ spuId, poiId }, { noDefaultWeightUnit: true })` 获取详情（若需类目迁移则调用 `ie.A_({ categoryId, poiId })` 重建属性模板）；
     - 内存中完成违禁词清洗、类目品牌库检索（`attrValueSug`）、必填及点名非必填属性注入、动态 `valueType: 10` 结构化组装、按需 69 条码修复及 CPV 挂载；
     - 调用 `walle.g0(e)` 确认前端实时校验零告警；
     - 经 `Z._f`、`Z.eN`、`he.z`、`G.Hq` 编译载荷 `q`，依次执行 `ie.sI`（若遇软性建议类目则设 `ignoreSuggestCategory: true` 重试）、`ie.L0`、`ie.$W`（`needAudit: true, checkActivitySkuModify: true`），并调用 `ie.vP` 回读验证。
     - **单 SPU 纯内存处理耗时 < 800ms，整体吞吐量稳定达到 100-200 SPU/分钟**。



