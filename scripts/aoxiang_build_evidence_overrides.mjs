#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    output[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return output;
}

function optionName(option) {
  return String(option?.propertyValueName || "");
}

function options(definition) {
  const direct = definition?.optionalValue || [];
  const nested = (definition?.subCategoryPropertyList || []).flatMap((child) => child.optionalValue || []);
  return [...direct, ...nested];
}

function inputValues(definition, value, unitPattern = null) {
  if (definition.valueType === "INPUT") {
    return [{ propertyValueId: null, propertyValueName: String(value), propertyValueType: "INPUT" }];
  }
  if (definition.valueType === "INPUT_OPTION" || definition.valueType === "MULTI_INPUT_OPTION") {
    const unit = options(definition).find((option) => unitPattern?.test(optionName(option)));
    if (!unit) return null;
    return [
      { propertyValueId: null, propertyValueName: String(value), propertyValueType: "INPUT" },
      { propertyValueId: String(unit.propertyValueId), propertyValueName: optionName(unit), propertyValueType: "SELECT" },
    ];
  }
  return null;
}

function unambiguous(candidates) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && candidates[0].occurrences >= Math.max(3, candidates[1].occurrences * 3)) return candidates[0];
  return null;
}

function putOverride(overrides, skuCode, channel, definition, candidate, unitPattern = null) {
  const values = inputValues(definition, candidate.value, unitPattern);
  if (!values) return false;
  overrides[skuCode] ||= {};
  overrides[skuCode][channel] ||= {};
  overrides[skuCode][channel][String(definition.propertyId)] = {
    values,
    source: "same_product_media_ocr",
    evidence: {
      value: candidate.value,
      occurrences: candidate.occurrences,
      maxConfidence: candidate.maxConfidence,
      urls: [...new Set(candidate.evidence.map((entry) => entry.url))],
      snippets: [...new Set(candidate.evidence.map((entry) => entry.text))].slice(0, 5),
    },
  };
  return true;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["candidates", "definitions", "out"]) {
  if (!args[required]) throw new Error(`missing --${required}`);
}

const candidates = JSON.parse(await readFile(args.candidates, "utf8"));
const definitions = JSON.parse(await readFile(args.definitions, "utf8"));
const baseOverrides = args.base
  ? JSON.parse(await readFile(args.base, "utf8")).overrides || {}
  : {};
const overrides = structuredClone(baseOverrides);
const summary = { license: 0, registration: 0, alcohol: 0, wort: 0 };

for (const [skuCode, item] of Object.entries(candidates.items || {})) {
  const byChannel = definitions.results?.[skuCode] || {};
  for (const [channel, list] of Object.entries(byChannel)) {
    for (const definition of list || []) {
      let candidate = null;
      let kind = null;
      let unitPattern = null;
      if (/化妆品生产许可证/.test(definition.propertyName)) {
        candidate = unambiguous(item.candidates.licenses || []);
        kind = "license";
      } else if (/备案编号|注册证号/.test(definition.propertyName)) {
        candidate = unambiguous(item.candidates.registrations || []);
        kind = "registration";
      } else if (/酒精度/.test(definition.propertyName)) {
        candidate = unambiguous(item.candidates.alcohol || []);
        kind = "alcohol";
        unitPattern = /%\s*vol/i;
      } else if (/麦汁浓度/.test(definition.propertyName)) {
        candidate = unambiguous(item.candidates.wort || []);
        kind = "wort";
        unitPattern = /°\s*P/i;
      }
      if (candidate && putOverride(overrides, skuCode, channel, definition, candidate, unitPattern)) summary[kind] += 1;
    }
  }
}

const manual = {
  "05155": {
    alcohol: { value: "4.5", url: "https://img.alicdn.com/imgextra/i4/1/O1CN01OpjtBI1BsVUzucY8R_!!1-2-tcretail.png" },
    wort: { value: "12", url: "https://img.alicdn.com/imgextra/i4/1/O1CN01OpjtBI1BsVUzucY8R_!!1-2-tcretail.png" },
  },
  "1013365": {
    alcohol: { value: "4", url: "same_product_media_ocr:label_line" },
    wort: { value: "10", url: "same_product_media_ocr:label_line" },
  },
  "1013358": {
    alcohol: { value: "52", url: "same_product_title_and_media:52度白酒" },
  },
};

overrides["05155"] = {
  MT: {
    "1200256821": {
      values: [{ propertyValueName: "4.5", propertyValueType: "INPUT" }, { propertyValueId: "500", propertyValueName: "%vol", propertyValueType: "SELECT" }],
      source: "same_product_media_evidence",
      evidence: { value: "4.5", urls: [manual["05155"].alcohol.url], snippets: ["酒精度4.5°"] },
    },
    "1200256820": {
      values: [{ propertyValueName: "12", propertyValueType: "INPUT" }, { propertyValueId: "501", propertyValueName: "°P", propertyValueType: "SELECT" }],
      source: "same_product_media_evidence",
      evidence: { value: "12", urls: [manual["05155"].wort.url], snippets: ["原麦浓度12°"] },
    },
  },
  ELE: {
    "606286534": {
      values: [{ propertyValueName: "4.5", propertyValueType: "INPUT" }, { propertyValueId: "1219214", propertyValueName: "%vol", propertyValueType: "SELECT" }],
      source: "same_product_media_evidence",
      evidence: { value: "4.5", urls: [manual["05155"].alcohol.url], snippets: ["酒精度4.5°"] },
    },
    "606286833": {
      values: [{ propertyValueName: "12", propertyValueType: "INPUT" }, { propertyValueId: "5536", propertyValueName: "°P", propertyValueType: "SELECT" }],
      source: "same_product_media_evidence",
      evidence: { value: "12", urls: [manual["05155"].wort.url], snippets: ["原麦浓度12°"] },
    },
  },
};

for (const [skuCode, values] of Object.entries(manual)) {
  const byChannel = definitions.results?.[skuCode] || {};
  for (const [channel, list] of Object.entries(byChannel)) {
    for (const definition of list || []) {
      const pair = /酒精度/.test(definition.propertyName)
        ? [values.alcohol, /%\s*vol/i]
        : /麦汁浓度/.test(definition.propertyName)
          ? [values.wort, /°\s*P/i]
          : [null, null];
      if (!pair[0]) continue;
      putOverride(overrides, skuCode, channel, definition, {
        value: pair[0].value,
        occurrences: 1,
        maxConfidence: 1,
        evidence: [{ url: pair[0].url, text: pair[0].value }],
      }, pair[1]);
    }
  }
}

if (args["field-overrides"]) {
  const fieldOverrides = JSON.parse(await readFile(args["field-overrides"], "utf8")).overrides || {};
  for (const [skuCode, channels] of Object.entries(fieldOverrides)) {
    overrides[skuCode] ||= {};
    for (const [channel, fields] of Object.entries(channels)) {
      overrides[skuCode][channel] ||= {};
      Object.assign(overrides[skuCode][channel], fields);
    }
  }
}

await writeFile(args.out, JSON.stringify({ schema: "aoxiang-evidence-overrides-v1", generatedAt: new Date().toISOString(), summary, overrides }, null, 2));
process.stdout.write(`${JSON.stringify({ ...summary, skus: Object.keys(overrides).length })}\n`);
