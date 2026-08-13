import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./aoxiang_channel_engine.js", import.meta.url), "utf8");
const sandbox = { console, setTimeout, clearTimeout, URL, AbortController };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "aoxiang_channel_engine.js" });

const engine = sandbox.AoxiangChannelEngine;
assert.equal(engine.ENGINE_VERSION, "1.5.4");

const extendedPackaging = {
  propertyId: "2020563",
  propertyName: "包装规格",
  channelCode: "ELE",
  valueType: "SELECT",
  supportExtend: "1",
  optionalValue: [],
};
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseExtendedSelectFact(
    extendedPackaging,
    "包装规格",
    { skus: [{ specification: "大号80只/包" }] },
  ))),
  [{ propertyValueId: "", propertyValueName: "大号80只/包", propertyValueType: null }],
);
assert.equal(
  engine._test.chooseExtendedSelectFact(
    extendedPackaging,
    "包装规格",
    { skuName: "美丽雅 一次性保鲜罩食品级200只/袋", skus: [{ specification: "" }] },
  )[0].propertyValueName,
  "200只/袋",
);

const evidenceDefinition = {
  propertyId: "608370046",
  propertyName: "主面料成分含量",
  propertyType: "NORMAL",
  channelCode: "ELE",
  needFlag: 0,
  valueType: "SELECT",
  supportExtend: "0",
  optionalValue: [
    { propertyValueId: "40714522917", propertyValueName: "89%~95%（含）" },
  ],
};
const evidencePlan = {
  properties: { ELE: [{ ...evidenceDefinition, currentValue: [] }] },
  changes: [],
  blockers: [{ channel: "ELE", fieldId: "608370046", field: "主面料成分含量" }],
};
engine._test.applyEvidenceOverrides(
  evidencePlan,
  { ELE: { data: [evidenceDefinition] } },
  "1972896",
  {
    1972896: {
      ELE: {
        608370046: {
          values: [{ propertyValueId: "40714522917", propertyValueName: "89%~95%（含）" }],
          evidence: "同商品检测报告：棉93.6%、氨纶6.4%",
        },
      },
    },
  },
);
assert.equal(evidencePlan.blockers.length, 0);
assert.equal(evidencePlan.changes[0].source, "same_product_media_evidence");
assert.equal(evidencePlan.properties.ELE[0].currentValue[0].propertyValueId, "40714522917");

const select = {
  valueType: "SELECT",
  supportExtend: "0",
  optionalValue: [
    { propertyValueId: "1", propertyValueName: "国产" },
    { propertyValueId: "2", propertyValueName: "进口" },
  ],
};
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.materializeValues(select, [{ propertyValueId: null, propertyValueName: "国产" }]))),
  [{ propertyValueId: "1", propertyValueName: "国产" }],
);

const inputOption = {
  valueType: "INPUT_OPTION",
  optionalValue: [
    { propertyValueId: "3487", propertyValueName: "ml" },
    { propertyValueId: "76", propertyValueName: "L" },
  ],
};
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.materializeValues(inputOption, [
    { propertyValueId: null, propertyValueName: "330" },
    { propertyValueId: null, propertyValueName: "mL" },
  ]))),
  [
    { propertyValueId: null, propertyValueName: "330", propertyValueType: "INPUT" },
    { propertyValueId: "3487", propertyValueName: "ml", propertyValueType: "SELECT" },
  ],
);

const fabric = {
  propertyId: "f1",
  propertyName: "面料成分",
  propertyType: "NORMAL",
  channelCode: "MT",
  needFlag: 1,
  valueType: "MULTI_INPUT_OPTION",
  subCategoryPropertyList: [
    { subValueType: "INPUT", optionalValue: [] },
    { subValueType: "NUMBER", optionalValue: [] },
    { subValueType: "SELECT", optionalValue: [{ propertyValueId: "604", propertyValueName: "%" }] },
  ],
};
const detail = {
  skuName: "100%纯棉保暖内衣",
  skus: [{ skuCode: "A1", specification: "L" }],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
};
const plan = engine._test.planProperties(detail, {
  MT: { data: [fabric] },
  ELE: { data: [{
    propertyId: "e1",
    propertyName: "材质",
    propertyType: "NORMAL",
    channelCode: "ELE",
    needFlag: 1,
    valueType: "INPUT",
    matchValue: [{ propertyValueName: "棉" }],
    optionalValue: [],
  }] },
});
assert.equal(plan.blockers.length, 0);
assert.equal(plan.properties.MT[0].currentValue[0].propertyValueName, "棉");
assert.equal(plan.properties.MT[0].currentValue[1].propertyValueName, "100");
assert.equal(plan.properties.MT[0].currentValue[2].propertyValueId, "604");

