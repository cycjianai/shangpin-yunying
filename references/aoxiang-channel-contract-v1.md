# 翱象渠道属性合同 v1

## 1. 适用范围

本合同只适用于当前已登录翱象平台（`saas-retail.ele.me`）的渠道属性批量填充。目标渠道固定为：

- `MT`：美团；
- `ELE`：淘宝闪购/饿了么。

允许读取商品诊断与商品主档，允许填写两渠道的必填属性并保存。通常禁止修改商品类目、价格、库存、图片、上下架、
活动退出状态、门店关系及用户未点名的其他主档字段。类目只有两种逐商品例外：一是属性接口明确返回“分类不存在”，
当前类目树存在名称和完整父路径一致的精确换代叶子 ID；二是标题与当前类目明确冲突，且错误类目直接产生与商品无关的
监管属性，当前渠道树存在语义唯一的正确叶子类目。两者统一记录为 `exact_obsolete_category_repair`，必须先保存旧/新 ID
与路径，保存后独立回读，并在字段级审计中显式披露。
禁止输出 Cookie、Authorization、签名或完整请求头。

## 2. 身份与清单冻结

复用用户当前 Chrome 登录态，冻结并留证：门店名称、`storeCode`、`planId`、诊断 `channelCode`、诊断 `type`、
初始待处理总数及唯一 SKU 集合。当前实测接口：

- `POST /goods/check/v3/pageGoodsIssue`：诊断分页；`pageSize` 最大 100，总数位于响应顶层 `total`；
- `GET /goods/master/detail?skuCode=...`：商品主档详情；
- `POST /goods/master/matchChannelCategoryPropertyV3`：当前类目属性定义与平台匹配值；
- `POST /goods/master/update`：平台原生商品保存；
- `GET /goods/check/v3/channelIssueCount`：渠道问题计数交叉核验。
- `POST /goods/check/reCheck2`：批量保存后的平台原生异步重检，请求体为当前 `storeCode`；
- `GET /goods/check/getReCheckTime`：重检状态轮询。

接口主机固定为 `https://tc-supply-chain-portal.ele.me`。只允许在绑定的登录页隔离执行上下文内使用
`credentials: include`，不得读取或搬运浏览器存储凭证。

## 3. 值来源与安全顺序

先冻结策略：

- `deterministic_fill`：首次补空与合法平台推荐；模型、OCR、Web 均为 0。
- `evidence_semantic_correction`：用户指出现值不合理、平台校验提示未识别，或确定性补齐后的稳定诊断仍有语义残差时使用。
  允许同商品媒体 OCR 与模型候选判断，不允许 Web 猜商品事实；目标仍只限 MT/ELE 渠道属性。

每个必填字段按以下顺序物化：

确定性补齐按以下顺序物化：

1. 当前渠道已有且与商品语义、目标定义都一致的值；
2. `matchChannelCategoryPropertyV3` 返回、且与同品标题/规格/OCR/已验证跨渠道事实交叉一致的合法 `matchValue`；推荐值先
   只读审计，出现包装形态冲突、单件/总量倒置、重量/容量单位冲突或容量误入浓度时必须拒绝；
3. 同一商品另一目标渠道的等价事实，按目标 `SELECT/INPUT/INPUT_OPTION/MULTI_INPUT_OPTION` 结构转换；
4. 标题、别名、规格、条码与现有主档中的明确事实；
5. 仅非监管字段的安全默认或当前候选中的“其他/通用/否/普通”等中性选项。

纠错模式不得把 current 或 `matchValue` 当真值。按“用户明确纠正/平台范围提示 → 标题与规格逐字事实 → 同商品详情图
OCR → 已验证的另一目标渠道同一事实 → 当前平台精确候选中的语义判断”重算问题字段。模型只能返回本次请求给出的
`field_key` 和逐字候选；事实型输入必须在标题、规格、详情或同商品 OCR 中有明确证据。

选项型值必须使用当前定义的候选 ID；输入+单位型必须同时写数值与当前候选单位。跨渠道转换允许把
“500w”转为 `500 + W`、把“11㎡(含)-20㎡(含)”转为该事实范围内的 `11 + ㎡`。不得把源渠道候选 ID 直接复制到
目标渠道。

`supportExtend=1` 的下拉由翱象前端按自由文本处理；当候选为空且商品规格存在明确原文时，提交
`propertyValueId="" + propertyValueName=<规格原文> + propertyValueType=null`，来源记为 `title_or_spec_fact`。
检测报告、吊牌或同商品详情图中的逐字事实可通过逐 SKU `evidenceOverrides` 映射到当前合法候选，来源固定为
`same_product_media_evidence` 并保存证据说明。覆盖不得跨 SKU 复用。

