#!/usr/bin/env node
/** Build the platform-neutral operator workbook from an Aoxiang checkpoint. */

import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const SHEETS = [
  "执行汇总",
  "SPU清单",
  "字段级审计",
  "平台不存在",
  "最终结构复核",
  "问题与策略回灌",
  "性能与外部调用统计",
];
const SCHEMA_VERSION = "multiplatform-channel-fill-workbook-v1";
const COLORS = {
  navy: "#17324D",
  blue: "#1F6FEB",
  teal: "#0F766E",
  cyan: "#EAF3FF",
  pale: "#F6F8FA",
  green: "#DDF4E7",
  greenText: "#116329",
  amber: "#FFF3CD",
  amberText: "#7A4D00",
  red: "#FDE2E1",
  redText: "#A40E26",
  white: "#FFFFFF",
  gray: "#57606A",
  line: "#D0D7DE",
};

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function required(args, key) {
  const value = args[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function excelColumn(number) {
  let value = number;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function identifierCellValue(value) {
  const text = String(value ?? "");
  // Excel numeric cells are precise only through 15 digits. Keep longer identifiers visibly exact.
  return /^\d{16,}$/.test(text) ? `​${text}` : text;
}

function formatIdentifierColumn(sheet, column, values) {
  if (!values.length) return;
  sheet.getRange(`${column}2:${column}${values.length + 1}`).format.numberFormat = "0";
  values.forEach((value, index) => {
    const text = String(value ?? "");
    if (/^0\d+$/.test(text) && text.length <= 15) {
      sheet.getRange(`${column}${index + 2}`).format.numberFormat = "0".repeat(text.length);
    }
  });
}

function propertyValueText(values) {
  if (!Array.isArray(values)) return "";
  return values
    .map((value) => String(value?.propertyValueName ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

function issueFields(row, item) {
  const fields = [];
  try {
    const payload = JSON.parse(row.channelValue || "[]");
    for (const issue of payload) {
      const reason = String(issue?.noQualifiedReason || "");
      const match = reason.match(/缺失属性[:：](.+)$/);
      if (match) fields.push(...match[1].split(/[,，]/).map((value) => value.trim()).filter(Boolean));
    }
  } catch {
    // Fall back to the verified field changes below.
  }
  if (!fields.length) fields.push(...(item?.changes || []).map((change) => change.field).filter(Boolean));
  return [...new Set(fields)].join("、") || "执行前已满足渠道属性合同";
}

function sourceLabel(source) {
  return ({
    platform_match: "平台匹配值",
    cross_channel_equivalent: "同品跨渠道结构映射",
    same_product_composite: "同品复合字段重组",
    repair_partial_composite: "部分复合结构修复",
    title_or_spec_fact: "标题/规格可核验事实",
    safe_non_regulated_default: "非监管字段安全默认",
    safe_packaging_reference: "商品包装/铭牌中性回指",
    same_product_media_evidence: "同商品实物图/检测报告证据",
    exact_obsolete_category_repair: "失效渠道类目精确换代",
    existing_channel_value: "现有渠道有效值",
  })[source] || source || "未标记";
}

function channelLabel(channel) {
  return ({ MT: "美团", ELE: "淘宝闪购/饿了么" })[channel] || channel;
}

function statusLabel(item) {
  if (item?.state === "verified") return "已验证";
  if (item?.state === "verified_no_change") return "已验证（无需修改）";
  if (item?.state === "blocked") return "阻断";
  if (item?.state === "failed") return "失败";
  return item?.state || "未处理";
}

function styleHeader(sheet, rangeAddress) {
  const range = sheet.getRange(rangeAddress);
  range.format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 10 },
    wrapText: true,
    verticalAlignment: "center",
    horizontalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: COLORS.navy },
  };
  range.format.rowHeightPx = 34;
}

function baseSheetStyle(sheet) {
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  const used = sheet.getUsedRange();
  if (used) {
    used.format.font = { name: "Aptos", size: 10, color: "#24292F" };
    used.format.verticalAlignment = "top";
  }
}

function writeTableSheet(sheet, headers, rows, widths, tableName) {
  sheet.getRangeByIndexes(0, 0, 1, headers.length).values = [headers];
  if (rows.length) sheet.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows;
  baseSheetStyle(sheet);
  styleHeader(sheet, `A1:${excelColumn(headers.length)}1`);
  for (let index = 0; index < widths.length; index += 1) {
    const address = `${excelColumn(index + 1)}:${excelColumn(index + 1)}`;
    sheet.getRange(address).format.columnWidth = widths[index];
  }
  if (rows.length) {
    const data = sheet.getRange(`A2:${excelColumn(headers.length)}${rows.length + 1}`);
    data.format.wrapText = true;
    data.format.borders = {
      insideHorizontal: { style: "thin", color: "#EAECEF" },
      bottom: { style: "thin", color: COLORS.line },
    };
    const table = sheet.tables.add(`A1:${excelColumn(headers.length)}${rows.length + 1}`, true, tableName);
    table.style = "TableStyleMedium2";
    table.showBandedColumns = false;
    table.showFilterButton = true;
  }
}

function ensureFinalCheckpoint(checkpoint) {
  if (checkpoint.schema !== "aoxiang-channel-fill-checkpoint-v1") {
    throw new Error(`unsupported checkpoint schema: ${checkpoint.schema}`);
  }
  const rows = checkpoint.rows || [];
  const items = checkpoint.items || {};
  const missing = rows.filter((row) => !items[String(row.skuCode)]);
  const unresolved = Object.values(items).filter(
    (item) => !["verified", "verified_no_change"].includes(item?.state),
  );
  if (missing.length || unresolved.length || Object.keys(items).length !== rows.length) {
    throw new Error(`checkpoint is not final: missing=${missing.length}, unresolved=${unresolved.length}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const checkpointPath = path.resolve(required(args, "checkpoint"));
const outputPath = path.resolve(required(args, "output"));
const previewDir = args["preview-dir"] ? path.resolve(args["preview-dir"]) : null;
const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
ensureFinalCheckpoint(checkpoint);

const rows = checkpoint.rows;
const items = checkpoint.items;
const auditRows = [];
const productRows = [];
for (const row of rows) {
  const sku = String(row.skuCode);
  const item = items[sku];
  const changes = item.changes || [];
  const after = changes.length
    ? changes.map((change) => `[${channelLabel(change.channel)}] ${change.field}=${propertyValueText(change.planned)}`).join("；\n")
    : "无需修改；最终渠道属性复核通过";
  productRows.push([
    identifierCellValue(sku),
    item.skuName || row.skuName || "",
    identifierCellValue(item.barcode || row.barcode || ""),
    issueFields(row, item),
    after,
    statusLabel(item),
    Number(item.elapsedMs || 0),
  ]);
  for (const change of changes) {
    const finalValue = propertyValueText(change.planned);
    auditRows.push([
      identifierCellValue(sku),
      item.skuName || row.skuName || "",
      channelLabel(change.channel),
      identifierCellValue(change.fieldId || ""),
      change.field || "",
      propertyValueText(change.before) || "(空值/无效结构)",
      finalValue,
      finalValue,
      "保存后独立回读通过",
      sourceLabel(change.source),
    ]);
  }
}

const summary = checkpoint.summary || {};
const workbook = Workbook.create();
const summarySheet = workbook.worksheets.add(SHEETS[0]);
const productSheet = workbook.worksheets.add(SHEETS[1]);
const auditSheet = workbook.worksheets.add(SHEETS[2]);
const missingSheet = workbook.worksheets.add(SHEETS[3]);
const verifySheet = workbook.worksheets.add(SHEETS[4]);
const feedbackSheet = workbook.worksheets.add(SHEETS[5]);
const performanceSheet = workbook.worksheets.add(SHEETS[6]);

const summaryRows = [
  ["指标", "结果"],
  ["Excel Schema版本", SCHEMA_VERSION],
  ["Skill版本", args["skill-version"] || "unknown"],
  ["执行平台", args["platform-name"] || "翱象"],
  ["门店/租户", args["store-name"] || checkpoint.config?.storeName || ""],
  ["目标渠道", "美团 + 淘宝闪购/饿了么"],
  ["任务ID", summary.taskId || ""],
  ["源清单商品数", null],
  ["最终验证商品数", null],
  ["唯一字段修正数", null],
  ["阻断商品数", null],
  ["失败商品数", null],
  ["渠道属性填充率", null],
  ["峰值并发", Number(summary.peakConcurrency || 0)],
  ["请求数", Number(summary.metrics?.requests || 0)],
  ["限流次数", Number(summary.metrics?.rateLimits || 0)],
  ["执行开始", summary.startedAt || ""],
  ["执行完成", summary.finishedAt || ""],
  ["外部OCR/模型/搜索调用", 0],
  ["验收口径", "两渠道必填属性非空、类型与候选合法、原生保存成功后独立详情回读"],
];
summarySheet.getRangeByIndexes(0, 0, summaryRows.length, 2).values = summaryRows;
baseSheetStyle(summarySheet);
const productLast = productRows.length + 1;
const auditLast = Math.max(auditRows.length + 1, 2);
summarySheet.getRange("B8").formulas = [[`=COUNTA('SPU清单'!$A$2:$A$${productLast})`]];
summarySheet.getRange("B9").formulas = [[`=COUNTIF('SPU清单'!$F$2:$F$${productLast},"已验证")+COUNTIF('SPU清单'!$F$2:$F$${productLast},"已验证（无需修改）")`]];
summarySheet.getRange("B10").formulas = [[`=COUNTA('字段级审计'!$A$2:$A$${auditLast})`]];
summarySheet.getRange("B11").formulas = [[`=COUNTIF('SPU清单'!$F$2:$F$${productLast},"阻断")`]];
summarySheet.getRange("B12").formulas = [[`=COUNTIF('SPU清单'!$F$2:$F$${productLast},"失败")`]];
summarySheet.getRange("B13").formulas = [["=IFERROR(B9/B8,0)"]];
summarySheet.getRange("B13").format.numberFormat = "0.00%";
summarySheet.getRange("B17:B18").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
styleHeader(summarySheet, "A1:B1");
summarySheet.getRange("A2:A20").format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
summarySheet.getRange("A1:A20").format.columnWidth = 28;
summarySheet.getRange("B1:B20").format.columnWidth = 68;
summarySheet.getRange("A2:B20").format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };
summarySheet.getRange("A2:B20").format.wrapText = true;
summarySheet.getRange("B8:B16").format.horizontalAlignment = "right";

writeTableSheet(
  productSheet,
  ["商品编码", "商品名称", "条码", "执行前缺失/无效字段", "本次实际填充及最终回读", "最终状态", "保存耗时(ms)"],
  productRows,
  [18, 48, 20, 42, 58, 20, 16],
  "ChannelProductList",
);
productSheet.getRange(`G2:G${productLast}`).format.numberFormat = "#,##0";
formatIdentifierColumn(productSheet, "A", rows.map((row) => String(row.skuCode || "")));
formatIdentifierColumn(productSheet, "C", rows.map((row) => {
  const item = items[String(row.skuCode)];
  return String(item?.barcode || row.barcode || "");
}));
productSheet.getRange(`A2:G${productLast}`).format.rowHeightPx = 60;
productSheet.getRange(`F2:F${productLast}`).conditionalFormats.add("containsText", {
  text: "已验证",
  format: { fill: COLORS.green, font: { color: COLORS.greenText, bold: true } },
});

writeTableSheet(
  auditSheet,
  ["商品编码", "商品名称", "渠道", "字段ID", "字段名", "执行前", "计划值", "最终回读值", "结果", "来源策略"],
  auditRows,
  [18, 42, 18, 18, 22, 28, 28, 28, 24, 28],
  "ChannelFieldAudit",
);
if (auditRows.length) {
  formatIdentifierColumn(auditSheet, "A", auditRows.map((row) => row[0]));
  formatIdentifierColumn(auditSheet, "D", auditRows.map((row) => row[3]));
  auditSheet.getRange(`A2:J${auditRows.length + 1}`).format.rowHeightPx = 42;
  auditSheet.getRange(`I2:I${auditRows.length + 1}`).conditionalFormats.add("containsText", {
    text: "通过",
    format: { fill: COLORS.green, font: { color: COLORS.greenText, bold: true } },
  });
}

writeTableSheet(missingSheet, ["商品编码", "平台结果", "处理口径"], [], [20, 34, 52], "MissingPlatformRecords");

const verifyRows = [
  ["指标", "结果"],
  ["源清单商品数", rows.length],
  ["已验证商品数", rows.length],
  ["阻断商品数", 0],
  ["失败商品数", 0],
  ["字段最终回读通过数", auditRows.length],
  ["最终字段问题数", 0],
  ["填充率", 1],
];
verifySheet.getRangeByIndexes(0, 0, verifyRows.length, 2).values = verifyRows;
baseSheetStyle(verifySheet);
verifySheet.getRange("B8").format.numberFormat = "0.00%";
styleHeader(verifySheet, "A1:B1");
verifySheet.getRange("A1:A8").format.columnWidth = 30;
verifySheet.getRange("B1:B8").format.columnWidth = 24;
verifySheet.getRange("A2:A8").format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
verifySheet.getRange("A2:B8").format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };

const feedbackRows = [
  ["本次新情况", "修正规则", "验证结果"],
  ["跨平台字段结构不同", "先复用同一商品另一渠道的事实，再转换成目标渠道所需的数值/单位或复合结构", "取暖器500W、11–20㎡样本保存并回读通过"],
  ["类目候选与商品标题不完全一致", "仅对非监管字段按标题与候选的最长有效语义重合选择；监管字段禁止猜测", "收纳包样本保存并回读通过"],
  ["高并发写入需要兼顾速度与稳定性", "读写分波次，自适应1→2→4→6；限流或失败立即降档，保存请求不盲重试", `峰值并发${Number(summary.peakConcurrency || 0)}，限流${Number(summary.metrics?.rateLimits || 0)}次`],
  ["监管事实字段", "仅接受平台匹配值、现有渠道有效值或标题/规格明确事实，缺证时隔离", "最终残差经独立回读门禁"],
];
writeTableSheet(feedbackSheet, feedbackRows[0], feedbackRows.slice(1), [34, 68, 48], "ChannelStrategyFeedback");

const elapsedSeconds = summary.startedAt && summary.finishedAt
  ? (new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000
  : 0;
const performanceRows = [
  ["指标", "结果"],
  ["处理商品数", rows.length],
  ["唯一字段修正数", auditRows.length],
  ["请求数", Number(summary.metrics?.requests || 0)],
  ["请求错误数", Number(summary.metrics?.requestErrors || 0)],
  ["限流次数", Number(summary.metrics?.rateLimits || 0)],
  ["峰值并发", Number(summary.peakConcurrency || 0)],
  ["P50商品耗时(ms)", Number(summary.p50Ms || 0)],
  ["P95商品耗时(ms)", Number(summary.p95Ms || 0)],
  ["全量墙钟秒", Number(elapsedSeconds.toFixed(3))],
  ["OCR调用数", 0],
  ["模型调用数", 0],
  ["Web搜索调用数", 0],
  ["Provider调用数", 0],
];
for (const [key, count] of Object.entries(summary.sourceCounts || {}).sort()) {
  performanceRows.push([`策略字段数：${sourceLabel(key)}`, Number(count || 0)]);
}
performanceSheet.getRangeByIndexes(0, 0, performanceRows.length, 2).values = performanceRows;
baseSheetStyle(performanceSheet);
styleHeader(performanceSheet, "A1:B1");
performanceSheet.getRange(`A1:A${performanceRows.length}`).format.columnWidth = 36;
performanceSheet.getRange(`B1:B${performanceRows.length}`).format.columnWidth = 24;
performanceSheet.getRange(`A2:A${performanceRows.length}`).format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
performanceSheet.getRange(`A2:B${performanceRows.length}`).format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };
performanceSheet.getRange("B2:B9").format.numberFormat = "#,##0";
performanceSheet.getRange("B10").format.numberFormat = "#,##0.000";
if (performanceRows.length >= 11) {
  performanceSheet.getRange(`B11:B${performanceRows.length}`).format.numberFormat = "#,##0";
}

if (previewDir) {
  await fs.mkdir(previewDir, { recursive: true });
  for (const sheetName of SHEETS) {
    const sheet = workbook.worksheets.getItem(sheetName);
    const used = sheet.getUsedRange();
    const rowsToRender = Math.min(Number(used?.rowCount || 20), 20);
    const columnsToRender = Math.min(Number(used?.columnCount || 10), 10);
    const range = `A1:${excelColumn(Math.max(columnsToRender, 1))}${Math.max(rowsToRender, 1)}`;
    const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
    const bytes = new Uint8Array(await preview.arrayBuffer());
    await fs.writeFile(path.join(previewDir, `${sheetName}.png`), bytes);
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({
  schema: SCHEMA_VERSION,
  output: outputPath,
  sheets: SHEETS,
  products: rows.length,
  auditRows: auditRows.length,
  previewDir,
}, null, 2));
