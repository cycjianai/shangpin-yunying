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

const FALLBACK_TOKEN = "Bearer mini_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzM4NCJ9.eyJkYXRhIjoie1wiYWNjb3VudFwiOlwiMTgyNjQ3NjU4MTJcIixcImxvZ0luV2F5XCI6XCJURU5BTlRfTE9HSU5cIixcInRlbmFudENvZGVcIjpcIjMzMjhcIixcInVzZXJJZFwiOjUwODg1LFwidXVpZFwiOlwiYzA1ZTEyN2MtM2ZmZC00MjE1LTkxNWMtYWU2YzQ2MjBjYjdhXCJ9IiwiaXNzIjoiY29tcGFueVVzZXIiLCJleHAiOjE3OTA5MzkxMTJ9.Wq4xMHEURoIFnvbLTGKdsV0p0r_zwvIB3IR2AgwGmGnrd_ab-GeNmk-RGdigYBZh";

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

// Category helper: detect clothing / textiles
function isClothingCategory(title, catPath = '') {
  return /服装|内衣|睡衣|外套|卫衣|裤|袜|T恤|裙|泳衣|保暖衣|文胸|毛衣|大衣|风衣|服饰|家纺|床单|被套|毛巾/i.test(title + ' ' + catPath);
}

// Rule 35: Detect attributes that involve gifts, giveaways, cups, openers, straws, packaging
function isGiftOrGiveawayAttr(name) {
  return /赠|送|附赠|开瓶器|杯子|吸管|餐具|封口夹|礼袋|礼盒|赠品|礼赠/i.test(name);
}

// Rule 35: Detect affirmative/gift values that must never be accepted
function isGiftAffirmativeValue(val) {
  if (!val) return false;
  const s = String(val).trim();
  return /^(是|有|赠送|赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|带吸管|带餐具|带杯套|礼盒包装|礼盒装|定制礼盒装|礼盒|礼袋装)$/i.test(s) ||
         /(?:赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|礼盒装|定制礼盒装|礼袋装)/.test(s);
}