assert.equal(engine._test.normalizeFieldName("酒精度(%vol)"), "酒精度");
assert.equal(engine._test.normalizeFieldName("功率（W）"), "功率");
assert.equal(engine._test.normalizeFieldName("内胆材质"), "内胆材质");
assert.equal(engine._test.normalizeFieldName("杯盖材质"), "杯盖材质");
assert.equal(engine._test.normalizeFieldName("主面料成分含量"), "主面料成分含量");
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseCount({
    valueType: "INPUT_OPTION",
    optionalValue: [{ propertyValueId: "21482", propertyValueName: "只" }],
  }, "只数", "垃圾袋"))),
  [],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseCount({
    valueType: "INPUT_OPTION",
    optionalValue: [{ propertyValueId: "21482", propertyValueName: "只" }],
  }, "只数", "垃圾袋1只装"))),
  [
    { propertyValueId: null, propertyValueName: "1", propertyValueType: "INPUT" },
    { propertyValueId: "21482", propertyValueName: "只", propertyValueType: "SELECT" },
  ],
);
assert.equal(
  engine._test.chooseCount({ valueType: "INPUT" }, "包装数量", "400ml/个 6900000000000")[0]?.propertyValueName,
  "1",
);
assert.equal(
  engine._test.chooseCount({ valueType: "INPUT" }, "包装数量", "46件套组合工具/套")[0]?.propertyValueName,
  "46",
);

const wortDefinition = {
  propertyId: "wort",
  propertyName: "麦汁浓度(°P)",
  channelCode: "ELE",
  needFlag: 1,
  valueType: "INPUT_OPTION",
  optionalValue: [{ propertyValueId: "p", propertyValueName: "°P" }],
};
const alcoholDefinition = {
  propertyId: "alcohol",
  propertyName: "酒精度(%vol)",
  channelCode: "ELE",
  needFlag: 1,
  valueType: "INPUT_OPTION",
  optionalValue: [{ propertyValueId: "vol", propertyValueName: "%vol" }],
};
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseMeasurement(
    wortDefinition,
    wortDefinition.propertyName,
    "麦克雷 原麦汁浓度 500ml*3罐",
  ))),
  [],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseMeasurement(
    wortDefinition,
    wortDefinition.propertyName,
    "麦克雷 24°P烈性啤酒 500ml/罐",
  ).map((value) => value.propertyValueName))),
  ["24", "°P"],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.chooseMeasurement(
    alcoholDefinition,
    alcoholDefinition.propertyName,
    "500ml*3罐 酒精度4.5%vol",
  ).map((value) => value.propertyValueName))),
  ["4.5", "%vol"],
);
assert.equal(
  engine._test.chooseMeasurement({ valueType: "INPUT", propertyName: "容量（L）" }, "容量（L）", "容量500ml")[0]?.propertyValueName,
  "0.5",
);
assert.equal(
  engine._test.chooseMeasurement({ valueType: "INPUT", propertyName: "线长（m）" }, "线长（m）", "线长30cm")[0]?.propertyValueName,
  "0.3",
);
assert.equal(
  engine._test.chooseMeasurement({ valueType: "INPUT", propertyName: "电池容量（mAh）" }, "电池容量（mAh）", "电池容量10000mAh")[0]?.propertyValueName,
  "10000",
);
assert.equal(engine._test.isValidValues(wortDefinition, [
  { propertyValueName: "500" },
  { propertyValueId: "p", propertyValueName: "°P" },
]), false);
assert.equal(engine._test.isValidValues(wortDefinition, [
  { propertyValueName: "12" },
  { propertyValueId: "p", propertyValueName: "°P" },
]), true);

