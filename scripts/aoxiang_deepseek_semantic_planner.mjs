#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PLANNER_VERSION = "1.2.0";
const HIGH_EVIDENCE_FIELD_RE = /(许可证|许可编号|备案|注册证|批准文号|执行标准|认证证书|生产厂家|生产者|制造商|厂家联系方式|条码|型号|功率|电压|酒精度|麦汁浓度|营养|配料|成分含量|安全等级|安全类别|医疗器械分类|产地|国产\/进口|是否进口|材质|面料|填充物|颜色|尺寸|长度|线长|直径|厚度|净重|重量|容量|净含量|保质期|有效期|生产日期|数量|片数|支数|只数|页数|本数|枝数|朵数|插位数|接口数量|适用人数|适合人数|浓度|含量|是否|可否|APP控制|手机可连接)/;

const SYSTEM_PROMPT = `你是翱象商品渠道属性纠错助手。任务是根据同一商品的标题、规格、详情文本、商品图片OCR文字、当前平台候选项，同时修复美团(MT)与淘宝闪购(ELE)渠道属性。

硬规则：
1. 只能处理 candidate_items 中给出的 field_key，不能新增字段，不能修改类目ID，不能改变商品身份。
2. SELECT 的 value 必须逐字等于 candidates 中一个原文；MULTI_SELECT 必须返回 candidates 原文数组。没有合适候选返回 null，严禁发明候选。
3. INPUT_OPTION 返回 {"number":"数字或文本","unit":"单位候选原文"}。MULTI_INPUT_OPTION 若只有一个数值子项也返回该结构；若有多个数值子项，返回 {"numbers":["数字1","数字2"],"unit":"单位候选原文"}。INPUT 返回字符串。
4. 普通运营语义字段（品牌、商品类别、材质、功效、口味、包装方式、售卖方式、适用对象、款式等）可基于标题、规格和商品常识在候选项中判断。
5. 证号、备案号、许可证、厂家、型号、功率、电压、酒精度、麦汁浓度、容量/净含量、尺寸、数量、保质期、安全等级等事实字段，只能使用标题、规格、详情或同商品OCR中明确出现的事实；没有明确证据返回 null。500ml 只能表示容量，绝不能当作酒精度或麦汁浓度。
6. current_values 是该问题组当前保存值，可能正确也可能被平台驳回。若它与商品证据和语义明确一致可以保留；若不合理必须改选。不能为了省事无条件复用原值。
7. 同一商品的问题字段尽量完整覆盖。reason 必须简短说明依据。JSON之外不要输出任何文字。

输出JSON：
{"products":[{"request_id":"原值","items":[{"field_key":"原值","value":"值、数组、结构对象或null","confidence":0.0,"reason":"依据"}],"reason":"整体说明"}]}`;

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
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/&gt;/g, ">")
    .replace(/[\s_\-:：;；,，.。()（）【】\[\]{}'"“”‘’/\\%°+]/g, "")
    .replace(/毫升/g, "ml")
    .replace(/千克|公斤/g, "kg")
    .replace(/克/g, "g")
    .replace(/升/g, "l")
    .replace(/平方米/g, "㎡")
    .replace(/其它/g, "其他");
}

function normalizeFieldName(value) {
  const text = normalize(value);
  const aliases = {
    是否进口: "国产进口",
    国产进口: "国产进口",
    商品分类: "商品类别",
    单规格容量: "单件净含量",
    单品净含量: "单件净含量",
    每件净含量: "单件净含量",
    包装规格: "包装数量",
    主体材质: "材质",
    主面料材质: "面料成分",
    主面料成分: "面料成分",
  };
  if (aliases[text]) return aliases[text];
  if (/^酒精度(?:vol)?$/.test(text)) return "酒精度";
  if (/^麦汁浓度p?$/.test(text)) return "麦汁浓度";
  if (/^(?:额定)?功率w?$/.test(text)) return "功率";
  if (/^适用面积(?:㎡|m2)?$/.test(text)) return "适用面积";
  if (/^总净含量(?:g|kg|ml|l)?$/.test(text)) return "总净含量";
  if (/^单件净含量(?:g|kg|ml|l)?$/.test(text)) return "单件净含量";
  if (/^净含量(?:g|kg|ml|l)?$/.test(text)) return "净含量";
  return text;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function bigrams(value) {
  const text = normalize(value);
  const output = new Set();
  for (let index = 0; index < text.length - 1; index += 1) output.add(text.slice(index, index + 2));
  return output;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function optionScore(option, item, definition) {
  const name = String(option.propertyValueName || "");
  const normalizedName = normalize(name);
  const title = normalize(`${item.skuName} ${item.aliasName} ${item.subTitle} ${(item.specifications || []).join(" ")}`);
  const current = new Set((definition.currentValue || []).map((value) => normalize(value.propertyValueName)));
  const matched = new Set((definition.matchValue || []).map((value) => normalize(value.propertyValueName)));
  let score = 0;
  if (normalizedName && title.includes(normalizedName)) score += 10000 + normalizedName.length * 100;
  for (const part of name.split(/[\/（）()]/).map(normalize).filter((value) => value.length >= 2)) {
    if (title.includes(part)) score += 7000 + part.length * 80;
  }
  if (matched.has(normalizedName)) score += 1800;
  if (current.has(normalizedName)) score += 800;
  score += similarity(name, item.skuName) * 1000;
  if (/^(?:other\/)?其他$|^无品牌$/.test(normalizedName)) score -= 100;
  return score;
}

function selectOptions(item, definition, limit = 40) {
  const options = definition.optionalValue || [];
  if (options.length <= limit) return options;
  return options
    .map((option, index) => ({ option, index, score: optionScore(option, item, definition) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.option);
}

function ocrBySku(ocr) {
  const grouped = new Map();
  for (const record of ocr?.records || []) {
    const skuCode = String(record.skuCode || "");
    if (!skuCode) continue;
    const bucket = grouped.get(skuCode) || [];
    for (const observation of record.observations || []) {
      const text = String(observation.text || "").trim();
      if (text.length < 2 || Number(observation.confidence || 0) < 0.3) continue;
      bucket.push({ text, confidence: Number(observation.confidence || 0), url: record.url });
    }
    grouped.set(skuCode, bucket);
  }
  return grouped;
}

function compactOcr(records, item, maxLines = 80) {
  const seen = new Set();
  const title = `${item.skuName} ${item.issueFields?.join(" ") || ""}`;
  return (records || [])
    .filter((entry) => {
      const key = normalize(entry.text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({ ...entry, score: entry.confidence * 10 + similarity(entry.text, title) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxLines)
    .map((entry) => entry.text.slice(0, 120));
}

function candidateItem(item, channel, definition, optionLimit) {
  const options = selectOptions(item, definition, optionLimit);
  const childUnits = (definition.subCategoryPropertyList || [])
    .flatMap((child) => child.optionalValue || [])
    .map((option) => option.propertyValueName);
  return {
    field_key: `${channel}:${definition.propertyId}`,
    channel,
    attr_name: definition.propertyName,
    logical_name: normalizeFieldName(definition.propertyName),
    value_type: definition.valueType,
    current_values: (definition.currentValue || []).map((value) => value.propertyValueName),
    platform_match: (definition.matchValue || []).map((value) => value.propertyValueName),
    min: definition.minValue,
    max: definition.maxValue,
    text_max_length: definition.textMaxLength,
    candidates: options.map((option) => option.propertyValueName),
    unit_candidates: [
      ...(definition.valueType === "INPUT_OPTION" ? options.map((option) => option.propertyValueName) : []),
      ...childUnits,
    ],
  };
}

function productRequest(item, ocrRecords, options = {}) {
  const definitions = ["MT", "ELE"].flatMap((channel) =>
    (item.definitions?.[channel] || []).map((definition) => ({ channel, definition })),
  );
  return {
    request_id: String(item.skuCode),
    title: item.skuName,
    sku_specifications: item.specifications || [],
    issue_text: item.issueText,
    detail_text: String(item.description || "").slice(0, Number(options.descriptionMaxLength || 2200)),
    same_product_image_ocr: compactOcr(ocrRecords, item, Number(options.ocrMaxLines || 80)),
    candidate_items: definitions.map(({ channel, definition }) =>
      candidateItem(item, channel, definition, Number(options.optionLimit || 40)),
    ),
  };
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("model_response_not_json");
  }
}

function remoteRunnerSource(payload) {
  return `
process.chdir('/home/yuandian/backend');
require('/home/yuandian/backend/scripts/meituan_product_optimization_basic_info_fill.js');
const input = ${JSON.stringify(payload)};
const key = String(process.env.MEITUAN_ATTRIBUTE_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
const base = String(process.env.MEITUAN_ATTRIBUTE_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\\/+$/, '');
const model = String(process.env.MEITUAN_ATTRIBUTE_LLM_MODEL || process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash').trim();
if (!key) throw new Error('missing_llm_api_key');
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120000);
fetch(base + '/chat/completions', {
  method: 'POST',
  headers: {'content-type':'application/json', authorization:'Bearer ' + key},
  body: JSON.stringify({model, response_format:{type:'json_object'}, temperature:0.1, messages:[{role:'system',content:input.system},{role:'user',content:JSON.stringify(input.user)}]}),
  signal: controller.signal,
}).then(async response => {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || ('http_' + response.status));
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty_llm_response');
  process.stdout.write(JSON.stringify({model:body.model || model, usage:body.usage || null, content}));
}).catch(error => { process.stderr.write(String(error?.message || error)); process.exitCode=1; }).finally(() => clearTimeout(timer));
`;
}

function runRemote(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-S", "none", options.host || "s1", "node -"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("remote_llm_timeout"));
    }, Number(options.timeoutMs || 140000));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `remote_llm_exit_${code}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("remote_llm_invalid_envelope"));
        }
      }
    });
    child.stdin.end(remoteRunnerSource(payload));
  });
}

function exactOption(definition, wanted) {
  const target = String(wanted == null ? "" : wanted);
  return (definition.optionalValue || []).find((option) => String(option.propertyValueName) === target) || null;
}

function evidenceText(item, ocrRecords) {
  return [
    item.skuName,
    item.aliasName,
    item.subTitle,
    ...(item.specifications || []),
    item.description,
    ...(ocrRecords || []).map((entry) => entry.text),
  ].filter(Boolean).join(" ");
}

function numericTokens(value) {
  return String(value == null ? "" : value).match(/\d+(?:\.\d+)?/g) || [];
}

function normalizedUnit(value) {
  const unit = String(value || "").toLowerCase().replace(/\s+/g, "");
  const aliases = {
    毫升: "ml",
    厘升: "cl",
    升: "l",
    克: "g",
    千克: "kg",
    公斤: "kg",
    斤: "jin",
    米: "m",
    厘米: "cm",
    毫米: "mm",
    平方米: "m2",
    "㎡": "m2",
    "m²": "m2",
  };
  return aliases[unit] || unit;
}

function measurementFamily(unit) {
  if (["ml", "cl", "l"].includes(unit)) return "volume";
  if (["g", "kg", "jin"].includes(unit)) return "mass";
  if (["mm", "cm", "m"].includes(unit)) return "length";
  if (unit === "m2") return "area";
  return unit;
}

function measurementBase(number, unit) {
  const factors = { ml: 1, cl: 10, l: 1000, g: 1, kg: 1000, jin: 500, mm: 1, cm: 10, m: 1000, m2: 1 };
  return Number(number) * Number(factors[unit] || 1);
}

function explicitMeasurement(value, sourceText) {
  if (typeof value !== "object" || value == null || value.number == null || !value.unit) return null;
  const targetUnit = normalizedUnit(value.unit);
  const targetFamily = measurementFamily(targetUnit);
  const targetBase = measurementBase(value.number, targetUnit);
  const expression = /(\d+(?:\.\d+)?)\s*(ml|毫升|cl|厘升|l|升|g|克|kg|千克|公斤|斤|mm|毫米|cm|厘米|m²|㎡|平方米|m|米)/gi;
  let match;
  while ((match = expression.exec(sourceText)) !== null) {
    const sourceUnit = normalizedUnit(match[2]);
    if (measurementFamily(sourceUnit) !== targetFamily) continue;
    const sourceBase = measurementBase(match[1], sourceUnit);
    if (Math.abs(sourceBase - targetBase) <= Math.max(0.000001, Math.abs(targetBase) * 0.00001)) return true;
  }
  return false;
}

function hasExplicitEvidence(fieldName, value, sourceText) {
  if (!HIGH_EVIDENCE_FIELD_RE.test(fieldName)) return true;
  if (/(容量|净含量|净重|重量|长度|线长|尺寸|直径|厚度|适用面积)/.test(fieldName)) {
    const measurement = explicitMeasurement(value, sourceText);
    if (measurement != null) return measurement;
  }
  const tokens = numericTokens(typeof value === "object" ? value.number ?? value.text ?? JSON.stringify(value) : value);
  if (!tokens.length) {
    const wanted = normalize(typeof value === "object" ? value.text ?? JSON.stringify(value) : value);
    return wanted.length >= 2 && normalize(sourceText).includes(wanted);
  }
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (/麦汁浓度/.test(fieldName)) {
    return escaped.every((token) => new RegExp(`(?:原?麦(?:汁)?(?:浓度)?[^\\d]{0,8}${token}|${token}\\s*°?\\s*[pP]\\b)`, "i").test(sourceText));
  }
  if (/酒精度/.test(fieldName)) {
    return escaped.every((token) => new RegExp(`(?:酒精(?:度|含量)?[^\\d]{0,8}${token}|${token}\\s*(?:%\\s*vol|%vol|vol|度|°))`, "i").test(sourceText));
  }
  if (/功率/.test(fieldName)) {
    return escaped.every((token) => new RegExp(`(?:功率[^\\d]{0,8}${token}|${token}\\s*(?:w|瓦))`, "i").test(sourceText));
  }
  const sourceTokens = new Set(numericTokens(sourceText).map((token) => String(Number(token))));
  return tokens.every((token) => sourceTokens.has(String(Number(token))));
}

function materialize(definition, value) {
  if (value == null) return [];
  if (definition.valueType === "SELECT") {
    const option = exactOption(definition, value);
    return option ? [{ ...option, propertyValueType: "SELECT" }] : [];
  }
  if (definition.valueType === "MULTI_SELECT") {
    const requested = Array.isArray(value) ? value : [value];
    const options = requested.map((entry) => exactOption(definition, entry));
    return options.every(Boolean) ? options.map((option) => ({ ...option, propertyValueType: "SELECT" })) : [];
  }
  if (definition.valueType === "INPUT") {
    const text = String(value).trim();
    if (!text || (definition.textMaxLength && text.length > Number(definition.textMaxLength))) return [];
    const number = Number(text);
    if (definition.minValue != null && Number.isFinite(number) && number < Number(definition.minValue)) return [];
    if (definition.maxValue != null && Number.isFinite(number) && number > Number(definition.maxValue)) return [];
    return [{ propertyValueId: null, propertyValueName: text, propertyValueType: "INPUT" }];
  }
  if (definition.valueType === "INPUT_OPTION") {
    if (typeof value !== "object") return [];
    const text = String(value.number ?? value.text ?? "").trim();
    const unit = exactOption(definition, value.unit);
    if (!text || !unit) return [];
    const number = Number(text);
    if (definition.minValue != null && Number.isFinite(number) && number < Number(definition.minValue)) return [];
    if (definition.maxValue != null && Number.isFinite(number) && number > Number(definition.maxValue)) return [];
    return [
      { propertyValueId: null, propertyValueName: text, propertyValueType: "INPUT" },
      { ...unit, propertyValueType: "SELECT" },
    ];
  }
  if (definition.valueType === "MULTI_INPUT_OPTION") {
    if (typeof value !== "object" || value == null) return [];
    const children = definition.subCategoryPropertyList || [];
    if (!children.length) return [];
    const suppliedNumbers = Array.isArray(value.numbers)
      ? value.numbers.map((entry) => String(entry).trim())
      : value.number == null
        ? []
        : [String(value.number).trim()];
    let numberIndex = 0;
    const output = [];
    for (const child of children) {
      if (child.subValueType === "SELECT") {
        const unit = (child.optionalValue || []).find(
          (option) => String(option.propertyValueName) === String(value.unit || ""),
        );
        if (!unit) return [];
        output.push({ ...unit, propertyValueType: "SELECT" });
      } else if (child.subValueType === "READ_ONLY_INPUT") {
        output.push({ propertyValueId: null, propertyValueName: "×", propertyValueType: "READ_ONLY_INPUT" });
      } else {
        const text = suppliedNumbers[numberIndex++];
        if (!text) return [];
        const number = Number(text);
        if (child.minValue != null && Number.isFinite(number) && number < Number(child.minValue)) return [];
        if (child.maxValue != null && Number.isFinite(number) && number > Number(child.maxValue)) return [];
        output.push({
          propertyValueId: null,
          propertyValueName: text,
          propertyValueType: child.subValueType || "INPUT",
        });
      }
    }
    return numberIndex === suppliedNumbers.length ? output : [];
  }
  return [];
}

function validateProductDecision(item, response, ocrRecords, meta, options = {}) {
  const definitions = new Map(["MT", "ELE"].flatMap((channel) =>
    (item.definitions?.[channel] || []).map((definition) => [
      `${channel}:${definition.propertyId}`,
      { channel, definition },
    ]),
  ));
  const sourceText = evidenceText(item, ocrRecords);
  const accepted = [];
  const unresolved = [];
  const seen = new Set();
  const threshold = Number(options.minConfidence || 0.6);
  for (const decision of response?.items || []) {
    const fieldKey = String(decision.field_key || "");
    const target = definitions.get(fieldKey);
    if (!target || seen.has(fieldKey)) continue;
    const { channel, definition } = target;
    seen.add(fieldKey);
    if (decision.value == null) {
      unresolved.push({ fieldKey, channel, field: definition.propertyName, reason: decision.reason || "model_returned_null" });
      continue;
    }
    const confidence = Number(decision.confidence || 0);
    if (confidence < threshold) {
      unresolved.push({ fieldKey, channel, field: definition.propertyName, reason: "low_confidence", confidence });
      continue;
    }
    const values = materialize(definition, decision.value);
    if (!values.length) {
      unresolved.push({ fieldKey, channel, field: definition.propertyName, reason: "invalid_or_out_of_candidate_value", value: decision.value });
      continue;
    }
    if (!hasExplicitEvidence(definition.propertyName, decision.value, sourceText)) {
      unresolved.push({ fieldKey, channel, field: definition.propertyName, reason: "missing_explicit_same_product_evidence", value: decision.value });
      continue;
    }
    accepted.push({
      fieldKey,
      channel,
      field: definition.propertyName,
      fieldId: String(definition.propertyId),
      values,
      source: HIGH_EVIDENCE_FIELD_RE.test(definition.propertyName)
        ? "deepseek_explicit_same_product_fact"
        : definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT"
          ? "deepseek_semantic_exact_candidate"
          : "deepseek_semantic_text",
      evidence: {
        provider: "deepseek",
        model: meta.model,
        confidence,
        reason: decision.reason || "",
        requestHash: meta.requestHash,
      },
    });
  }
  for (const [fieldKey, target] of definitions) {
    if (!seen.has(fieldKey)) unresolved.push({
      fieldKey,
      channel: target.channel,
      field: target.definition.propertyName,
      reason: "model_omitted_field",
    });
  }
  return { accepted, unresolved };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function plan(items, ocr, options = {}) {
  const groupedOcr = ocrBySku(ocr);
  const requests = items.map((item) => productRequest(item, groupedOcr.get(String(item.skuCode)), options));
  const batches = chunks(requests, Number(options.batchSize || 4));
  const cachedCalls = new Map((options.cachedCalls || []).map((call) => [call.requestHash, call]));
  const calls = await mapWithConcurrency(batches, Number(options.concurrency || 4), async (products, batchIndex) => {
    const user = { products };
    const requestHash = createHash("sha256").update(JSON.stringify(user)).digest("hex");
    const cached = cachedCalls.get(requestHash);
    if (cached?.response && products.every((product) => cached.requestIds?.includes(product.request_id))) {
      return { ...cached, batchIndex, cached: true };
    }
    let lastError;
    for (let attempt = 1; attempt <= Number(options.retries || 3); attempt += 1) {
      try {
        const envelope = await runRemote({ system: SYSTEM_PROMPT, user }, options);
        const response = extractJson(envelope.content);
        const returnedIds = new Set((response.products || []).map((product) => String(product.request_id)));
        const missingIds = products.map((product) => String(product.request_id)).filter((requestId) => !returnedIds.has(requestId));
        if (missingIds.length) throw new Error(`model_omitted_products:${missingIds.join(",")}`);
        const call = {
          batchIndex,
          requestHash,
          requestIds: products.map((product) => product.request_id),
          attempt,
          model: envelope.model,
          usage: envelope.usage,
          response,
        };
        if (options.onCall) await options.onCall(call);
        return call;
      } catch (error) {
        lastError = error;
      }
    }
    const call = {
      batchIndex,
      requestHash,
      requestIds: products.map((product) => product.request_id),
      error: String(lastError?.message || lastError || "unknown_llm_error"),
    };
    if (options.onCall) await options.onCall(call);
    return call;
  });

  const responseBySku = new Map();
  for (const call of calls) {
    for (const response of call.response?.products || []) {
      responseBySku.set(String(response.request_id), { response, call });
    }
  }
  const overrides = {};
  const decisions = [];
  const unresolved = [];
  for (const item of items) {
    const skuCode = String(item.skuCode);
    const matched = responseBySku.get(skuCode);
    if (!matched) {
      unresolved.push({ skuCode, reason: "missing_product_response" });
      continue;
    }
    const validated = validateProductDecision(
      item,
      matched.response,
      groupedOcr.get(skuCode),
      { model: matched.call.model, requestHash: matched.call.requestHash },
      options,
    );
    if (validated.accepted.length) {
      overrides[skuCode] = {};
      for (const accepted of validated.accepted) {
        overrides[skuCode][accepted.channel] ||= {};
        overrides[skuCode][accepted.channel][accepted.fieldId] = {
          values: accepted.values,
          source: accepted.source,
          evidence: accepted.evidence,
        };
      }
    }
    decisions.push({ skuCode, accepted: validated.accepted, unresolved: validated.unresolved });
    unresolved.push(...validated.unresolved.map((entry) => ({ skuCode, ...entry })));
  }
  return {
    schema: "aoxiang-deepseek-semantic-overrides-v1",
    plannerVersion: PLANNER_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      products: items.length,
      calls: calls.length,
      failedCalls: calls.filter((call) => call.error).length,
      acceptedProducts: Object.keys(overrides).length,
      acceptedFields: decisions.reduce((total, decision) => total + decision.accepted.length, 0),
      unresolvedFields: unresolved.length,
      promptTokens: calls.reduce((total, call) => total + Number(call.usage?.prompt_tokens || 0), 0),
      completionTokens: calls.reduce((total, call) => total + Number(call.usage?.completion_tokens || 0), 0),
    },
    calls: calls.map(({ response, ...receipt }) => receipt),
    decisions,
    unresolved,
    overrides,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["contexts", "out"]) if (!args[required]) throw new Error(`missing --${required}`);
  const contexts = JSON.parse(await readFile(args.contexts, "utf8"));
  const ocr = args.ocr ? JSON.parse(await readFile(args.ocr, "utf8")) : { records: [] };
  const offset = Math.max(0, Number(args.offset || 0));
  const limit = args.limit == null ? contexts.items.length : Math.max(0, Number(args.limit));
  const items = contexts.items.slice(offset, offset + limit).filter((item) => !item.error && item.definitions?.ELE?.length);
  const callsPath = args["calls-out"] || `${args.out}.calls.json`;
  let cachedCalls = [];
  try {
    cachedCalls = JSON.parse(await readFile(callsPath, "utf8")).calls || [];
  } catch {
    cachedCalls = [];
  }
  const progressCalls = new Map(cachedCalls.map((call) => [call.requestHash, call]));
  let progressWrite = Promise.resolve();
  const result = await plan(items, ocr, {
    batchSize: Number(args["batch-size"] || 4),
    concurrency: Number(args.concurrency || 4),
    retries: Number(args.retries || 3),
    minConfidence: Number(args["min-confidence"] || 0.6),
    optionLimit: Number(args["option-limit"] || 40),
    host: args.host || "s1",
    cachedCalls,
    onCall(call) {
      progressCalls.set(call.requestHash, call);
      progressWrite = progressWrite.then(() => writeFile(callsPath, JSON.stringify({
        schema: "aoxiang-deepseek-call-checkpoint-v1",
        plannerVersion: PLANNER_VERSION,
        updatedAt: new Date().toISOString(),
        calls: [...progressCalls.values()],
      }, null, 2)));
      return progressWrite;
    },
  });
  await progressWrite;
  await writeFile(args.out, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}

export {
  PLANNER_VERSION,
  SYSTEM_PROMPT,
  hasExplicitEvidence,
  materialize,
  normalizeFieldName,
  plan,
  productRequest,
  selectOptions,
  validateProductDecision,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
