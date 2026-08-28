#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const AUDITOR_VERSION = "1.1.0";
const FACT_FIELD_RE = /(许可证|许可编号|备案|注册证|批准文号|执行标准|认证证书|生产厂家|生产者|制造商|型号|功率|电压|酒精度|麦汁浓度|营养|配料|成分含量|安全等级|安全类别|医疗器械|产地|国产\/进口|是否进口|材质|面料|填充物|颜色|尺寸|长度|线长|直径|厚度|净重|重量|容量|净含量|保质期|有效期|生产日期|数量|片数|支数|只数|页数|本数|枝数|朵数|插位数|接口数量|适用人数|适合人数|浓度|含量|APP控制|手机可连接)/;
const REGULATED_NUMBER_RE = /(酒精度|麦汁浓度|功率|电压|尺寸|长度|线长|直径|厚度|净重|重量|容量|净含量|保质期|有效期|数量|片数|支数|只数|页数|本数|枝数|朵数|插位数|接口数量|浓度|含量)/;
const EXPLICIT_SOURCES = new Set([
  "deepseek_explicit_same_product_fact",
  "same_product_media_ocr",
  "same_product_media_ocr_field_context",
  "same_product_detail_text",
  "title_explicit_fact",
  "specification_explicit_fact",
  "cross_channel_exact_same_product_fact",
  "platform_match_validated",
]);
const UNCERTAIN_EVIDENCE_REASON_RE = /(?:通常|常见|常识|推断|推测|默认|疑似|误差可能|商品常识|OCR误差|最接近|最合适)/;

function parseArgs(argv) {
  const output = { sources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--source") {
      output.sources.push(argv[++index]);
    } else if (token.startsWith("--")) {
      output[token.slice(2)] = argv[++index];
    }
  }
  return output;
}

function valueSignature(values) {
  return JSON.stringify((values || []).map((value) => ({
    id: value.propertyValueId == null ? null : String(value.propertyValueId),
    name: String(value.propertyValueName ?? ""),
    type: String(value.propertyValueType ?? ""),
  })));
}

function definitionIndex(contexts) {
  const output = new Map();
  for (const item of contexts.items || []) {
    const skuCode = String(item.skuCode || "");
    for (const channel of ["MT", "ELE"]) {
      for (const definition of item.definitions?.[channel] || []) {
        output.set(`${skuCode}:${channel}:${definition.propertyId}`, { item, channel, definition });
      }
    }
  }
  return output;
}

function exactSelectValue(definition, value) {
  const options = [
    ...(definition.optionalValue || []),
    ...(definition.subCategoryPropertyList || []).flatMap((child) => child.optionalValue || []),
  ];
  return options.some((option) => {
    const idMatches = value.propertyValueId != null
      && option.propertyValueId != null
      && String(value.propertyValueId) === String(option.propertyValueId);
    return idMatches && String(value.propertyValueName) === String(option.propertyValueName);
  });
}

function numericParts(values) {
  return (values || [])
    .filter((value) => /INPUT|NUMBER/.test(String(value.propertyValueType || "")))
    .map((value) => Number(value.propertyValueName))
    .filter(Number.isFinite);
}

