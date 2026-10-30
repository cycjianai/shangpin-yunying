/**
 * 牵牛花类目属性自动填充与有效性校验规则引擎
 * 迭代版本：v1.3.0 (官方推荐优先 + 全空白补全版)
 * 核心升级与最高原则：
 * 0. 【平台官方推荐第一优先级】：
 *    - 优先调用官方推荐接口 `queryRecommendDynamicInfoAndWeight`（支持美团 100 与饿了么 200）；
 *    - 只要官方推荐返回了属性建议（如品牌、备案编号/注册证号、商品类别、适用部位等），必须 100% 优先采纳；
 *    - 官方推荐回填完成后，再检查未被推荐覆盖的剩余空白属性（!isPropertyValid(prop) 或未赋值项）；
 * 1. 【有效性深度核验】：不仅检查是否为空，还严格校验已有值是否属于平台当前有效候选库；
 * 2. 用户定制原则：
 *    - 优先从商品标题、规格中提取精确事实；
 *    - 长度/尺寸未明确标注时：默认填写 0米（数值 0）；
 *    - 形状/适用场景等未明确标注时：优先选择“通用”；
 *    - 品牌未明确标注且无推荐时：优先选择“其他”（若无则“无品牌”）；
 *    - 其余未明确或模糊的单选/多选：优先选择“其他”或包含更多情况的安全通用选项；
 *    - 结构值（Type 10）严格按照模版 sequence 与单位 optionId 组装；
 *    - 主档提交保存仅对纯渠道类目属性字段携带 coverToStore: 1；严禁对 spu_name / picture 发送 coverToStore: 1 冲掉门店自定义，存在门店自定义（customizedNameFlag / customizedPicFlag）的门店必须按门店维度独立维护。
 */

export function extractNumber(title, propName) {
  const t = title || '';
  if (/(?:包装数量|包数|件数|只数|盒数|条数|刀片数量|单盒数量|套装数量|蒸蛋数量|包装方式|套装类型|刀头数量)/.test(propName)) {
    const m = t.match(/(\d+)\s*(?:包|盒|袋|支|件|个|条|抽|片|瓶|罐|套|把|份|双|本|箱|桶|张|卷|枚|串|粒)/);
    if (m) return m[1];
    const m2 = t.match(/(\d+)件套|(\d+)件装|(\d+)支装|(\d+)只装|(\d+)片装/);
    if (m2) return m2[1] || m2[2] || m2[3] || m2[4] || m2[5];
    return '1';
  }
  if (/(?:单包抽数|单包片数|单包条数|单包张数|张数)/.test(propName)) {
    const m = t.match(/(\d+)\s*(?:抽|片|条|张|支)/);
    if (m) return m[1];
    return '10';
  }
  if (/(?:净含量|单件净含量|总净含量|单包净含量|容量|总容积|水箱容量)/.test(propName)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:g|克|kg|千克|ml|毫升|l|升)/i);
    if (m) return m[1];
    return '500';
  }
  if (/(?:长度|球体直径|直径|高度|尺寸|夹口宽度|商品尺寸)/.test(propName)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m|cm|厘米|mm|毫米)/i);
    if (m) return m[1];
    // 规则 2: 长度默认填写 0米
    return '0';
  }
  if (/(?:保质期|续航时间)/.test(propName)) {
    const m = t.match(/(\d+)\s*(?:天|个月|年|小时)/);
    if (m) return m[1];
    return '365';
  }
  if (/(?:麦汁浓度|酒精度)/.test(propName)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:°p|%|度)/i);
    if (m) return m[1];
    return '10';
  }
  return '1';
}

/**
 * 校验属性当前值是否有效
 * @param {object} prop 
 * @returns {boolean} true: 有效且合法; false: 缺失或属于已失效旧值，需重新填写
 */
export function isPropertyValid(prop) {
  if (!prop) return false;
  const vals = prop.customValue || [];
  if (!vals.length) return false;

  const type = String(prop.attrValueType);

  // 结构值校验
  if (type === '10') {
    const structVals = vals[0]?.structAttrValueList || [];
    if (!structVals.length) return false;
    const rows = structVals[0]?.valueList || [];
    return rows.length > 0;
  }

  // 枚举单选/多选/下拉校验：必须命中当前候选列表
  if (type === '1' || type === '2' || type === '5') {
    const options = prop.attrValueList || prop.optionalValue || [];
    if (!options.length) {
      // 若类目未配置候选，退化为非空检查
      return Boolean(vals[0]?.attrValue || vals[0]?.attrValueId);
    }
    // 检查是否有至少一个值命中当前候选
    return vals.some(v => {
      const vId = String(v.attrValueId || '');
      const vText = String(v.attrValue || '').trim();
      if (!vId && !vText) return false;
      return options.some(o => {
        const optId = String(o.attrValueId || o.optionId || o.id || '');
        const optName = String(o.attrValue || o.optionValue || o.name || '').trim();
        return (vId && optId && vId === optId) || (vText && optName && vText === optName);
      });
    });
  }

  // 其他类型非空校验
  return vals.some(v => Boolean(v && (v.attrValue || v.attrValueId)));
}