const crossPlatformMeasurementDetail = {
  skuName: "家用暖风机",
  skus: [{ skuCode: "H1", specification: "1台" }],
  channelGeneralCategoryProperty: {
    MT: [
      {
        propertyId: "mt-power",
        propertyName: "额定功率（W）",
        valueType: "INPUT",
        currentValue: [{ propertyValueName: "500w" }],
      },
      {
        propertyId: "mt-area",
        propertyName: "适用面积",
        valueType: "SELECT",
        currentValue: [{ propertyValueId: "range", propertyValueName: "11㎡(含)-20㎡(含)" }],
      },
    ],
    ELE: [],
  },
};
const crossPlatformMeasurementPlan = engine._test.planProperties(crossPlatformMeasurementDetail, {
  MT: { data: [
    {
      propertyId: "mt-power",
      propertyName: "额定功率（W）",
      channelCode: "MT",
      needFlag: 1,
      valueType: "INPUT",
    },
    {
      propertyId: "mt-area",
      propertyName: "适用面积",
      channelCode: "MT",
      needFlag: 1,
      valueType: "SELECT",
      optionalValue: [{ propertyValueId: "range", propertyValueName: "11㎡(含)-20㎡(含)" }],
    },
  ] },
  ELE: { data: [
    {
      propertyId: "ele-power",
      propertyName: "功率（W）",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "INPUT_OPTION",
      optionalValue: [{ propertyValueId: "w", propertyValueName: "W" }],
    },
    {
      propertyId: "ele-area",
      propertyName: "适用面积（㎡）",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "INPUT_OPTION",
      optionalValue: [{ propertyValueId: "sqm", propertyValueName: "㎡" }],
    },
  ] },
});
assert.equal(crossPlatformMeasurementPlan.blockers.length, 0);
assert.deepEqual(
  JSON.parse(JSON.stringify(crossPlatformMeasurementPlan.properties.ELE.map(
    (property) => property.currentValue.map((value) => value.propertyValueName),
  ))),
  [["500", "W"], ["11", "㎡"]],
);

const categoryOverlapPlan = engine._test.planProperties({
  skuName: "运动旅行鞋子收纳袋大号收纳包",
  skus: [{ skuCode: "B1", specification: "L码" }],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, {
  MT: { data: [] },
  ELE: { data: [{
    propertyId: "category",
    propertyName: "商品类别",
    channelCode: "ELE",
    needFlag: 1,
    valueType: "SELECT",
    optionalValue: [
      { propertyValueId: "box", propertyValueName: "保温箱" },
      { propertyValueId: "basket", propertyValueName: "食物篮" },
      { propertyValueId: "storage", propertyValueName: "食物收纳箱" },
      { propertyValueId: "bag", propertyValueName: "食物保温包" },
    ],
  }] },
});
assert.equal(categoryOverlapPlan.properties.ELE[0].currentValue[0].propertyValueId, "storage");

const residualPlan = engine._test.planProperties({
  skuName: "苹果15Pro手机壳两件套",
  skus: [{ skuCode: "R1", specification: "两件套" }],
  channelBackCategoryList: [
    { channelCode: "MT", categoryId: "m" },
    { channelCode: "ELE", categoryId: "e" },
  ],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, {
  MT: { data: [{
    propertyId: "count",
    propertyName: "包装数量",
    channelCode: "MT",
    needFlag: 1,
    valueType: "SELECT",
    optionalValue: [
      { propertyValueId: "one", propertyValueName: "单件装" },
      { propertyValueId: "two", propertyValueName: "2件套" },
    ],
  }] },
  ELE: { data: [
    {
      propertyId: "phone",
      propertyName: "适用手机品牌",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "SELECT",
      optionalValue: [
        { propertyValueId: "huawei", propertyValueName: "华为（HUAWEI）" },
        { propertyValueId: "apple", propertyValueName: "苹果（Apple）" },
      ],
    },
    {
      propertyId: "license",
      propertyName: "备案编号/注册证号",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "INPUT",
    },
    {
      propertyId: "life",
      propertyName: "保质期",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "INPUT_OPTION",
      matchValue: [{ propertyValueName: "180天" }],
      optionalValue: [
        { propertyValueId: "day", propertyValueName: "天" },
        { propertyValueId: "year", propertyValueName: "年" },
      ],
    },
  ] },
});
assert.equal(residualPlan.blockers.length, 1);
assert.equal(residualPlan.blockers[0].field, "备案编号/注册证号");
assert.equal(residualPlan.properties.MT[0].currentValue[0].propertyValueId, "two");
assert.equal(residualPlan.properties.ELE[0].currentValue[0].propertyValueId, "apple");
assert.deepEqual(JSON.parse(JSON.stringify(residualPlan.properties.ELE[1].currentValue)), []);
assert.deepEqual(
  JSON.parse(JSON.stringify(residualPlan.properties.ELE[2].currentValue.map((value) => value.propertyValueName))),
  ["180", "天"],
);

const inputIdDefinition = {
  propertyId: "life",
  propertyName: "保质期",
  channelCode: "ELE",
  needFlag: 1,
  valueType: "INPUT_OPTION",
  optionalValue: [{ propertyValueId: "day", propertyValueName: "天" }],
};
const idInsensitivePlan = {
  changes: [{
    channel: "ELE",
    fieldId: "life",
    field: "保质期",
    planned: [
      { propertyValueId: "0", propertyValueName: "21", propertyValueType: "INPUT" },
      { propertyValueId: "day", propertyValueName: "天", propertyValueType: "SELECT" },
    ],
  }],
};
const idInsensitiveDetail = {
  channelGeneralCategoryProperty: {
    MT: [],
    ELE: [{
      ...inputIdDefinition,
      currentValue: [
        { propertyValueId: "-1599", propertyValueName: "21", propertyValueType: "INPUT" },
        { propertyValueId: "day", propertyValueName: "天", propertyValueType: "SELECT" },
      ],
    }],
  },
};
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.verifyPlanned(idInsensitiveDetail, {
    MT: { data: [] },
    ELE: { data: [inputIdDefinition] },
  }, idInsensitivePlan))),
  [],
);