function auditEntry(target, override) {
  const { definition } = target;
  const values = override?.values;
  const reasons = [];
  const warnings = [];
  if (!Array.isArray(values) || !values.length) reasons.push("empty_override_values");
  for (const value of values || []) {
    if (String(value.propertyValueName ?? "").trim() === "") reasons.push("blank_value");
    if (/SELECT/.test(String(value.propertyValueType || "")) && !exactSelectValue(definition, value)) {
      reasons.push("select_not_exact_platform_candidate");
    }
  }
  const numbers = numericParts(values);
  for (const number of numbers) {
    if (definition.minValue != null && number < Number(definition.minValue)) reasons.push("below_platform_minimum");
    if (definition.maxValue != null && number > Number(definition.maxValue)) reasons.push("above_platform_maximum");
    if (REGULATED_NUMBER_RE.test(definition.propertyName) && number < 0) reasons.push("negative_regulated_number");
    if (/(酒精度|麦汁浓度)/.test(definition.propertyName) && number > 80) reasons.push("concentration_above_80");
  }
  if (/(酒精度|麦汁浓度)/.test(definition.propertyName)) {
    const joined = (values || []).map((value) => String(value.propertyValueName || "")).join(" ");
    if (/\b(?:ml|毫升|cl|厘升|l|升|g|克|kg|千克|公斤)\b/i.test(joined)) reasons.push("capacity_or_weight_used_as_concentration");
  }
  const confidence = Number(override?.evidence?.confidence ?? override?.evidence?.maxConfidence ?? 1);
  const source = String(override?.source || "");
  const evidenceReason = String(override?.evidence?.reason || "");
  if (UNCERTAIN_EVIDENCE_REASON_RE.test(evidenceReason)) {
    reasons.push("evidence_reason_indicates_inference_or_uncertainty");
  }
  const legacyValidatedDeepSeekSelect = source === "deepseek_semantic_exact_candidate"
    && override?.evidence?.provider === "deepseek"
    && Boolean(override?.evidence?.requestHash);
  if (FACT_FIELD_RE.test(definition.propertyName) && !EXPLICIT_SOURCES.has(source) && !legacyValidatedDeepSeekSelect) {
    reasons.push("fact_field_without_explicit_source");
  }
  if (FACT_FIELD_RE.test(definition.propertyName) && confidence < 0.8) reasons.push("fact_field_confidence_below_0_8");
  if (!FACT_FIELD_RE.test(definition.propertyName) && confidence < 0.8) reasons.push("semantic_confidence_below_0_8");
  const before = definition.currentValue || [];
  if (valueSignature(before) === valueSignature(values)) warnings.push("no_change");
  if ((before || []).length && !(values || []).length) reasons.push("would_clear_existing_value");
  return { reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], confidence, before };
}

function mergeSources(sources) {
  const merged = {};
  for (const source of sources) {
    for (const [skuCode, channels] of Object.entries(source.overrides || source || {})) {
      merged[skuCode] ||= {};
      for (const [channel, fields] of Object.entries(channels || {})) {
        merged[skuCode][channel] ||= {};
        Object.assign(merged[skuCode][channel], fields || {});
      }
    }
  }
  return merged;
}

function audit(contexts, sources) {
  const index = definitionIndex(contexts);
  const merged = mergeSources(sources);
  const approved = {};
  const changes = [];
  const blocked = [];
  const warnings = [];
  for (const [skuCode, channels] of Object.entries(merged)) {
    for (const [channel, fields] of Object.entries(channels || {})) {
      for (const [fieldId, override] of Object.entries(fields || {})) {
        const key = `${skuCode}:${channel}:${fieldId}`;
        const target = index.get(key);
        if (!target) {
          blocked.push({ skuCode, channel, fieldId, reasons: ["field_not_in_current_context"] });
          continue;
        }
        const result = auditEntry(target, override);
        const record = {
          skuCode,
          skuName: target.item.skuName,
          channel,
          fieldId,
          field: target.definition.propertyName,
          before: result.before,
          after: override.values,
          source: override.source,
          confidence: result.confidence,
        };
        if (result.reasons.length) {
          blocked.push({ ...record, reasons: result.reasons });
          continue;
        }
        approved[skuCode] ||= {};
        approved[skuCode][channel] ||= {};
        approved[skuCode][channel][fieldId] = override;
        changes.push(record);
        for (const warning of result.warnings) warnings.push({ ...record, warning });
      }
    }
  }
  const changed = changes.filter((record) => valueSignature(record.before) !== valueSignature(record.after));
  return {
    schema: "aoxiang-audited-semantic-overrides-v1",
    auditorVersion: AUDITOR_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      sourceProducts: Object.keys(merged).length,
      approvedProducts: Object.keys(approved).length,
      approvedFields: changes.length,
      actualChanges: changed.length,
      blockedFields: blocked.length,
      warnings: warnings.length,
    },
    overrides: approved,
    changes,
    blocked,
    warnings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.contexts || !args.out || !args.sources.length) {
    throw new Error("usage: --contexts file --source file [--source file ...] --out file");
  }
  const contexts = JSON.parse(await readFile(args.contexts, "utf8"));
  const sources = await Promise.all(args.sources.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const result = audit(contexts, sources);
  await writeFile(args.out, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}

export { AUDITOR_VERSION, audit, auditEntry, mergeSources, valueSignature };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
