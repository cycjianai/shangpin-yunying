import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { isPropertyValid, fillProperty } from './required_property_rules.mjs';
import { resolveChannelCategoryFallback, getChannelLeafCategories } from './semantic_category_resolver.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function coverageField(channelId) {
  const cid = Number(channelId);
  if (cid === 100) return 'mt_channel_category_property';
  if (cid === 200) return 'elm_channel_category_property';
  if (cid === 300) return 'jd_channel_category_property';
  return '';
}

async function setupBrowserTabs(context, count) {
  console.log(`Setting up ${count} browser tabs for distributed signing...`);
  const pages = [];
  const existing = context.pages().filter(p => p.url().includes('qnh.meituan.com') && !p.isClosed());
  pages.push(...existing);

  while (pages.length < count) {
    const p = await context.newPage();
    await p.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    pages.push(p);
  }

  console.log(`Ready with ${pages.length} tabs.`);
  return pages.slice(0, count);
}

async function processSingleSpu(page, item) {
  const startTime = Date.now();
  const spuId = String(item.spuId);
  const spuName = item.spuName || '';

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

  const activeChannels = detail.spuChannelInfoList || [];
  const modifiedChannels = new Set();
  let categoriesFilledCount = 0;
  let recommendationsAppliedCount = 0;
  let fallbacksFilledCount = 0;

  // Build present channels map
  const presentChannels = {};
  for (const ch of activeChannels) {
    if (ch.categoryCode && ch.categoryName) {
      presentChannels[Number(ch.channelId)] = {
        code: ch.categoryCode,
        name: ch.categoryName,
        path: ch.categoryNamePath
      };
    }
  }

  // 2. Resolve missing categories via Universal Semantic Resolver
  const missingPropChannelMap = {};
  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if (!ch.categoryCode || !ch.categoryName) {
      const resolved = await resolveChannelCategoryFallback(page, cid, spuName, presentChannels);
      if (resolved) {
        ch.categoryCode = resolved.code;
        ch.categoryName = resolved.name;
        ch.categoryCodePath = resolved.idPath;
        ch.categoryNamePath = resolved.namePath;
        ch.upcRequired = resolved.upcRequired ?? null;
        ch.resourceType = resolved.resourceType ?? null;
        modifiedChannels.add(cid);
        categoriesFilledCount++;
        missingPropChannelMap[String(cid)] = [{ channelCategoryId: resolved.code }];
      }
    } else if ((cid === 100 || cid === 200) && (!ch.categoryProperties || ch.categoryProperties.length === 0)) {
      missingPropChannelMap[String(cid)] = [{ channelCategoryId: ch.categoryCode }];
    }
  }

  // 3. Query batchQuery for properties of newly assigned or empty channels
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

  // 4. Query official recommendations
  const upc = detail.skus?.[0]?.upcList?.[0] || '';
  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if ((cid === 100 || cid === 200) && ch.categoryCode && ch.categoryProperties && ch.categoryProperties.length > 0) {
      try {
        const recPropsRes = await page.evaluate(async ({ spuName, channelId, channelCategoryId, upc }) => {
          let url = 'https://qnh.meituan.com/qnh-gw5/api/storeSpu/queryRecommendDynamicInfoAndWeight?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
          let headers = { 'Content-Type': 'application/json' };
          let body = JSON.stringify({ spuName, channelId, channelCategoryId, upc: upc || '' });
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
      } catch (err) {}
    }
  }

  // 5. Fill remaining properties (0-blank rule)
  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if (!ch.categoryProperties || ch.categoryProperties.length === 0) continue;

    for (const prop of ch.categoryProperties) {
      if (!isPropertyValid(prop)) {
        const filled = fillProperty(prop, spuName);
        if (filled) {
          prop.customValue = filled;
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
        }
      }
    }
  }

  // 6. Save to QNH
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
        durationMs: Date.now() - startTime
      };
    }
  }

  return {
    spuId,
    spuName,
    status: modifiedChannels.size > 0 ? 'updated' : 'no_change',
    categoriesFilledCount,
    recommendationsAppliedCount,
    fallbacksFilledCount,
    modifiedChannels: Array.from(modifiedChannels),
    durationMs: Date.now() - startTime
  };
}