纠错链固定拆成四层，禁止合并成一次不透明模型写入：

1. `aoxiang_context_collector.js` 冻结 SKU、标题、问题字段、MT/ELE 当前值、匹配值、候选、值类型、范围与单位结构；
2. `aoxiang_deepseek_semantic_planner.mjs` 以小批次并发规划，逐 call checkpoint，强制精确候选、本地范围和同品证据校验；
3. `aoxiang_audit_semantic_overrides.mjs` 合并规划与逐 SKU OCR 覆盖，拦截空值、候选错配、越界、低证据和单位家族错误；
4. `aoxiang_channel_engine.js` 以 `evidenceOverridesOnly + allowPartialEvidence` 只写批准字段，保存后按变化字段独立回读。

酒精度、麦汁浓度、净含量、容量、重量、功率、电压、尺寸、证号与保质期等事实字段的模型置信度至少 0.8，且必须有
同商品明确证据；普通候选语义字段同样至少 0.8。证据理由包含“通常/常识/推断/推测/默认/疑似/OCR 误差”时，即使分数
达到阈值也必须阻断。`500ml` 只证明容量；不得生成 `500°P`、`500%vol` 或 `500g`。平台 `matchValue` 只有通过同品
证据复核后才可转为 `platform_match_validated`，不能因来源是平台就绕过审计。真实证据超出平台 schema 时不得 clamp、替换或
清空当前值，只记录 `platform_schema_blocker`。

监管编号、证照、型号、功率、电压、酒精度、生产厂家等不得生成虚构事实。若精确事实缺失，可在平台允许纯文本且
用户要求完成全部属性时使用“详见商品包装/详见产品铭牌”这种中性回指，并以
`safe_packaging_reference` 单独审计；数值+单位字段不允许使用文本回指，仍须阻断直到取得同品事实。

## 4. 保存与回读

固定 writer 为 `scripts/aoxiang_channel_engine.js`。保存 payload 由当前详情完整归一化，保留 SKU、图片、类目、
自定义字段与售后规则，只替换 `channelGeneralCategoryProperty.MT/ELE`，并强制
`updateOnExitActivityFlag=0`。保存请求不自动重试。

每个商品保存后重新 GET 详情；所有新增必填字段必须满足：非空、值类型合法、候选 ID 合法、复合字段子项齐全、
最终值与计划值逐项一致。只有 `verified` 或 `verified_no_change` 可进入完成 checkpoint。

## 5. 渐进并发与断点续跑

先通过 1 条 UI canary、1 条直接接口 canary、50 条只读扫描和 10 条多品类实写。全量从并发 1 起步，连续健康波次按
`1→2→4→6` 提升；出现 429、请求失败或异常长尾时降档。只读请求可重试，mutation 固定一次并靠独立回读判定。

每轮 `AoxiangChannelEngine.exportTask(taskId)` 输出
`aoxiang-channel-fill-checkpoint-v1`。恢复时只跳过 `verified/verified_no_change`，blocked 与 failed 必须基于新的详情
重新规划；不得重复保存已验证商品。最终 checkpoint 的 `items` 必须与冻结 `rows` 一一对应。

诊断分页是异步快照。保存后必须先调用 `reCheck2`，并轮询重检时间与顶层 `total`；重检期间下降中的旧残量只能视为缓存，
不得据此重复 mutation。只有最新重检稳定后才生成下一轮残差。

当前实测 `getReCheckTime` 可在重检实际完成前返回 0，诊断总数也会短暂出现 0 或中间值。稳定残差必须满足：调用
`reCheck2` 后等待并全量分页，至少 60 秒窗口内连续 3 次得到相同非瞬时 `total` 和 SKU 集合。出现 0、总数变化或集合变化
立即重新计时。任何瞬时 0 都不得用于完成声明。

## 6. 最终验收

完成声明同时满足：

- 冻结 SKU 全集合均为 `verified/verified_no_change`；
- 保存后详情全字段复核问题数为 0；
- 诊断列表全量分页中 `problemType=4`（缺失渠道属性）为 0；
- 未把无图文、图片、价格等非属性问题计入本任务，也未越权修复；
- 统一运营工作簿由最终 checkpoint 生成并通过
  `validate_multiplatform_channel_workbook.mjs`；
- Excel 工作表顺序固定为：执行汇总、SPU清单、字段级审计、平台不存在、最终结构复核、问题与策略回灌、
  性能与外部调用统计；
- `deterministic_fill` 的 OCR、Web、模型与 provider 调用为 0；`evidence_semantic_correction` 只允许同商品 OCR 与已配置
  语义模型，并在工作簿中记录调用数、模型名、置信度和未解决字段。Web 与 provider 仍为 0。