const structuralResidualPlan = engine._test.planProperties({
  skuName: "松下E14灯泡 防褥疮气垫床",
  skus: [{ skuCode: "S1", specification: "约2斤" }],
  channelBackCategoryList: [
    { channelCode: "MT", categoryId: "m" },
    { channelCode: "ELE", categoryId: "e" },
  ],
  channelGeneralCategoryProperty: {
    MT: [{
      propertyId: "weight",
      propertyName: "整被重量",
      valueType: "MULTI_INPUT_OPTION",
      currentValue: [{ propertyValueName: "2斤" }],
    }],
    ELE: [],
  },
}, {
  MT: { data: [
    {
      propertyId: "weight",
      propertyName: "整被重量",
      channelCode: "MT",
      needFlag: 1,
      valueType: "MULTI_INPUT_OPTION",
      subCategoryPropertyList: [
        { subValueType: "NUMBER", optionalValue: [] },
        { subValueType: "SELECT", optionalValue: [{ propertyValueId: "jin", propertyValueName: "斤" }] },
      ],
    },
    {
      propertyId: "medical",
      propertyName: "医疗器械分类",
      channelCode: "MT",
      needFlag: 1,
      valueType: "SELECT",
      optionalValue: [
        { propertyValueId: "one", propertyValueName: "I 类" },
        { propertyValueId: "two", propertyValueName: "II 类" },
        { propertyValueId: "none", propertyValueName: "非医疗器械" },
      ],
    },
  ] },
  ELE: { data: [{
    propertyId: "lamp",
    propertyName: "灯头接口（灯头型号）",
    channelCode: "ELE",
    needFlag: 1,
    valueType: "SELECT",
    optionalValue: [
      { propertyValueId: "e40", propertyValueName: "E40" },
      { propertyValueId: "e14", propertyValueName: "E14" },
      { propertyValueId: "other", propertyValueName: "其他" },
    ],
  }] },
});
assert.equal(structuralResidualPlan.blockers.length, 0);
assert.deepEqual(
  JSON.parse(JSON.stringify(structuralResidualPlan.properties.MT[0].currentValue.map((value) => value.propertyValueName))),
  ["2", "斤"],
);
assert.equal(structuralResidualPlan.properties.MT[1].currentValue[0].propertyValueId, "two");
assert.equal(structuralResidualPlan.properties.ELE[0].currentValue[0].propertyValueId, "e14");

const outOfVocabularyRegulated = engine._test.planProperties({
  skuName: "E14灯泡",
  skus: [{ skuCode: "L1" }],
  channelBackCategoryList: [{ channelCode: "ELE", categoryId: "e" }],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, {
  MT: { data: [] },
  ELE: { data: [{
    propertyId: "lamp",
    propertyName: "灯头接口（灯头型号）",
    channelCode: "ELE",
    needFlag: 1,
    valueType: "SELECT",
    optionalValue: [
      { propertyValueId: "e27", propertyValueName: "E27" },
      { propertyValueId: "other", propertyValueName: "其他" },
    ],
  }] },
});
assert.equal(outOfVocabularyRegulated.blockers.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(outOfVocabularyRegulated.properties.ELE[0].currentValue)), []);

