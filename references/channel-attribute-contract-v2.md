# 渠道类目属性 100% 结构合同 v2

## 适用范围

当用户提供 SPU 清单并要求把渠道类目属性全部填满时，冻结为 `channel_attributes_only`。目标是平台现存商品的每个
目标渠道属性满足当前字段类型、候选与复合结构合同，并在保存后重新读取验证；不是页面显示非空、请求成功或本轮修改项
通过。

除用户另开新 run 扩大范围外，审核原因矩阵、OCR、图片/条码扫描、博查、Web、LLM、生图、provider 和图片上传预算
全部为 0。所有动作通过固定启动器并受任务开始时的脚本 SHA-256 约束。

## 字段有效性

- 类型 1/2/5：必须非空；当前类目有候选时，值 ID 与标签都必须属于当前候选集合。
- 类型 5 产地：候选非空时只写精确候选；候选为空且当前接口明确采用地域树合同时，才可写已验证国家节点，并审计来源。
- 类型 8 日期：使用 `YYYY-MM-DD`，回读 `attrValueId=0`。
- 类型 9 时长：数字和当前单位选项必须同时存在；平台归一化 ID 为 null 时仍以完整“数字+单位”判定。
- 类型 10 结构值：外层自由文本为空，值进入 `structAttrValueList.valueList`；每行覆盖模板 sequence，保留允许的多行。
- 其他自由文本：非空并遵守最大长度。品牌、类目与店内分类仍使用各自真实 ID 合同。
- 页面可见的旧字符串若不满足底层结构，仍是未完成，必须重新物化。
- **失效候选清理（幽灵属性）**：平台类目更新后，旧版属性值 ID 可能已不在当前类目有效候选库（`attrValueList` / `optionalValue`）中，导致前台显示“请选择”但后台有历史字符串。二次清洗必须强制校验已有值是否在当前候选库内，不合法必须重新物化。

## 用户授权的安全默认与兜底规则（User Rulebook）

未在标题、规格、类目中明确标注的属性，严格按以下层级和规则补全（实装于 `scripts/platforms/qnh/required_property_rules.mjs`）：
1. **包容性与安全性优先**：优先选包含更多情况且不会出错的选项；可模糊时优先选择“其他”。
2. **长度/尺寸/数值**：未明确标注时，默认填写 **`0米`**（数值填写 `0`）。
3. **形状/适用场景**：未明确标注时，优先选择 **`通用`**。
4. **品牌**：未明确标注时，优先选择 **`其他`**（若候选无“其他”则兜底选择“无品牌”）。

## 计划与并发锁

1. 读取完整详情和当前类目模板后再判断有效性，不能只查空字符串；必须校验已有值是否属于当前合法候选。
2. 取值顺序：当前合法推荐 → 同 SPU 跨渠道等价事实 → 标题/SKU 明确事实 → 用户授权的安全非监管默认。
3. 推荐必须同时通过字段 ID、选项 ID、标签和商品事实冲突门；监管事实与证号不能用默认值。
4. expected-old 保存接口原文，包括尾空格；规范化只用于展示/比较，不能替代并发锁原值。
5. 一个 SPU 合并为一次保存；dry-run 与正式写入使用独立 checkpoint。

## 牵牛花执行边界

Chrome 扩展和受管 CDP 可以是不同 transport，但写入合同不变：冻结列表页原生 profile；每个 SPU 精确进入编辑 route，
捕获本页原生 detail POST，对最终 endpoint/method/body 当次签名，一次保存后独立 detail 回读。扩展不得读取 Cookie、
localStorage 或 sessionStorage。

大任务使用 `run_qnh_batch.sh`，单进程最多 50 SPU。先通过统一资源准入，默认一个可复用热 writer；只有相同商品量
canary 的端到端墙钟更短、失败率不升、回读完整且资源余量持续通过，才按 `1→2→4` 升档，4 为硬上限。同一 SPU
始终单飞；压力出现后只降不升，商品终态立即回收任务页。

## 未知结果与恢复

- 保存失败、超时或连接中断先重读整批；已物化商品记为完成，不重复保存，只为当前仍非法字段生成 residual。
- dry-run 的 `Failed to fetch` 没有平台副作用，可只补检失败项；不能把预检成功计作保存成功。
- 平台明确“记录不存在”时标记 `missing_on_platform`，从平台现存完成率分母剔除，但保留在统一七表。
- 长任务只在同一冻结合同/run-dir 复用详情、建议、计划和完成窗口；不得跨 run 搬运 checkpoint。

## 全量验证与输出

每批保存后重读该批全部商品；全任务结束时重读所有平台现存 SPU，并运行：

```bash
python3 scripts/validate_channel_contracts.py \
  --details "$RUN_DIR/details-final.json" \
  --output "$RUN_DIR/channel-contract-validation.json"
```

只有 `products_with_issues=0` 且 `issue_count=0` 才可完成。源清单唯一 SPU 必须全部进入唯一终态，平台现存与不存在之和
等于源数；写请求成功率不能冒充 100%。

最终工作簿严格使用 `product-governance-operations-workbook-v1` 和
[统一输出内容合同](core/output-contract.md)。渠道字段 ID 固定为
`channel_attribute.<channel>.<platform_field_id>`；不复制源文件的其他工作表，不另建近义审计表。Schema validator、
平台完成门和 handoff gate 任一失败时不得交付。
