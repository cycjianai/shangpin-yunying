#!/usr/bin/env node
/** Validate the platform-neutral operator workbook against its final checkpoint. */

import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { isReadbackPassed, validateAuditRow } from "./core/operations_contract.mjs";

const OPERATIONS_SCHEMA = JSON.parse(
  await fs.readFile(new URL("./operations_workbook_schema.json", import.meta.url), "utf8"),
);
const EXPECTED_SHEETS = OPERATIONS_SCHEMA.sheets;
const HEADERS = OPERATIONS_SCHEMA.headers;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function required(args, key) {
  if (!args[key]) throw new Error(`missing --${key}`);
  return path.resolve(args[key]);
}

const args = parseArgs(process.argv.slice(2));
const workbookPath = required(args, "workbook");
const checkpointPath = required(args, "checkpoint");
const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
const errors = [];
const rows = checkpoint.rows || [];
const items = checkpoint.items || {};
const expectedAuditRows = Object.values(items).reduce((count, item) => count + (item.changes || []).length, 0);
const unresolved = Object.values(items).filter(
  (item) => !["verified", "verified_no_change"].includes(item?.state),
);
if (Object.keys(items).length !== rows.length) errors.push("checkpoint_item_count_mismatch");
if (unresolved.length) errors.push(`checkpoint_unresolved:${unresolved.length}`);

const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const actualSheets = [];
for (let index = 0; index < EXPECTED_SHEETS.length; index += 1) {
  try {
    actualSheets.push(workbook.worksheets.getItemAt(index).name);
  } catch {
    break;
  }
}
if (JSON.stringify(actualSheets) !== JSON.stringify(EXPECTED_SHEETS)) {
  errors.push(`sheet_order_mismatch:${actualSheets.join("|")}`);
}

const productSheet = workbook.worksheets.getItem("SPU清单");
const auditSheet = workbook.worksheets.getItem("字段级审计");
const verifySheet = workbook.worksheets.getItem("最终结构复核");
const summarySheet = workbook.worksheets.getItem("执行汇总");
const missingSheet = workbook.worksheets.getItem("平台不存在");
const feedbackSheet = workbook.worksheets.getItem("问题与策略回灌");
const performanceSheet = workbook.worksheets.getItem("性能与外部调用统计");
const productValues = productSheet.getUsedRange().values;
const auditValues = auditSheet.getUsedRange().values;
const verifyValues = verifySheet.getUsedRange().values;
const summaryValues = summarySheet.getUsedRange().values;
for (const [sheetName, values] of [
  [EXPECTED_SHEETS[0], summaryValues],
  [EXPECTED_SHEETS[1], productValues],
  [EXPECTED_SHEETS[2], auditValues],
  [EXPECTED_SHEETS[3], missingSheet.getUsedRange().values],
  [EXPECTED_SHEETS[4], verifyValues],
  [EXPECTED_SHEETS[5], feedbackSheet.getUsedRange().values],
  [EXPECTED_SHEETS[6], performanceSheet.getUsedRange().values],
]) {
  if (JSON.stringify(values[0] || []) !== JSON.stringify(HEADERS[sheetName])) {
    errors.push(`header_mismatch:${sheetName}`);
  }
}
if (productValues.length - 1 !== rows.length) errors.push(`product_row_count:${productValues.length - 1}`);
if (productValues.slice(1).some((row) => !String(row[0] || "") || !String(row[1] || "") || !String(row[2] || ""))) {
  errors.push("product_spu_or_bc_empty");
}
if (auditValues.length - 1 !== expectedAuditRows) errors.push(`audit_row_count:${auditValues.length - 1}`);
let canonicalReadbackCount = 0;
for (let index = 1; index < auditValues.length; index += 1) {
  const rowErrors = validateAuditRow(auditValues[index]);
  errors.push(...rowErrors.map((error) => `audit_contract:${index + 1}:${error}`));
  try {
    if (isReadbackPassed(auditValues[index][8])) canonicalReadbackCount += 1;
  } catch {
    // validateAuditRow already emitted the canonical result error.
  }
}
const verifyMap = Object.fromEntries(verifyValues.slice(1).map((row) => [String(row[0] || ""), row[1]]));
if (Number(verifyMap["最终问题数"] || 0) !== 0) errors.push("verify_issue_nonzero");
const summaryMap = Object.fromEntries(summaryValues.slice(1).map((row) => [String(row[0] || ""), row[1]]));
if (JSON.stringify(summaryValues.slice(1).map((row) => String(row[0] || ""))) !== JSON.stringify(OPERATIONS_SCHEMA.summary_metrics)) {
  errors.push("summary_metric_order_mismatch");
}
if (JSON.stringify(verifyValues.slice(1).map((row) => String(row[0] || ""))) !== JSON.stringify(OPERATIONS_SCHEMA.verify_metrics)) {
  errors.push("verify_metric_order_mismatch");
}
const performanceValues = performanceSheet.getUsedRange().values;
if (JSON.stringify(performanceValues.slice(1).map((row) => String(row[0] || ""))) !== JSON.stringify(OPERATIONS_SCHEMA.performance_metrics)) {
  errors.push("performance_metric_order_mismatch");
}
if (Number(summaryMap["源清单商品数"] || 0) !== rows.length) errors.push("summary_source_count_mismatch");
for (const metric of ["Excel Schema版本", "Skill版本", "执行平台", "任务类型", "合同指纹SHA256", "门店/租户名称"]) {
  if (!String(summaryMap[metric] || "").trim()) errors.push(`summary_identity_empty:${metric}`);
}
if (String(summaryMap["Excel Schema版本"] || "") !== OPERATIONS_SCHEMA.schema_version) errors.push("summary_schema_mismatch");
if (!Object.values(OPERATIONS_SCHEMA.content_contract.platform_values).includes(String(summaryMap["执行平台"] || ""))) errors.push("summary_platform_invalid");
if (!OPERATIONS_SCHEMA.content_contract.task_values.includes(String(summaryMap["任务类型"] || ""))) errors.push("summary_task_invalid");
if (Number(summaryMap["最终合同通过商品数"] || 0) !== rows.length) errors.push("summary_verified_count_mismatch");
if (Number(summaryMap["唯一操作项数"] || 0) !== expectedAuditRows) errors.push("summary_audit_count_mismatch");
if (Number(summaryMap["最终回读通过项数"] || 0) !== canonicalReadbackCount) errors.push("summary_readback_count_mismatch");
if (Number(summaryMap["最终合同通过商品数"] || 0) + Number(summaryMap["最终问题数"] || 0) !== Number(summaryMap["平台现存商品数"] || 0)) errors.push("summary_terminal_reconciliation_mismatch");
if (String(summaryMap["完成率"] || "") !== "100.00%") errors.push("summary_fill_rate_mismatch");
if (Number(performanceValues.find((row) => String(row[0] || "") === "唯一操作项数")?.[1] || 0) !== expectedAuditRows) errors.push("performance_operation_count_mismatch");

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
if (/#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/.test(String(formulaErrors.ndjson || ""))) {
  errors.push("formula_error_match");
}

const report = {
  schema: "multiplatform-channel-fill-workbook-validation-v1",
  valid: errors.length === 0,
  workbook: workbookPath,
  checkpoint: checkpointPath,
  sheets: actualSheets,
  products: rows.length,
  auditRows: expectedAuditRows,
  errors,
};
if (args.output) {
  await fs.writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 1;
