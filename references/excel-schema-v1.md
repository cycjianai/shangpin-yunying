# QNH 渠道属性 Excel Schema v1

Schema ID：`qnh-channel-fill-workbook-v1`。

## 1. 文件与工作表顺序

文件名固定为 `MMDD{本次租户可见名称}{源清单唯一SPU数}.xlsx`。

工作表顺序固定为：

1. `执行汇总`
2. 源工作簿业务工作表（保持原有顺序）；无源 XLSX 时固定创建 `SPU清单`
3. `字段级审计`
4. `平台不存在`
5. `最终结构复核`
6. `问题与策略回灌`
7. `性能与外部调用统计`

源文件中同名的旧生成审计表必须移除并按本次最终事实重建；其他业务工作表不得删除、改名或重排。

## 2. 精确表头

- `执行汇总`：`指标`、`结果`
- 无源 XLSX 的 `SPU清单`：`SPUID`、`执行前缺失/无效字段`、`本次实际填充及最终回读`
- 源 XLSX 第一工作表：A 列保持原 SPU；B/C 表头强制为 `执行前缺失/无效字段`、`本次实际填充及最终回读`
- `字段级审计`：`SPU编码`、`商品名称`、`渠道`、`字段ID`、`字段名`、`执行前`、`计划值`、`最终回读值`、`结果`、`来源策略`
- `平台不存在`：`SPU编码`、`平台结果`、`处理口径`
- `最终结构复核`：`指标`、`结果`
- `问题与策略回灌`：`本次新情况`、`修正规则`、`验证结果`
- `性能与外部调用统计`：`指标`、`结果`

不得使用“商品终态、自评与口径、结构残差、速度根因”等近义表替代 canonical 工作表。

## 3. B/C 列合同

- B 列逐 SPU 写执行前空值或旧结构无效字段、渠道、字段 ID/名和旧值。
- C 列逐 SPU 写本次实际新增/修正字段及最终独立回读值。
- 平台不存在必须在 B/C 写明“不存在/未写入/不计入现存分母”。
- 执行前已经合法且没有历史审计时，写“执行前已满足渠道属性结构合同”和“无需修改；最终全字段复核通过”。
- 源表已有可信 B/C 历史记录时必须合并保留；不能用“无需修改”覆盖之前真实操作。
- 每个源 SPU 的 B/C 都必须非空，且第一工作表唯一 SPU 集合必须与 manifest 完全一致。

## 4. 必需汇总指标

`执行汇总` 至少且只按最终事实计算：Schema 版本、Skill 版本、任务模式、合同指纹、租户名称、源表唯一 SPU、平台现存、平台不存在、结构通过、填充率、有修正 SPU、无需修改 SPU、唯一修正字段、字段回读通过、最终问题数以及 OCR/博查/Web/模型/provider/图片上传调用数。

`最终结构复核` 必须包含 `products_with_issues`、`issue_count` 与最终填充率。两项问题数只要不为 0，导出器必须失败，不能生成 100% 汇总。

## 5. 机器验收

导出必须使用 `export_standard_channel_fill_workbook.py`，随后运行：

```bash
python3 scripts/validate_standard_channel_fill_workbook.py \
  --contract "$RUN_DIR/task-contract.json" \
  --manifest "$MANIFEST" \
  --workbook "$OUTPUT_XLSX" \
  --summary "$OUTPUT_XLSX_WITHOUT_SUFFIX.summary.json" \
  ${SOURCE_XLSX:+--source-xlsx "$SOURCE_XLSX"}
```

Schema、顺序、表头、SPU 集合、B/C、汇总对账或版本指纹任一不符时返回非零；该文件不得交付。

Schema validator 只证明表内结构正确，不证明它就是本任务的权威执行结果。对用户交付前还必须执行
`qnh_workbook_handoff_gate.py`：合同角色必须是 `execution`，summary、validator、完成门和 XLSX 必须来自同一
run 且路径、指纹、租户名、源 SPU 数完全对账。`validation_only` 表即使结构合法也固定
`delivery_eligible=false`，不能替代曾发生真实写入的执行表。
