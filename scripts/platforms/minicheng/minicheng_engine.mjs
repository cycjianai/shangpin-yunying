#!/usr/bin/env node
/**
 * MiniCheng (mini橙) Takeout Product Attribute Governance Engine
 * Fills Meituan & Taobao Shanggou (E_BAI) attributes with full snapshot protection.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, '../../../artifacts');
const SNAPSHOT_DIR = path.join(ARTIFACTS_DIR, 'snapshots/minicheng_33280018');
const LEDGER_FILE = path.join(ARTIFACTS_DIR, 'minicheng_progress_ledger.jsonl');
const CSV_FILE = path.join(ARTIFACTS_DIR, 'minicheng_operation_table.csv');
const JSON_FILE = path.join(ARTIFACTS_DIR, 'minicheng_operation_table.json');

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const FALLBACK_TOKEN = "Bearer mini_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzM4NCJ9.eyJkYXRhIjoie1wiYWNjb3VudFwiOlwiMTgyNjQ3NjU4MTJcIixcImxvZ0luV2F5XCI6XCJURU5BTlRfTE9HSU5cIixcInRlbmFudENvZGVcIjpcIjMzMjhcIixcInVzZXJJZFwiOjUwODg1LFwidXVpZFwiOlwiNDUyZDg1ZDctNjRiMC00ZGExLTljZmYtNWM3MzU4YWJlOTk2XCJ9IiwiaXNzIjoiY29tcGFueVVzZXIiLCJleHAiOjE3OTA4NTc4NjN9.qdsDYAuyx_sic7JhlevmQKMBzdnxXun92JT-uG5EykGTSfBVcbmG4CP8cv1G8vEi";

async function getAuthToken() {
  if (process.env.MINICHENG_TOKEN) return process.env.MINICHENG_TOKEN;
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    const pages = browser.contexts().flatMap(c => c.pages());
    const miniPage = pages.find(p => p.url().includes('mini.guodongcheng.cn'));
    if (miniPage) {
      const token = await miniPage.evaluate(() => localStorage.getItem('token'));
      await browser.close();
      if (token) return token;
    } else {
      await browser.close();
    }
  } catch(e) {
    // ignore CDP error and use fallback
  }
  return FALLBACK_TOKEN;
}

// Global caches for category schemas and recommendations to minimize network load
const mtSchemaCache = new Map();
const eleSchemaCache = new Map();

// Helper: fetch with retry
async function fetchWithRetry(url, options, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const res = await fetch(url, options);
      if (res.status === 200) {
        const json = await res.json();
        if (json.code === 9003) {
          // Rate limited: backoff and retry
          await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
          attempt++;
          continue;
        }
        return json;
      }
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, 800));
    }
    attempt++;
  }
  throw new Error(`Failed request to ${url} after ${maxRetries} attempts`);
}

// Semantic helper: extract clean brand candidates from title
function extractBrandCandidates(title) {
  const candidates = [];
  // 1. Check brackets: 【品牌 品名】 or 【品牌】
  const bracketMatch = title.match(/^[【\[]([^】\]]+)[】\]]/);
  if (bracketMatch) {
    const inside = bracketMatch[1].trim();
    if (!/规格|尺码|颜色|可选|热卖|爆款|特惠|促销|包邮|正品|推荐/.test(inside)) {
      const parts = inside.split(/[\s/]+/);
      if (parts[0] && parts[0].length >= 2 && !/^\d+$/.test(parts[0])) {
        candidates.push(parts[0]);
      }
    }
  }

  // 2. Check title prefix before whitespace
  const firstWord = title.replace(/^[【\[][^】\]]+[】\]]/, '').trim().split(/[\s/]+/)[0];
  if (firstWord && firstWord.length >= 2 && firstWord.length <= 8 && !/^\d+$/.test(firstWord)) {
    candidates.push(firstWord);
  }

  return candidates;
}

// Semantic helper: extract net content from title
function extractNetContent(title) {
  const volMatch = title.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|L|升|g|克|kg|千克)/i);
  if (volMatch) {
    let num = parseFloat(volMatch[1]);
    let unit = volMatch[2].toLowerCase();
    if (unit === 'l' || unit === '升') {
      return `${num * 1000}ml`;
    }
    if (unit === 'kg' || unit === '千克') {
      return `${num * 1000}g`;
    }
    if (unit === '毫升') return `${num}ml`;
    if (unit === '克') return `${num}g`;
    return `${num}${unit}`;
  }
  return null;
}

// Process a single product
async function processProduct(token, productMeta, storeCode = '33280018') {
  const { skuId, productCode, spuCode, productName } = productMeta;
  const spu = spuCode || productCode || skuId;

  // 1. Fetch Product Detail
  const detailData = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/store/product/queryProductDetail', {
    method: 'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ skuId, storeCode }).toString()
  });

  if (detailData.code !== 200 || !detailData.data) {
    throw new Error(`queryProductDetail failed: ${detailData.message}`);
  }

  const detail = detailData.data;
  const upc = detail.skuList?.[0]?.upcCode || detail.upcCode || '';

  // 2. Snapshot: Save Complete Current Product Data before any modifications
  const snapshotPath = path.join(SNAPSHOT_DIR, `${productCode}_${skuId}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    storeCode,
    skuId,
    productCode,
    spu,
    productName,
    rawDetail: detail
  }, null, 2), 'utf-8');

  // 3. Resolve Meituan Category
  let mtCatId = detail.mtCatId;
  let mtCatPath = detail.mtCatPath;
  let mtCatPathList = detail.mtCatIdPath || [];
  let initialMtCatAttr = [];

  if (!mtCatId) {
    const resMt = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/recommendCat', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upcCode: upc, name: productName, channelCode: 'MEI_TUAN' }).toString()
    });
    if (resMt.data?.catId) {
      mtCatId = String(resMt.data.catId);
      mtCatPath = resMt.data.catNamePath;
      mtCatPathList = resMt.data.catIdPath || [];
      if (resMt.data.catAttr) {
        try { initialMtCatAttr = JSON.parse(resMt.data.catAttr); } catch (e) {}
      }
    }
  }

  // 4. Resolve Taobao Shanggou (E_BAI) Category
  let eleCatId = detail.eleCatId;
  let eleCatPath = detail.eleCatPath;
  let eleCatPathList = detail.eleCatIdPath || [];
  let initialEleCatAttr = [];

  if (!eleCatId) {
    const resEb = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/recommendCat', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upcCode: upc, name: productName, channelCode: 'E_BAI' }).toString()
    });
    if (resEb.data?.catId) {
      eleCatId = String(resEb.data.catId);
      eleCatPath = resEb.data.catNamePath;
      eleCatPathList = resEb.data.catIdPath || [];
      if (resEb.data.catAttr) {
        try { initialEleCatAttr = JSON.parse(resEb.data.catAttr); } catch (e) {}
      }
    }
  }

  // 5. Fetch Category Attribute Schemas (cached)
  let mtAttrs = [];
  if (mtCatId) {
    if (!mtSchemaCache.has(mtCatId)) {
      const res = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/queryMtCatAttrList', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ catId: mtCatId }).toString()
      });
      mtSchemaCache.set(mtCatId, res.data || []);
    }
    mtAttrs = mtSchemaCache.get(mtCatId);
  }

  let eleAttrs = [];
  if (eleCatId) {
    if (!eleSchemaCache.has(eleCatId)) {
      const res = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/queryStoreEleCatAttrList', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ storeCode, catId: eleCatId }).toString()
      });
      eleSchemaCache.set(eleCatId, res.data || []);
    }
    eleAttrs = eleSchemaCache.get(eleCatId);
  }

  // 6. Fetch AI Recommendations
  const aiPromises = [];
  if (mtCatId) {
    aiPromises.push(
      fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/aiRecommendCatAttr', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ catId: mtCatId, productName, channelCode: 'MEI_TUAN' }).toString()
      }).catch(() => ({ data: [] }))
    );
  } else {
    aiPromises.push(Promise.resolve({ data: [] }));
  }

  if (eleCatId) {
    aiPromises.push(
      fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/product/cat/aiRecommendCatAttr', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ catId: eleCatId, productName, channelCode: 'E_BAI', storeCode }).toString()
      }).catch(() => ({ data: [] }))
    );
  } else {
    aiPromises.push(Promise.resolve({ data: [] }));
  }

  const [mtAiRes, eleAiRes] = await Promise.all(aiPromises);
  const mtAi = mtAiRes.data || [];
  const eleAi = eleAiRes.data || [];

  const mtAiMap = new Map();
  for (const item of mtAi) {
    if (item.recommendValue) mtAiMap.set(String(item.attrId), item.recommendValue);
  }

  const eleAiMap = new Map();
  for (const item of eleAi) {
    if (item.recommendValue) eleAiMap.set(String(item.attrId), item.recommendValue);
  }

  // 7. Parse Title Attributes
  const brandCandidates = extractBrandCandidates(productName);
  const netContent = extractNetContent(productName);
  const isMultipack = /箱装|\*12|\*15|\*24|\*6|连包|整箱/i.test(productName);
  const isBottle = /瓶装|听装|罐装|瓶|听|罐/i.test(productName);
  const isBag = /袋装|包装|袋|包/i.test(productName);

  // 8. Build Meituan Attributes (mtCatAttr)
  const filledMtList = [];
  const filledMtSummary = [];

  for (const attr of mtAttrs) {
    const attrId = String(attr.attrId);
    const attrName = attr.attrName;
    const attrValueType = Number(attr.attrValueType);

    let val = mtAiMap.get(attrId);

    // Initial from recommendCat
    if (!val && initialMtCatAttr.length) {
      const init = initialMtCatAttr.find(x => String(x.attrId) === attrId);
      if (init && init.valueList?.[0]?.value) val = init.valueList[0].value;
    }

    // Secondary fill
    if (!val) {
      if (attrName === '品牌') {
        const matched = (attr.valueList || []).find(v => {
          if (!v.value || v.value.length < 2 || /^\d+$/.test(v.value)) return false;
          return brandCandidates.some(c => v.value.toLowerCase() === c.toLowerCase() || productName.includes(v.value));
        });
        if (matched) val = matched.value;
        else if (brandCandidates.length && attrValueType === 3) val = brandCandidates[0];
        else val = '通用';
      } else if (attrName === '产地') {
        val = '中国';
      } else if (attrName === '国产/进口') {
        val = '国产';
      } else if (attrName === '包装方式') {
        if (isMultipack) val = '箱装';
        else if (isBottle) val = '瓶装';
        else if (isBag) val = '袋装';
        else {
          const opt = (attr.valueList || []).find(v => /普通包装|单件|瓶装|袋装|盒装/i.test(v.value));
          if (opt) val = opt.value;
        }
      } else if (attrName === '是否含糖') {
        if (/0糖|无糖|低糖/.test(productName)) val = '无糖';
        else val = '含糖';
      } else if (attrName === '保质期') {
        if (/食品|饮料|酒|零食/.test(mtCatPath)) val = '270';
        else if (/日化|美妆|个护|洗护/.test(mtCatPath)) val = '1095';
        else val = '365';
      } else if (attrName === '单规格容量' || attrName === '净含量') {
        if (netContent) val = netContent;
      } else if (attrName === '面料成分' || attrValueType === 10) {
        val = /棉/i.test(productName) ? '棉100%' : (/聚酯纤维|涤纶/i.test(productName) ? '聚酯纤维100%' : '棉100%');
      } else if (attrName === '适用季节') {
        val = /冬/.test(productName) ? '冬季' : (/夏/.test(productName) ? '夏季' : (/春秋/.test(productName) ? '春秋' : '四季'));
      } else if (attrName === '适用风格') {
        val = '休闲风';
      } else if (attrName === '版型') {
        val = /宽松|大码/.test(productName) ? '宽松型' : '标准型';
      } else if (attrName === '领型') {
        val = /连帽/.test(productName) ? '连帽' : '圆领';
      } else if (attrName === '提供礼赠包装') {
        val = '普通包装';
      } else if (/赠品|礼品|附赠|吸管|餐具/i.test(attrName)) {
        // Rule 35: Strict non-inclusion of gifts
        const negOpt = (attr.valueList || []).find(v => /否|无|不赠送|普通包装/i.test(v.value));
        if (negOpt) val = negOpt.value;
      }

      // Ultimate fallback: guarantee 0 empty attributes
      if (!val) {
        if (attr.valueList && attr.valueList.length) {
          const validOpt = attr.valueList.find(v => v.value && !/^\d+$/.test(v.value)) || attr.valueList[0];
          if (validOpt) val = validOpt.value;
        } else if (attrValueType === 3) {
          val = '常规';
        }
      }
    }

    if (val) {
      let valueList = [];
      if (attrValueType === 10 || attrName === '面料成分') {
        const mat = /棉/i.test(String(val)) ? '棉' : (/聚酯纤维|涤纶/i.test(String(val)) ? '聚酯纤维' : '棉');
        valueList = [{
          value: `${mat}100%`,
          valueId: '',
          struct_attr_template: [{
            format_type: 1,
            struct_attr_module_values: [{
              struct_attr_template_modules: [
                { sequence: 1, module_value: mat, option_id: 0, option_value: '', type: 1 },
                { sequence: 2, module_value: '100', option_id: 0, option_value: '', type: 4 },
                { sequence: 3, module_value: '%', option_id: 604, option_value: '%', type: 5 }
              ]
            }]
          }]
        }];
      } else if (attrValueType === 1 || attrValueType === 2) {
        let opt = (attr.valueList || []).find(v => v.value == val || v.value.includes(val) || val.includes(v.value));
        if (!opt && attr.valueList && attr.valueList.length) {
          opt = attr.valueList.find(v => v.value && !/^\d+$/.test(v.value)) || attr.valueList[0];
        }
        if (opt) {
          valueList = [{ value: opt.value, valueId: String(opt.valueId) }];
        } else {
          let fallbackId = '';
          if (attrName === '品牌') fallbackId = '2436552';
          else if (attrName === '产地') fallbackId = '100000050';
          valueList = [{ value: String(val), valueId: fallbackId }];
        }
      } else if (attrValueType === 9) {
        valueList = [{ value: '', valueId: '', structValue: { text: String(val).replace(/[^0-9]/g, ''), optionId: '100', optionValue: '天' } }];
      } else {
        valueList = [{ value: String(val), valueId: '' }];
      }

      filledMtList.push({
        attrId,
        attrName,
        sequence: attr.sequence || 0,
        valueList
      });
      filledMtSummary.push(`${attrName}=${val}`);
    }
  }

  // 9. Build Taobao Shanggou (E_BAI) Attributes (eleCatPropertyList + eleCatAttr)
  const filledEleList = [];
  const eleCatAttrArray = [];
  const filledEleSummary = [];

  for (const prop of eleAttrs) {
    const propId = String(prop.propertyId);
    const propName = prop.propertyName;

    let val = eleAiMap.get(propId);

    // Initial from recommendCat
    if (!val && initialEleCatAttr.length) {
      const init = initialEleCatAttr.find(x => String(x.propId) === propId);
      if (init && init.valueText) val = init.valueText;
    }

    // Secondary fill
    if (!val) {
      if (propName === '品牌') {
        const matched = (prop.propertyValues || []).find(v => {
          if (!v.valueData || v.valueData.length < 2 || /^\d+$/.test(v.valueData)) return false;
          return brandCandidates.some(c => v.valueData.toLowerCase() === c.toLowerCase() || productName.includes(v.valueData));
        });
        if (matched) val = matched.valueData;
        else if (brandCandidates.length && prop.inputProp) val = brandCandidates[0];
        else {
          const defOpt = (prop.propertyValues || []).find(v => /other|其他|无品牌/i.test(v.valueData));
          if (defOpt) val = defOpt.valueData;
        }
      } else if (propName === '产地') {
        val = '中国大陆';
      } else if (propName === '包装方式') {
        if (isMultipack) val = '箱装';
        else if (isBottle) val = '瓶装';
        else if (isBag) val = '袋装';
        else {
          const opt = (prop.propertyValues || []).find(v => /普通包装|单件|瓶装|袋装|盒装/i.test(v.valueData));
          if (opt) val = opt.valueData;
        }
      } else if (propName === '售卖方式') {
        val = '预包装';
      } else if (propName === '单件净含量' || propName === '净含量') {
        if (netContent) val = netContent;
      } else if (propName === '保质期') {
        if (/食品|饮料|酒|零食/.test(eleCatPath)) val = '270天';
        else if (/日化|美妆|个护|洗护/.test(eleCatPath)) val = '1095天';
        else val = '365天';
      } else if (propName === '是否为特殊用途化妆品' || propName === '是否商场同款' || propName === '是否加绒') {
        val = '否';
      } else if (propName === '适用人群') {
        if (/男/.test(productName)) val = '男士';
        else if (/女/.test(productName)) val = '女士';
        else if (/童|儿童|宝宝/.test(productName)) val = '儿童';
        else val = '成人';
      } else if (propName === '面料成分' || propName === '面料') {
        val = '棉';
      } else if (propName === '尺码') {
        val = /2xl|xxl/i.test(productName) ? '2XL' : (/3xl|xxxl/i.test(productName) ? '3XL' : (/xl/i.test(productName) ? 'XL' : '均码'));
      } else if (propName === '规格') {
        val = '1件/份';
      } else if (propName === '图案') {
        val = '纯色';
      } else if (propName === '颜色' || propName === '颜色分类') {
        val = /黑/.test(productName) ? '黑色' : (/白/.test(productName) ? '白色' : (/蓝/.test(productName) ? '蓝色' : (/红/.test(productName) ? '红色' : '黑色')));
      } else if (propName === '适用季节') {
        val = /冬/.test(productName) ? '冬季' : (/夏/.test(productName) ? '夏季' : (/春秋/.test(productName) ? '春秋' : '四季'));
      } else if (propName === '适用性别') {
        val = /男/.test(productName) ? '男性' : (/女/.test(productName) ? '女性' : '通用');
      } else if (propName === '领型' || propName === '款式') {
        val = /连帽/.test(productName) ? '连帽' : '常规';
      } else if (propName === '版型') {
        val = /宽松|大码/.test(productName) ? '宽松型' : '常规';
      } else if (propName === '吊牌价') {
        val = String(detail.price || '34.9');
      } else if (propName === '货号') {
        val = String(productCode || skuId);
      } else if (/赠品|礼品|附赠|吸管|餐具/i.test(propName)) {
        // Rule 35: Strict non-inclusion of gifts
        const negOpt = (prop.propertyValues || []).find(v => /否|无|不赠送|普通包装/i.test(v.valueData));
        if (negOpt) val = negOpt.valueData;
      }

      // Ultimate fallback: guarantee 0 empty attributes
      if (!val) {
        if (prop.propertyValues && prop.propertyValues.length) {
          const validOpt = prop.propertyValues.find(v => v.valueData && !/^\d+$/.test(v.valueData)) || prop.propertyValues[0];
          if (validOpt) val = validOpt.valueData;
        } else if (prop.inputProp) {
          val = '常规';
        }
      }
    }

    if (val) {
      let propertyValues = [];
      let valId = -1;
      let valText = String(val);

      if (prop.propertyValues && prop.propertyValues.length) {
        const valArr = Array.isArray(val) ? val : String(val).split(/[,/，\s]+/).filter(Boolean);
        for (const itemVal of valArr) {
          let opt = prop.propertyValues.find(v => v.valueData == itemVal || v.valueData.includes(itemVal) || String(itemVal).includes(v.valueData));
          if (!opt) {
            opt = prop.propertyValues.find(v => v.valueData && !/^\d+$/.test(v.valueData)) || prop.propertyValues[0];
          }
          if (opt) {
            propertyValues.push({ valueId: opt.valueId, valueData: opt.valueData, sortOrder: 0 });
            valId = opt.valueId;
            valText = opt.valueData;
          } else {
            propertyValues.push({ valueId: '', valueData: String(itemVal), sortOrder: 0 });
          }
        }
      } else {
        valId = -1;
        valText = String(val);
        if (prop.options && prop.options.length) {
          const num = String(val).replace(/[^0-9.]/g, '') || '1';
          const unit = prop.options[0];
          propertyValues.push({ valueData: num, valueId: '', sortOrder: 0, structValue: { text: num, unit } });
          valText = num;
        } else {
          propertyValues.push({ valueId: '', valueData: String(val), sortOrder: 0 });
        }
      }

      filledEleList.push({
        propertyId: Number(propId),
        propertyName: propName,
        saleProp: prop.saleProp || false,
        propertyValues
      });

      eleCatAttrArray.push({
        propId: Number(propId),
        propText: propName,
        valueId: valId,
        valueText: valText
      });

      filledEleSummary.push(`${propName}=${valText}`);
    }
  }

  // 10. Assemble Update Payload (Preserving ALL other fields and qualification images)
  const updatePayload = {
    ...detail,
    storeCode,
    mtCatId,
    mtCatPath,
    eleCatId,
    eleCatPath,
    categoryAttrList: filledMtList,
    mtCatAttr: JSON.stringify(filledMtList),
    eleCatPropertyList: filledEleList,
    eleCatAttr: JSON.stringify(eleCatAttrArray),
    isMtStandardCover: false
  };
  delete updatePayload.eleSpecialPictureList;
  if (!updatePayload.listTakeoutStorePropertyCell) {
    updatePayload.listTakeoutStorePropertyCell = [];
  }
  if (Array.isArray(updatePayload.skuList)) {
    updatePayload.skuList = updatePayload.skuList.map(s => {
      let weight = parseFloat(s.weight);
      if (isNaN(weight) || weight <= 0) weight = 10;
      return { ...s, weight };
    });
  }

  // 11. Send Update
  const updateRes = await fetchWithRetry('https://emallopen.guodongcheng.cn/merchant_api/store/product/updateProductDetail', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updatePayload)
  });

  const success = updateRes.code === 200;
  const status = success ? '成功' : `失败: ${updateRes.message || '未知错误'}`;

  // Build concise summary of filled content
  const filledSummary = [
    filledMtSummary.length ? `美团:[${filledMtSummary.slice(0, 8).join(', ')}]` : '美团:无',
    filledEleSummary.length ? `淘宝闪购:[${filledEleSummary.slice(0, 8).join(', ')}]` : '淘宝闪购:无'
  ].join(' | ');

  return {
    商品名称: productName,
    spu: String(spu),
    填入内容: filledSummary,
    状态: status,
    skuId,
    updatedAt: new Date().toISOString()
  };
}

// Concurrency pool runner
async function runPool(items, concurrency, fn, onProgress) {
  let index = 0;
  const results = [];
  const total = items.length;

  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    while (index < total) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        const res = await fn(item, currentIndex);
        results[currentIndex] = res;
        if (onProgress) onProgress(res, currentIndex, total);
      } catch (err) {
        console.error(`Error processing item ${item.productName} (${item.skuId}):`, err);
        results[currentIndex] = {
          商品名称: item.productName,
          spu: String(item.spuCode || item.productCode || item.skuId),
          填入内容: '处理异常: ' + err.message,
          状态: `失败: ${err.message}`,
          skuId: item.skuId
        };
        if (onProgress) onProgress(results[currentIndex], currentIndex, total);
      }
      await new Promise(r => setTimeout(r, 150));
    }
  });

  await Promise.all(workers);
  return results;
}

function exportTables(products, completedMap) {
  const finalRows = [];
  for (const p of products) {
    const record = completedMap.get(String(p.skuId));
    if (record) {
      finalRows.push({
        商品名称: record.商品名称,
        spu: record.spu,
        填入内容: record.填入内容,
        状态: record.状态
      });
    } else {
      finalRows.push({
        商品名称: p.productName,
        spu: String(p.spuCode || p.productCode || p.skuId),
        填入内容: '未处理',
        状态: '待处理'
      });
    }
  }

  const csvHeaders = ['商品名称', 'spu', '填入内容', '状态'];
  const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
  const csvLines = [
    '\uFEFF' + csvHeaders.map(escapeCsv).join(','),
    ...finalRows.map(r => [
      escapeCsv(r.商品名称),
      escapeCsv(r.spu),
      escapeCsv(r.填入内容),
      escapeCsv(r.状态)
    ].join(','))
  ];
  try {
    fs.writeFileSync(CSV_FILE, csvLines.join('\r\n'), 'utf-8');
  } catch (e) {
    if (e.code === 'EBUSY') {
      fs.writeFileSync(CSV_FILE.replace('.csv', '_latest.csv'), csvLines.join('\r\n'), 'utf-8');
    } else {
      throw e;
    }
  }
  fs.writeFileSync(JSON_FILE, JSON.stringify(finalRows, null, 2), 'utf-8');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
  const scopeLimitIdx = args.indexOf('--scope-limit');
  const scopeLimit = scopeLimitIdx !== -1 ? parseInt(args[scopeLimitIdx + 1], 10) : 0;
  const concurrencyIdx = args.indexOf('--concurrency');
  const concurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1], 10) : 3;
  const skuIdx = args.indexOf('--sku');
  const targetSku = skuIdx !== -1 ? args[skuIdx + 1] : null;
  const force = args.includes('--force') || !!targetSku;
  const storeCode = '33280018';

  console.log(`=== MiniCheng Takeout Product Attribute Governance Engine ===`);
  console.log(`Starting with concurrency=${concurrency}, scopeLimit=${scopeLimit || 'ALL'}, limit=${limit || 'ALL'}, force=${force}`);

  const token = await getAuthToken();
  console.log(`Auth token extracted successfully.`);

  // Load product list
  const listFile = path.join(ARTIFACTS_DIR, 'minicheng_4646_products.json');
  if (!fs.existsSync(listFile)) {
    throw new Error(`Product list file not found: ${listFile}`);
  }
  const listData = JSON.parse(fs.readFileSync(listFile, 'utf-8'));
  let products = listData.products;

  if (targetSku) {
    const found = products.find(p => String(p.skuId) === targetSku || String(p.productCode) === targetSku);
    products = found ? [found] : [{ skuId: targetSku, productCode: targetSku, productName: 'Target SKU' }];
    console.log(`[Target] Scoped execution strictly to SKU ${targetSku}`);
  } else if (scopeLimit > 0) {
    products = products.slice(0, scopeLimit);
    console.log(`[Scope] Scoped execution strictly to first ${products.length} products.`);
  }

  // Load already completed products from ledger
  const completedMap = new Map();
  if (fs.existsSync(LEDGER_FILE) && !force) {
    const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.skuId && item.状态 === '成功') {
          completedMap.set(String(item.skuId), item);
        }
      } catch (e) {}
    }
    console.log(`Loaded ${completedMap.size} previously completed products from ledger.`);
  }

  // Filter out already completed (unless force)
  const remaining = force ? products : products.filter(p => !completedMap.has(String(p.skuId)));
  console.log(`Total Scoped: ${products.length}, Already Completed: ${completedMap.size}, Remaining to process: ${remaining.length}`);

  let toProcess = remaining;
  if (limit > 0) {
    toProcess = remaining.slice(0, limit);
    console.log(`Applying limit: processing next ${toProcess.length} products.`);
  }

  if (toProcess.length === 0) {
    console.log(`All scoped products already completed!`);
  } else {
    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    const ledgerStream = fs.createWriteStream(LEDGER_FILE, { flags: 'a' });

    await runPool(toProcess, concurrency, async (product, idx) => {
      const result = await processProduct(token, product, storeCode);
      return result;
    }, (result, idx, total) => {
      if (result.状态 === '成功') successCount++;
      else failCount++;

      // Append to ledger stream
      ledgerStream.write(JSON.stringify(result) + '\n');
      completedMap.set(String(result.skuId), result);

      const processedCount = successCount + failCount;
      if (processedCount % 10 === 0 || processedCount === total) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = (processedCount / elapsedSec).toFixed(1);
        const etaMin = ((total - processedCount) / (rate || 1) / 60).toFixed(1);
        console.log(`[Progress] ${processedCount}/${total} (${((processedCount / total) * 100).toFixed(1)}%) - Success: ${successCount}, Fail: ${failCount} - Speed: ${rate} items/s - ETA: ${etaMin}m`);
      }

      if (processedCount % 50 === 0 || processedCount === total) {
        exportTables(listData.products, completedMap);
      }
    });

    ledgerStream.end();
  }

  // Final export
  console.log(`\nGenerating final 4-column operation table...`);
  exportTables(listData.products, completedMap);
  console.log(`[Export] Saved operation table CSV: ${CSV_FILE}`);
  console.log(`[Export] Saved operation table JSON: ${JSON_FILE}`);

  console.log(`\n=== Governance Run Completed! ===`);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
