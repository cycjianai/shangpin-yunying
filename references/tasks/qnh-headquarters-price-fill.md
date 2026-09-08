# 任务分支：牵牛花总部零售价按货盘补齐

`platform_adapter=qnh`，`task_mode=headquarters_price_fill`，`capability_status=runtime_guided`。
本分支补齐用户圈定商品的**空总部建议零售价**。它不修改已有主档价格，不同步门店，不调整活动或消费者有效价。
用户要求覆盖非空价格、分渠道/区域定价、同步门店或其他字段时，需要对应明确范围；本离线规划器不支持，不能强行复用。

规划和验证脚本已经提供；浏览器获取原生证据、资源准入、上传与确认由当前环境指导执行，并不是任意会话可直接运行的通用 writer。
先读 [批量选择与读取](../qnh-bulk-operations.md)。不要调用仅支持旧属性模式的 `qnh_task_contract.py`/`run_task_action.py`
冒充本分支合同；本分支用下列 manifest、plan、批次意图和统一业务终态留证。

## 1. 冻结身份、范围和价格语义

用户授权当前账号商品写入后，冻结 tenant、标签/搜索筛选、SPU/SKU 全集合、来源货盘版本和本次只修改主档的影响范围。
先全量读取基线，报告空价 SPU 数和空价 SKU 数。任一规格空价即计一个空价 SPU；多规格必须逐 SKU 统计。

当前列表总部价格字段是：

```text
skus[].suggestPrice.tenantSuggestPrice.unifiedSuggestPrice
```

`suggestPrice=null` 或上述已知结构明确无值为“空”；`basicPrice="0.0"` 与 `baseSalePrice=null` 不是本任务的空价依据。
0 是已有值，不当空值覆盖；已有区域/渠道价格或未知结构先分类，不能清掉后改统一价。当前页面显示 `-` 与列表字段先互证。
只有对应结构已验证、且所有必须字段存在时才使用列表读回。不能把属性质量、审核失败或渠道不可售当作价格未保存。

## 2. 一次提取来源，逐规格唯一匹配

输入是同一授权货盘的完整商品/SKU 价格快照。只取用户指定的价格字段，不取折扣价、平均价或 SPU 最低价。
匹配优先级：名称+规格+条码共同一致；名称+规格唯一；条码+规格唯一。真实条码与名称候选指向不同商品时阻塞。
名称回退仅用于缺条码或已证实由复制生成的条码（例如目标条码等于目标 SKU）；不得掩盖真实条码冲突。
不同规格分别匹配；名称或条码相同但容量、包装数、颜色、尺码不同不得串价；多个候选即使同价也保留人工复核。

金额必须有限、精确到分且在当前官方模板范围内。此批模板统一总部价范围 `0.01–99999`；不要四舍五入三位小数、补 0 或猜价。
有阻塞项时继续无歧义的范围，但最终报告剩余和原因；不能改分母或把部分完成说成全部完成。

## 3. 当前实践的官方请求链

| 顺序 | 页面/请求 | 判定 |
|---|---|---|
| 筛选与基线 | `/unifiedGoods/tenant/spu-list` → `POST /qnh-gw3/api/product/tenant/page-query` | 原生 HTTP 2xx/code 0；当前签名版本、tenant、完整筛选 |
| 打开专用入口 | 批量管理 → 批量修改总部零售价；route `/unifiedGoods/batch/edit-goods-suggest-price` | 现场存在该入口，不进入逐 SPU 编辑页 |
| 下载模板 | 页面“下载”按钮 | 当前模板列名、最多行数、金额范围及说明；不复用旧账号的下载 URL |
| 上传 | 页面文件控件 → `POST /api/v1/file/uploadV2` | 上传成功只代表文件可用，未修改商品 |
| 提交 | “确认导入” → “确定导入？”中的“确认” → `POST /api/shepherd/product-management/submitSuggestPriceTask` | 当前官方表单发送；两个按钮属于同一次业务提交 |
| 请求范围 | `taskTypeName=XSUPPLY_UPDATE_TENANT_SKU_SUGGEST_PRICE_BY_EXCEL`，`selectCoverageStoreType=0` | “仅修改主档”；1/2 都会扩大到门店，禁止默认选择 |
| 验收 | 重新查询全部原筛选商品，逐 SKU 读取总部价并比对来源 | 全分页、ID 集合、目标值、原有价格和保护字段一致 |

`actCheckType=1` 是本次原生表单观察值，不是可跨会话硬编码的权限参数。上传地址/回执只在本地当前 run 内保留最小必要信息。
导入页由官方代码处理请求签名、文件绑定与业务校验，不把列表签名拿去直接发送该批量 mutation，更不能仿造成逐 SPU update。