async function main() {
  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  const missingFile = path.join(runDir, 'spus_with_missing_channel_categories.json');

  let missingData;
  try {
    missingData = JSON.parse(await fs.readFile(missingFile, 'utf8'));
  } catch (e) {
    console.error('Missing categories file not found. Please wait for scan_missing_channel_categories to complete.');
    process.exit(1);
  }

  const targets = missingData.items || [];
  console.log(`================ 渠道类目语义兜底与属性回填任务启动 ================`);
  console.log(`待治理商品数：${targets.length} | 架构：4 Tabs + 12 并发`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = await setupBrowserTabs(context, 4);

  // Preload leaf categories
  console.log('Preloading Eleme & JD leaf categories...');
  await getChannelLeafCategories(pages[0], 200);
  await getChannelLeafCategories(pages[0], 300);
  console.log('Leaf categories preloaded.');

  let successCount = 0;
  let updatedCount = 0;
  let noChangeCount = 0;
  let failCount = 0;
  let totalCategoriesFilled = 0;
  let totalRecommendationsApplied = 0;
  let totalFallbacksFilled = 0;
  const failures = [];
  const durations = [];
  const runStartTime = Date.now();

  let currentIndex = 0;
  async function worker(workerId) {
    while (true) {
      const idx = currentIndex++;
      if (idx >= targets.length) break;

      const item = targets[idx];
      const spuId = String(item.spuId);
      let page = pages[(workerId - 1) % pages.length];

      if (page.isClosed()) {
        page = await context.newPage();
        await page.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
        pages[(workerId - 1) % pages.length] = page;
      }

      let retries = 0;
      while (retries < 3) {
        try {
          const result = await processSingleSpu(page, item);
          durations.push(result.durationMs);

          if (result.status === 'updated') {
            updatedCount++;
            successCount++;
            totalCategoriesFilled += result.categoriesFilledCount;
            totalRecommendationsApplied += result.recommendationsAppliedCount;
            totalFallbacksFilled += result.fallbacksFilledCount;
          } else if (result.status === 'no_change') {
            noChangeCount++;
            successCount++;
          } else {
            failCount++;
            failures.push({ spuId, error: result.error, name: result.spuName });
          }
          break;
        } catch (err) {
          retries++;
          if (retries >= 3) {
            failCount++;
            failures.push({ spuId, error: err.message });
          } else {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }

      if ((idx + 1) % 10 === 0 || idx === targets.length - 1) {
        const elapsedSec = (Date.now() - runStartTime) / 1000;
        const rate = Math.round(((idx + 1) / elapsedSec) * 60);
        const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1));
        console.log(`[Progress ${idx + 1}/${targets.length}] Rate: ${rate} SPU/min | Avg: ${avgDuration}ms | Updated: ${updatedCount} | NoChange: ${noChangeCount} | Fail: ${failCount} (补类目:${totalCategoriesFilled}, 补属性:${totalFallbacksFilled})`);
      }

      await new Promise(r => setTimeout(r, 30));
    }
  }

  const workerPromises = [];
  for (let w = 1; w <= 12; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  const report = {
    generated_at: new Date().toISOString(),
    total_targets: targets.length,
    success_count: successCount,
    updated_count: updatedCount,
    no_change_count: noChangeCount,
    fail_count: failCount,
    total_categories_filled: totalCategoriesFilled,
    total_recommendations_applied: totalRecommendationsApplied,
    total_fallbacks_filled: totalFallbacksFilled,
    failures,
  };

  const reportFile = path.join(runDir, 'semantic_category_and_property_backfill_report.json');
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================ 渠道类目语义兜底与属性回填完毕 ================`);
  console.log(`总处理商品数：${targets.length}`);
  console.log(`成功更新商品数：${updatedCount}`);
  console.log(`补齐渠道类目数：${totalCategoriesFilled}`);
  console.log(`采纳官方推荐属性数：${totalRecommendationsApplied}`);
  console.log(`回填属性总数：${totalFallbacksFilled}`);
  console.log(`失败数：${failCount}`);
  console.log(`报告已保存至：${reportFile}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
