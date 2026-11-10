import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { isPropertyValid, fillProperty, extractNumber } from './required_property_rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = {
    tabs: 4,
    concurrency: 12,
    offset: 0,
    limit: null,
    benchmark: false,
    resume: true,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--tabs=')) {
      args.tabs = parseInt(arg.split('=')[1], 10) || 4;
    } else if (arg.startsWith('--concurrency=')) {
      args.concurrency = parseInt(arg.split('=')[1], 10) || 12;
    } else if (arg.startsWith('--offset=')) {
      args.offset = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--benchmark') {
      args.benchmark = true;
    } else if (arg === '--no-resume') {
      args.resume = false;
    }
  }
  return args;
}

function coverageField(channelId) {
  const cid = Number(channelId);
  if (cid === 100) return 'mt_channel_category_property';
  if (cid === 200) return 'elm_channel_category_property';
  if (cid === 300) return 'jd_channel_category_property';
  return '';
}

async function processSingleSpu(page, spuItem) {
  const startTime = Date.now();
  const spuId = String(spuItem.spuId || spuItem.spu_id || spuItem);

  // 1. Fetch live detail
  const detailRes = await page.evaluate(async (id) => {
    let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
    let headers = { 'Content-Type': 'application/json' };
    let body = JSON.stringify({ spuId: id });
    if (window.H5guard && typeof window.H5guard.sign === 'function') {
      const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
      Object.assign(headers, signed.headers || {});
      if (signed.url) url = signed.url;
    }
    const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
    return await resp.json();
  }, spuId);

  const detail = detailRes.data;
  if (!detail || !detail.spuId) {
    return {
      spuId,
      status: 'error',
      error: detailRes.msg || 'Detail not found',
      durationMs: Date.now() - startTime
    };
  }

  const spuName = String(detail.spuName || '');
  const upc = String(detail.skuList?.[0]?.upc || spuItem.upc || '');
  const activeChannels = detail.spuChannelInfoList || [];
  const modifiedChannels = new Set();
  let categoriesFilledCount = 0;
  let recommendationsAppliedCount = 0;
  let fallbacksFilledCount = 0;

  // 2. Channel Category Check & Auto-Fill
  const emptyChannels = activeChannels.filter(c => !c.categoryCode || !c.categoryName).map(c => Number(c.channelId));
  if (emptyChannels.length > 0) {
    const recRes = await page.evaluate(async ({ channelIds, spuName, upc }) => {
      let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/batchRecommend?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
      let headers = { 'Content-Type': 'application/json' };
      let body = JSON.stringify({
        channelIds,
        spuUpcNameInfoVOS: [{ upc: upc || '', name: spuName }]
      });
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
        Object.assign(headers, signed.headers || {});
        if (signed.url) url = signed.url;
      }
      const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
      return await resp.json();
    }, { channelIds: [100, 200, 300], spuName, upc });

    const recList = recRes.data?.[0]?.recommendChannelCategoryList || [];
    const recMap = {};
    recList.forEach(r => { recMap[Number(r.channelId)] = r; });

    for (const ch of activeChannels) {
      const cid = Number(ch.channelId);
      if ((!ch.categoryCode || !ch.categoryName) && recMap[cid]) {
        const rec = recMap[cid];
        ch.categoryCode = rec.categoryId;
        ch.categoryName = rec.categoryName;
        ch.categoryCodePath = rec.idPath;
        ch.categoryNamePath = rec.namePath;
        ch.upcRequired = rec.upcRequired ?? null;
        ch.resourceType = rec.resourceType ?? null;
        modifiedChannels.add(cid);
        categoriesFilledCount++;
      }
    }
  }

  // 2.1 Check if any MT/ELM channel is missing categoryProperties schema, query batchQuery if needed
  const missingPropChannelMap = {};
  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if ((cid === 100 || cid === 200) && ch.categoryCode && (!ch.categoryProperties || ch.categoryProperties.length === 0)) {
      missingPropChannelMap[String(cid)] = [{ channelCategoryId: ch.categoryCode }];
    }
  }

  if (Object.keys(missingPropChannelMap).length > 0) {
    const propBatchRes = await page.evaluate(async (map) => {
      let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/property/batchQuery?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
      let headers = { 'Content-Type': 'application/json' };
      let body = JSON.stringify({ channelCategoryCodeMapV2: map });
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
        Object.assign(headers, signed.headers || {});
        if (signed.url) url = signed.url;
      }
      const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
      return await resp.json();
    }, missingPropChannelMap);

    const propData = propBatchRes.data || {};
    for (const ch of activeChannels) {
      const chKey = String(ch.channelId);
      if (propData[chKey] && propData[chKey][0]) {
        ch.categoryProperties = propData[chKey][0].categoryProperties || [];
      }
    }
  }

  // 3. Official Property Recommendations (美团 100, 饿了么 200) - 优先点掉全部推荐
  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if ((cid === 100 || cid === 200) && ch.categoryCode && ch.categoryProperties && ch.categoryProperties.length > 0) {
      try {
        const recPropsRes = await page.evaluate(async ({ spuName, channelId, channelCategoryId, upc }) => {
          let url = 'https://qnh.meituan.com/qnh-gw5/api/storeSpu/queryRecommendDynamicInfoAndWeight?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
          let headers = { 'Content-Type': 'application/json' };
          let body = JSON.stringify({
            spuName,
            channelId,
            channelCategoryId,
            upc: upc || ''
          });
          if (window.H5guard && typeof window.H5guard.sign === 'function') {
            const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
            Object.assign(headers, signed.headers || {});
            if (signed.url) url = signed.url;
          }
          const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
          return await resp.json();
        }, { spuName, channelId: cid, channelCategoryId: ch.categoryCode, upc });

        const recProps = recPropsRes.data?.channelDynamicInfoVOList || [];
        for (const rp of recProps) {
          if (rp.customValue && rp.customValue.length > 0) {
            const targetProp = ch.categoryProperties.find(p => String(p.attrId) === String(rp.attrId));
            if (targetProp) {
              const oldValStr = JSON.stringify(targetProp.customValue || []);
              const newValStr = JSON.stringify(rp.customValue);
              if (oldValStr !== newValStr) {
                targetProp.customValue = rp.customValue;
                modifiedChannels.add(cid);
                recommendationsAppliedCount++;
              }
            }
          }
        }
      } catch (err) {
        // Ignore recommendation query error
      }
    }
  }

  // 3.5 & 3.6 图片原值与门店自定义主图隔离保护铁律：
  // 严禁注入通用说明占位图，严禁将平台示例图(pictureExample)写入特殊图槽位，
  // 且严禁在主档 update/v2 中推送 { field: 'picture', coverToStore: 1 }（会冲掉门店 customizedPicFlag: true 自定义主图！）
  const detailImagesFilled = false;
  const specialPicsFilled = false;

  // 4. Remaining Properties Fallback (必填 + 非必填全量填满，做到 0 空白)
  const mtChannel = activeChannels.find(c => Number(c.channelId) === 100);
  const mtShelfProp = mtChannel?.categoryProperties?.find(p => p.attrName === '保质期');
  const mtShelfVal = mtShelfProp?.customValue?.[0]?.attrValue || '360天';

  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if (!ch.categoryProperties || ch.categoryProperties.length === 0) continue;

    for (const prop of ch.categoryProperties) {
      if (!isPropertyValid(prop)) {
        // 保质期结构值
        if (prop.attrName === '保质期' && String(prop.attrValueType) === '10') {
          const daysMatch = mtShelfVal.match(/(\d+)/);
          const days = daysMatch ? daysMatch[1] : '360';
          prop.customValue = [{
            attrValueId: null,
            attrValue: null,
            douyinDiyType: null,
            structAttrValueList: [
              {
                formatType: 1,
                valueList: [
                  [
                    {
                      value: String(days),
                      optionId: null,
                      sequence: 1,
                      optionValue: null,
                      moduleId: null,
                      unitId: null,
                      unitName: null,
                    },
                    {
                      value: null,
                      optionId: 1,
                      sequence: 2,
                      optionValue: '天',
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
          }];
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
          continue;
        }

        // 净含量结构值
        if (prop.attrName === '净含量' && String(prop.attrValueType) === '10') {
          const m = spuName.match(/(\d+(?:\.\d+)?)\s*(g|克|kg|千克|ml|毫升|l|升)/i);
          const num = m ? m[1] : '500';
          const unit = m ? m[2].toLowerCase() : 'g';
          const unitId = (unit === 'kg' || unit === '千克' || unit === 'l' || unit === '升') ? 2 : 1;
          const unitName = unitId === 2 ? 'kg' : 'g';
          prop.customValue = [{
            attrValueId: null,
            attrValue: null,
            douyinDiyType: null,
            structAttrValueList: [
              {
                formatType: 1,
                valueList: [
                  [
                    {
                      value: String(num),
                      optionId: null,
                      sequence: 1,
                      optionValue: null,
                      moduleId: null,
                      unitId: null,
                      unitName: null,
                    },
                    {
                      value: null,
                      optionId: unitId,
                      sequence: 2,
                      optionValue: unitName,
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
          }];
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
          continue;
        }

        // 通用规则引擎
        const filled = fillProperty(prop, spuName);
        if (filled) {
          prop.customValue = filled;
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
        }
      }
    }
  }

  // 4.5. 京东到家品牌（brandInfo）与多规格销售属性（saleAttrList）及全量 SKU 规格关联
  const ch300 = activeChannels.find(c => Number(c.channelId) === 300);
  if (ch300 && ch300.categoryCode) {
    if (!ch300.brandInfo || !ch300.brandInfo.brandCode || !ch300.brandInfo.brandName) {
      ch300.brandInfo = { clean: null, brandName: '无品牌', brandCode: '35247' };
      modifiedChannels.add(300);
    }

    const skus = Array.isArray(detail.skus) ? detail.skus : [];
    const isMultiSku = Number(detail.specType) === 2 || skus.length > 1;
    if (isMultiSku && skus.length > 0) {
      const hasCh300SaleAttr =
        Array.isArray(ch300.saleAttrList) &&
        ch300.saleAttrList.length > 0 &&
        Boolean(ch300.saleAttrList[0]?.attrId);
      const allSkusHaveJdAttr = skus.every(sku => {
        const sci300 = (sku.skuChannelInfoList || []).find(sci => Number(sci.channelId) === 300);
        return (
          Array.isArray(sci300?.saleAttrValueList) &&
          sci300.saleAttrValueList.length > 0 &&
          Boolean(sci300.saleAttrValueList[0]?.attrValue)
        );
      });

      if (!hasCh300SaleAttr || !allSkusHaveJdAttr) {
        let targetAttr = null;
        if (hasCh300SaleAttr) {
          targetAttr = {
            attrId: String(ch300.saleAttrList[0].attrId),
            attrName: ch300.saleAttrList[0].attrName || '颜色',
          };
        } else {
          try {
            const jdPropRes = await page.evaluate(async (catId) => {
              let url = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/property/batchQuery?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
              let headers = { 'Content-Type': 'application/json' };
              let body = JSON.stringify({
                channelCategoryCodeMapV2: { 300: [{ channelCategoryId: String(catId) }] }
              });
              if (window.H5guard && typeof window.H5guard.sign === 'function') {
                const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
                Object.assign(headers, signed.headers || {});
                if (signed.url) url = signed.url;
              }
              const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
              return await resp.json();
            }, ch300.categoryCode);
            const jdSaleAttrs = jdPropRes?.data?.['300']?.[0]?.jdSaleAttrList || [];
            const first = jdSaleAttrs[0] || { attrId: '1577293', attrName: '颜色' };
            targetAttr = {
              attrId: String(first.attrId),
              attrName: first.attrName,
            };
          } catch {
            targetAttr = { attrId: '1577293', attrName: '颜色' };
          }

          ch300.saleAttrList = [{
            attrId: String(targetAttr.attrId),
            attrName: targetAttr.attrName,
            picRelated: false,
            saleAttrValueList: [],
            attrSortNum: 0,
          }];
          if (ch300.skuPicSetting === null || ch300.skuPicSetting === undefined) {
            ch300.skuPicSetting = 0;
          }
          modifiedChannels.add(300);
          fallbacksFilledCount++;
        }

        const usedValues = new Set();
        for (const sku of skus) {
          const sci300 = (sku.skuChannelInfoList || []).find(sci => Number(sci.channelId) === 300);
          const existingVal = sci300?.saleAttrValueList?.[0]?.attrValue;
          if (existingVal && String(sci300.saleAttrValueList[0].attrId) === String(targetAttr.attrId)) {
            usedValues.add(String(existingVal));
          }
        }

        for (let i = 0; i < skus.length; i++) {
          const sku = skus[i];
          sku.skuChannelInfoList = Array.isArray(sku.skuChannelInfoList) ? sku.skuChannelInfoList : [];
          const mtSci = sku.skuChannelInfoList.find(sci => Number(sci.channelId) === 100);
          const rawSpec =
            sku.specName ||
            (mtSci?.saleAttrValueList || []).map(v => v.attrValue).filter(Boolean).join('/') ||
            `规格${i + 1}`;
          let specText = String(rawSpec).trim().slice(0, 28) || `规格${i + 1}`;

          let sci300 = sku.skuChannelInfoList.find(sci => Number(sci.channelId) === 300);
          if (!sci300) {
            sci300 = {
              channelId: 300,
              skuPicUrlList: null,
              saleAttrValueList: [],
              upc: null,
              channelSkuList: null,
            };
            sku.skuChannelInfoList.push(sci300);
          }

          const hasValidExisting =
            Array.isArray(sci300.saleAttrValueList) &&
            sci300.saleAttrValueList.length > 0 &&
            sci300.saleAttrValueList[0]?.attrValue &&
            String(sci300.saleAttrValueList[0]?.attrId) === String(targetAttr.attrId);

          if (!hasValidExisting) {
            if (usedValues.has(specText)) {
              specText = `${specText.slice(0, 25)}_${i + 1}`;
            }
            usedValues.add(specText);
            sci300.saleAttrValueList = [{
              attrId: Number(targetAttr.attrId),
              attrName: targetAttr.attrName,
              attrValue: specText,
              attrValueId: null,
            }];
            modifiedChannels.add(300);
            fallbacksFilledCount++;
          }
        }
      }
    }
  }

  // 5. Save to QNH (仅限纯渠道类目属性字段，严禁级联覆盖门店自定义名称 spu_name 或自定义图片 picture)
  if (modifiedChannels.size > 0) {
    const fieldCoverageInfoList = Array.from(modifiedChannels).map(cid => ({
      field: coverageField(cid),
      coverToStore: 1,
    })).filter(f => f.field);

    const updateRes = await page.evaluate(async ({ url, body }) => {
      let reqUrl = url;
      const headers = { 'Content-Type': 'application/json' };
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url: reqUrl, method: 'POST', data: JSON.stringify(body) });
        Object.assign(headers, signed.headers || {});
        if (signed.url) reqUrl = signed.url;
      }
      const resp = await fetch(reqUrl, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include' });
      return await resp.json();
    }, {
      url: 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0',
      body: {
        tenantSpu: detail,
        coverageRequest: { fieldCoverageInfoList }
      }
    });

    if (updateRes.code !== 0) {
      return {
        spuId,
        spuName,
        status: 'fail',
        error: updateRes.msg || updateRes.message || 'Save failed',
        categoriesFilledCount,
        recommendationsAppliedCount,
        fallbacksFilledCount,
        detailImagesFilled,
        durationMs: Date.now() - startTime
      };
    }
  }

  return {
    spuId,
    spuName,
    status: (modifiedChannels.size > 0 || detailImagesFilled) ? 'updated' : 'no_change',
    categoriesFilledCount,
    recommendationsAppliedCount,
    fallbacksFilledCount,
    detailImagesFilled,
    modifiedChannels: Array.from(modifiedChannels),
    durationMs: Date.now() - startTime
  };
}

async function setupBrowserTabs(context, count) {
  console.log(`Setting up ${count} browser tabs for distributed signing...`);
  const pages = [];
  const existing = context.pages().filter(p => p.url().includes('qnh.meituan.com'));
  pages.push(...existing);

  while (pages.length < count) {
    const p = await context.newPage();
    await p.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2000);
    pages.push(p);
  }

  console.log(`Ready with ${pages.length} tabs.`);
  return pages.slice(0, count);
}

async function main() {
  const args = parseArgs();
  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  await fs.mkdir(runDir, { recursive: true });

  const pendingFile = path.join(runDir, 'pending_spus_to_clean.json');
  let targets = [];
  try {
    const raw = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
    targets = raw.spus || [];
  } catch (e) {
    console.error('Pending SPUs file not found. Please run dump_all_tenant_spus.mjs first.');
    process.exit(1);
  }

  console.log(`Total pending SPUs to process: ${targets.length}`);

  // Checkpoint resume handling
  const checkpointFile = path.join(runDir, 'mass_cleaning_checkpoint.json');
  const processedSpuIds = new Set();
  if (args.resume) {
    try {
      const cp = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
      (cp.processed_spu_ids || []).forEach(id => processedSpuIds.add(String(id)));
      console.log(`Resuming from checkpoint: ${processedSpuIds.size} SPUs already processed.`);
    } catch (e) {
      // no checkpoint yet
    }
  }

  targets = targets.filter(t => !processedSpuIds.has(String(t.spuId)));
  if (args.limit) {
    targets = targets.slice(args.offset, args.offset + args.limit);
  } else if (args.offset > 0) {
    targets = targets.slice(args.offset);
  }

  console.log(`Effective SPUs for this run: ${targets.length}`);
  if (targets.length === 0) {
    console.log('No SPUs to process! All completed.');
    process.exit(0);
  }

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  // Setup tabs
  const pages = await setupBrowserTabs(context, args.tabs);

  let successCount = 0;
  let updatedCount = 0;
  let noChangeCount = 0;
  let failCount = 0;
  let totalCategoriesFilled = 0;
  let totalRecommendationsApplied = 0;
  let totalFallbacksFilled = 0;
  let totalDetailImagesFilled = 0;
  const failures = [];
  const durations = [];

  const runStartTime = Date.now();
  let currentIndex = 0;
  let lastCheckpointTime = Date.now();

  async function worker(workerId) {
    while (true) {
      const idx = currentIndex++;
      if (idx >= targets.length) break;

      const item = targets[idx];
      const spuId = String(item.spuId);
      let page = pages[(workerId - 1) % pages.length];

      // Tab health check
      if (page.isClosed()) {
        console.log(`[Worker ${workerId}] Tab was closed, recreating...`);
        page = await context.newPage();
        await page.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
        pages[(workerId - 1) % pages.length] = page;
      }

      let retries = 0;
      while (retries < 3) {
        try {
          const result = await processSingleSpu(page, item);
          durations.push(result.durationMs);
          processedSpuIds.add(spuId);

          if (result.status === 'updated') {
            updatedCount++;
            successCount++;
            totalCategoriesFilled += result.categoriesFilledCount;
            totalRecommendationsApplied += result.recommendationsAppliedCount;
            totalFallbacksFilled += result.fallbacksFilledCount;
            if (result.detailImagesFilled) totalDetailImagesFilled++;
          } else if (result.status === 'no_change') {
            noChangeCount++;
            successCount++;
          } else {
            failCount++;
            failures.push({ spuId, error: result.error, name: result.spuName });
          }
          break; // Success or handled
        } catch (err) {
          retries++;
          if (retries >= 3) {
            failCount++;
            failures.push({ spuId, error: err.message, name: item.spuName });
          } else {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }

      // Live telemetry
      if ((idx + 1) % 10 === 0 || idx === targets.length - 1) {
        const elapsedSec = (Date.now() - runStartTime) / 1000;
        const rate = Math.round(((idx + 1) / elapsedSec) * 60);
        const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1));
        console.log(`[Progress ${idx + 1}/${targets.length}] Rate: ${rate} SPU/min | Avg: ${avgDuration}ms | Updated: ${updatedCount} | NoChange: ${noChangeCount} | Fail: ${failCount} (补类目:${totalCategoriesFilled}, 补图:${totalDetailImagesFilled}, 补属性:${totalFallbacksFilled})`);
      }

      // Periodic checkpoint
      if (Date.now() - lastCheckpointTime > 30000 || (idx + 1) % 100 === 0) {
        lastCheckpointTime = Date.now();
        await fs.writeFile(checkpointFile, JSON.stringify({
          last_updated: new Date().toISOString(),
          total_processed: processedSpuIds.size,
          processed_spu_ids: Array.from(processedSpuIds)
        }, null, 2), 'utf8');
      }

      await new Promise(r => setTimeout(r, 40));
    }
  }

  console.log(`\nStarting execution with ${args.tabs} tabs, ${args.concurrency} concurrent workers...`);
  const workerPromises = [];
  for (let w = 1; w <= args.concurrency; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  // Final checkpoint
  await fs.writeFile(checkpointFile, JSON.stringify({
    last_updated: new Date().toISOString(),
    total_processed: processedSpuIds.size,
    processed_spu_ids: Array.from(processedSpuIds)
  }, null, 2), 'utf8');

  // Report
  const totalElapsedSec = (Date.now() - runStartTime) / 1000;
  const finalRate = Math.round((targets.length / totalElapsedSec) * 60);
  const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1));

  const report = {
    generated_at: new Date().toISOString(),
    tabs: args.tabs,
    concurrency: args.concurrency,
    total_targets: targets.length,
    elapsed_seconds: totalElapsedSec,
    effective_rate_spu_per_min: finalRate,
    avg_latency_ms: avgDuration,
    success_count: successCount,
    updated_count: updatedCount,
    no_change_count: noChangeCount,
    fail_count: failCount,
    total_categories_filled: totalCategoriesFilled,
    total_recommendations_applied: totalRecommendationsApplied,
    total_fallbacks_filled: totalFallbacksFilled,
    failures,
  };

  const reportPath = path.join(runDir, 'mass_cleaning_report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================= 大规模商品清洗执行完毕 =================`);
  console.log(`总商品数：${targets.length}`);
  console.log(`总耗时：${Math.round(totalElapsedSec)} 秒 (${(totalElapsedSec / 60).toFixed(1)} 分钟)`);
  console.log(`综合跑速：${finalRate} SPU/分钟 (平均每商品 ${avgDuration}ms)`);
  console.log(`更新成功数：${updatedCount}`);
  console.log(`无需更新数：${noChangeCount}`);
  console.log(`失败数：${failCount}`);
  console.log(`补齐渠道类目数：${totalCategoriesFilled}`);
  console.log(`采纳官方推荐属性数：${totalRecommendationsApplied}`);
  console.log(`规则兜底补齐属性数：${totalFallbacksFilled}`);
  console.log(`报告已保存至：${reportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error in mass cleaning:', err);
    process.exit(1);
  });