export function fillProperty(prop, title = '') {
  const type = String(prop.attrValueType);
  const name = prop.attrName || '';

  // 1. 结构值 (Type 10)
  if (type === '10') {
    const template = prop.structAttrTemplateList?.[0];
    if (!template || !template.valueFormatList) return null;
    const formatType = template.valueFormatTypeList?.[0]?.formatType || 1;
    const numSeq = template.valueFormatList.find(f => f.sequence === 1);
    const unitSeq = template.valueFormatList.find(f => f.sequence === 2);
    const numVal = extractNumber(title, name);
    const unitOption = unitSeq?.optionList?.[0] || { optionId: 1, optionValue: '' };

    return [
      {
        attrValueId: null,
        attrValue: null,
        douyinDiyType: null,
        structAttrValueList: [
          {
            formatType,
            valueList: [
              [
                {
                  value: String(numVal),
                  optionId: null,
                  sequence: 1,
                  optionValue: null,
                  moduleId: null,
                  unitId: null,
                  unitName: null,
                },
                {
                  value: null,
                  optionId: unitOption.optionId,
                  sequence: 2,
                  optionValue: unitOption.optionValue,
                  moduleId: null,
                  unitId: null,
                  unitName: null,
                },
              ],
            ],
            templateId: null,
          },
        ],
        childrenJson: null,
        useFallbackValue: null,
      },
    ];
  }

  // 2. 枚举单选/多选 (Type 1, 2, 5)
  if (type === '1' || type === '2' || type === '5') {
    const options = prop.attrValueList || prop.optionalValue || [];
    if (!options.length) return null;

    // 阶段 1: 常见关键业务属性精准语义匹配
    let matched = null;

    // 规则 35: 赠品与附赠属性全量默认否定契约（有否定项必选，全为赠送项则坚决不填保持留白）
    if (/(?:赠品|赠送|附赠|是否赠|配赠|礼品|礼赠|杯子|开瓶器|餐具|吸管)/.test(name)) {
      matched = options.find(o => /(?:不赠|不送|无|否|普通包装|环保包装|不提供)/.test((o.attrValue || o.optionValue || '').trim()));
      if (matched) {
        return [{
          attrValueId: String(matched.attrValueId || matched.optionId || ''),
          attrValue: String(matched.attrValue || matched.optionValue || ''),
          structAttrValueList: []
        }];
      } else {
        // 候选全为肯定赠送（如只有“赠礼袋”、“礼盒包装”）时，坚决不选任何项，强制保持留白
        return [];
      }
    }

    // A. 包装方式 / 包装形式
    if (/(?:包装方式|包装形式|包装类型)/.test(name)) {
      if (/真空/.test(title)) matched = options.find(o => /真空/.test(o.attrValue || o.optionValue || ''));
      else if (/礼盒/.test(title)) matched = options.find(o => /礼盒/.test(o.attrValue || o.optionValue || ''));
      else if (/袋/.test(title)) matched = options.find(o => /袋/.test(o.attrValue || o.optionValue || ''));
      else if (/盒/.test(title)) matched = options.find(o => /盒/.test(o.attrValue || o.optionValue || ''));
      else if (/罐/.test(title)) matched = options.find(o => /罐/.test(o.attrValue || o.optionValue || ''));
      else if (/桶/.test(title)) matched = options.find(o => /桶/.test(o.attrValue || o.optionValue || ''));
      else if (/箱/.test(title)) matched = options.find(o => /箱/.test(o.attrValue || o.optionValue || ''));
      else if (/散装/.test(title)) matched = options.find(o => /散装/.test(o.attrValue || o.optionValue || ''));
    }

    // B. 是否有机
    if (!matched && /(?:是否有机|有机)/.test(name)) {
      if (/有机/.test(title)) {
        matched = options.find(o => /^(?:是|有机)$/.test(o.attrValue || o.optionValue || ''));
      } else {
        matched = options.find(o => /^(?:否|非有机)$/.test(o.attrValue || o.optionValue || ''));
      }
    }

    // C. 国产/进口
    if (!matched && /(?:国产\/进口|进口\/国产)/.test(name)) {
      if (/进口/.test(title)) {
        matched = options.find(o => /进口/.test(o.attrValue || o.optionValue || ''));
      } else {
        matched = options.find(o => /国产/.test(o.attrValue || o.optionValue || ''));
      }
    }

    // D. 储藏条件 / 储存条件
    if (!matched && /(?:储藏条件|储存条件|保存条件)/.test(name)) {
      if (/冷冻/.test(title)) matched = options.find(o => /冷冻/.test(o.attrValue || o.optionValue || ''));
      else if (/冷藏/.test(title)) matched = options.find(o => /冷藏/.test(o.attrValue || o.optionValue || ''));
      else matched = options.find(o => /常温/.test(o.attrValue || o.optionValue || ''));
    }

    // 阶段 2: 标题字面精确包含匹配
    if (!matched) {
      matched = options.find(o => {
        const optName = o.attrValue || o.optionValue || '';
        return optName && optName.length >= 2 && title.includes(optName);
      });
    }

    // 常见同义词匹配
    if (!matched) {
      if (/电池/.test(title) && /供电方式/.test(name)) {
        matched = options.find(o => /电池式/.test(o.attrValue || o.optionValue || ''));
      } else if (/纸箱|纸盒/.test(title) && /材质/.test(name)) {
        matched = options.find(o => /纸质/.test(o.attrValue || o.optionValue || ''));
      } else if (/水粉/.test(title) && /类别/.test(name)) {
        matched = options.find(o => /水粉/.test(o.attrValue || o.optionValue || ''));
      } else if (/卫生巾/.test(title) && /类别/.test(name)) {
        matched = options.find(o => /普通卫生巾/.test(o.attrValue || o.optionValue || ''));
      }
    }

    // 规则 3: 形状、适用场景等未明确时，优先选择“通用”
    if (!matched && /(?:形状|适用场景|场景)/.test(name)) {
      matched = options.find(o => /^(?:通用|常规)$/.test(o.attrValue || o.optionValue || ''));
    }

    // 规则 1: 遵循用户最高原则 —— 优先选包含更多情况的安全选项：“其他”
    if (!matched) {
      matched = options.find(o => /^(?:其他|其它)$/.test(o.attrValue || o.optionValue || ''));
    }
    // 选“通用”或“常规”
    if (!matched) {
      matched = options.find(o => /^(?:通用|常规)$/.test(o.attrValue || o.optionValue || ''));
    }
    // 包含“其他”字样的选项（如“其他材质”、“其他类别”）
    if (!matched) {
      matched = options.find(o => /(?:其他|其它)/.test(o.attrValue || o.optionValue || ''));
    }
    // 默认第一个可用候选，确保不留白
    if (!matched) {
      matched = options[0];
    }

    if (matched) {
      const valId = String(matched.attrValueId || matched.optionId || matched.id || '');
      const valText = String(matched.attrValue || matched.optionValue || matched.name || '');
      return [
        {
          attrValueId: valId || null,
          attrValue: valText,
          douyinDiyType: null,
          structAttrValueList: [],
          childrenJson: null,
          useFallbackValue: null,
        },
      ];
    }
    return null;
  }

  // 3. 字典搜索项 (Type 4) —— 产地与品牌精准对齐
  if (type === '4') {
    // 产地 / 原产地字典对齐（饿了么强制 27772: 中国大陆，美团 100000050: 中国）
    if (/(?:产地|原产地|生产国)/.test(name)) {
      const options = prop.attrValueList || prop.optionalValue || [];
      const matched = options.find(o => /^(?:中国大陆|中国|国产)$/.test(o.attrValue || o.optionValue || ''));
      if (matched) {
        return [{
          attrValueId: String(matched.attrValueId || matched.optionId || ''),
          attrValue: String(matched.attrValue || matched.optionValue || ''),
          douyinDiyType: null,
          structAttrValueList: [],
          childrenJson: null,
          useFallbackValue: null,
        }];
      }
      return [{
        attrValueId: '27772',
        attrValue: '中国大陆',
        douyinDiyType: null,
        structAttrValueList: [],
        childrenJson: null,
        useFallbackValue: null,
      }];
    }

    const options = prop.attrValueList || prop.optionalValue || [];
    let matched = options.find(o => {
      const optName = o.attrValue || o.optionValue || '';
      return optName && optName.length >= 2 && title.includes(optName);
    });
    if (!matched) {
      matched = options.find(o => /^(?:其他|其它)$/.test(o.attrValue || o.optionValue || ''));
    }
    if (!matched) {
      matched = options.find(o => /^(?:无品牌|自有品牌)$/.test(o.attrValue || o.optionValue || ''));
    }
    if (!matched && options.length > 0) {
      matched = options[0];
    }
    const valId = matched ? String(matched.attrValueId || matched.optionId || '') : '0';
    const valText = matched ? String(matched.attrValue || matched.optionValue || '') : '其他';
    return [
      {
        attrValueId: valId,
        attrValue: valText,
        douyinDiyType: null,
        structAttrValueList: [],
        childrenJson: null,
        useFallbackValue: null,
      },
    ];
  }

  // 4. 时长 / 保质期 (Type 9)
  if (type === '9') {
    return [
      {
        attrValueId: null,
        attrValue: '365天',
        douyinDiyType: null,
        structAttrValueList: [],
        childrenJson: null,
        useFallbackValue: null,
      },
    ];
  }

  // 5. 自由文本 / 数值 (Type 3)
  if (type === '3') {
    const num = extractNumber(title, name);
    return [
      {
        attrValueId: null,
        attrValue: String(num),
        douyinDiyType: null,
        structAttrValueList: [],
        childrenJson: null,
        useFallbackValue: null,
      },
    ];
  }

  return null;
}