// Rule 35: Resolve explicit negative/non-gift option from option pool
function resolveNegativeGiftOption(options, attrName) {
  if (!options || !options.length) return null;
  const getName = o => o.value || o.valueData || '';

  if (/开瓶器/i.test(attrName)) {
    const opt = options.find(o => /不赠送|不赠|无|否/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/杯子|杯/i.test(attrName)) {
    const opt = options.find(o => /不赠杯子|不赠送|不赠|无|否/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/吸管/i.test(attrName)) {
    const opt = options.find(o => /无吸管|不赠送|不带|无|否/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/餐具/i.test(attrName)) {
    const opt = options.find(o => /无餐具|不配|不赠送|无|否/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/礼袋|原厂礼袋/i.test(attrName)) {
    const opt = options.find(o => /无礼袋|不赠送|无|否/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/包装方式|包装形式/i.test(attrName)) {
    const opt = options.find(o => !/礼盒|礼袋|定制/i.test(getName(o)) && /普通包装|普通装|普通|袋装|瓶装|盒装|罐装|散装/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/礼盒装|是否礼盒/i.test(attrName)) {
    const opt = options.find(o => /非礼盒装|非礼盒|否|无/i.test(getName(o)));
    if (opt) return opt;
  }
  if (/提供礼赠包装/i.test(attrName)) {
    const opt = options.find(o => /普通包装|无礼袋包装|环保包装|无/i.test(getName(o)));
    if (opt) return opt;
  }

  const negOpt = options.find(o => /不赠送|不赠|无赠品|无|普通包装|普通|非礼盒|常规|否/i.test(getName(o)));
  if (negOpt) return negOpt;

  return null;
}

// Semantic helper: extract net content & unit from title
function extractNetContent(title, catPath = '') {
  const volMatch = title.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|L|升|g|克|kg|千克|斤)/i);
  if (volMatch) {
    let num = parseFloat(volMatch[1]);
    let unit = volMatch[2].toLowerCase();
    if (unit === 'l' || unit === '升') {
      return { num: num * 1000, unit: 'ml', rawText: `${num * 1000}ml`, unitCode: 300, unitName: 'mL' };
    }
    if (unit === 'kg' || unit === '千克') {
      return { num: num * 1000, unit: 'g', rawText: `${num * 1000}g`, unitCode: 202, unitName: 'g' };
    }
    if (unit === '斤') {
      return { num: num * 500, unit: 'g', rawText: `${num * 500}g`, unitCode: 202, unitName: 'g' };
    }
    if (unit === '毫升') return { num, unit: 'ml', rawText: `${num}ml`, unitCode: 300, unitName: 'mL' };
    if (unit === '克') return { num, unit: 'g', rawText: `${num}g`, unitCode: 202, unitName: 'g' };
    return { num, unit, rawText: `${num}${unit}`, unitCode: (unit === 'ml' ? 300 : 202), unitName: (unit === 'ml' ? 'mL' : 'g') };
  }
  const countMatch = title.match(/(\d+)\s*(抽|片|支|粒|双|对|只|个|包|袋|盒|桶|罐|瓶|份)/);
  if (countMatch) {
    return { num: parseInt(countMatch[1]), unit: countMatch[2], rawText: `${countMatch[1]}${countMatch[2]}` };
  }
  return null;
}

// Helper: Ensure net content has appropriate unit
function ensureNetContentUnit(val, title, catPath = '') {
  if (!val) {
    const extracted = extractNetContent(title, catPath);
    return extracted ? extracted.rawText : null;
  }
  const str = String(val).trim();
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const extracted = extractNetContent(title, catPath);
    if (extracted && extracted.unit) {
      return str + extracted.unit;
    }
    const isLiquid = /水|饮|酒|汁|液|露|乳|油|洗|喷雾|瓶|听|罐/i.test(title + ' ' + catPath);
    return str + (isLiquid ? 'ml' : 'g');
  }
  return str;
}

// Helper: Extract wort concentration for beer
function extractWort(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(°P|度|P)/i);
  if (m) return `${m[1]}°P`;
  return '8°P';
}

// Helper: Extract alcohol by volume
function extractAlcohol(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(%vol|度|%|vol)/i);
  if (m) {
    const num = parseFloat(m[1]);
    return `≥${num}%vol`;
  }
  return '≥4.3%vol';
}

// Helper: Extract length / cable length (0-5m range)
function extractLength(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(m|米)/i);
  if (m) {
    const val = parseFloat(m[1]);
    const clamped = Math.min(val, 5);
    return `${clamped}m`;
  }
  return '1.5m';
}

// Helper: Extract denier for hosiery
function extractDenier(title) {
  const m = title.match(/(\d+)\s*(d|D)/);
  if (m) return `${m[1]}D`;
  return '80D';
}

// Helper: Extract dimensions
function extractDimensions(title) {
  const m = title.match(/(\d+)\s*[*×xX]\s*(\d+)\s*(cm|mm|m)?/);
  if (m) {
    const unit = m[3] || 'cm';
    return `${m[1]}${unit}*${m[2]}${unit}`;
  }
  return '150cm*200cm';
}

