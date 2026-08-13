(function attachAoxiangContextCollector(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AoxiangContextCollector = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildAoxiangContextCollector() {
  "use strict";

  const VERSION = "1.0.0";
  const DEFAULT_API_ROOT = "https://tc-supply-chain-portal.ele.me";
  const DEFAULT_CHANNELS = ["MT", "ELE"];

  function normalizeFieldName(value) {
    let text = String(value == null ? "" : value)
      .toLowerCase()
      .replace(/&gt;/g, ">")
      .replace(/[\s_\-:：;；,，.。()（）【】\[\]{}'"“”‘’/\\%°]/g, "")
      .replace(/毫升/g, "ml")
      .replace(/千克|公斤/g, "kg")
      .replace(/克/g, "g")
      .replace(/升/g, "l")
      .replace(/平方米/g, "㎡")
      .replace(/其它/g, "其他");

    const exactAliases = {
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
    if (exactAliases[text]) return exactAliases[text];
    if (/^酒精度(?:vol)?$/.test(text)) return "酒精度";
    if (/^麦汁浓度p?$/.test(text)) return "麦汁浓度";
    if (/^(?:额定)?功率w?$/.test(text)) return "功率";
    if (/^适用面积(?:㎡|m2)?$/.test(text)) return "适用面积";
    if (/^总净含量(?:g|kg|ml|l)?$/.test(text)) return "总净含量";
    if (/^单件净含量(?:g|kg|ml|l)?$/.test(text)) return "单件净含量";
    if (/^净含量(?:g|kg|ml|l)?$/.test(text)) return "净含量";
    if (/^线长m$/.test(text)) return "线长";
    if (/^长度m$/.test(text)) return "长度";
    if (/^数量(?:支|只|片|本|页|枚|个)$/.test(text)) return "数量";
    return text;
  }

  function valueList(values) {
    return (Array.isArray(values) ? values : []).map((value) => ({
      propertyValueId: value?.propertyValueId == null ? null : String(value.propertyValueId),
      propertyValueName: String(value?.propertyValueName ?? ""),
      propertyValueType: value?.propertyValueType ?? null,
    }));
  }

  function compactDefinition(definition) {
    return {
      propertyId: String(definition.propertyId),
      propertyName: definition.propertyName,
      channelCode: definition.channelCode,
      needFlag: Number(definition.needFlag || 0),
      valueType: definition.valueType,
      minValue: definition.minValue ?? null,
      maxValue: definition.maxValue ?? null,
      precision: definition.precision ?? null,
      textMaxLength: definition.textMaxLength ?? null,
      supportExtend: String(definition.supportExtend ?? ""),
      placeholder: definition.placeholder ?? null,
      currentValue: valueList(definition.currentValue),
      matchValue: valueList(definition.matchValue),
      optionalValue: valueList(definition.optionalValue),
      subCategoryPropertyList: (definition.subCategoryPropertyList || []).map((child) => ({
        propertyId: child.propertyId == null ? null : String(child.propertyId),
        propertyName: child.propertyName ?? "",
        subValueType: child.subValueType ?? child.valueType ?? null,
        minValue: child.minValue ?? null,
        maxValue: child.maxValue ?? null,
        textMaxLength: child.textMaxLength ?? null,
        optionalValue: valueList(child.optionalValue),
      })),
    };
  }

  function issueFields(row) {
    const fields = [];
    let issues = [];
    try {
      issues = JSON.parse(row?.channelValue || "[]");
    } catch {
      issues = [];
    }
    for (const issue of issues) {
      if (Number(issue?.problemType || 0) !== 4) continue;
      const match = String(issue?.noQualifiedReason || "").match(/缺失属性[:：](.+)$/);
      if (!match) continue;
      fields.push(...match[1].split(/[,，]/).map((field) => field.trim()).filter(Boolean));
    }
    return [...new Set(fields)];
  }

  async function requestJson(apiRoot, path, options = {}) {
    const response = await fetch(`${apiRoot}${path}`, {
      method: options.method || "GET",
      credentials: "include",
      headers: options.body == null ? undefined : { "content-type": "application/json" },
      body: options.body == null ? undefined : JSON.stringify(options.body),
    });
    const json = await response.json();
    if (!response.ok || json.success === false || json.failed === true) {
      const error = new Error(json.message || `http_${response.status}`);
      error.status = response.status;
      error.code = json.code;
      throw error;
    }
    return json;
  }

  function currentValues(detail, channel, definition) {
    const entries = detail?.channelGeneralCategoryProperty?.[channel] || [];
    const current = entries.find((entry) => String(entry.propertyId) === String(definition.propertyId))
      || entries.find((entry) => normalizeFieldName(entry.propertyName) === normalizeFieldName(definition.propertyName));
    return current?.currentValue || definition.currentValue || [];
  }

  async function collectOne(row, config) {
    const apiRoot = config.apiRoot || DEFAULT_API_ROOT;
    const channels = config.channels || DEFAULT_CHANNELS;
    const fields = issueFields(row);
    const wanted = new Set(fields.map(normalizeFieldName));
    const detailResponse = await requestJson(apiRoot, `/goods/master/detail?skuCode=${encodeURIComponent(row.skuCode)}`);
    const detail = detailResponse.data;
    if (!detail) throw new Error("missing_product_detail");
    const categories = Object.fromEntries(
      (detail.channelBackCategoryList || []).map((category) => [category.channelCode, String(category.categoryId)]),
    );
    const sku = detail.skus?.[0] || {};
    const barcode = sku.mainBarCode || sku.barcodes?.[0] || row.barcode || "";
    const definitions = Object.fromEntries(await Promise.all(channels.map(async (channel) => {
      if (!categories[channel]) return [channel, []];
      const response = await requestJson(apiRoot, "/goods/master/matchChannelCategoryPropertyV3", {
        method: "POST",
        body: {
          channelCode: channel,
          channelCategoryId: categories[channel],
          barcode,
          skuName: detail.skuName,
        },
      });
      const matches = (response.data || []).filter(
        (definition) => wanted.has(normalizeFieldName(definition.propertyName)),
      );
      for (const definition of matches) definition.currentValue = currentValues(detail, channel, definition);
      return [channel, matches.map(compactDefinition)];
    })));
    const presentEle = new Set((definitions.ELE || []).map((definition) => normalizeFieldName(definition.propertyName)));
    const description = String(detail.description || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Number(config.descriptionMaxLength || 3000));
    return {
      skuCode: String(row.skuCode),
      skuName: detail.skuName || row.skuName || "",
      barcode,
      issueFields: fields,
      issueText: (() => {
        try {
          return JSON.parse(row.channelValue || "[]").map((issue) => issue.noQualifiedReason).filter(Boolean).join(";");
        } catch {
          return "";
        }
      })(),
      missingEleDefinitions: fields.filter((field) => !presentEle.has(normalizeFieldName(field))),
      aliasName: detail.aliasName || "",
      subTitle: detail.subTitle || "",
      description,
      specifications: (detail.skus || []).map((item) => item.specification).filter(Boolean),
      mediaUrls: [detail.mainPic, ...(detail.subPic || []), ...(detail.pictureList || [])]
        .flatMap((item) => typeof item === "string" ? [item] : [item?.url || item?.pictureUrl || item?.picture])
        .filter(Boolean),
      categories,
      definitions,
    };
  }

  async function collect(rows, options = {}) {
    const config = {
      apiRoot: options.apiRoot || DEFAULT_API_ROOT,
      channels: options.channels || DEFAULT_CHANNELS,
      concurrency: Math.max(1, Math.min(10, Number(options.concurrency || 6))),
      descriptionMaxLength: options.descriptionMaxLength || 3000,
    };
    const output = new Array(rows.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const index = cursor;
        cursor += 1;
        try {
          output[index] = await collectOne(rows[index], config);
        } catch (error) {
          output[index] = {
            skuCode: String(rows[index]?.skuCode || ""),
            error: {
              message: String(error?.message || error),
              status: error?.status || null,
              code: error?.code || null,
            },
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, rows.length) }, worker));
    return output;
  }

  return {
    VERSION,
    collect,
    _test: {
      compactDefinition,
      issueFields,
      normalizeFieldName,
    },
  };
});
