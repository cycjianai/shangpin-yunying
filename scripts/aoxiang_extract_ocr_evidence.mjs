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

function cleanText(text) {
  return String(text || "")
    .replace(/[\s:：;；,，。]+/g, "")
    .replace(/[（(]/g, "（")
    .replace(/[）)]/g, "）")
    .replace(/[粵粤專]/g, "粤")
    .replace(/[護护泸]/g, "沪")
    .replace(/G收网/g, "G妆网")
    .replace(/G枚网/g, "G妆网")
    .replace(/妆同留字/g, "妆网备字")
    .replace(/妆网货字/g, "妆网备字")
    .replace(/妆网备宇/g, "妆网备字");
}

function addCandidate(map, value, record, observation, kind) {
  if (!value) return;
  const key = value.replace(/\s+/g, "");
  const current = map.get(key) || { value: key, kind, occurrences: 0, maxConfidence: 0, evidence: [] };
  current.occurrences += 1;
  current.maxConfidence = Math.max(current.maxConfidence, Number(observation.confidence || 0));
  current.evidence.push({
    url: record.url,
    mediaIndex: record.mediaIndex,
    text: observation.text,
    confidence: observation.confidence,
  });
  map.set(key, current);
}

function extractForSku(records) {
  const licenses = new Map();
  const registrations = new Map();
  const alcohol = new Map();
  const wort = new Map();
  for (const record of records) {
    for (const observation of record.observations || []) {
      const cleaned = cleanText(observation.text);
      for (const match of cleaned.matchAll(/([粤沪浙苏鲁京闽川赣鄂皖豫湘桂琼陕云津冀晋辽吉黑甘青贵新宁藏]妆20\d{6})/g)) {
        addCandidate(licenses, match[1], record, observation, "cosmetic_license");
      }
      const registrationPatterns = [
        /([粤沪浙苏鲁京闽川赣鄂皖豫湘桂琼陕云津冀晋辽吉黑甘青贵新宁藏]G妆网备字20\d{8})/g,
        /(国妆网备进字（[粤沪浙苏鲁京闽川赣鄂皖豫湘桂琼陕云津冀晋辽吉黑甘青贵新宁藏]）20\d{8})/g,
        /(国妆备进字J20\d{6})/g,
        /(国妆特字(?:G|20)\d{6,8})/g,
      ];
      for (const pattern of registrationPatterns) {
        for (const match of cleaned.matchAll(pattern)) addCandidate(registrations, match[1], record, observation, "cosmetic_registration");
      }

      const alcoholPatterns = [
        /酒精(?:度|含量|液度)?[^\d]{0,4}[≥>]?\s*(\d+(?:\.\d+)?)\s*(?:%?vol|%|度|°)/ig,
        /(\d+(?:\.\d+)?)\s*(?:%?vol)\b/ig,
      ];
      for (const pattern of alcoholPatterns) {
        for (const match of observation.text.matchAll(pattern)) {
          const value = Number(match[1]);
          if (value >= 0 && value <= 100) addCandidate(alcohol, String(value), record, observation, "alcohol_percent_vol");
        }
      }

      const wortPatterns = [
        /(?:原)?麦(?:汁)?浓度[^\d]{0,4}(\d+(?:\.\d+)?)\s*(?:°\s*P?|P\b)/ig,
        /原麦汁[^\d]{0,4}(\d+(?:\.\d+)?)\s*(?:°\s*P?|P\b)/ig,
      ];
      for (const pattern of wortPatterns) {
        for (const match of observation.text.matchAll(pattern)) {
          const value = Number(match[1]);
          if (value >= 0 && value <= 80) addCandidate(wort, String(value), record, observation, "wort_degree_plato");
        }
      }
    }
  }
  const sort = (values) => [...values.values()].sort((a, b) => b.occurrences - a.occurrences || b.maxConfidence - a.maxConfidence);
  return { licenses: sort(licenses), registrations: sort(registrations), alcohol: sort(alcohol), wort: sort(wort) };
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["ocr", "checkpoint", "out"]) {
  if (!args[required]) throw new Error(`missing --${required}`);
}

const ocr = JSON.parse(await readFile(args.ocr, "utf8"));
const checkpoint = JSON.parse(await readFile(args.checkpoint, "utf8"));
const grouped = Object.groupBy(ocr.records || [], (record) => record.skuCode);
const items = {};
for (const [skuCode, records] of Object.entries(grouped)) {
  const item = checkpoint.items?.[skuCode];
  items[skuCode] = {
    skuCode,
    skuName: item?.skuName || "",
    blockerFields: [...new Set((item?.blockers || []).map((blocker) => blocker.field))],
    candidates: extractForSku(records),
  };
}

const output = {
  schema: "aoxiang-ocr-evidence-candidates-v1",
  generatedAt: new Date().toISOString(),
  items,
};
await writeFile(args.out, JSON.stringify(output, null, 2));

const summary = {
  items: Object.keys(items).length,
  uniqueLicense: Object.values(items).filter((item) => item.candidates.licenses.length === 1).length,
  uniqueRegistration: Object.values(items).filter((item) => item.candidates.registrations.length === 1).length,
  uniqueAlcohol: Object.values(items).filter((item) => item.candidates.alcohol.length === 1).length,
  uniqueWort: Object.values(items).filter((item) => item.candidates.wort.length === 1).length,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