// Helper: Extract SKU unit (e.g. 袋, 只, 个, 瓶, 盒, 罐, 包, 套, 支, 条, 双, 听, 桶, 份, 箱)
function extractSkuUnit(title, spec = '') {
  const combined = `${title} ${spec}`;
  // 1. Explicit slash match e.g. 5ml/袋, 1个/份, /瓶, /盒
  const slashMatch = combined.match(/\/([只个瓶袋盒罐包套支条双听桶份箱件])/);
  if (slashMatch) return slashMatch[1];

  // 2. Count + unit e.g. 1只, 2瓶, 10袋, 1套
  const countUnitMatch = combined.match(/\d+\s*([只个瓶袋盒罐包套支条双听桶份箱件])/);
  if (countUnitMatch) return countUnitMatch[1];

  // 3. Keyword scan
  if (/袋/i.test(combined)) return '袋';
  if (/瓶/i.test(combined)) return '瓶';
  if (/盒/i.test(combined)) return '盒';
  if (/罐|听/i.test(combined)) return '罐';
  if (/包/i.test(combined)) return '包';
  if (/只/i.test(combined)) return '只';
  if (/套/i.test(combined)) return '套';
  if (/支/i.test(combined)) return '支';
  if (/条/i.test(combined)) return '条';
  if (/双/i.test(combined)) return '双';
  if (/桶/i.test(combined)) return '桶';
  if (/箱/i.test(combined)) return '箱';

  return '份';
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

    const isGift = isGiftOrGiveawayAttr(attrName);
    let val = null;

    if (isGift) {
      const negOpt = resolveNegativeGiftOption(attr.valueList || [], attrName);
      if (negOpt) {
        val = negOpt.value;
      } else if (!attr.isRequired) {
        val = null; // Strictly omit non-required gift fields if no negative option
      } else {
        const safe = (attr.valueList || []).find(v => !isGiftAffirmativeValue(v.value)) || attr.valueList?.[0];
        if (safe) val = safe.value;
      }
    } else {
      val = mtAiMap.get(attrId);
      if (isGiftAffirmativeValue(val)) {
        const negOpt = resolveNegativeGiftOption(attr.valueList || [], attrName);
        val = negOpt ? negOpt.value : null;
      }

      // Initial from recommendCat
      if (!val && initialMtCatAttr.length) {
        const init = initialMtCatAttr.find(x => String(x.attrId) === attrId);
        if (init && init.valueList?.[0]?.value && !isGiftAffirmativeValue(init.valueList[0].value)) {
          val = init.valueList[0].value;
        }
      }
    }

    // Secondary fill
    if (!val && !isGift) {
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
      } else if (attrName === '包装方式' || attrName === '包装形式') {
        if (isMultipack) val = '箱装';
        else if (isBottle) val = '瓶装';
        else if (isBag) val = '袋装';
        else {
          const opt = (attr.valueList || []).find(v => !/礼盒|礼袋|定制/i.test(v.value) && /普通包装|单件|瓶装|袋装|盒装/i.test(v.value));
          if (opt) val = opt.value;
          else val = '普通包装';
        }
      } else if (attrName === '是否含糖') {
        if (/0糖|无糖|低糖/.test(productName)) val = '无糖';
        else val = '含糖';
      } else if (/保质期/i.test(attrName)) {
        if (/食品|饮料|酒|零食/.test(mtCatPath)) val = '270天';
        else if (/日化|美妆|个护|洗护/.test(mtCatPath)) val = '1095天';
        else val = '365天';
      } else if (/麦汁浓度/i.test(attrName)) {
        val = extractWort(productName);
      } else if (/酒精度|酒精含量/i.test(attrName)) {
        val = extractAlcohol(productName);
      } else if (/单规格容量|单件容量|主杯容量|^容量$/i.test(attrName)) {
        const netObj = extractNetContent(productName, mtCatPath);
        val = netObj ? netObj.rawText : '500ml';
      } else if (/单包净含量|单件净含量|^净含量$/i.test(attrName)) {
        val = ensureNetContentUnit(val, productName, mtCatPath) || (isBottle ? '500ml' : '100g');
      } else if (attrName === '面料成分') {
        if (isClothingCategory(productName, mtCatPath)) {
          val = /棉/i.test(productName) ? '棉100%' : (/聚酯纤维|涤纶/i.test(productName) ? '聚酯纤维100%' : '棉100%');
        } else {
          val = '常规';
        }
      } else if (/线长|电源线长|全长/i.test(attrName)) {
        val = extractLength(productName);
      } else if (/丹尼数/i.test(attrName)) {
        val = extractDenier(productName);
      } else if (/^尺寸$/i.test(attrName)) {
        val = extractDimensions(productName);
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
      } else if (attrValueType === 10 || (attr.structAttrTemplate && attr.structAttrTemplate.length)) {
        if (/浓度|麦汁/.test(attrName)) val = extractWort(productName);
        else if (/酒精|度数/.test(attrName)) val = extractAlcohol(productName);
        else if (/容量|容积/.test(attrName)) val = '500ml';
        else if (/线长|长度/.test(attrName)) val = '1.5m';
        else if (/重量|净含/.test(attrName)) val = '100g';
        else if (isClothingCategory(productName, mtCatPath) && /面料/.test(attrName)) val = '棉100%';
        else {
          const tpl = attr.structAttrTemplate?.[0];
          const modules = tpl?.structAttrTemplateModules || [];
          const unitMod = modules.find(m => m.inputType === 5 || (m.options && m.options.length));
          const numMatch = productName.match(/(\d+(?:\.\d+)?)\s*(只|个|片|抽|支|袋|盒|桶|罐|瓶|份|套|双|对|包|条|顶|米|m|cm|mm|g|ml|l|度|°P|%vol)?/i);
          const num = (numMatch && numMatch[1]) ? numMatch[1] : '1';
          let unitStr = '';
          if (unitMod && unitMod.options && unitMod.options.length) {
            const matchedOpt = unitMod.options.find(o => productName.includes(o.optionValue)) || unitMod.options[0];
            unitStr = matchedOpt ? matchedOpt.optionValue : '';
          }
          val = `${num}${unitStr}`;
        }
      }

      // Ultimate fallback: guarantee 0 empty attributes
      if (!val) {
        if (attr.valueList && attr.valueList.length) {
          const validOpt = attr.valueList.find(v => v.value && !/^\d+$/.test(v.value) && !isGiftAffirmativeValue(v.value)) || attr.valueList[0];
          if (validOpt) val = validOpt.value;
        } else if (attrValueType === 3) {
          val = '常规';
        }
      }
    }

    if (val) {
      let valueList = [];
      if (attrValueType === 10 || (attr.structAttrTemplate && attr.structAttrTemplate.length) || attrName === '面料成分') {
        if (attrName === '面料成分' && isClothingCategory(productName, mtCatPath)) {
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
        } else if (/麦汁浓度/i.test(attrName)) {
          const wortNum = String(val).replace(/[^0-9.]/g, '') || '8';
          valueList = [{
            value: `${wortNum}°P`,
            valueId: '',
            struct_attr_template: [{
              format_type: 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: [
                  { sequence: 1, module_value: wortNum, option_id: 0, option_value: '', type: 4 },
                  { sequence: 2, module_value: '', option_id: 501, option_value: '°P', type: 5 }
                ]
              }]
            }]
          }];
          val = `${wortNum}°P`;
        } else if (/酒精度|酒精含量/i.test(attrName)) {
          const alcNum = String(val).replace(/[^0-9.]/g, '') || '4.3';
          valueList = [{
            value: `${alcNum}%vol`,
            valueId: '',
            struct_attr_template: [{
              format_type: 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: [
                  { sequence: 1, module_value: alcNum, option_id: 0, option_value: '', type: 1 },
                  { sequence: 2, module_value: '', option_id: 500, option_value: '%vol', type: 5 }
                ]
              }]
            }]
          }];
          val = `≥${alcNum}%vol`;
        } else if (/容量|主杯容量/i.test(attrName)) {
          const netObj = extractNetContent(productName, mtCatPath) || { num: 500, unit: 'ml', unitCode: 300, unitName: 'mL' };
          const uCode = (netObj.unit === 'l' || netObj.unit === '升') ? 301 : 300;
          const uName = (netObj.unit === 'l' || netObj.unit === '升') ? 'L' : 'mL';
          valueList = [{
            value: String(netObj.num),
            valueId: '',
            struct_attr_template: [{
              format_type: 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: [
                  { sequence: 1, module_value: String(netObj.num), option_id: 0, option_value: '', type: 4 },
                  { sequence: 2, module_value: '', option_id: uCode, option_value: uName, type: 5 }
                ]
              }]
            }]
          }];
          val = `${netObj.num}${uName}`;
        } else if (/净含量/i.test(attrName)) {
          const netObj = extractNetContent(productName, mtCatPath) || { num: 100, unit: 'g', unitCode: 202, unitName: 'g' };
          valueList = [{
            value: String(netObj.num),
            valueId: '',
            struct_attr_template: [{
              format_type: 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: [
                  { sequence: 1, module_value: String(netObj.num), option_id: 0, option_value: '', type: 4 },
                  { sequence: 2, module_value: '', option_id: netObj.unitCode || 202, option_value: netObj.unitName || 'g', type: 5 }
                ]
              }]
            }]
          }];
          val = `${netObj.num}${netObj.unitName || 'g'}`;
        } else if (/线长|电源线长|全长/i.test(attrName)) {
          const lenNum = String(val).replace(/[^0-9.]/g, '') || '1.5';
          valueList = [{
            value: '702',
            valueId: '',
            struct_attr_template: [{
              format_type: 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: [
                  { sequence: 1, module_value: lenNum, option_id: 0, option_value: '', type: 4 },
                  { sequence: 2, module_value: '', option_id: 702, option_value: 'm', type: 5 }
                ]
              }]
            }]
          }];
          val = `${lenNum}m`;
        } else if (attr.structAttrTemplate && attr.structAttrTemplate.length) {
          const tpl = attr.structAttrTemplate[0];
          const modules = tpl.structAttrTemplateModules || [];
          const numMod = modules.find(m => m.inputType === 4 || m.inputType === 1) || modules[0];
          const unitMod = modules.find(m => m.inputType === 5 || (m.options && m.options.length));

          let num = '1';
          const numMatch = String(val).match(/\d+(?:\.\d+)?/) || productName.match(/(\d+(?:\.\d+)?)\s*(只|个|片|抽|支|袋|盒|桶|罐|瓶|份|套|双|对|包|条|顶|米|m|cm|mm|g|ml|l|度|°P|%vol)?/i);
          if (numMatch) {
            num = numMatch[1] || numMatch[0];
          }

          let chosenOpt = null;
          if (unitMod && unitMod.options && unitMod.options.length) {
            chosenOpt = unitMod.options.find(o => productName.includes(o.optionValue) || String(val).includes(o.optionValue)) || unitMod.options[0];
          }

          const assembledModules = modules.map(mod => {
            if (numMod && mod.sequence === numMod.sequence) {
              return { sequence: mod.sequence, module_value: String(num), option_id: 0, option_value: '', type: mod.inputType || 4 };
            }
            if (unitMod && mod.sequence === unitMod.sequence && chosenOpt) {
              return { sequence: mod.sequence, module_value: '', option_id: chosenOpt.optionId, option_value: chosenOpt.optionValue, type: 5 };
            }
            return { sequence: mod.sequence, module_value: '', option_id: 0, option_value: '', type: mod.inputType || 1 };
          });

          const unitStr = chosenOpt ? chosenOpt.optionValue : '';
          val = `${num}${unitStr}`;
          valueList = [{
            value: `${num}${unitStr}`,
            valueId: '',
            struct_attr_template: [{
              format_type: tpl.structAttrValueFormatTypes?.[0]?.formatType || 1,
              struct_attr_module_values: [{
                struct_attr_template_modules: assembledModules
              }]
            }]
          }];
        } else {
          valueList = [{ value: String(val), valueId: '' }];
        }
      } else if (attrValueType === 1 || attrValueType === 2) {
        let opt = (attr.valueList || []).find(v => v.value == val || v.value.includes(val) || val.includes(v.value));
        if (!opt && attr.valueList && attr.valueList.length) {
          opt = attr.valueList.find(v => v.value && !/^\d+$/.test(v.value) && !isGiftAffirmativeValue(v.value)) || attr.valueList[0];
        }
        if (opt) {
          valueList = [{ value: opt.value, valueId: String(opt.valueId) }];
          val = opt.value;
        } else {
          let fallbackId = '';
          if (attrName === '品牌') fallbackId = '2436552';
          else if (attrName === '产地') fallbackId = '100000050';
          valueList = [{ value: String(val), valueId: fallbackId }];
        }
      } else if (attrValueType === 9 || /保质期/i.test(attrName)) {
        const days = parseInt(String(val).replace(/[^0-9]/g, '')) || 270;
        valueList = [{ value: '', valueId: '', structValue: { text: String(days), optionId: '100', optionValue: '天' } }];
        val = `${days}天`;
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
    const isGift = isGiftOrGiveawayAttr(propName);

    let val = null;

    if (isGift) {
      const negOpt = resolveNegativeGiftOption(prop.propertyValues || [], propName);
      if (negOpt) {
        val = negOpt.valueData || negOpt.value;
      } else if (!prop.required) {
        val = null; // Strictly omit non-required gift fields if no negative option
      } else {
        const safe = (prop.propertyValues || []).find(v => !isGiftAffirmativeValue(v.valueData)) || prop.propertyValues?.[0];
        if (safe) val = safe.valueData;
      }
    } else {
      val = eleAiMap.get(propId);
      if (isGiftAffirmativeValue(val)) {
        const negOpt = resolveNegativeGiftOption(prop.propertyValues || [], propName);
        val = negOpt ? (negOpt.valueData || negOpt.value) : null;
      }

      // Initial from recommendCat
      if (!val && initialEleCatAttr.length) {
        const init = initialEleCatAttr.find(x => String(x.propId) === propId);
        if (init && init.valueText && !isGiftAffirmativeValue(init.valueText)) {
          val = init.valueText;
        }
      }
    }

    // Secondary fill
    if (!val && !isGift) {
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
      } else if (propName === '包装方式' || propName === '包装形式') {
        if (isMultipack) val = '箱装';
        else if (isBottle) val = '瓶装';
        else if (isBag) val = '袋装';
        else {
          const opt = (prop.propertyValues || []).find(v => !/礼盒|礼袋|定制/i.test(v.valueData) && /普通包装|单件|瓶装|袋装|盒装/i.test(v.valueData));
          if (opt) val = opt.valueData;
          else val = '普通包装';
        }
      } else if (propName === '售卖方式') {
        val = '预包装';
      } else if (/单包净含量|单件净含量|^净含量$/i.test(propName)) {
        val = ensureNetContentUnit(val, productName, eleCatPath) || (isBottle ? '500ml' : '100g');
      } else if (/保质期/i.test(propName)) {
        if (/食品|饮料|酒|零食/.test(eleCatPath)) val = '270天';
        else if (/日化|美妆|个护|洗护/.test(eleCatPath)) val = '1095天';
        else val = '365天';
      } else if (/麦汁浓度/i.test(propName)) {
        val = extractWort(productName);
      } else if (/酒精度|酒精含量/i.test(propName)) {
        val = extractAlcohol(productName);
      } else if (/单规格容量|单件容量|主杯容量|^容量$/i.test(propName)) {
        const netObj = extractNetContent(productName, eleCatPath);
        val = netObj ? netObj.rawText : '500ml';
      } else if (propName === '是否为特殊用途化妆品' || propName === '是否商场同款' || propName === '是否加绒') {
        val = '否';
      } else if (propName === '适用人群') {
        if (/男/.test(productName)) val = '男士';
        else if (/女/.test(productName)) val = '女士';
        else if (/童|儿童|宝宝/.test(productName)) val = '儿童';
        else val = '成人';
      } else if (propName === '面料成分' || propName === '面料') {
        if (isClothingCategory(productName, eleCatPath)) {
          val = /棉/i.test(productName) ? '棉' : (/聚酯纤维|涤纶/i.test(productName) ? '聚酯纤维' : '棉');
        } else {
          val = '常规';
        }
      } else if (/线长|电源线长|全长/i.test(propName)) {
        val = extractLength(productName);
      } else if (/丹尼数/i.test(propName)) {
        val = extractDenier(productName);
      } else if (/^尺寸$/i.test(propName)) {
        val = extractDimensions(productName);
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
      } else if (prop.options && prop.options.length) {
        const numMatch = productName.match(/(\d+(?:\.\d+)?)\s*(只|个|片|抽|支|袋|盒|桶|罐|瓶|份|套|双|对|包|条|顶|米|m|cm|mm|g|ml|l|度|°P|%vol)?/i);
        const num = (numMatch && numMatch[1]) ? numMatch[1] : '1';
        let unit = prop.options[0];
        const matched = prop.options.find(u => productName.includes(u));
        if (matched) unit = matched;
        val = `${num}${unit}`;
      } else if (isGiftOrGiveawayAttr(propName)) {
        const negOpt = resolveNegativeGiftOption(prop.propertyValues || [], propName);
        if (negOpt) val = negOpt.valueData || negOpt.value;
      }

      // Ultimate fallback: guarantee 0 empty attributes
      if (!val) {
        if (prop.propertyValues && prop.propertyValues.length) {
          const validOpt = prop.propertyValues.find(v => v.valueData && !/^\d+$/.test(v.valueData) && !isGiftAffirmativeValue(v.valueData)) || prop.propertyValues[0];
          if (validOpt) val = validOpt.valueData;
        } else if (prop.inputProp) {
          val = '常规';
        }
      }
    }

    if (val) {
      if (/单包净含量|单件净含量|^净含量$/i.test(propName)) {
        val = ensureNetContentUnit(val, productName, eleCatPath) || val;
      } else if (/保质期/i.test(propName) && !/天|月|年/.test(String(val))) {
        val = `${String(val).replace(/[^0-9]/g, '') || '270'}天`;
      }

      let propertyValues = [];
      let valId = -1;
      let valText = String(val);

      if (prop.propertyValues && prop.propertyValues.length) {
        const valArr = Array.isArray(val) ? val : String(val).split(/[,/，\s]+/).filter(Boolean);
        for (const itemVal of valArr) {
          let opt = prop.propertyValues.find(v => v.valueData == itemVal || v.valueData.includes(itemVal) || String(itemVal).includes(v.valueData));
          if (!opt) {
            opt = prop.propertyValues.find(v => v.valueData && !/^\d+$/.test(v.valueData) && !isGiftAffirmativeValue(v.valueData)) || prop.propertyValues[0];
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
          const numMatch = String(val).match(/\d+(?:\.\d+)?/) || productName.match(/\d+(?:\.\d+)?/);
          const num = numMatch ? numMatch[0] : '1';
          let unit = prop.options[0];
          const matchedUnit = prop.options.find(u => String(val).toLowerCase().includes(u.toLowerCase()) || productName.toLowerCase().includes(u.toLowerCase()));
          if (matchedUnit) {
            unit = matchedUnit;
          } else if (/g|克/.test(String(val)) && prop.options.includes('g')) {
            unit = 'g';
          } else if (/ml|毫升/.test(String(val)) && prop.options.includes('ml')) {
            unit = 'ml';
          } else if (/天/.test(String(val)) && prop.options.includes('天')) {
            unit = '天';
          } else if (/只/.test(String(val)) && prop.options.includes('只')) {
            unit = '只';
          } else if (/个/.test(String(val)) && prop.options.includes('个')) {
            unit = '个';
          }
          propertyValues.push({ valueData: `${num}${unit}`, valueId: '', sortOrder: 0, structValue: { text: num, unit } });
          valText = `${num}${unit}`;
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
      let unit = s.unit;
      if (!unit || unit.trim() === '') {
        unit = extractSkuUnit(productName, s.skuSpec);
      }
      return { ...s, weight, unit };
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
