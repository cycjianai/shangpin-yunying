#!/usr/bin/env node
/** Validate the platform-neutral operator workbook against its final checkpoint. */

import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const EXPECTED_SHEETS = [
  "执行汇总",
  "SPU清单",
  "字段级审计",
  "平台不存在",
  "最终结构复核",
  "问题与策略回灌",
  "性能与外部调用统计",
];

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
const productValues = productSheet.getUsedRange().values;
const auditValues = auditSheet.getUsedRange().values;
const verifyValues = verifySheet.getUsedRange().values;
const summaryValues = summarySheet.getUsedRange().values;
if (productValues.length - 1 !== rows.length) errors.push(`product_row_count:${productValues.length - 1}`);
if (auditValues.length - 1 !== expectedAuditRows) errors.push(`audit_row_count:${auditValues.length - 1}`);
const statuses = productValues.slice(1).map((row) => String(row[5] || ""));
if (statuses.some((status) => !status.startsWith("已验证"))) errors.push("product_status_not_verified");
const verifyMap = Object.fromEntries(verifyValues.slice(1).map((row) => [String(row[0] || ""), row[1]]));
if (Number(verifyMap["阻断商品数"] || 0) !== 0) errors.push("verify_blocked_nonzero");
if (Number(verifyMap["失败商品数"] || 0) !== 0) errors.push("verify_failed_nonzero");
if (Number(verifyMap["最终字段问题数"] || 0) !== 0) errors.push("verify_issue_nonzero");
const summaryMap = Object.fromEntries(summaryValues.slice(1).map((row) => [String(row[0] || ""), row[1]]));
if (Number(summaryMap["源清单商品数"] || 0) !== rows.length) errors.push("summary_source_count_mismatch");
if (Number(summaryMap["最终验证商品数"] || 0) !== rows.length) errors.push("summary_verified_count_mismatch");
if (Number(summaryMap["唯一字段修正数"] || 0) !== expectedAuditRows) errors.push("summary_audit_count_mismatch");
if (Number(summaryMap["渠道属性填充率"] || 0) < 0.999999) errors.push("summary_fill_rate_mismatch");

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
