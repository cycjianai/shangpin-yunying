#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const engine = require("./aoxiang_channel_engine.js");
const test = engine._test;

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    output[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return output;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[\s_\-:：;；,，.。()（）【】\[\]\/\\]+/g, "");
}

function valueKey(values) {
  return JSON.stringify(values.map((value) => [String(value.propertyValueId || ""), String(value.propertyValueName || "")]));
}

function fieldPattern(field) {
  const exact = String(field || "").replace(/[（(].*$/, "");
  const aliases = [exact];
  const rules = [
    [/材质|面料成分/, ["材质", "面料", "成分", "杯体", "杯身", "内胆"]],
    [/填充物/, ["填充物", "填充材质", "填充"]],
    [/功率/, ["功率", "额定功率", "输出功率"]],
    [/尺寸|直径|厚度|线长|容量|净重/, [exact, "规格", "产品尺寸"]],
    [/包装数量/, ["包装数量", "包装规格", "数量"]],
    [/商品类别/, ["商品类别", "产品类别", "类别"]],
    [/颜色/, ["颜色", "色号", "色泽"]],
    [/香型/, ["香型", "香调"]],
    [/控制方式/, ["控制方式", "操作方式"]],
    [/供电方式|充电模式/, ["供电方式", "充电方式", "供电", "电源"]],
    [/接口/, [exact, "接口", "插头"]],
    [/是否|可否|支持|APP控制/i, [exact]],
  ];
  for (const [pattern, values] of rules) if (pattern.test(field)) aliases.push(...values);
  return new RegExp([...new Set(aliases.filter((item) => item.length >= 2))].map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
}

function optionValue(definition, wanted) {
  const target = normalize(wanted);
  const option = (definition.optionalValue || []).find((item) => normalize(item.propertyValueName) === target);
  return option ? [structuredClone(option)] : [];
}

function booleanValues(definition, field, context) {
  if (!/是否|可否|支持|APP控制/i.test(field)) return [];
  const compact = normalize(context);
  const negative = /不支持|不可|不能|无|否/.test(compact);
  const positive = !negative && /支持|可以|可|是/.test(compact);
  if (!negative && !positive) return [];
  const preferences = negative ? ["否", "不支持", "不可", "无"] : ["是", "支持", "可以"];
  for (const preference of preferences) {
    const found = optionValue(definition, preference);
    if (found.length) return found;
  }
  return [];
}

function dimensionValues(definition, context) {
  if (definition.valueType !== "MULTI_INPUT_OPTION") return [];
  const match = context.match(/(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)(?:\s*[*xX×]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m|毫米|厘米|米)/i);
  if (!match) return [];
  const numbers = [match[1], match[2], match[3]].filter(Boolean);
  let numberIndex = 0;
  const unitWanted = normalize(match[4]).replace("毫米", "mm").replace("厘米", "cm").replace("米", "m");
  const raw = [];
  for (const child of definition.subCategoryPropertyList || []) {
    if (child.subValueType === "SELECT") {
      const unit = (child.optionalValue || []).find((option) => normalize(option.propertyValueName) === unitWanted);
      if (!unit) return [];
      raw.push(unit);
    } else {
      if (numberIndex >= numbers.length) return [];
      raw.push({ propertyValueName: numbers[numberIndex], propertyValueType: child.subValueType || "INPUT" });
      numberIndex += 1;
    }
  }
  return test.materializeValues(definition, raw);
}

function planFromContext(definition, field, context) {
  let values = booleanValues(definition, field, context);
  if (!test.isValidValues(definition, values) && /尺寸|长.?x.?宽/i.test(field)) values = dimensionValues(definition, context);
  if (!test.isValidValues(definition, values) && (definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT")) {
    values = test.chooseOptionByTitle(definition, field, context);
    if (values.some((value) => /其他|通用|普通/.test(value.propertyValueName || ""))) values = [];
  }
  if (!test.isValidValues(definition, values) && /包装数量|插位数|数量|页数|伞骨数量|内胆数量/.test(field)) {
    values = test.chooseCount(definition, field, context);
  }
  if (!test.isValidValues(definition, values) && /功率|电池容量|尺寸|直径|厚度|线长|容量|净重|适用床尺寸/.test(field)) {
    values = test.chooseMeasurement(definition, field, context);
  }
  return test.isValidValues(definition, values) ? values : [];
}

function candidateFor(definition, field, records) {
  const pattern = fieldPattern(field);
  const candidates = new Map();
  for (const record of records) {
    const lines = (record.observations || []).map((observation) => observation.text);
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue;
      const context = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(" ");
      const values = planFromContext(definition, field, context);
      if (!values.length) continue;
      const key = valueKey(values);
      const current = candidates.get(key) || { values, occurrences: 0, evidence: [] };
      current.occurrences += 1;
      current.evidence.push({ url: record.url, mediaIndex: record.mediaIndex, context });
      candidates.set(key, current);
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.occurrences - a.occurrences);
  if (ranked.length === 1) return ranked[0];
  if (ranked.length > 1 && ranked[0].occurrences >= Math.max(3, ranked[1].occurrences * 3)) return ranked[0];
  return null;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["ocr", "checkpoint", "definitions", "out"]) if (!args[required]) throw new Error(`missing --${required}`);
const ocr = JSON.parse(await readFile(args.ocr, "utf8"));
const checkpoint = JSON.parse(await readFile(args.checkpoint, "utf8"));
const definitions = JSON.parse(await readFile(args.definitions, "utf8"));
const grouped = Object.groupBy(ocr.records || [], (record) => record.skuCode);
const overrides = {};
const accepted = [];

for (const [skuCode, item] of Object.entries(checkpoint.items || {})) {
  if (item.state !== "blocked") continue;
  const records = grouped[skuCode] || [];
  const seen = new Set();
  for (const blocker of item.blockers || []) {
    const blockerKey = `${blocker.channel}:${blocker.fieldId}`;
    if (seen.has(blockerKey)) continue;
    seen.add(blockerKey);
    const definition = (definitions.results?.[skuCode]?.[blocker.channel] || []).find((entry) => String(entry.propertyId) === String(blocker.fieldId));
    if (!definition) continue;
    const candidate = candidateFor(definition, blocker.field, records);
    if (!candidate) continue;
    overrides[skuCode] ||= {};
    overrides[skuCode][blocker.channel] ||= {};
    overrides[skuCode][blocker.channel][String(definition.propertyId)] = {
      values: candidate.values,
      source: "same_product_media_ocr_field_context",
      evidence: {
        occurrences: candidate.occurrences,
        urls: [...new Set(candidate.evidence.map((entry) => entry.url))],
        contexts: [...new Set(candidate.evidence.map((entry) => entry.context))].slice(0, 5),
      },
    };
    accepted.push({ skuCode, channel: blocker.channel, field: blocker.field, values: candidate.values.map((value) => value.propertyValueName), occurrences: candidate.occurrences });
  }
}

await writeFile(args.out, JSON.stringify({ schema: "aoxiang-ocr-field-overrides-v1", generatedAt: new Date().toISOString(), accepted, overrides }, null, 2));
process.stdout.write(`${JSON.stringify({ skus: Object.keys(overrides).length, fields: accepted.length })}\n`);
