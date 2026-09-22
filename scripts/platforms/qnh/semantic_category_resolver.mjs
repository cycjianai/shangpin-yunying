import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Title distillation (strip specs, packaging, marketing noise)
export function distillTitle(title) {
  if (!title) return '';
  return title
    .replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:片|包|盒|袋|支|件|个|条|抽|瓶|罐|g|kg|ml|l|克|千克|毫升|升|颗|枚|张|双|把|本|桶|箱|组|套)(?:\/|\*|\s)*(?:包|盒|袋|支|件|个|条|瓶|罐|箱|份|组|套)?/gi, ' ')
    .replace(/(?:小包便携装|便携装|温和无刺激|清洁杀菌|杀菌消毒|家用|实惠装|特惠装|量贩装|家庭装|新老包装随机|随机发货|经典款|升级款|多功能|通用|神器)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 2. Cross-Channel Category Mapping (美团/京东到家 -> 饿了么)
export const CROSS_CHANNEL_MAP = {
  // 洗衣凝珠 -> 洗衣液/内衣洗涤剂
  '洗衣凝珠': {
    code: '201220042',
    name: '洗衣液/内衣洗涤剂',
    idPath: '201229768>201222049>201220042',
    namePath: '家庭清洁>衣物清洁/护理>洗衣液/内衣洗涤剂'
  },
  // 粉圆/芋圆/爆爆珠 / 其他烘焙材料 -> 生粉/蛋糕粉/预拌粉
  '粉圆/芋圆/爆爆珠': {
    code: '201229643',
    name: '生粉/蛋糕粉/预拌粉',
    idPath: '201230210>201221437>201229643',
    namePath: '调味品>烘焙辅料>生粉/蛋糕粉/预拌粉'
  },
  '其他烘焙材料': {
    code: '201229643',
    name: '生粉/蛋糕粉/预拌粉',
    idPath: '201230210>201221437>201229643',
    namePath: '调味品>烘焙辅料>生粉/蛋糕粉/预拌粉'
  },
  '烘焙辅料': {
    code: '201229643',
    name: '生粉/蛋糕粉/预拌粉',
    idPath: '201230210>201221437>201229643',
    namePath: '调味品>烘焙辅料>生粉/蛋糕粉/预拌粉'
  },
  // 湿巾 -> 湿纸巾
  '湿巾': {
    code: '201220661',
    name: '湿纸巾',
    idPath: '201229768>201227552>201220661',
    namePath: '家庭清洁>纸品湿巾>湿纸巾'
  },
  '卫生湿巾': {
    code: '201220661',
    name: '湿纸巾',
    idPath: '201229768>201227552>201220661',
    namePath: '家庭清洁>纸品湿巾>湿纸巾'
  }
};

let cachedChannelLeaves = {};

// 3. Load full leaf categories for any channel
export async function getChannelLeafCategories(page, channelId) {
  const cid = Number(channelId);
  if (cachedChannelLeaves[cid]) return cachedChannelLeaves[cid];

  const res = await page.evaluate(async (c) => {
    let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/queryByChannelId?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
    let headers = { 'Content-Type': 'application/json' };
    let body = JSON.stringify({ channelId: c });
    if (window.H5guard && typeof window.H5guard.sign === 'function') {
      const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
      Object.assign(headers, signed.headers || {});
      if (signed.url) url = signed.url;
    }
    const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
    return await resp.json();
  }, cid);

  const tree = res.data || [];
  const leaves = [];

  function traverse(node, pathNames = [], pathIds = []) {
    const curNames = [...pathNames, node.categoryName];
    const curIds = [...pathIds, node.categoryId];
    if (!node.children || node.children.length === 0) {
      leaves.push({
        code: String(node.categoryId),
        name: node.categoryName,
        idPath: curIds.join('>'),
        namePath: curNames.join('>'),
        channelId: cid,
        upcRequired: node.upcRequired ?? null,
        resourceType: node.resourceType ?? null,
      });
    } else {
      for (const child of node.children) {
        traverse(child, curNames, curIds);
      }
    }
  }

  for (const root of tree) {
    traverse(root);
  }

  cachedChannelLeaves[cid] = leaves;
  return leaves;
}

// 4. Semantic Fallback Matcher for Eleme
export async function resolveElemeCategoryFallback(page, spuName, presentChannels = {}) {
  // Step A: Check Cross-Channel Mapping
  const mtCatName = presentChannels[100]?.name;
  const jdCatName = presentChannels[300]?.name;
  if (mtCatName && CROSS_CHANNEL_MAP[mtCatName]) {
    return CROSS_CHANNEL_MAP[mtCatName];
  }
  if (jdCatName && CROSS_CHANNEL_MAP[jdCatName]) {
    return CROSS_CHANNEL_MAP[jdCatName];
  }

  // Step B: Distill title and re-query batchRecommend
  const distilled = distillTitle(spuName);
  if (distilled) {
    try {
      const recRes = await page.evaluate(async ({ name, cid }) => {
        let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/batchRecommend?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
        let headers = { 'Content-Type': 'application/json' };
        let body = JSON.stringify({
          channelIds: [cid],
          spuUpcNameInfoVOS: [{ upc: '', name }]
        });
        if (window.H5guard && typeof window.H5guard.sign === 'function') {
          const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
          Object.assign(headers, signed.headers || {});
          if (signed.url) url = signed.url;
        }
        const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
        return await resp.json();
      }, { name: distilled, cid: 200 });

      const rec = recRes.data?.[0]?.recommendChannelCategoryList?.find(r => Number(r.channelId) === 200);
      if (rec) {
        return {
          code: rec.categoryId,
          name: rec.categoryName,
          idPath: rec.idPath,
          namePath: rec.namePath,
          upcRequired: rec.upcRequired ?? null,
          resourceType: rec.resourceType ?? null,
        };
      }
    } catch (e) {}
  }

  // Step C: Match against Eleme 2,415 leaf categories
  const leaves = await getChannelLeafCategories(page, 200);
  const targetKeywords = [mtCatName, jdCatName, distilled, spuName].filter(Boolean);

  let bestMatch = null;
  let highestScore = 0;

  for (const leaf of leaves) {
    let score = 0;
    for (const kw of targetKeywords) {
      if (!kw) continue;
      if (leaf.name === kw) score += 50;
      else if (kw.includes(leaf.name) && leaf.name.length >= 2) score += leaf.name.length * 5;
      else if (leaf.name.includes(kw) && kw.length >= 2) score += kw.length * 4;

      if (leaf.namePath.includes(kw) && kw.length >= 2) score += 10;
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = leaf;
    }
  }

  if (highestScore >= 10 && bestMatch) {
    return bestMatch;
  }

  return null;
}

// 5. Universal Resolver for Any Channel (100, 200, 300)
export async function resolveChannelCategoryFallback(page, channelId, spuName, presentChannels = {}) {
  const cid = Number(channelId);
  if (cid === 200) {
    return await resolveElemeCategoryFallback(page, spuName, presentChannels);
  }

  // Step 1: Distill title and re-query batchRecommend for this channel
  const distilled = distillTitle(spuName);
  if (distilled) {
    try {
      const recRes = await page.evaluate(async ({ name, cid }) => {
        let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/batchRecommend?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
        let headers = { 'Content-Type': 'application/json' };
        let body = JSON.stringify({
          channelIds: [cid],
          spuUpcNameInfoVOS: [{ upc: '', name }]
        });
        if (window.H5guard && typeof window.H5guard.sign === 'function') {
          const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
          Object.assign(headers, signed.headers || {});
          if (signed.url) url = signed.url;
        }
        const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
        return await resp.json();
      }, { name: distilled, cid });

      const rec = recRes.data?.[0]?.recommendChannelCategoryList?.find(r => Number(r.channelId) === cid);
      if (rec) {
        return {
          code: rec.categoryId,
          name: rec.categoryName,
          idPath: rec.idPath,
          namePath: rec.namePath,
          upcRequired: rec.upcRequired ?? null,
          resourceType: rec.resourceType ?? null,
        };
      }
    } catch (e) {}
  }

  // Step 2: Match against channel leaf categories
  const leaves = await getChannelLeafCategories(page, cid);
  const otherCatNames = Object.values(presentChannels).map(c => c.name).filter(Boolean);
  const targetKeywords = [...otherCatNames, distilled, spuName].filter(Boolean);

  let bestMatch = null;
  let highestScore = 0;

  for (const leaf of leaves) {
    let score = 0;
    for (const kw of targetKeywords) {
      if (!kw) continue;
      if (leaf.name === kw) score += 50;
      else if (kw.includes(leaf.name) && leaf.name.length >= 2) score += leaf.name.length * 5;
      else if (leaf.name.includes(kw) && kw.length >= 2) score += kw.length * 4;

      if (leaf.namePath.includes(kw) && kw.length >= 2) score += 10;
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = leaf;
    }
  }

  if (highestScore >= 10 && bestMatch) {
    return bestMatch;
  }

  return null;
}