模板首行目前为 `*SKU编码`、`*总部零售价（元）`、`渠道编码`。说明/示例行必须删除；SKU/条码写文本，价格写两位十进制文本。
`渠道编码` 留空按当前模板表示所有渠道共用建议价，**不等于同步门店**；只有用户范围是统一总部价且原值为空才适用。
模板写入文件是平台输入，不受七表输出格式约束；用户需要标准运营报告时使用七表 Schema。只要求前后数量时直接按完整回读汇报。

## 4. 批次、预检与未知结果

1. 先选一个单规格和一个不同价格的多规格商品做小批量（候选没有这种形状时记录实际覆盖）。
   最终独立回读正确、原有价格与保护字段不变后再扩大。
2. 依当前模板上限分批，本次为最多 5,000 行；一个 SPU 的规格尽量放在同一批，禁止靠多线程重复提交。
3. 上传前/确认前重新读取该批目标旧值并核对 tenant/filter/SKU 绑定。目标价格被外部改动时重新规划该项；不能按旧基线覆盖。
4. 真正可能提交前原子落盘批次意图：run、tenant、筛选摘要、源版本/计划摘要、SKU 集合、文件 SHA256、only_master、时间。
   “确认导入”只打开复核弹窗；最终确认前保留意图。任何异常都不能删掉 marker 重试。
5. 同一业务批次发现旧意图（已发送/受理/未知），一律先 query 原任务和目标价格；不重新上传/确认。
   文件变更、新文件名、浏览器重连或新 run 不能解除原 SKU 未知写入屏障。运行账本是本地恢复镜像，跨进程/账号的并发权仍需项目持久租约。
6. 平台 code 0 只记 accepted；查询原导入任务进度和失败报告，并在有界物化窗口读回。明确未执行失败才可重建精确残余批次，
   其余保持 `pending_verify`，不能因仍空就断定导入没执行。
7. 每波按其冻结范围完成回读/残余核对后再进入下一波。平台任务列表有时跳到旧任务类型或筛选缓存，先核对实际任务类型和时间；
   “列表为空”不能证明提交不存在。也不能把旧的任务“完成”当作当前批次证据。

## 5. 可复用离线工具（不连接平台，不提交文件）

`scripts/platforms/qnh/headquarters_price_fill/prepare.py`：校验快照完整性、建名称/条码索引、生成可审计计划、canary 与分批模板；
最终核对逐 SKU 目标价、保护字段、身份集合和开始/结束空值数，并生成统一字段事件。

```bash
python3 scripts/platforms/qnh/headquarters_price_fill/prepare.py plan \
  --baseline baseline.json --source source.json --output-dir runs/price-fill --batch-size 5000
python3 scripts/platforms/qnh/headquarters_price_fill/prepare.py claim \
  --plan runs/price-fill/plan.json --batch batch-1 --preflight preflight.json
# 由当前受控浏览器完成已授权官方提交；该工具没有 submit 命令。
python3 scripts/platforms/qnh/headquarters_price_fill/prepare.py verify \
  --plan runs/price-fill/plan.json --final final.json --output runs/price-fill/verification.json
```

`plan` 的输出目录必须新建；`claim` 使用排他创建，重复调用必拒绝；输出文件不允许覆盖已冻结批次。该本地 marker 只防同一 run 重入，
不能代替项目共享租约或跨 run 未知结果索引。`verify` 不用保存响应做价格判断；不完整分页、过滤器漂移、SKU 缺失/重复、
已有价变化与目标不符都阻止成功。支持部分完成报告，非零退出时保留所有已验证结果与残余，不能重做成功项。

批次预检只需新鲜读取本批全部目标 SKU 及对应完整 SPU，不必每批重扫整个标签；同筛选的局部观察应标 `complete=false`，
保留原生总数，工具检查无池外对象且本批 SKU 一个不少。基线和最终验收仍必须 `complete=true` 全量复扫。

输入格式及字段投影见脚本模块文档。数据适配只改键名和明确价格表示，不能为过校验伪造 `complete`、计数或来源权限。
总部统一价缺失但区域/渠道已有价的商品保留 `blocked`，不会用模板清空其他定价结构。

## 6. 交付

最终对用户首先报告：开始空价 SPU/SKU、完成后剩余 SPU/SKU、已填规格、未解决原因。非目标已有价不覆盖。
字段事件用 `sku.<sku_id>.headquarters_retail_price`，`来源策略=source_store_verified_archive`，金额 `CNY 12.34`。
规划器的 `audit_events` 可接共享七表 exporter；最终表格还必须包含真实资源、请求/墙钟和当前 run 的 handoff 证据，不能补造。
源价不唯一、未知写结果、页码遗漏或非目标变更的商品不得计 `verified_complete`。只给开始/结束数量的用户无需被迫阅读长报告。
