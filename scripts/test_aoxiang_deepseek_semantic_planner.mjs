#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  hasExplicitEvidence,
  materialize,
  normalizeFieldName,
  productRequest,
  selectOptions,
  validateProductDecision,
} from "./aoxiang_deepseek_semantic_planner.mjs";

assert.equal(normalizeFieldName("酒精度(%vol)"), "酒精度");
assert.equal(normalizeFieldName("功率（W）"), "功率");
assert.equal(hasExplicitEvidence("麦汁浓度(°P)", { number: "12", unit: "°P" }, "原麦汁浓度12°P"), true);
assert.equal(hasExplicitEvidence("麦汁浓度(°P)", { number: "500", unit: "°P" }, "容量500ml"), false);
assert.equal(hasExplicitEvidence("酒精度(%vol)", { number: "12", unit: "%vol" }, "容量500ml"), false);
assert.equal(hasExplicitEvidence("总净含量", { number: "1250", unit: "ml" }, "规格1.25L/瓶"), true);
assert.equal(hasExplicitEvidence("总净含量", { number: "200", unit: "ml" }, "规格20CL/瓶"), true);
assert.equal(hasExplicitEvidence("净含量", { number: "200", unit: "g" }, "规格200ml/瓶"), false);
assert.equal(hasExplicitEvidence("材质", "塑料", "手机支架/个"), false);
assert.equal(hasExplicitEvidence("材质", "316不锈钢", "316不锈钢保温杯"), true);

const brandDefinition = {
  propertyId: "1",
  propertyName: "品牌",
  valueType: "SELECT",
  optionalValue: [
    { propertyValueId: "a", propertyValueName: "other/其他" },
    { propertyValueId: "b", propertyValueName: "McCray/麦克雷" },
    { propertyValueId: "c", propertyValueName: "测试品牌" },
  ],
  currentValue: [{ propertyValueName: "other/其他" }],
  matchValue: [{ propertyValueName: "other/其他" }],
};
const item = {
  skuCode: "05155",
  skuName: "麦克雷 烈性啤酒IPA 500ml*3罐",
  issueText: "缺失属性:品牌",
  issueFields: ["品牌"],
  specifications: [],
  definitions: { ELE: [brandDefinition] },
};
assert.equal(selectOptions(item, brandDefinition, 2)[0].propertyValueName, "McCray/麦克雷");
assert.deepEqual(materialize(brandDefinition, "McCray/麦克雷").map((value) => value.propertyValueId), ["b"]);
assert.equal(productRequest(item, [], { optionLimit: 2 }).candidate_items[0].candidates[0], "McCray/麦克雷");

const inputOptionDefinition = {
  propertyId: "2",
  propertyName: "麦汁浓度(°P)",
  valueType: "INPUT_OPTION",
  optionalValue: [{ propertyValueId: "u", propertyValueName: "°P" }],
  minValue: 0,
  maxValue: 80,
};
assert.deepEqual(
  materialize(inputOptionDefinition, { number: "12", unit: "°P" }).map((value) => value.propertyValueName),
  ["12", "°P"],
);
assert.deepEqual(materialize(inputOptionDefinition, { number: "500", unit: "°P" }), []);

const multiInputOptionDefinition = {
  propertyId: "3",
  propertyName: "单规格容量",
  valueType: "MULTI_INPUT_OPTION",
  subCategoryPropertyList: [
    { subValueType: "NUMBER", optionalValue: [] },
    { subValueType: "SELECT", optionalValue: [{ propertyValueId: "ml", propertyValueName: "ml" }] },
  ],
};
assert.deepEqual(
  materialize(multiInputOptionDefinition, { number: "500", unit: "ml" }).map((value) => value.propertyValueName),
  ["500", "ml"],
);

const explicitSelectItem = {
  skuCode: "material-1",
  skuName: "316不锈钢保温杯",
  issueText: "缺失属性:材质",
  definitions: {
    ELE: [{
      propertyId: "material",
      propertyName: "材质",
      valueType: "SELECT",
      optionalValue: [{ propertyValueId: "316", propertyValueName: "316不锈钢" }],
      currentValue: [],
      matchValue: [],
    }],
  },
};
const plannedExplicitSelect = validateProductDecision(explicitSelectItem, {
  items: [{ field_key: "ELE:material", value: "316不锈钢", confidence: 1, reason: "标题明确" }],
}, [], { model: "test", requestHash: "test" }, { minConfidence: 0.6 });
assert.equal(plannedExplicitSelect.accepted[0].source, "deepseek_explicit_same_product_fact");

process.stdout.write(`${JSON.stringify({ ok: true, cases: 10 })}\n`);
