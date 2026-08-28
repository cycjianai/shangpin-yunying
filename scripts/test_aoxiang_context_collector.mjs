#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collector = require("./aoxiang_context_collector.js");

const cases = new Map([
  ["酒精度(%vol)", "酒精度"],
  ["麦汁浓度(°P)", "麦汁浓度"],
  ["功率（W）", "功率"],
  ["额定功率（W）", "功率"],
  ["净含量（g）", "净含量"],
  ["总净含量(ml)", "总净含量"],
  ["单规格容量", "单件净含量"],
  ["商品分类", "商品类别"],
]);

for (const [input, expected] of cases) {
  assert.equal(collector._test.normalizeFieldName(input), expected, input);
}

assert.deepEqual(
  collector._test.issueFields({
    channelValue: JSON.stringify([
      { problemType: 4, noQualifiedReason: "缺失属性:品牌,总净含量,商品类别" },
      { problemType: 3, noQualifiedReason: "缺失属性:不应采集" },
    ]),
  }),
  ["品牌", "总净含量", "商品类别"],
);

process.stdout.write(`${JSON.stringify({ ok: true, version: collector.VERSION, cases: cases.size })}\n`);
