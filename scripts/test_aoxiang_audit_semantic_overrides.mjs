#!/usr/bin/env node

import assert from "node:assert/strict";
import { audit } from "./aoxiang_audit_semantic_overrides.mjs";

const contexts = {
  items: [{
    skuCode: "05155",
    skuName: "麦克雷 烈性啤酒IPA 原麦汁浓度 500ml*3罐",
    definitions: {
      ELE: [{
        propertyId: "wort",
        propertyName: "麦汁浓度(°P)",
        valueType: "INPUT_OPTION",
        minValue: 0,
        maxValue: 80,
        currentValue: [{ propertyValueId: null, propertyValueName: "12", propertyValueType: "INPUT" }],
        optionalValue: [{ propertyValueId: "p", propertyValueName: "°P" }],
      }],
      MT: [{
        propertyId: "brand",
        propertyName: "品牌",
        valueType: "SELECT",
        currentValue: [],
        optionalValue: [{ propertyValueId: "mc", propertyValueName: "麦克雷" }],
      }],
    },
  }],
};
const source = { overrides: {
  "05155": {
    ELE: {
      wort: {
        values: [
          { propertyValueId: null, propertyValueName: "500", propertyValueType: "INPUT" },
          { propertyValueId: "p", propertyValueName: "°P", propertyValueType: "SELECT" },
        ],
        source: "deepseek_explicit_same_product_fact",
        evidence: { confidence: 1 },
      },
    },
    MT: {
      brand: {
        values: [{ propertyValueId: "mc", propertyValueName: "麦克雷", propertyValueType: "SELECT" }],
        source: "deepseek_semantic_exact_candidate",
        evidence: { confidence: 1 },
      },
    },
  },
} };
const result = audit(contexts, [source]);
assert.equal(result.summary.approvedFields, 1);
assert.equal(result.summary.blockedFields, 1);
assert.equal(result.blocked[0].reasons.includes("concentration_above_80"), true);
assert.equal(result.overrides["05155"].MT.brand.values[0].propertyValueName, "麦克雷");

const invalidSelect = structuredClone(source);
invalidSelect.overrides["05155"].MT.brand.values[0].propertyValueId = "wrong";
const invalidResult = audit(contexts, [invalidSelect]);
assert.equal(invalidResult.blocked.some((entry) => entry.reasons.includes("select_not_exact_platform_candidate")), true);

const legacyValidated = structuredClone(source);
legacyValidated.overrides["05155"].MT.brand.source = "deepseek_semantic_exact_candidate";
legacyValidated.overrides["05155"].MT.brand.evidence = {
  provider: "deepseek",
  requestHash: "validated-by-planner-1-1",
  confidence: 1,
};
const legacyResult = audit(contexts, [legacyValidated]);
assert.equal(legacyResult.overrides["05155"].MT.brand.values[0].propertyValueName, "麦克雷");

const uncertain = structuredClone(source);
uncertain.overrides["05155"].MT.brand.evidence.reason = "通常使用该品牌，常识判断";
const uncertainResult = audit(contexts, [uncertain]);
assert.equal(uncertainResult.blocked.some(
  (entry) => entry.reasons.includes("evidence_reason_indicates_inference_or_uncertainty"),
), true);

const validatedPlatformMatch = structuredClone(source);
validatedPlatformMatch.overrides["05155"].ELE.wort.values[0].propertyValueName = "12";
validatedPlatformMatch.overrides["05155"].ELE.wort.source = "platform_match_validated";
validatedPlatformMatch.overrides["05155"].ELE.wort.evidence = {
  provider: "platform_match",
  confidence: 1,
  reason: "平台推荐与同品图片标注交叉验证",
};
const platformResult = audit(contexts, [validatedPlatformMatch]);
assert.equal(platformResult.overrides["05155"].ELE.wort.values[0].propertyValueName, "12");

process.stdout.write(`${JSON.stringify({ ok: true, cases: 8 })}\n`);