const medicalClassFallback = engine._test.planProperties({
  skuName: "蒸汽热敷眼罩",
  skus: [{ skuCode: "M1" }],
  channelBackCategoryList: [{ channelCode: "MT", categoryId: "m" }],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, {
  MT: { data: [{
    propertyId: "medical",
    propertyName: "医疗器械分类",
    channelCode: "MT",
    needFlag: 1,
    valueType: "SELECT",
    optionalValue: [
      { propertyValueId: "one", propertyValueName: "i 类" },
      { propertyValueId: "two", propertyValueName: "ii 类" },
    ],
  }] },
  ELE: { data: [] },
});
assert.equal(medicalClassFallback.blockers.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(medicalClassFallback.properties.MT[0].currentValue)), []);

const servicePlan = engine._test.planProperties({
  skuName: "加急配送服务",
  skus: [{ skuCode: "SERVICE" }],
  channelBackCategoryList: [
    { channelCode: "MT", categoryId: "m", categoryName: "信息公告" },
    { channelCode: "ELE", categoryId: "e", categoryName: "店铺服务" },
  ],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, { MT: { data: [] }, ELE: { data: [] } });
assert.equal(servicePlan.blockers.length, 0);

const categoryDetail = {
  channelBackCategoryList: [{
    channelCode: "ELE",
    categoryId: "obsolete",
    categoryName: "",
    categoryPath: "母婴 > 其他婴儿用品",
  }],
};
const categoryRepairs = engine._test.applyCategoryOverrides({
  config: {
    categoryOverrides: {
      X1: {
        ELE: {
          categoryId: "current",
          categoryName: "其他婴儿床品/防护/出行用品",
          categoryPath: "母婴 > 婴儿床品/防护/出行用品 > 其他婴儿床品/防护/出行用品",
        },
      },
    },
  },
}, categoryDetail, "X1");
assert.equal(categoryRepairs.length, 1);
assert.equal(categoryDetail.channelBackCategoryList[0].categoryId, "current");
assert.deepEqual(
  JSON.parse(JSON.stringify(engine._test.verifyCategoryRepairs(categoryDetail, categoryRepairs))),
  [],
);

const diagnosedRow = {
  channelValue: JSON.stringify([{ problemType: 4, noQualifiedReason: "缺失属性:厂家联系方式,商品类别" }]),
};
const diagnosedFields = engine._test.diagnosisRequiredFields(diagnosedRow);
assert.equal(diagnosedFields.has("厂家联系方式"), true);
assert.equal(diagnosedFields.has("商品类别"), true);
const diagnosisOverridePlan = engine._test.planProperties({
  skuName: "测试食品",
  skus: [{ skuCode: "D1" }],
  channelBackCategoryList: [{ channelCode: "ELE", categoryId: "e" }],
  channelGeneralCategoryProperty: { MT: [], ELE: [] },
}, {
  MT: { data: [] },
  ELE: { data: [{
    propertyId: "phone",
    propertyName: "厂家联系方式",
    channelCode: "ELE",
    needFlag: 0,
    valueType: "INPUT",
  }] },
}, { ELE: diagnosedFields });
assert.equal(diagnosisOverridePlan.blockers.length, 1);
assert.equal(diagnosisOverridePlan.properties.ELE[0].needFlag, 1);
assert.deepEqual(JSON.parse(JSON.stringify(diagnosisOverridePlan.properties.ELE[0].currentValue)), []);

const diagnosedRegulatedCompositePlan = engine._test.planProperties({
  skuName: "进口红葡萄酒 750ml/瓶",
  skus: [{ skuCode: "D2" }],
  channelBackCategoryList: [{ channelCode: "ELE", categoryId: "e" }],
  channelGeneralCategoryProperty: {
    MT: [],
    ELE: [{
      propertyId: "alcohol",
      propertyName: "酒精度(%vol)",
      valueType: "INPUT_OPTION",
      currentValue: [
        { propertyValueName: "12" },
        { propertyValueId: "vol", propertyValueName: "%vol" },
      ],
    }],
  },
}, {
  MT: { data: [] },
  ELE: { data: [{
    propertyId: "alcohol",
    propertyName: "酒精度(%vol)",
    channelCode: "ELE",
    needFlag: 1,
    valueType: "INPUT_OPTION",
    optionalValue: [{ propertyValueId: "vol", propertyValueName: "%vol" }],
  }] },
}, { ELE: new Set(["酒精度"]) });
assert.equal(diagnosedRegulatedCompositePlan.blockers.length, 1);
assert.equal(diagnosedRegulatedCompositePlan.blockers[0].field, "酒精度(%vol)");
assert.deepEqual(JSON.parse(JSON.stringify(diagnosedRegulatedCompositePlan.properties.ELE[0].currentValue)), []);

const evidenceOnlyDetail = {
  skuName: "红色塑料水杯",
  skus: [{ skuCode: "P1" }],
  channelBackCategoryList: [{ channelCode: "ELE", categoryId: "e" }],
  channelGeneralCategoryProperty: {
    MT: [],
    ELE: [
      {
        propertyId: "material",
        propertyName: "材质",
        valueType: "SELECT",
        currentValue: [{ propertyValueId: "metal", propertyValueName: "金属" }],
      },
      {
        propertyId: "category",
        propertyName: "商品类别",
        valueType: "SELECT",
        currentValue: [{ propertyValueId: "other", propertyValueName: "其他" }],
      },
    ],
  },
};
const evidenceOnlyMatches = {
  MT: { data: [] },
  ELE: { data: [
    {
      propertyId: "material",
      propertyName: "材质",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "SELECT",
      optionalValue: [
        { propertyValueId: "plastic", propertyValueName: "塑料" },
        { propertyValueId: "metal", propertyValueName: "金属" },
      ],
    },
    {
      propertyId: "category",
      propertyName: "商品类别",
      channelCode: "ELE",
      needFlag: 1,
      valueType: "SELECT",
      optionalValue: [
        { propertyValueId: "cup", propertyValueName: "水杯" },
        { propertyValueId: "other", propertyValueName: "其他" },
      ],
    },
  ] },
};
const evidenceOnlyPlan = engine._test.planProperties(
  evidenceOnlyDetail,
  evidenceOnlyMatches,
  { ELE: new Set(["材质", "商品类别"]) },
);
const evidenceOnlyOverrides = {
  P1: {
    ELE: {
      category: {
        values: [{ propertyValueId: "cup", propertyValueName: "水杯" }],
        source: "deepseek_semantic_exact_candidate",
      },
    },
  },
};
engine._test.applyEvidenceOverrides(evidenceOnlyPlan, evidenceOnlyMatches, "P1", evidenceOnlyOverrides, evidenceOnlyDetail);
engine._test.retainOnlyEvidenceOverrides(
  evidenceOnlyPlan,
  evidenceOnlyDetail,
  evidenceOnlyMatches,
  "P1",
  evidenceOnlyOverrides,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(evidenceOnlyPlan.properties.ELE[0].currentValue.map((value) => value.propertyValueName))),
  ["金属"],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(evidenceOnlyPlan.changes.map((change) => [change.field, change.planned[0].propertyValueName]))),
  [["商品类别", "水杯"]],
);

const invalidEvidencePlan = engine._test.planProperties(
  evidenceOnlyDetail,
  evidenceOnlyMatches,
  { ELE: new Set(["材质", "商品类别"]) },
);
const invalidEvidenceOverrides = {
  P1: {
    ELE: {
      material: {
        values: [{ propertyValueId: "wood", propertyValueName: "木材" }],
        source: "same_product_media_ocr",
      },
    },
  },
};
engine._test.applyEvidenceOverrides(
  invalidEvidencePlan,
  evidenceOnlyMatches,
  "P1",
  invalidEvidenceOverrides,
  evidenceOnlyDetail,
);
engine._test.retainOnlyEvidenceOverrides(
  invalidEvidencePlan,
  evidenceOnlyDetail,
  evidenceOnlyMatches,
  "P1",
  invalidEvidenceOverrides,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(invalidEvidencePlan.properties.ELE[0].currentValue.map((value) => value.propertyValueName))),
  ["金属"],
);
assert.equal(invalidEvidencePlan.changes.some((change) => change.field === "材质"), false);

console.log("aoxiang_channel_engine tests passed");
