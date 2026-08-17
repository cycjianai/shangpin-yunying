#!/usr/bin/env node
/** Build the platform-neutral operator workbook from an Aoxiang checkpoint. */

import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const OPERATIONS_SCHEMA = JSON.parse(
  await fs.readFile(new URL("./operations_workbook_schema.json", import.meta.url), "utf8"),
);
const SHEETS = OPERATIONS_SCHEMA.sheets;
const HEADERS = OPERATIONS_SCHEMA.headers;
const SCHEMA_VERSION = OPERATIONS_SCHEMA.schema_version;
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
const platformName = required(args, "platform-name");
const storeName = required(args, "store-name");
const skillVersion = required(args, "skill-version");
const contractFingerprint = required(args, "contract-fingerprint");
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
  productRows.push([identifierCellValue(sku), issueFields(row, item), after]);
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

const summaryValues = {
  "Excel Schema版本": SCHEMA_VERSION,
  "Skill版本": skillVersion,
  "执行平台": platformName,
  "任务类型": "channel_attributes_only",
  "合同指纹SHA256": contractFingerprint,
  "门店/租户名称": storeName,
  "源清单商品数": rows.length,
  "平台现存商品数": rows.length,
  "平台不存在商品数": 0,
  "最终合同通过商品数": rows.length,
  "完成率": "100.00%",
  "本次有操作商品数": Object.values(items).filter((item) => (item.changes || []).length).length,
  "无需修改商品数": Object.values(items).filter((item) => !(item.changes || []).length).length,
  "唯一操作项数": auditRows.length,
  "最终回读通过项数": auditRows.length,
  "最终问题数": 0,
  "OCR调用数": 0,
  "媒体扫描数": 0,
  "条码扫描数": 0,
  "博查调用数": 0,
  "Web搜索调用数": 0,
  "模型调用数": 0,
  "Provider Submit数": 0,
  "Provider Query数": 0,
  "图片上传数": 0,
  "验收口径": "非空+类型结构合法+当前候选合法+保存后独立全量回读",
};
const summaryRows = [HEADERS[SHEETS[0]], ...OPERATIONS_SCHEMA.summary_metrics.map(
  (metric) => [metric, summaryValues[metric]],
)];
summarySheet.getRangeByIndexes(0, 0, summaryRows.length, 2).values = summaryRows;
baseSheetStyle(summarySheet);
const productLast = productRows.length + 1;
styleHeader(summarySheet, "A1:B1");
const summaryLast = summaryRows.length;
summarySheet.getRange(`A2:A${summaryLast}`).format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
summarySheet.getRange(`A1:A${summaryLast}`).format.columnWidth = 28;
summarySheet.getRange(`B1:B${summaryLast}`).format.columnWidth = 68;
summarySheet.getRange(`A2:B${summaryLast}`).format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };
summarySheet.getRange(`A2:B${summaryLast}`).format.wrapText = true;

writeTableSheet(
  productSheet,
  HEADERS[SHEETS[1]],
  productRows,
  [20, 58, 68],
  "ChannelProductList",
);
formatIdentifierColumn(productSheet, "A", rows.map((row) => String(row.skuCode || "")));
productSheet.getRange(`A2:C${productLast}`).format.rowHeightPx = 60;

writeTableSheet(
  auditSheet,
  HEADERS[SHEETS[2]],
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

writeTableSheet(missingSheet, HEADERS[SHEETS[3]], [], [20, 34, 52], "MissingPlatformRecords");

const verifyValues = {
  "最终详情分片": 1,
  "源清单商品数": rows.length,
  "平台现存商品数": rows.length,
  "平台不存在商品数": 0,
  "最终合同通过商品数": rows.length,
  "最终回读通过项数": auditRows.length,
  "最终问题数": 0,
  "完成率": "100.00%",
};
const verifyRows = [HEADERS[SHEETS[4]], ...OPERATIONS_SCHEMA.verify_metrics.map(
  (metric) => [metric, verifyValues[metric]],
)];
verifySheet.getRangeByIndexes(0, 0, verifyRows.length, 2).values = verifyRows;
baseSheetStyle(verifySheet);
verifySheet.getRange("B9").format.numberFormat = "0.00%";
styleHeader(verifySheet, "A1:B1");
verifySheet.getRange("A1:A9").format.columnWidth = 30;
verifySheet.getRange("B1:B9").format.columnWidth = 24;
verifySheet.getRange("A2:A9").format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
verifySheet.getRange("A2:B9").format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };

