(function attachAoxiangChannelEngine(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AoxiangChannelEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildEngine(root) {
  "use strict";

  const ENGINE_VERSION = "1.5.4";
  const DEFAULT_API_ROOT = "https://tc-supply-chain-portal.ele.me";
  const TARGET_CHANNELS = ["MT", "ELE"];
  const REGULATED_FIELD_RE = /(许可证|许可编号|备案|注册证|批准文号|执行标准|认证证书|生产厂家|生产者|制造商|厂家联系方式|条码|型号|功率|电压|酒精度|麦汁浓度|营养|配料|成分含量|安全等级|安全类别|医疗器械分类)/;
  const COUNT_FIELD_RE = /(包装数量|单品数量|商品数量|数量（|数量\(|^数量$|片数|支数|只数|枚数|页数|本数|枝数|朵数|刀头数量|替换头数量|电池节数|水果种数|插位数|接口数量|适用人数|适合人数)/;
  const MEASURE_FIELD_RE = /(净含量|容量|净重|重量|长度|线长|尺寸|直径|厚度|功率|适用面积|保质期|酒精度|麦汁浓度)/;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/&gt;/g, ">")
      .replace(/[\s\-_—–·•,，.。:：;；/\\()（）【】\[\]{}'"“”‘’]+/g, "")
      .replace(/毫升/g, "ml")
      .replace(/千克|公斤/g, "kg")
      .replace(/克/g, "g")
      .replace(/升/g, "l")
      .replace(/其它/g, "其他")
      .trim();
  }

  function normalizeFieldName(value) {
    const text = normalizeText(value)
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "");
    const aliases = {
      是否进口: "国产进口",
      国产进口: "国产进口",
      单规格容量: "单件净含量",
      单品净含量: "单件净含量",
      每件净含量: "单件净含量",
      包装规格: "包装数量",
      单品数量: "包装数量",
      商品数量: "包装数量",
      规格尺寸: "尺寸",
      主体材质: "材质",
      主面料材质: "面料成分",
      主面料成分: "面料成分",
    };
    if (aliases[text]) return aliases[text];
    if (/^酒精度(?:%?vol)?$/.test(text)) return "酒精度";
    if (/^麦汁浓度(?:°?p)?$/.test(text)) return "麦汁浓度";
    if (/^(?:额定)?功率(?:w)?$/.test(text)) return "功率";
    if (/^适用面积/.test(text)) return "适用面积";
    if (text === "面料成分") return "面料成分";
    if (text === "材质") return "材质";
    return text;
  }

  function valueName(value) {
    return String(value?.propertyValueName == null ? "" : value.propertyValueName).trim();
  }

  function valueId(value) {
    const raw = value?.propertyValueId;
    return raw == null ? "" : String(raw);
  }

  function optionList(definition) {
    return Array.isArray(definition?.optionalValue) ? definition.optionalValue : [];
  }

  function findOption(definition, wanted) {
    const options = optionList(definition);
    if (!options.length || wanted == null) return null;
    const wantedId = valueId(wanted);
    const wantedName = normalizeText(typeof wanted === "object" ? valueName(wanted) : wanted);
    if (wantedId) {
      const byId = options.find((option) => valueId(option) === wantedId);
      if (byId) return clone(byId);
    }
    if (!wantedName) return null;
    let found = options.find((option) => normalizeText(valueName(option)) === wantedName);
    if (found) return clone(found);
    found = options.find((option) => {
      const name = normalizeText(valueName(option));
      return name && (name.includes(wantedName) || wantedName.includes(name));
    });
    return found ? clone(found) : null;
  }

  function makeValue(name, type, id) {
    return {
      propertyValueId: id == null || id === "" ? null : String(id),
      propertyValueName: name,
      propertyValueType: type || null,
    };
  }

  function materializeValues(definition, rawValues) {
    const raw = Array.isArray(rawValues) ? rawValues.filter(Boolean) : [];
    if (!raw.length) return [];
    const type = definition?.valueType;
    if (type === "SELECT" || type === "MULTI_SELECT") {
      const mapped = raw.map((value) => findOption(definition, value) || clone(value)).filter(Boolean);
      if (definition?.supportExtend !== "1" && optionList(definition).length) {
        return mapped.filter((value) => Boolean(findOption(definition, value)));
      }
      return mapped;
    }
    if (type === "INPUT") {
      const name = valueName(raw[0]);
      return name ? [makeValue(name, "INPUT", raw[0]?.propertyValueId)] : [];
    }
    if (type === "INPUT_OPTION") {
      const first = raw[0];
      const unitRaw = raw[1];
      const unit = findOption(definition, unitRaw) || unitRaw;
      if (!valueName(first) || !valueName(unit)) return [];
      return [
        makeValue(valueName(first), "INPUT", first?.propertyValueId),
        makeValue(valueName(unit), "SELECT", valueId(unit) || null),
      ];
    }
    if (type === "MULTI_INPUT_OPTION") {
      const children = Array.isArray(definition?.subCategoryPropertyList)
        ? definition.subCategoryPropertyList
        : [];
      if (!children.length) return raw.map(clone);
      const result = [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const source = raw[index];
        if (!source || !valueName(source)) return [];
        if (child.subValueType === "SELECT") {
          const unit = findOption(child, source);
          if (!unit) return [];
          result.push(makeValue(valueName(unit), "SELECT", valueId(unit)));
        } else {
          result.push(makeValue(valueName(source), child.subValueType || "INPUT", source.propertyValueId));
        }
      }
      return result;
    }
    return raw.map(clone);
  }

  function numericBound(value) {
    if (value == null || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function scalarConstraint(definition, index = 0) {
    const child = definition?.valueType === "MULTI_INPUT_OPTION"
      ? definition?.subCategoryPropertyList?.[index]
      : definition;
    const fieldName = String(definition?.propertyName || "");
    const min = numericBound(child?.minValue ?? definition?.minValue);
    const max = numericBound(child?.maxValue ?? definition?.maxValue);
    const numeric = child?.subValueType === "NUMBER"
      || min != null
      || max != null
      || definition?.valueType === "INPUT_OPTION"
      || (definition?.valueType === "MULTI_INPUT_OPTION"
        && child?.subValueType !== "SELECT"
        && (MEASURE_FIELD_RE.test(fieldName) || COUNT_FIELD_RE.test(fieldName)));
    let domainMin = null;
    let domainMax = null;
    if (/酒精度/.test(fieldName)) {
      domainMin = 0;
      domainMax = 100;
    } else if (/麦汁浓度/.test(fieldName)) {
      domainMin = 0;
      domainMax = 80;
    } else if (/成分含量|百分比|占比/.test(fieldName)) {
      domainMin = 0;
      domainMax = 100;
    } else if (numeric && (MEASURE_FIELD_RE.test(fieldName) || COUNT_FIELD_RE.test(fieldName))) {
      domainMin = 0;
    }
    return {
      numeric,
      min: min == null ? domainMin : domainMin == null ? min : Math.max(min, domainMin),
      max: max == null ? domainMax : domainMax == null ? max : Math.min(max, domainMax),
      textMaxLength: numericBound(child?.textMaxLength ?? definition?.textMaxLength),
    };
  }

  function isValidScalar(definition, value, index = 0) {
    const text = valueName(value);
    if (!text) return false;
    const child = definition?.valueType === "MULTI_INPUT_OPTION"
      ? definition?.subCategoryPropertyList?.[index]
      : definition;
    if (child?.subValueType === "READ_ONLY_INPUT") {
      return child.readOnlyValue != null && text === String(child.readOnlyValue);
    }
    const constraint = scalarConstraint(definition, index);
    if (constraint.textMaxLength != null && text.length > constraint.textMaxLength) return false;
    if (!constraint.numeric) return true;
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return false;
    const number = Number(text);
    if (!Number.isFinite(number)) return false;
    if (constraint.min != null && number < constraint.min) return false;
    if (constraint.max != null && number > constraint.max) return false;
    return true;
  }

  function isValidValues(definition, values) {
    const current = Array.isArray(values) ? values : [];
    if (!current.length) return false;
    const type = definition?.valueType;
    if (type === "SELECT" || type === "MULTI_SELECT") {
      if (type === "SELECT" && current.length !== 1) return false;
      return current.every((value) => {
        if (!valueName(value)) return false;
        if (definition?.supportExtend === "1" && !optionList(definition).length) return true;
        if (!optionList(definition).length) return Boolean(valueId(value) || valueName(value));
        return Boolean(findOption(definition, value));
      });
    }
    if (type === "INPUT") return isValidScalar(definition, current[0], 0);
    if (type === "INPUT_OPTION") {
      if (current.length < 2 || !isValidScalar(definition, current[0], 0)) return false;
      if (!valueName(current[1])) return false;
      return !optionList(definition).length || Boolean(findOption(definition, current[1]));
    }
    if (type === "MULTI_INPUT_OPTION") {
      const children = Array.isArray(definition?.subCategoryPropertyList)
        ? definition.subCategoryPropertyList
        : [];
      if (!children.length) return current.every((value, index) => isValidScalar(definition, value, index));
      if (current.length !== children.length) return false;
      return current.every((value, index) => {
        const child = children[index];
        if (child?.subValueType === "SELECT") {
          return Boolean(valueName(value)) && (!optionList(child).length || Boolean(findOption(child, value)));
        }
        return isValidScalar(definition, value, index);
      });
    }
    return current.every((value) => Boolean(valueName(value)));
  }

  function stripDefinition(definition, currentValue, requiredOverride = false) {
    return {
      propertyId: definition?.propertyId == null ? null : String(definition.propertyId),
      propertyName: definition?.propertyName || "",
      propertyType: definition?.propertyType || "NORMAL",
      channelCode: definition?.channelCode || null,
      needFlag: requiredOverride ? 1 : Number(definition?.needFlag || 0),
      valueType: definition?.valueType || null,
      textMaxLength: definition?.textMaxLength == null ? null : definition.textMaxLength,
      supportExtend: definition?.supportExtend == null ? null : String(definition.supportExtend),
      optionalValueGetType: definition?.optionalValueGetType || null,
      supportPicture: definition?.supportPicture == null ? null : definition.supportPicture,
      currentValue: Array.isArray(currentValue) ? clone(currentValue) : [],
    };
  }

  function currentByDefinition(detail, channel, definition) {
    const entries = detail?.channelGeneralCategoryProperty?.[channel] || [];
    const byId = entries.find((entry) => String(entry.propertyId) === String(definition.propertyId));
    const byName = entries.find(
      (entry) => normalizeFieldName(entry.propertyName) === normalizeFieldName(definition.propertyName),
    );
    const found = byId || byName;
    return materializeValues(definition, found?.currentValue || definition?.currentValue || []);
  }

  function rawCurrentByDefinition(detail, channel, definition) {
    const entries = detail?.channelGeneralCategoryProperty?.[channel] || [];
    const found = entries.find((entry) => String(entry.propertyId) === String(definition.propertyId))
      || entries.find((entry) => normalizeFieldName(entry.propertyName) === normalizeFieldName(definition.propertyName));
    return clone(found?.currentValue || definition?.currentValue || []);
  }

  function contradictsExplicitProduct(definition, candidate, detail) {
    const field = normalizeFieldName(definition.propertyName);
    const title = String(detail?.skuName || "");
    const names = (Array.isArray(candidate) ? candidate : []).map(valueName);
    if (field === "是否含糖" && /无糖|零糖|0糖|不含糖/.test(title)) {
      return names.includes("含糖");
    }
    if (field !== "包装方式" || (detail?.skus || []).length !== 1) return false;
    const spec = String(detail.skus[0].specification || "");
    const t = title.match(/\/(瓶|盒|袋|罐|杯|桶)/);
    const s = spec.match(/[*×x]\s*1\s*(瓶|盒|袋|罐|杯|桶)\s*$/i);
    if (!t || !s || t[1] !== s[1] || /套装|组合|礼盒|混合/.test(title)) return false;
    const normalized = names.map(n => n.replace(/装$/, "").replace(/^听$/, "罐"));
    if (normalized.includes("箱")) return true;
    return normalized.includes("袋") && ["盒", "罐", "瓶"].includes(t[1]);
  }

  function allEvidence(detail, matches, requiredFieldsByChannel = {}) {
    const evidence = [];
    for (const channel of TARGET_CHANNELS) {
      const definitions = matches?.[channel]?.data || [];
      for (const definition of definitions) {
        const current = currentByDefinition(detail, channel, definition);
        const diagnosedInvalid = requiredFieldsByChannel?.[channel]?.has?.(
          normalizeFieldName(definition.propertyName),
        );
        if (!diagnosedInvalid && isValidValues(definition, current) && !contradictsExplicitProduct(definition, current, detail)) {
          evidence.push({
            channel,
            field: normalizeFieldName(definition.propertyName),
            values: current,
            source: "existing_channel_value",
          });
        }
        const matched = materializeValues(definition, definition.matchValue);
        if (isValidValues(definition, matched) && !contradictsExplicitProduct(definition, matched, detail)) {
          evidence.push({
            channel,
            field: normalizeFieldName(definition.propertyName),
            values: matched,
            source: "platform_match",
          });
        }
      }
    }
    return evidence;
  }

  function valuesFromEvidence(definition, candidates) {
    for (const candidate of candidates) {
      const type = definition?.valueType;
      if (type === "SELECT" || type === "MULTI_SELECT") {
        const mapped = candidate.values.map((value) => findOption(definition, value)).filter(Boolean);
        if (mapped.length && (type === "MULTI_SELECT" || mapped.length === 1)) return mapped;
      } else if (type === "INPUT") {
        const text = valueName(candidate.values[0]);
        if (text) return [makeValue(text, "INPUT", null)];
      } else if (type === "INPUT_OPTION" || type === "MULTI_INPUT_OPTION") {
        const mapped = materializeValues(definition, candidate.values);
        if (isValidValues(definition, mapped)) return mapped;
        const loose = chooseLooseComposite(definition, candidate.values.map(valueName).join(" "));
        if (isValidValues(definition, loose)) return loose;
      }
    }
    return [];
  }

  function productText(detail) {
    const skuText = (detail?.skus || [])
      .map((sku) => `${sku.specification || ""} ${(sku.barcodes || []).join(" ")}`)
      .join(" ");
    return `${detail?.skuName || ""} ${detail?.aliasName || ""} ${detail?.subTitle || ""} ${skuText}`;
  }

  function parseMeasurement(text) {
    const expression = /(\d+(?:\.\d+)?)\s*(mAh|毫安时|ml|mL|毫升|l|L|升|g|克|kg|千克|公斤|斤|片|袋|罐|瓶|支|个|只|枚|盒|包|页|本|朵|种|节|粒|个月|天|年|小时|cm|厘米|mm|毫米|㎡|平方米|m²|m2|m|M|米|w|W|瓦|%vol|%)/g;
    const matches = [];
    let match;
    while ((match = expression.exec(text)) !== null) {
      matches.push({ number: Number(match[1]), rawNumber: match[1], unit: match[2], index: match.index });
    }
    return matches;
  }

  function normalizedUnit(unit) {
    const map = {
      毫升: "ml",
      ml: "ml",
      mL: "ml",
      L: "l",
      升: "l",
      克: "g",
      千克: "kg",
      公斤: "kg",
      厘米: "cm",
      毫米: "mm",
      "㎡": "㎡",
      "平方米": "㎡",
      "m²": "㎡",
      m2: "㎡",
      "瓦": "w",
      米: "m",
      "毫安时": "mah",
      mAh: "mah",
    };
    return map[unit] || String(unit || "").toLowerCase();
  }

  function chooseLooseComposite(definition, text) {
    if (!text) return [];
    const measured = chooseMeasurement(definition, definition.propertyName || "", text);
    if (isValidValues(definition, measured)) return measured;
    if (MEASURE_FIELD_RE.test(definition?.propertyName || "") || COUNT_FIELD_RE.test(definition?.propertyName || "")) {
      return [];
    }
    const number = text.match(/\d+(?:\.\d+)?/)?.[0];
    if (!number) return [];
    if (definition.valueType === "INPUT_OPTION") {
      const normalized = normalizeText(text);
      let unit = optionList(definition).find((option) => normalized.includes(normalizeText(valueName(option))));
      if (!unit && optionList(definition).length === 1) unit = optionList(definition)[0];
      return unit
        ? [makeValue(number, "INPUT", null), makeValue(valueName(unit), "SELECT", valueId(unit))]
        : [];
    }
    if (definition.valueType === "MULTI_INPUT_OPTION") {
      const children = definition.subCategoryPropertyList || [];
      return children.map((child) => {
        if (child.subValueType === "SELECT") {
          const normalized = normalizeText(text);
          let unit = optionList(child).find((option) => normalized.includes(normalizeText(valueName(option))));
          if (!unit && optionList(child).length === 1) unit = optionList(child)[0];
          return unit ? makeValue(valueName(unit), "SELECT", valueId(unit)) : null;
        }
        if (child.subValueType === "READ_ONLY_INPUT") return makeValue("×", "READ_ONLY_INPUT", null);
        return makeValue(number, child.subValueType || "INPUT", null);
      }).filter(Boolean);
    }
    return [];
  }

  function chooseMeasurement(definition, fieldName, text) {
    const sourceText = String(text || "");
    let chosen = null;
    if (/酒精度/.test(fieldName)) {
      const explicit = sourceText.match(/酒精(?:度|含量)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:%\s*vol|%vol|vol|%|°|度)/i)
        || sourceText.match(/(\d+(?:\.\d+)?)\s*(?:%\s*vol|%vol|vol)\b/i)
        || sourceText.match(/(?:白酒|果酒|黄酒|米酒|葡萄酒|红酒|干红|威士忌|伏特加|白兰地|青梅酒|洋酒)[^\d度]{0,12}(\d+(?:\.\d+)?)\s*度/i)
        || sourceText.match(/(\d+(?:\.\d+)?)\s*度[^\d]{0,8}(?:白酒|果酒|黄酒|米酒|葡萄酒|红酒|干红|威士忌|伏特加|白兰地|青梅酒|洋酒)/i);
      if (explicit) chosen = { number: Number(explicit[1]), rawNumber: explicit[1], unit: "%vol", index: explicit.index || 0 };
    } else if (/麦汁浓度/.test(fieldName)) {
      const explicit = sourceText.match(/(?:原)?麦(?:汁)?浓度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:°\s*[pP]?|[pP]\b)/i)
        || sourceText.match(/(\d+(?:\.\d+)?)\s*°\s*[pP]\b/i);
      if (explicit) chosen = { number: Number(explicit[1]), rawNumber: explicit[1], unit: "°P", index: explicit.index || 0 };
    }

    const measures = parseMeasurement(sourceText);
    if (!chosen) {
      const allowed = /功率/.test(fieldName)
        ? new Set(["w"])
        : /电池容量/.test(fieldName)
          ? new Set(["mah"])
        : /适用面积/.test(fieldName)
          ? new Set(["㎡"])
          : /保质期/.test(fieldName)
            ? new Set(["个月", "天", "年", "小时"])
            : /净含量|容量/.test(fieldName)
              ? new Set(["ml", "l", "g", "kg", "斤"])
              : /净重|重量/.test(fieldName)
                ? new Set(["g", "kg", "斤"])
                : /长度|线长|尺寸|直径|厚度/.test(fieldName)
                  ? new Set(["m", "cm", "mm"])
                  : null;
      chosen = measures.find((entry) => !allowed || allowed.has(normalizedUnit(entry.unit))) || null;
    }
    if (!chosen && /功率/.test(fieldName)) {
      const electrical = sourceText.match(/(\d+(?:\.\d+)?)\s*v\s*[/×x*]?\s*(\d+(?:\.\d+)?)\s*a/i);
      if (electrical) {
        const watts = Number(electrical[1]) * Number(electrical[2]);
        chosen = { number: watts, rawNumber: String(watts), unit: "W", index: electrical.index || 0 };
      }
    }
    if (!chosen) return [];
    if (/总净含量/.test(fieldName)) {
      const tail = text.slice(chosen.index + String(chosen.rawNumber).length + chosen.unit.length);
      const count = tail.match(/^\s*(?:[*xX×]|\*)\s*(\d+)/);
      if (count) chosen = { ...chosen, number: chosen.number * Number(count[1]), rawNumber: String(chosen.number * Number(count[1])) };
    }
    const sourceUnit = normalizedUnit(chosen.unit);
    if (definition.valueType === "INPUT") {
      let converted = chosen.number;
      if (/\( ?kg\)|（ ?kg）/i.test(fieldName) && sourceUnit === "g") converted /= 1000;
      if (/\( ?l\)|（ ?l）/i.test(fieldName) && sourceUnit === "ml") converted /= 1000;
      if (/\( ?m\)|（ ?m）/.test(fieldName)) {
        if (sourceUnit === "cm") converted /= 100;
        if (sourceUnit === "mm") converted /= 1000;
      }
      if (/\( ?cm\)|（ ?cm）/.test(fieldName)) {
        if (sourceUnit === "m") converted *= 100;
        if (sourceUnit === "mm") converted /= 10;
      }
      if (converted !== chosen.number) chosen = { ...chosen, number: converted, rawNumber: String(Number(converted.toFixed(6))) };
    }
    if (definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT") {
      const wantedUnit = normalizedUnit(chosen.unit);
      const exact = optionList(definition).find((option) => parseMeasurement(valueName(option)).some(
        (entry) => Number(entry.number) === Number(chosen.number) && normalizedUnit(entry.unit) === wantedUnit,
      ));
      return exact ? [clone(exact)] : [];
    }
    if (definition.valueType === "INPUT") {
      return [makeValue(chosen.rawNumber, "INPUT", null)];
    }
    if (definition.valueType === "INPUT_OPTION" || definition.valueType === "MULTI_INPUT_OPTION") {
      const unitWanted = normalizedUnit(chosen.unit);
      const unitDefinition = definition.valueType === "MULTI_INPUT_OPTION"
        ? (definition.subCategoryPropertyList || []).find((child) => child.subValueType === "SELECT")
        : definition;
      let unit = optionList(unitDefinition).find(
        (option) => normalizedUnit(valueName(option)) === unitWanted,
      );
      if (!unit) return [];
      if (definition.valueType === "INPUT_OPTION") {
        return [makeValue(chosen.rawNumber, "INPUT", null), makeValue(valueName(unit), "SELECT", valueId(unit))];
      }
      const children = definition.subCategoryPropertyList || [];
      return children.map((child) => {
        if (child.subValueType === "SELECT") return makeValue(valueName(unit), "SELECT", valueId(unit));
        return makeValue(chosen.rawNumber, child.subValueType || "INPUT", null);
      });
    }
    return [];
  }

  function chooseCount(definition, fieldName, text) {
    let number = null;
    if (/插位数/.test(fieldName) && /插座|插排|插线板|面板|轨道/.test(text)) {
      const conversion = text.match(/一转([二三四五六七八九十])/);
      const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      if (conversion) number = chineseNumbers[conversion[1]];
      if (number == null) {
        const holeMatch = text.match(/(十五|二十|五|十|二十五|三十|\d+)孔/);
        const holeNumbers = { 五: 5, 十: 10, 十五: 15, 二十: 20, 二十五: 25, 三十: 30 };
        const holes = holeMatch ? Number(holeNumbers[holeMatch[1]] || holeMatch[1]) : null;
        if (holes && holes % 5 === 0) number = holes / 5;
      }
    }
    const patterns = [
      /(?:[*xX×]|\*)\s*(\d+)\s*(?:个|件|罐|瓶|袋|盒|包|支|片|只|枚|页)?/,
      /(\d+)\s*(?:个|件|罐|瓶|袋|盒|包|支|片|只|枚|页|杯|孔|位)(?:装|套|组合|\/|\s|$)/,
      /(\d+)\s*\/\s*(?:个|件|罐|瓶|袋|盒|包|支|片|只|枚|页|本|朵|种|节|粒|套|把|根|张|块|台|床)(?:\s|$)/,
    ];
    if (number == null) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          number = Number(match[1]);
          break;
        }
      }
    }
    if (number == null) {
      const chinese = text.match(/([一二两三四五六七八九十])\s*(?:个|件|罐|瓶|袋|盒|包|支|片|只|枚|页|本|朵|种|节|粒|套)(?:装|\/|$)?/);
      const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      if (chinese) number = chineseNumbers[chinese[1]];
    }
    if (number == null && /\/\s*(?:个|件|罐|瓶|袋|盒|包|支|片|只|枚|页|本|朵|种|节|粒|套|把|根|张|块|台|床)(?:\s|$)/.test(text)) {
      number = 1;
    }
    if (number == null) return [];
    if (definition.valueType === "INPUT") return [makeValue(String(number), "INPUT", null)];
    if (definition.valueType === "INPUT_OPTION") {
      const unit = optionList(definition)[0];
      return unit
        ? [makeValue(String(number), "INPUT", null), makeValue(valueName(unit), "SELECT", valueId(unit))]
        : [];
    }
    if (definition.valueType === "MULTI_INPUT_OPTION") {
      const children = definition.subCategoryPropertyList || [];
      return children.map((child) => {
        if (child.subValueType === "SELECT") {
          const unit = optionList(child)[0];
          return unit ? makeValue(valueName(unit), "SELECT", valueId(unit)) : null;
        }
        return makeValue(String(number), child.subValueType || "INPUT", null);
      }).filter(Boolean);
    }
    if (definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT") {
      const selected = optionList(definition).find((option) => {
        const label = valueName(option);
        const optionNumber = label.match(/\d+/)?.[0];
        if (optionNumber != null && Number(optionNumber) === number) return true;
        if (number === 1 && /单|一/.test(label)) return true;
        if (number === 2 && /双|两|二/.test(label)) return true;
        if (number === 3 && /三/.test(label)) return true;
        if (number >= 3 && /多人|3人及以上|三人及以上/.test(label)) return true;
        return false;
      });
      if (selected) return [clone(selected)];
      const other = optionList(definition).find((option) => /其他/.test(valueName(option)));
      return other ? [clone(other)] : [];
    }
    return [];
  }

  function longestMeaningfulOverlap(haystack, needle) {
    const ignored = new Set(["商品", "用品", "专用", "配件", "其他", "通用"]);
    for (let length = Math.min(6, needle.length); length >= 2; length -= 1) {
      for (let index = 0; index <= needle.length - length; index += 1) {
        const fragment = needle.slice(index, index + length);
        if (!ignored.has(fragment) && haystack.includes(fragment)) return length;
      }
    }
    return 0;
  }

  function chooseOptionByTitle(definition, fieldName, text) {
    const normalizedProduct = normalizeText(text);
    const options = optionList(definition);
    const scored = options
      .map((option) => {
        const label = normalizeText(valueName(option));
        let score = 0;
        if (label && normalizedProduct.includes(label) && label.length >= 2) score += 100 + label.length;
        if (/国产进口/.test(normalizeFieldName(fieldName))) {
          if (/进口|海外|原装/.test(text) && /进口/.test(valueName(option))) score += 300;
          if (/国产|国货|中国大陆|中国制造/.test(text) && /国产/.test(valueName(option))) score += 300;
        }
        if (/是否含糖/.test(fieldName)) {
          if (/无糖|零糖|0糖/.test(text) && /无糖|0糖/.test(valueName(option))) score += 300;
          if (/含糖/.test(text) && /含糖/.test(valueName(option))) score += 250;
        }
        if (/适用性别/.test(fieldName)) {
          if (/女/.test(text) && /女/.test(valueName(option))) score += 300;
          if (/男/.test(text) && /男/.test(valueName(option))) score += 300;
          if (/儿童|宝宝|婴幼儿/.test(text) && /儿童|婴/.test(valueName(option))) score += 300;
        }
        if (/是否加绒/.test(fieldName)) {
          if (/加绒|绒里|绒款/.test(text) && !/不加绒|无绒/.test(text) && /加绒/.test(valueName(option))) score += 300;
          if (/薄|无绒|不加绒|夏季|夏款|春夏/.test(text) && !/加绒|绒里|绒款/.test(text) && /不加绒|无绒/.test(valueName(option))) score += 280;
        }
        if (/包装方式/.test(fieldName)) {
          if (/罐/.test(text) && /罐装/.test(valueName(option))) score += 300;
          if (/瓶/.test(text) && /瓶装/.test(valueName(option))) score += 300;
          if (/袋|包/.test(text) && /袋装|包袋/.test(valueName(option))) score += 280;
          if (/盒/.test(text) && /盒装/.test(valueName(option))) score += 300;
          if (/箱/.test(text) && /箱装/.test(valueName(option))) score += 300;
          if (/杯/.test(text) && /杯装/.test(valueName(option))) score += 300;
        }
        if (/材质/.test(fieldName)) {
          if (/不锈钢/.test(text) && /不锈钢/.test(valueName(option))) score += 350;
          if (/金属/.test(text) && /金属/.test(valueName(option))) score += 300;
          if (/塑料|塑胶/.test(text) && /塑料/.test(valueName(option))) score += 300;
          if (/硅胶/.test(text) && /硅胶/.test(valueName(option))) score += 300;
          if (/木/.test(text) && /木/.test(valueName(option))) score += 300;
          const materialAliases = [
            [/高硼硅|无铅玻璃|水晶玻璃|玻璃/, /玻璃|水晶/],
            [/骨瓷|陶瓷|瓷/, /陶瓷|瓷/],
            [/亚克力/, /亚克力|塑料/],
            [/\b(?:PP|PC|ABS|PVC|PE)\b/i, /PP|PC|ABS|PVC|PE|塑料/i],
            [/铝合金|铝制|铝壳/, /铝/],
            [/黄铜|紫铜|铜制/, /铜/],
            [/聚酯纤维|涤纶/, /聚酯|涤纶/],
            [/尼龙/, /尼龙/],
            [/乳胶/, /乳胶/],
            [/牛仔/, /牛仔|棉/],
            [/纯棉|全棉|棉布/, /棉/],
            [/羊毛|毛呢/, /羊毛|毛呢/],
            [/竹制|竹/, /竹/],
            [/树脂/, /树脂/],
            [/橡胶/, /橡胶/],
            [/纸制|纸/, /纸/],
            [/真皮|牛皮|羊皮/, /真皮|牛皮|羊皮/],
          ];
          for (const [productPattern, optionPattern] of materialAliases) {
            if (productPattern.test(text) && optionPattern.test(valueName(option))) score += 360;
          }
        }
        if (/填充物/.test(fieldName)) {
          const fillingAliases = [
            [/无填充|床垫保护套|床笠/, /无填充|无/],
            [/棉花被|棉花胎|棉絮|棉花/, /棉花|棉/],
            [/聚酯纤维|纤维被|羽丝绒/, /聚酯|纤维|羽丝绒/],
            [/羽绒|鸭绒|鹅绒/, /羽绒|鸭绒|鹅绒/],
            [/荞麦/, /荞麦/],
            [/乳胶/, /乳胶/],
            [/水床|水垫/, /水/],
            [/充气|气垫/, /空气|充气/],
          ];
          for (const [productPattern, optionPattern] of fillingAliases) {
            if (productPattern.test(text) && optionPattern.test(valueName(option))) score += 380;
          }
        }
        if (/线长/.test(fieldName)) {
          if (/无线|明装|暗装|墙壁|面板|轨道插座|转换插头|转接头|空气开关/.test(text)
            && !/\d+(?:\.\d+)?\s*(?:m|M|米|cm|厘米)\s*(?:线|线长|数据线)/.test(text)
            && /无线/.test(valueName(option))) score += 420;
        }
        if (/控制方式/.test(fieldName)) {
          const controlAliases = [
            [/遥控/, /遥控/], [/触控|触摸/, /触控|触摸/],
            [/按键|机械式/, /按键|机械/], [/声控/, /声控/],
            [/手动|手持/, /手动/], [/APP控制|APP智控/i, /APP/i],
          ];
          for (const [productPattern, optionPattern] of controlAliases) {
            if (productPattern.test(text) && optionPattern.test(valueName(option))) score += 380;
          }
        }
        if (/供电方式|充电模式/.test(fieldName)) {
          if (/USB|Type-C|type-c/i.test(text) && /USB|Type-C/i.test(valueName(option))) score += 380;
          if (/电池/.test(text) && /电池/.test(valueName(option))) score += 380;
          if (/插电|220V|电源适配器/i.test(text) && /插电|电源|市电/.test(valueName(option))) score += 360;
        }
        if (/适用手机品牌/.test(fieldName)) {
          const aliases = [
            [/苹果|iphone/i, /苹果|apple/i], [/华为|matepad/i, /华为|huawei/i],
            [/小米/i, /小米|xiaomi/i], [/红米|redmi/i, /红米|redmi/i],
            [/真我|realme/i, /真我|realme/i], [/荣耀|honor/i, /荣耀|honor/i],
            [/一加|oneplus/i, /一加|oneplus/i], [/三星|samsung/i, /三星|samsung/i],
            [/oppo/i, /oppo/i], [/vivo/i, /vivo/i], [/iqoo/i, /iqoo/i],
            [/联想|moto/i, /联想|moto|motorola/i], [/魅族|meizu/i, /魅族|meizu/i],
          ];
          for (const [productPattern, optionPattern] of aliases) {
            if (productPattern.test(text) && optionPattern.test(valueName(option))) score += 420;
          }
          if (/switch|任天堂/i.test(text) && /通用|其他/.test(valueName(option))) score += 360;
        }
        if (/功能特点|^功能$/.test(fieldName)) {
          const synonyms = [
            [/防窥/, /防偷窥/], [/超清|高清|增透/, /高清/], [/钢化/, /防爆/],
            [/防摔/, /防摔|防震/], [/抗指纹|磨砂/, /防指纹|抗指纹/],
            [/磁吸/, /磁吸/], [/超薄/, /超薄/], [/散热/, /散热/],
          ];
          for (const [productPattern, optionPattern] of synonyms) {
            if (productPattern.test(text) && optionPattern.test(valueName(option))) score += 360;
          }
        }
        if (/款式特色/.test(fieldName) && /网红/.test(text) && /网红/.test(valueName(option))) score += 420;
        if (/裤长/.test(fieldName)) {
          if (/短裤/.test(text) && /短裤|五分|5分/.test(valueName(option))) score += 420;
          if (/拖地|长裤|阔腿裤|牛仔裤/.test(text) && /长裤/.test(valueName(option))) score += 320;
        }
        if (/加工方式/.test(fieldName)) {
          if (/生茶|生普/.test(text) && /生普/.test(valueName(option))) score += 420;
          if (/熟茶|熟普/.test(text) && /熟普/.test(valueName(option))) score += 420;
        }
        if (/储藏条件/.test(fieldName) && /常温/.test(valueName(option))) score += 260;
        if (/发热体类型/.test(fieldName) && /ptc|陶瓷/i.test(text) && /PTC|陶瓷/i.test(valueName(option))) score += 420;
        if (/耳机插头类型/.test(fieldName) && /苹果|iphone|扁头/i.test(text) && /lightning/i.test(valueName(option))) score += 420;
        if (/接口$/.test(fieldName) && /3\.5mm/.test(text) && /lightning转3\.5mm/i.test(valueName(option))) score += 420;
        if (/灯头接口/.test(fieldName)) {
          const token = text.match(/\b(?:E\d+|G\d+(?:\.\d+)?|GU\d+(?:\.\d+)?|R7S|B22|T\d+)\b/i)?.[0];
          if (token && normalizeText(valueName(option)).includes(normalizeText(token))) score += 420;
        }
        if (/医疗器械分类/.test(fieldName)) {
          if (/防褥疮气垫床/.test(text) && /II|ii|二类|第二类/.test(valueName(option))) score += 420;
          if (/非医疗器械/.test(text) && /非医疗器械/.test(valueName(option))) score += 420;
        }
        if (/商品类别/.test(fieldName)) {
          const overlap = longestMeaningfulOverlap(normalizedProduct, label);
          if (overlap >= 2) score += 160 + overlap * 10;
        }
        return { option, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.length ? [clone(scored[0].option)] : [];
  }

  function chooseSafeDefault(definition, fieldName, text) {
    if (REGULATED_FIELD_RE.test(fieldName)) return [];
    if (COUNT_FIELD_RE.test(fieldName)) {
      const counted = chooseCount(definition, fieldName, text);
      if (counted.length) return counted;
    }
    if (MEASURE_FIELD_RE.test(fieldName)) {
      const measured = chooseMeasurement(definition, fieldName, text);
      if (measured.length) return measured;
    }
    if (definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT") {
      const titleChoice = chooseOptionByTitle(definition, fieldName, text);
      if (titleChoice.length) return titleChoice;
      const preferences = /品牌/.test(fieldName)
        ? ["other/其他", "其他品牌", "无品牌", "其他"]
        : /售卖方式/.test(fieldName) && /(?:\d+(?:\.\d+)?\s*(?:ml|mL|L|g|kg|克|千克|瓶|罐|袋|包|盒|箱))|预包装/.test(text)
          ? ["预包装"]
          : /是否|可否|支持/.test(fieldName) && /不支持|不可|不能|无|否/.test(text)
            ? ["否", "不支持", "不可", "无"]
            : /是否|可否|支持/.test(fieldName) && /支持|可以|可用|是/.test(text)
              ? ["是", "支持", "可以"]
              : [];
      for (const preference of preferences) {
        const option = optionList(definition).find((item) => {
          const label = normalizeText(valueName(item));
          const wanted = normalizeText(preference);
          return label === wanted || label.includes(wanted) || wanted.includes(label);
        });
        if (option) return [clone(option)];
      }
    }
    return [];
  }

  function chooseExtendedSelectFact(definition, fieldName, detail) {
    if (
      !["SELECT", "MULTI_SELECT"].includes(definition?.valueType)
      || String(definition?.supportExtend || "") !== "1"
      || optionList(definition).length
    ) return [];
    const specification = String(detail?.skus?.[0]?.specification || "").trim();
    const title = String(detail?.skuName || "");
    const explicitPack = [...title.matchAll(/\d+(?:\.\d+)?\s*(?:只|片|枚|张|双|条|件|个|支|根|本|套|袋|盒|包|卷|瓶|罐)(?:\s*\/\s*(?:包|袋|条|卷|双|件|盒|根|支|瓶|罐))/gi)].pop()?.[0] || "";
    const exactText = specification || explicitPack;
    if (/包装规格|售卖规格|规格/.test(fieldName) && exactText) {
      // 翱象的 supportExtend 下拉在前端以自由文本输入，原生转换器提交空 ID + 文本名。
      return [{ propertyValueId: "", propertyValueName: exactText, propertyValueType: null }];
    }
    return [];
  }

  function chooseExplicitInputFact(definition, fieldName, text) {
    if (definition.valueType !== "INPUT") return [];
    if (/型号/.test(fieldName)) {
      const token = text.match(/\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9-]{2,}\b/i)?.[0];
      if (token) return [makeValue(token, "INPUT", null)];
    }
    return [];
  }

  function chooseSafeReference(definition, fieldName) {
    const reference = /功率|电压|型号|生产者|制造商|认证证书/.test(fieldName)
      ? "详见产品铭牌"
      : "详见商品包装";
    if (definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT") {
      const other = optionList(definition).find((option) => /其他/.test(valueName(option)));
      return other ? [clone(other)] : [];
    }
    if (definition.valueType === "INPUT") return [makeValue(reference, "INPUT", null)];
    if (definition.valueType === "INPUT_OPTION") {
      const unit = optionList(definition)[0];
      return unit
        ? [makeValue(reference, "INPUT", null), makeValue(valueName(unit), "SELECT", valueId(unit))]
        : [];
    }
    if (definition.valueType === "MULTI_INPUT_OPTION") {
      const children = definition.subCategoryPropertyList || [];
      return children.map((child) => {
        if (child.subValueType === "SELECT") {
          const unit = optionList(child)[0];
          return unit ? makeValue(valueName(unit), "SELECT", valueId(unit)) : null;
        }
        if (child.subValueType === "READ_ONLY_INPUT") return makeValue("×", "READ_ONLY_INPUT", null);
        return makeValue(reference, child.subValueType || "INPUT", null);
      }).filter(Boolean);
    }
    return [];
  }

  function chooseFabricComposite(definition, detail, evidence) {
    if (definition.valueType !== "MULTI_INPUT_OPTION" || !/面料成分|材质/.test(definition.propertyName)) return [];
    const materialEvidence = evidence.find(
      (entry) => /面料成分|材质/.test(entry.field) && valueName(entry.values[0]),
    );
    let material = materialEvidence ? valueName(materialEvidence.values[0]) : "";
    const text = productText(detail);
    if (!material) {
      const candidates = ["棉", "聚酯纤维", "涤纶", "锦纶", "羊毛", "蚕丝", "粘胶"];
      material = candidates.find((name) => text.includes(name)) || "";
    }
    if (!material) return [];
    const escapedMaterial = material.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const percentMatch = text.match(new RegExp(`(?:${escapedMaterial}\\s*)?(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:${escapedMaterial})?`));
    const percent = /纯棉|全棉/.test(text) && material === "棉" ? "100" : percentMatch?.[1];
    if (!percent) return [];
    const children = definition.subCategoryPropertyList || [];
    return children.map((child) => {
      if (child.subValueType === "INPUT") return makeValue(material, "INPUT", null);
      if (child.subValueType === "NUMBER") return makeValue(percent, "NUMBER", null);
      const unit = optionList(child).find((option) => valueName(option) === "%") || optionList(child)[0];
      return unit ? makeValue(valueName(unit), "SELECT", valueId(unit)) : null;
    }).filter(Boolean);
  }

  function diagnosisRequiredFields(row) {
    const output = new Set();
    let issues = [];
    try {
      issues = JSON.parse(row?.channelValue || "[]");
    } catch {
      return output;
    }
    for (const issue of issues) {
      if (Number(issue?.problemType || 0) !== 4) continue;
      const reason = String(issue?.noQualifiedReason || "");
      const match = reason.match(/缺失属性[:：](.+)$/);
      if (!match) continue;
      for (const field of match[1].split(/[,，]/)) {
        const normalized = normalizeFieldName(field);
        if (normalized) output.add(normalized);
      }
    }
    return output;
  }

  function isRequiredDefinition(definition, channel, requiredFieldsByChannel) {
    if (Number(definition?.needFlag || 0) === 1) return true;
    const required = requiredFieldsByChannel?.[channel];
    return Boolean(required?.has?.(normalizeFieldName(definition?.propertyName)));
  }

  function planProperties(detail, matches, requiredFieldsByChannel = {}) {
    const evidence = allEvidence(detail, matches, requiredFieldsByChannel);
    const text = productText(detail);
    const output = clone(detail.channelGeneralCategoryProperty || {});
    const changes = [];
    const blockers = [];

    for (const channel of TARGET_CHANNELS) {
      const definitions = matches?.[channel]?.data || [];
      if (!definitions.length) {
        const category = (detail.channelBackCategoryList || []).find((item) => item.channelCode === channel);
        const notApplicableService = /信息公告|店铺服务|店铺公告/.test(`${category?.categoryName || ""}${category?.categoryPath || ""}`);
        if (category && !notApplicableService) blockers.push({ channel, field: "*", reason: "missing_channel_definition" });
        continue;
      }
      const planned = [];
      for (const definition of definitions) {
        const required = isRequiredDefinition(definition, channel, requiredFieldsByChannel);
        const before = currentByDefinition(detail, channel, definition);
        const rawBefore = rawCurrentByDefinition(detail, channel, definition);
        const diagnosedInvalid = requiredFieldsByChannel?.[channel]?.has?.(
          normalizeFieldName(definition.propertyName),
        );
        let current = diagnosedInvalid ? [] : before;
        let source = "existing_channel_value";
        if (required && !isValidValues(definition, current)) {
          current = materializeValues(definition, definition.matchValue);
          source = "platform_match";
          const recommendationConflict = contradictsExplicitProduct(definition, current, detail);
          if (recommendationConflict) current = [];
          if (!recommendationConflict && !isValidValues(definition, current) && (definition.matchValue || []).length) {
            current = valuesFromEvidence(definition, [{ values: definition.matchValue }]);
          }
          if (!isValidValues(definition, current)) {
            const crossCandidates = evidence.filter(
              (entry) => entry.channel !== channel && entry.field === normalizeFieldName(definition.propertyName),
            );
            current = valuesFromEvidence(definition, crossCandidates);
            source = "cross_channel_equivalent";
          }
          if (!isValidValues(definition, current)) {
            current = chooseFabricComposite(definition, detail, evidence);
            source = "same_product_composite";
          }
          if (
            !isValidValues(definition, current)
            && !REGULATED_FIELD_RE.test(definition.propertyName)
            && (definition.valueType === "INPUT_OPTION" || definition.valueType === "MULTI_INPUT_OPTION")
            && valueName(rawBefore[0])
          ) {
            current = chooseLooseComposite(definition, rawBefore.map(valueName).join(" "));
            if (!isValidValues(definition, current)) {
              const repairedCount = Number(valueName(rawBefore[0]));
              if (Number.isFinite(repairedCount)) current = chooseCount(definition, definition.propertyName, `${repairedCount}个`);
            }
            source = "repair_partial_composite";
          }
          if (!isValidValues(definition, current)) {
            current = definition.valueType === "SELECT" || definition.valueType === "MULTI_SELECT"
              ? chooseOptionByTitle(definition, definition.propertyName, text)
              : chooseExplicitInputFact(definition, definition.propertyName, text);
            if (!isValidValues(definition, current)) {
              current = MEASURE_FIELD_RE.test(definition.propertyName)
                ? chooseMeasurement(definition, definition.propertyName, text)
                : COUNT_FIELD_RE.test(definition.propertyName)
                  ? chooseCount(definition, definition.propertyName, text)
                  : chooseOptionByTitle(definition, definition.propertyName, text);
            }
            source = "title_or_spec_fact";
          }
          if (!isValidValues(definition, current)) {
            current = chooseExtendedSelectFact(definition, definition.propertyName, detail);
            source = "title_or_spec_fact";
          }
          if (!isValidValues(definition, current)) {
            current = chooseSafeDefault(definition, definition.propertyName, text);
            source = "safe_non_regulated_default";
          }
        }
        if (contradictsExplicitProduct(definition, current, detail)) {
          current = rawBefore;
          blockers.push({ channel, fieldId: String(definition.propertyId), field: definition.propertyName, reason: "semantic_conflict_with_title_and_spec" });
        }
        if (required && !isValidValues(definition, current)) {
          blockers.push({
            channel,
            fieldId: String(definition.propertyId),
            field: definition.propertyName,
            valueType: definition.valueType,
            regulated: REGULATED_FIELD_RE.test(definition.propertyName),
            reason: REGULATED_FIELD_RE.test(definition.propertyName)
              ? "missing_same_product_regulated_evidence"
              : "no_valid_value_or_option",
          });
        }
        planned.push(stripDefinition(definition, current, required));
        if (JSON.stringify(before) !== JSON.stringify(current)) {
          changes.push({
            channel,
            fieldId: String(definition.propertyId),
            field: definition.propertyName,
            valueType: definition.valueType,
            before: clone(before),
            planned: clone(current),
            source,
          });
        }
      }
      output[channel] = planned;
    }
    return { properties: output, changes, blockers, requiredFieldsByChannel };
  }

  function applyEvidenceOverrides(plan, matches, skuCode, evidenceOverrides = {}, detail = null) {
    if (!plan.appliedEvidenceOverrideKeys) plan.appliedEvidenceOverrideKeys = new Set();
    const skuOverrides = evidenceOverrides?.[String(skuCode)] || {};
    for (const [channel, channelOverrides] of Object.entries(skuOverrides)) {
      const definitions = matches?.[channel]?.data || [];
      const planned = plan.properties?.[channel] || [];
      for (const [fieldKey, overrideConfig] of Object.entries(channelOverrides || {})) {
        const override = Array.isArray(overrideConfig) ? { values: overrideConfig } : (overrideConfig || {});
        const definition = definitions.find((item) => String(item.propertyId) === String(fieldKey))
          || definitions.find((item) => normalizeFieldName(item.propertyName) === normalizeFieldName(fieldKey));
        if (!definition) {
          plan.blockers.push({ channel, fieldId: String(fieldKey), field: String(fieldKey), reason: "evidence_override_definition_missing" });
          continue;
        }
        const values = materializeValues(definition, override.values || []);
        if (!isValidValues(definition, values)) {
          plan.blockers.push({
            channel,
            fieldId: String(definition.propertyId),
            field: definition.propertyName,
            reason: "evidence_override_value_invalid",
          });
          continue;
        }
        plan.appliedEvidenceOverrideKeys.add(`${channel}:${definition.propertyId}`);
        const property = planned.find((item) => String(item.propertyId) === String(definition.propertyId));
        const before = detail
          ? currentByDefinition(detail, channel, definition)
          : materializeValues(definition, property?.currentValue || []);
        if (property) {
          property.currentValue = clone(values);
          property.needFlag = 1;
        } else {
          planned.push(stripDefinition(definition, values, true));
        }
        plan.blockers = plan.blockers.filter(
          (blocker) => !(blocker.channel === channel && (
            String(blocker.fieldId || "") === String(definition.propertyId)
            || normalizeFieldName(blocker.field) === normalizeFieldName(definition.propertyName)
          )),
        );
        const change = {
          channel,
          fieldId: String(definition.propertyId),
          field: definition.propertyName,
          valueType: definition.valueType,
          before,
          planned: clone(values),
          source: override.source || "same_product_media_evidence",
          evidence: override.evidence || null,
        };
        const existing = plan.changes.findIndex(
          (item) => item.channel === channel && String(item.fieldId) === String(definition.propertyId),
        );
        if (JSON.stringify(before) !== JSON.stringify(values)) {
          if (existing >= 0) plan.changes[existing] = change;
          else plan.changes.push(change);
        } else if (existing >= 0) {
          plan.changes.splice(existing, 1);
        }
      }
      plan.properties[channel] = planned;
    }
    return plan;
  }

  function retainOnlyEvidenceOverrides(plan, detail, matches, skuCode, evidenceOverrides = {}) {
    const allowed = plan.appliedEvidenceOverrideKeys || new Set();
    plan.changes = plan.changes.filter((change) => allowed.has(`${change.channel}:${change.fieldId}`));
    for (const channel of TARGET_CHANNELS) {
      const definitions = matches?.[channel]?.data || [];
      const planned = plan.properties?.[channel] || [];
      for (const definition of definitions) {
        if (allowed.has(`${channel}:${definition.propertyId}`)) continue;
        const property = planned.find((item) => String(item.propertyId) === String(definition.propertyId));
        const original = rawCurrentByDefinition(detail, channel, definition);
        if (property) property.currentValue = clone(original);
      }
    }
    return plan;
  }

  function normalizeSku(detail, sku) {
    const weight = sku.weightForUnit == null ? sku.weight : sku.weightForUnit;
    return {
      masterChannelCategoryProperty: clone(sku.masterChannelCategoryProperty || {}),
      masterSpecification: sku.masterSpecification || sku.specification || "",
      skuPic: sku.skuPic || "",
      extendsAttributes: clone(sku.extendsAttributes || {}),
      specification: sku.specification || "",
      channelCategoryProperty: clone(sku.channelCategoryProperty || {}),
      barcodes: clone(sku.barcodes || []),
      mainBarCode: sku.mainBarCode || sku.barcodes?.[0] || "",
      skuCode: sku.skuCode || sku.subSkuCode,
      suggestPrice: sku.suggestPrice,
      weightForUnit: weight,
      weightUnit: sku.weightUnit,
      inventoryUnit: sku.inventoryUnit || detail.inventoryUnit,
      saleUnit: sku.saleUnit || detail.saleUnit,
      cabinetCodeList: clone(sku.cabinetCodeList || []),
      saleStartWith: String(sku.saleStartWith == null ? 1 : sku.saleStartWith),
      storeGoodsCustomSaleStartWithFlag: Number(sku.storeGoodsCustomSaleStartWithFlag || 0),
      saleStep: String(sku.saleStep == null ? 1 : sku.saleStep),
      packageFeeFlag: Number(sku.packageFeeFlag || 0),
      ...(sku.packageFeeStep == null ? {} : { packageFeeStep: sku.packageFeeStep }),
      ...(sku.packageFee == null ? {} : { packageFee: sku.packageFee }),
      purchaseUnit: sku.purchaseUnit || detail.purchaseUnit || sku.inventoryUnit || detail.inventoryUnit,
      purchaseSpec: sku.purchaseSpec || detail.purchaseSpec || 1,
    };
  }

  function assertMultiSpecSafe(detail, skus) {
    const expectedCount = Number(detail?._expectedSkuCount || 1);
    const hasMultiSpu = String(detail?.spuCode || "").startsWith("@@") || Number(detail?.goodsType) === 1 || Number(detail?.originGoodsType) === 1;
    if (detail?._relationVerified === false) {
      throw new Error("FATAL_MULTI_SPEC_GUARD_MISSING: /goods/relation/detail was not verified before building master/update payload");
    }
    if (skus.length < expectedCount) {
      throw new Error(`FATAL_MULTI_SPEC_DOWNGRADE_BLOCKED: payload skus.length (${skus.length}) < expectedSkuCount (${expectedCount})`);
    }
    if (hasMultiSpu && skus.length <= 1 && expectedCount > 1) {
      throw new Error(`FATAL_MULTI_SPEC_DOWNGRADE_BLOCKED: multi-spec SPU (${detail?.spuCode}) cannot be saved with skus.length=${skus.length}`);
    }
  }

  function buildSavePayload(detail, plannedProperties) {
    const skus = (detail.skus || []).map((sku, index) => {
      const normalized = normalizeSku(detail, sku);
      normalized.specRank = sku.specRank || sku.rank || (index + 1);
      normalized.rank = sku.rank || sku.specRank || (index + 1);
      return normalized;
    });
    assertMultiSpecSafe(detail, skus);
    const firstSku = skus[0] || {};
    const pictures = [detail.mainPic, ...(detail.subPic || [])].filter(Boolean);
    const specialPictures = Array.isArray(detail.specialPictures) ? clone(detail.specialPictures) : [];
    const multipleFrontCategoryList = Array.isArray(detail.multipleFrontCategoryList)
      ? clone(detail.multipleFrontCategoryList)
      : [];
    const storeGoodsCustomFields = skus.map((sku) => ({
      barcodes: clone(sku.barcodes || []),
      skuCode: sku.skuCode,
      storeGoodsCustomSaleStartWithFlag: sku.storeGoodsCustomSaleStartWithFlag,
      saleStartWith: sku.saleStartWith,
      weightUnit: sku.weightUnit,
      weightForUnit: sku.weightForUnit,
      specification: sku.specification,
      channelCategoryProperty: clone(sku.channelCategoryProperty || {}),
      cabinetCodeList: clone(sku.cabinetCodeList || []),
    }));
    return {
      skus,
      multipleFrontCategoryListJson: JSON.stringify(multipleFrontCategoryList),
      skuName: detail.skuName || "",
      mainPic: detail.mainPic || "",
      subPic: clone(detail.subPic || []),
      frontCategoryId: clone(detail.frontCategoryId || []),
      multipleFrontCategoryList,
      merchantCategoryId: detail.merchantCategoryId,
      channelBackCategoryList: (detail.channelBackCategoryList || []).map((category) => ({
        channelCode: category.channelCode,
        categoryName: category.categoryName || "",
        categoryId: category.categoryId == null ? "" : String(category.categoryId),
        categoryPath: category.categoryPath || "",
        matchCategoryId: category.matchCategoryId || "",
        matchCategoryName: category.matchCategoryName || "",
        matchCategoryPath: category.matchCategoryPath || "",
      })),
      aliasName: detail.aliasName || "",
      subTitle: detail.subTitle || "",
      description: detail.description || "",
      goodsType: Number(detail.goodsType || 0),
      specialPictures,
      specialPicturesJson: JSON.stringify(specialPictures),
      channelCategoryProperty: clone(detail.channelCategoryProperty || {}),
      specification: firstSku.specification || "",
      inventoryUnit: detail.inventoryUnit || firstSku.inventoryUnit,
      saleUnit: detail.saleUnit || firstSku.saleUnit,
      deliveryCondition: detail.deliveryCondition || "normal",
      storeGoodsCustomSkuNameFlag: detail.storeGoodsCustomSkuNameFlag,
      storeGoodsCustomPropertyFlag: Number(detail.storeGoodsCustomPropertyFlag || 0),
      customProperty: clone(detail.customProperty),
      storeGoodsCustomAliasNameFlag: detail.storeGoodsCustomAliasNameFlag,
      storeGoodsCustomDescriptionFlag: detail.storeGoodsCustomDescriptionFlag,
      storeGoodsCustomWeightFlag: detail.storeGoodsCustomWeightFlag || null,
      weightForUnit: firstSku.weightForUnit,
      weightUnit: firstSku.weightUnit,
      storeGoodsCustomSubTitleFlag: detail.storeGoodsCustomSubTitleFlag,
      storeGoodsCustomProductNameSupplementFlag: detail.storeGoodsCustomProductNameSupplementFlag,
      productNameSupplement: detail.productNameSupplement,
      pictureList: pictures,
      storeGoodsCustomPictureFlag: Number(detail.storeGoodsCustomPictureFlag || 0),
      cabinetCodeList: clone(firstSku.cabinetCodeList || []),
      storeGoodsCustomFields,
      storeGoodsCustomFieldsJson: JSON.stringify(storeGoodsCustomFields),
      goodsStatus: Number(detail.goodsStatus || 0),
      videoUrls: clone(detail.videoUrls || []),
      videoIds: clone(detail.videoIds || []),
      channelGeneralCategoryProperty: clone(plannedProperties),
      channelAfterSaleRuleMap: clone(detail.channelAfterSaleRuleMap || {}),
      updateOnExitActivityFlag: 0,
      purchaseUnit: detail.purchaseUnit || firstSku.purchaseUnit || firstSku.inventoryUnit,
      purchaseSpec: detail.purchaseSpec || firstSku.purchaseSpec || 1,
    };
  }

  function applyCategoryOverrides(task, detail, skuCode) {
    const overrides = task?.config?.categoryOverrides?.[String(skuCode)] || {};
    const repairs = [];
    for (const [channel, override] of Object.entries(overrides)) {
      const list = detail.channelBackCategoryList || (detail.channelBackCategoryList = []);
      const index = list.findIndex((category) => category.channelCode === channel);
      const before = index >= 0 ? clone(list[index]) : null;
      const planned = {
        ...(before || {}),
        channelCode: channel,
        categoryId: String(override.categoryId),
        categoryName: override.categoryName || "",
        categoryPath: override.categoryPath || "",
      };
      if (before && String(before.categoryId) === planned.categoryId) continue;
      if (index >= 0) list[index] = planned;
      else list.push(planned);
      repairs.push({
        channel,
        fieldId: "__channel_category__",
        field: "渠道类目",
        valueType: "CATEGORY",
        before: before ? [makeValue(`${before.categoryId}|${before.categoryName || before.categoryPath || ""}`, "CATEGORY", before.categoryId)] : [],
        planned: [makeValue(`${planned.categoryId}|${planned.categoryName || planned.categoryPath}`, "CATEGORY", planned.categoryId)],
        source: "exact_obsolete_category_repair",
        beforeCategory: before,
        plannedCategory: clone(planned),
      });
    }
    return repairs;
  }

  function verifyCategoryRepairs(detail, repairs) {
    const issues = [];
    for (const repair of repairs) {
      const current = (detail.channelBackCategoryList || []).find(
        (category) => category.channelCode === repair.channel,
      );
      if (!current || String(current.categoryId) !== String(repair.plannedCategory.categoryId)) {
        issues.push({
          channel: repair.channel,
          fieldId: repair.fieldId,
          field: repair.field,
          reason: "category_readback_mismatch",
          expected: String(repair.plannedCategory.categoryId),
          actual: current?.categoryId == null ? "" : String(current.categoryId),
        });
      }
    }
    return issues;
  }

  function taskRoot() {
    if (!root.__aoxiangEngineTasks) root.__aoxiangEngineTasks = {};
    return root.__aoxiangEngineTasks;
  }

  function errorInfo(error) {
    return {
      name: error?.name || "Error",
      message: String(error?.message || error),
      status: error?.status || null,
      code: error?.code || null,
    };
  }

  async function requestJson(task, path, options = {}) {
    const mutation = Boolean(options.mutation);
    const attempts = mutation ? 1 : Number(options.attempts || 3);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = controller
        ? setTimeout(() => controller.abort(), Number(options.timeoutMs || (mutation ? 45000 : 30000)))
        : null;
      try {
        const response = await fetch(`${task.config.apiRoot}${path}`, {
          method: options.method || "GET",
          credentials: "include",
          headers: options.body == null ? undefined : { "content-type": "application/json" },
          body: options.body == null ? undefined : JSON.stringify(options.body),
          signal: controller?.signal,
        });
        const text = await response.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          const parseError = new Error(`invalid_json:${path}`);
          parseError.status = response.status;
          throw parseError;
        }
        task.metrics.requests += 1;
        task.metrics.requestMs += Date.now() - started;
        if (!response.ok || json.success === false || json.failed === true) {
          const httpError = new Error(json.message || `http_${response.status}`);
          httpError.status = response.status;
          httpError.code = json.code;
          if (response.status === 429) task.metrics.rateLimits += 1;
          throw httpError;
        }
        return json;
      } catch (error) {
        task.metrics.requestErrors += 1;
        lastError = error;
        const retryable = !mutation && attempt < attempts && (
          error?.name === "AbortError" ||
          error?.status === 429 ||
          error?.code === "SYSTEM_ERROR" ||
          Number(error?.status || 0) >= 500 ||
          /Failed to fetch|NetworkError|timeout|aborted/i.test(String(error?.message || error))
        );
        if (!retryable) throw error;
        await sleep(300 * attempt + Math.floor(Math.random() * 250));
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw lastError || new Error(`request_failed:${path}`);
  }

  async function fetchDetail(task, skuCode) {
    return requestJson(task, `/goods/master/detail?skuCode=${encodeURIComponent(skuCode)}`);
  }

  async function fetchRelationList(task, code) {
    if (!code) return [];
    const res = await requestJson(
      task,
      `/goods/relation/detail?skuCode=${encodeURIComponent(code)}&relationType=1&positive=1`,
    );
    return Array.isArray(res?.data) ? res.data : [];
  }

  async function hydrateRelationSkus(task, detail, row) {
    const rawCode = String(row?.skuCode || detail?.skus?.[0]?.skuCode || "");
    const spuCode = String(detail?.spuCode || row?.spuCode || "");
    let relList = await fetchRelationList(task, rawCode);
    if ((!relList || relList.length <= 1) && spuCode.startsWith("@@") && spuCode !== rawCode) {
      const spuRelList = await fetchRelationList(task, spuCode);
      if (spuRelList.length > relList.length) relList = spuRelList;
    }
    const rowMultiCount = Array.isArray(row?.multiSubGoods) && row.multiSubGoods.length > 0
      ? row.multiSubGoods.length
      : 0;
    const expectedCount = Math.max(
      detail?.skus?.length || 1,
      relList?.length || 0,
      rowMultiCount,
      spuCode.startsWith("@@") ? 2 : 1,
    );
    if (relList && relList.length > 0) {
      const baseSku = detail.skus?.[0] || {};
      detail.skus = relList.map((relItem, index) => {
        const mg = relItem.masterGoods || {};
        const itemSku = mg?.skus?.[0] || {};
        const merged = clone(baseSku);
        merged.skuCode = itemSku.skuCode || relItem.subSkuCode || merged.skuCode;
        merged.subSkuCode = merged.skuCode;
        merged.barcodes = Array.isArray(itemSku.barcodes) && itemSku.barcodes.length > 0
          ? clone(itemSku.barcodes)
          : [itemSku.mainBarCode || merged.mainBarCode].filter(Boolean);
        merged.mainBarCode = merged.barcodes[0] || "";
        merged.specification = itemSku.specification || merged.specification || "";
        merged.masterSpecification = merged.specification;
        merged.suggestPrice = itemSku.suggestPrice != null ? itemSku.suggestPrice : merged.suggestPrice;
        const validWeight = (itemSku.weight && itemSku.weight > 0 && itemSku.weight < 99999)
          ? itemSku.weight
          : ((merged.weight && merged.weight > 0 && merged.weight < 99999) ? merged.weight : 10);
        merged.weight = validWeight;
        merged.weightForUnit = validWeight;
        merged.weightUnit = itemSku.weightUnit || merged.weightUnit || "g";
        merged.cabinetCodeList = Array.isArray(itemSku.cabinetCodeList) && itemSku.cabinetCodeList.length > 0
          ? clone(itemSku.cabinetCodeList)
          : clone(merged.cabinetCodeList || []);
        merged.specRank = relItem.rank || (index + 1);
        merged.rank = relItem.rank || (index + 1);
        if (merged.channelCategoryProperty) {
          for (const ch of ["MT", "JD", "ELE"]) {
            if (merged.channelCategoryProperty[ch]?.[0]?.currentValue) {
              merged.channelCategoryProperty[ch][0].currentValue.propertyValueName = merged.specification;
            }
          }
        }
        return merged;
      });
      if (detail.skus.length > 1) {
        detail.goodsType = 1;
        detail.originGoodsType = 1;
      }
    }
    detail._relationVerified = true;
    detail._expectedSkuCount = expectedCount;
    assertMultiSpecSafe(detail, detail.skus || []);
    return detail;
  }

  function categoriesFor(detail) {
    return Object.fromEntries(
      (detail.channelBackCategoryList || []).map((category) => [category.channelCode, String(category.categoryId)]),
    );
  }

  function primaryBarcode(detail) {
    const sku = detail.skus?.[0];
    return sku?.mainBarCode || sku?.barcodes?.[0] || "";
  }

  async function fetchMatches(task, detail) {
    const categories = categoriesFor(detail);
    const barcode = primaryBarcode(detail);
    const pairs = await Promise.all(TARGET_CHANNELS.map(async (channel) => {
      if (!categories[channel]) return [channel, { data: [], success: false, missingCategory: true }];
      const response = await requestJson(task, "/goods/master/matchChannelCategoryPropertyV3", {
        method: "POST",
        body: {
          channelCode: channel,
          channelCategoryId: categories[channel],
          barcode,
          skuName: detail.skuName,
        },
      });
      return [channel, response];
    }));
    return Object.fromEntries(pairs);
  }

  function verifyPlanned(detail, matches, plan, options = {}) {
    const issues = [];
    for (const channel of TARGET_CHANNELS) {
      const readback = detail.channelGeneralCategoryProperty?.[channel] || [];
      const definitions = matches?.[channel]?.data || [];
      if (!options.changesOnly) {
        for (const definition of definitions) {
          if (!isRequiredDefinition(definition, channel, plan.requiredFieldsByChannel || {})) continue;
          const current = currentByDefinition(detail, channel, definition);
          if (!isValidValues(definition, current)) {
            issues.push({ channel, fieldId: String(definition.propertyId), field: definition.propertyName, reason: "required_value_invalid" });
          }
        }
      }
      for (const change of plan.changes.filter((item) => item.channel === channel)) {
        const current = readback.find((item) => String(item.propertyId) === String(change.fieldId));
        const currentValues = materializeValues(
          (matches[channel].data || []).find((item) => String(item.propertyId) === String(change.fieldId)) || current,
          current?.currentValue || [],
        );
        const definition = (matches[channel].data || []).find(
          (item) => String(item.propertyId) === String(change.fieldId),
        ) || current;
        const comparisonKey = (value, index) => {
          if (definition?.valueType === "INPUT") return valueName(value);
          if (definition?.valueType === "INPUT_OPTION" && index === 0) return valueName(value);
          if (definition?.valueType === "MULTI_INPUT_OPTION") {
            const child = definition.subCategoryPropertyList?.[index];
            if (child?.subValueType !== "SELECT") return valueName(value);
          }
          return `${valueId(value)}|${valueName(value)}`;
        };
        const expected = change.planned.map(comparisonKey);
        const actual = currentValues.map(comparisonKey);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          issues.push({ channel, fieldId: change.fieldId, field: change.field, reason: "readback_mismatch", expected, actual });
        }
      }
    }
    return issues;
  }

  async function inspectOne(task, row, mode) {
    const started = Date.now();
    const skuCode = String(row.skuCode);
    const base = {
      skuCode,
      skuName: row.skuName || "",
      barcode: row.barcode || "",
      channelCategoryId: row.channelCategoryId || "",
      startedAt: nowIso(),
      mode,
    };
    try {
      const detailResponse = await fetchDetail(task, skuCode);
      const detail = detailResponse.data;
      if (!detail || !detail.skus?.length) throw new Error("missing_product_detail");
      await hydrateRelationSkus(task, detail, row);
      const categoryRepairs = applyCategoryOverrides(task, detail, skuCode);
      const matches = await fetchMatches(task, detail);
      const diagnosedRequired = diagnosisRequiredFields(row);
      const requiredFieldsByChannel = diagnosedRequired.size
        ? { [task.config.diagnosisChannelCode]: diagnosedRequired }
        : {};
      const plan = planProperties(detail, matches, requiredFieldsByChannel);
      applyEvidenceOverrides(plan, matches, skuCode, task.config.evidenceOverrides, detail);
      if (task.config.evidenceOverridesOnly) {
        retainOnlyEvidenceOverrides(plan, detail, matches, skuCode, task.config.evidenceOverrides);
      }
      const partialEvidenceScope = Boolean(
        task.config.allowPartialEvidence
        && task.config.evidenceOverridesOnly
        && diagnosedRequired.size,
      );
      const partialApply = Boolean(
        partialEvidenceScope
        && (plan.changes.length || categoryRepairs.length),
      );
      const result = {
        ...base,
        skuName: detail.skuName || base.skuName,
        barcode: primaryBarcode(detail) || base.barcode,
        changes: [...categoryRepairs, ...plan.changes],
        categoryRepairs,
        diagnosisRefresh: diagnosedRequired.size > 0 && plan.changes.length === 0 && categoryRepairs.length === 0,
        blockers: plan.blockers,
        state: plan.blockers.length && !partialApply
          ? "blocked"
          : mode === "scan"
            ? (partialApply ? "planned_partial" : "planned")
            : (partialApply ? "ready_partial" : "ready"),
      };
      if (mode === "scan" || (plan.blockers.length && !partialApply)) {
        result.elapsedMs = Date.now() - started;
        result.finishedAt = nowIso();
        return result;
      }
      if (!plan.changes.length && !categoryRepairs.length && !diagnosedRequired.size) {
        const issues = verifyPlanned(detail, matches, plan);
        result.verificationIssues = issues;
        result.state = issues.length ? "failed" : "verified_no_change";
        result.elapsedMs = Date.now() - started;
        result.finishedAt = nowIso();
        return result;
      }
      const payload = buildSavePayload(detail, plan.properties);
      result.payloadShape = {
        topLevelKeys: Object.keys(payload),
        skuCount: payload.skus.length,
        targetPropertyCounts: Object.fromEntries(TARGET_CHANNELS.map((channel) => [channel, payload.channelGeneralCategoryProperty?.[channel]?.length || 0])),
      };
      let saveResponse;
      try {
        saveResponse = await requestJson(task, "/goods/master/update", {
          method: "POST",
          body: payload,
          mutation: true,
          timeoutMs: task.config.mutationTimeoutMs,
        });
        result.save = { state: "acknowledged", message: saveResponse.message || "OK" };
      } catch (saveError) {
        result.save = { state: "unknown_or_failed", error: errorInfo(saveError) };
      }
      const readbackResponse = await fetchDetail(task, skuCode);
      const readback = readbackResponse.data;
      const issues = [
        ...verifyPlanned(readback, matches, plan, { changesOnly: partialEvidenceScope }),
        ...verifyCategoryRepairs(readback, categoryRepairs),
      ];
      result.verificationIssues = issues;
      result.readback = {
        state: issues.length ? "mismatch" : "verified",
        verifiedFieldCount: result.changes.length - issues.filter((issue) => /readback_mismatch/.test(issue.reason)).length,
        changedFieldCount: result.changes.length,
      };
      result.state = issues.length ? "failed" : partialEvidenceScope ? "verified_partial" : "verified";
      result.elapsedMs = Date.now() - started;
      result.finishedAt = nowIso();
      return result;
    } catch (error) {
      return {
        ...base,
        state: "failed",
        error: errorInfo(error),
        elapsedMs: Date.now() - started,
        finishedAt: nowIso(),
      };
    }
  }

  function summarizeTask(task) {
    const counts = {};
    const sourceCounts = {};
    const blockerFields = {};
    const durations = [];
    for (const item of Object.values(task.items)) {
      counts[item.state] = (counts[item.state] || 0) + 1;
      if (Number.isFinite(item.elapsedMs)) durations.push(item.elapsedMs);
      for (const change of item.changes || []) sourceCounts[change.source] = (sourceCounts[change.source] || 0) + 1;
      for (const blocker of item.blockers || []) blockerFields[blocker.field] = (blockerFields[blocker.field] || 0) + 1;
    }
    durations.sort((a, b) => a - b);
    const percentile = (fraction) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] : null;
    return {
      taskId: task.id,
      engineVersion: ENGINE_VERSION,
      mode: task.mode,
      running: task.running,
      paused: task.paused,
      pauseRequested: task.pauseRequested,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      totalRows: task.rows.length,
      selectedRows: task.selectedRows,
      processed: Object.keys(task.items).length,
      counts,
      sourceCounts,
      blockerFields,
      concurrency: task.concurrency,
      peakConcurrency: task.peakConcurrency,
      metrics: clone(task.metrics),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      lastItems: task.order.slice(-10).map((skuCode) => {
        const item = task.items[skuCode];
        return { skuCode, state: item.state, elapsedMs: item.elapsedMs, error: item.error || item.save?.error || null };
      }),
    };
  }

  function createTask(config) {
    if (!config?.taskId) throw new Error("taskId is required");
    if (!Array.isArray(config.rows) || !config.rows.length) throw new Error("rows are required");
    const tasks = taskRoot();
    if (tasks[config.taskId]?.running) throw new Error(`task already running: ${config.taskId}`);
    const seen = new Set();
    const rows = config.rows.filter((row) => {
      const key = String(row.skuCode || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const task = {
      id: config.taskId,
      config: {
        apiRoot: config.apiRoot || DEFAULT_API_ROOT,
        storeCode: config.storeCode,
        storeName: config.storeName,
        planId: Number(config.planId),
        diagnosisChannelCode: config.diagnosisChannelCode || "ELE",
        diagnosisType: Number(config.diagnosisType || 38),
        maxConcurrency: Math.max(1, Math.min(10, Number(config.maxConcurrency || 4))),
        mutationTimeoutMs: Number(config.mutationTimeoutMs || 45000),
        categoryOverrides: clone(config.categoryOverrides || {}),
        evidenceOverrides: clone(config.evidenceOverrides || {}),
        evidenceOverridesOnly: Boolean(config.evidenceOverridesOnly),
        allowPartialEvidence: Boolean(config.allowPartialEvidence),
      },
      rows,
      items: clone(config.initialItems || {}),
      order: Object.keys(config.initialItems || {}),
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      mode: null,
      running: false,
      paused: false,
      pauseRequested: false,
      selectedRows: 0,
      concurrency: 1,
      peakConcurrency: 1,
      metrics: { requests: 0, requestErrors: 0, requestMs: 0, rateLimits: 0, waves: 0 },
    };
    tasks[task.id] = task;
    return summarizeTask(task);
  }

  async function runWave(task, rows, mode, concurrency) {
    let next = 0;
    const worker = async () => {
      while (true) {
        if (task.pauseRequested) return;
        const index = next;
        next += 1;
        if (index >= rows.length) return;
        const row = rows[index];
        const item = await inspectOne(task, row, mode);
        task.items[item.skuCode] = item;
        task.order.push(item.skuCode);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  }

  async function executeTask(task, options) {
    const mode = options.mode === "scan" ? "scan" : "apply";
    task.mode = mode;
    task.running = true;
    task.paused = false;
    task.pauseRequested = false;
    task.startedAt = task.startedAt || nowIso();
    const skipStates = new Set(["verified", "verified_no_change", "verified_partial"]);
    const offset = Math.max(0, Number(options.offset || 0));
    const limit = options.limit == null ? task.rows.length : Math.max(0, Number(options.limit));
    const candidates = task.rows
      .filter((row) => !skipStates.has(task.items[String(row.skuCode)]?.state))
      .slice(offset, offset + limit);
    task.selectedRows = candidates.length;
    let cursor = 0;
    let concurrency = Math.max(1, Math.min(task.config.maxConcurrency, Number(options.initialConcurrency || 1)));
    let cleanWaves = 0;
    const concurrencySteps = [1, 2, 4, 6, 8, 10].filter((value) => value <= task.config.maxConcurrency);

    while (cursor < candidates.length && !task.pauseRequested) {
      task.concurrency = concurrency;
      task.peakConcurrency = Math.max(task.peakConcurrency, concurrency);
      const waveSize = Math.min(candidates.length - cursor, Math.max(1, concurrency * Number(options.waveMultiplier || 5)));
      const wave = candidates.slice(cursor, cursor + waveSize);
      const beforeRateLimits = task.metrics.rateLimits;
      await runWave(task, wave, mode, concurrency);
      cursor += wave.length;
      task.metrics.waves += 1;
      const results = wave.map((row) => task.items[String(row.skuCode)]).filter(Boolean);
      const bad = results.filter((item) => item.state === "failed").length;
      const limited = task.metrics.rateLimits > beforeRateLimits;
      if (bad || limited) {
        cleanWaves = 0;
        const lower = [...concurrencySteps].reverse().find((value) => value < concurrency);
        concurrency = lower || 1;
      } else {
        cleanWaves += 1;
        if (cleanWaves >= 2) {
          const higher = concurrencySteps.find((value) => value > concurrency);
          if (higher) concurrency = higher;
          cleanWaves = 0;
        }
      }
    }

    task.running = false;
    task.paused = task.pauseRequested;
    if (!task.paused) task.finishedAt = nowIso();
    return summarizeTask(task);
  }

  function start(taskId, options = {}) {
    const task = taskRoot()[taskId];
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.running) return summarizeTask(task);
    task.promise = executeTask(task, options).catch((error) => {
      task.running = false;
      task.finishedAt = nowIso();
      task.fatalError = errorInfo(error);
      return summarizeTask(task);
    });
    return summarizeTask(task);
  }

  function pause(taskId) {
    const task = taskRoot()[taskId];
    if (!task) throw new Error(`unknown task: ${taskId}`);
    task.pauseRequested = true;
    return summarizeTask(task);
  }

  function status(taskId) {
    const task = taskRoot()[taskId];
    if (!task) throw new Error(`unknown task: ${taskId}`);
    const result = summarizeTask(task);
    result.fatalError = task.fatalError || null;
    return result;
  }

  function exportTask(taskId) {
    const task = taskRoot()[taskId];
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return {
      schema: "aoxiang-channel-fill-checkpoint-v1",
      engineVersion: ENGINE_VERSION,
      exportedAt: nowIso(),
      config: clone(task.config),
      summary: summarizeTask(task),
      rows: clone(task.rows),
      items: clone(task.items),
      order: clone(task.order),
    };
  }

  return {
    ENGINE_VERSION,
    createTask,
    start,
    pause,
    status,
    exportTask,
    _test: {
      normalizeText,
      normalizeFieldName,
      findOption,
      materializeValues,
      isValidValues,
      planProperties,
      buildSavePayload,
      verifyPlanned,
      applyCategoryOverrides,
      applyEvidenceOverrides,
      retainOnlyEvidenceOverrides,
      verifyCategoryRepairs,
      chooseMeasurement,
      chooseCount,
      chooseOptionByTitle,
      chooseExtendedSelectFact,
      diagnosisRequiredFields,
      isRequiredDefinition,
    },
  };
});