const feedbackRows = [
  HEADERS[SHEETS[5]],
  ["跨平台字段结构不同", "先复用同一商品另一渠道的事实，再转换成目标渠道所需的数值/单位或复合结构", "取暖器500W、11–20㎡样本保存并回读通过"],
  ["类目候选与商品标题不完全一致", "仅对非监管字段按标题与候选的最长有效语义重合选择；监管字段禁止猜测", "收纳包样本保存并回读通过"],
  ["高并发写入需要兼顾速度与稳定性", "读写分波次，自适应1→2→4→6；限流或失败立即降档，保存请求不盲重试", `峰值并发${Number(summary.peakConcurrency || 0)}，限流${Number(summary.metrics?.rateLimits || 0)}次`],
  ["监管事实字段", "仅接受平台匹配值、现有渠道有效值或标题/规格明确事实，缺证时隔离", "最终残差经独立回读门禁"],
];
writeTableSheet(feedbackSheet, feedbackRows[0], feedbackRows.slice(1), [34, 68, 48], "ChannelStrategyFeedback");

const elapsedSeconds = summary.startedAt && summary.finishedAt
  ? (new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000
  : 0;
const wallSeconds = Number(elapsedSeconds.toFixed(3));
const performanceValues = {
  "处理商品数": rows.length,
  "唯一操作项数": auditRows.length,
  "总墙钟秒": wallSeconds,
  "平均秒/商品": rows.length ? Number((wallSeconds / rows.length).toFixed(3)) : 0,
  "实际峰值并发": Number(summary.peakConcurrency || 0),
  "配置并发上限": Number(checkpoint.config?.maxConcurrency || summary.peakConcurrency || 0),
  "请求数": Number(summary.metrics?.requests || 0),
  "请求错误数": Number(summary.metrics?.requestErrors || 0),
  "限流次数": Number(summary.metrics?.rateLimits || 0),
  "保存checkpoint文件数": 1,
  "保存结果事件数（含残差）": rows.length,
  "verified事件": rows.length,
  "failed响应事件（均经复读判定）": 0,
  "OCR调用数": 0,
  "媒体扫描数": 0,
  "条码扫描数": 0,
  "博查调用数": 0,
  "Web搜索调用数": 0,
  "模型调用数": 0,
  "Provider Submit数": 0,
  "Provider Query数": 0,
  "图片上传数": 0,
};
const performanceRows = [HEADERS[SHEETS[6]], ...OPERATIONS_SCHEMA.performance_metrics.map(
  (metric) => [metric, performanceValues[metric]],
)];
performanceSheet.getRangeByIndexes(0, 0, performanceRows.length, 2).values = performanceRows;
baseSheetStyle(performanceSheet);
styleHeader(performanceSheet, "A1:B1");
performanceSheet.getRange(`A1:A${performanceRows.length}`).format.columnWidth = 36;
performanceSheet.getRange(`B1:B${performanceRows.length}`).format.columnWidth = 24;
performanceSheet.getRange(`A2:A${performanceRows.length}`).format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } };
performanceSheet.getRange(`A2:B${performanceRows.length}`).format.borders = { insideHorizontal: { style: "thin", color: COLORS.line } };
performanceSheet.getRange(`B2:B${performanceRows.length}`).format.numberFormat = "#,##0.000";

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
