import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { isPropertyValid, fillProperty, extractNumber } from './required_property_rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = {
    concurrency: 3,
    offset: 0,
    limit: null,
    spuId: null,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--concurrency=')) {
      args.concurrency = parseInt(arg.split('=')[1], 10) || 3;
    } else if (arg.startsWith('--offset=')) {
      args.offset = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--spu=')) {
      args.spuId = arg.split('=')[1];
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
  const spuId = String(spuItem.spu_id || spuItem.spuId || spuItem);

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
    return { spuId, status: 'error', error: detailRes.msg || 'Detail not found' };
  }

  const spuName = String(detail.spuName || '');
  const upc = String(detail.skuList?.[0]?.upc || '');
  const activeChannels = detail.spuChannelInfoList || [];
  const modifiedChannels = new Set();
  let categoriesFilledCount = 0;
  let recommendationsAppliedCount = 0;
  let fallbacksFilledCount = 0;

  // 2. Check if any active channel has empty category
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

    const channelCodeMap = {};
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
        channelCodeMap[String(cid)] = [{ channelCategoryId: rec.categoryId }];
        modifiedChannels.add(cid);
        categoriesFilledCount++;
      }
    }

    // Fetch category properties for newly set categories
    if (Object.keys(channelCodeMap).length > 0) {
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
      }, channelCodeMap);

      const propData = propBatchRes.data || {};
      for (const ch of activeChannels) {
        const chKey = String(ch.channelId);
        if (propData[chKey] && propData[chKey][0]) {
          ch.categoryProperties = propData[chKey][0].categoryProperties || [];
        }
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
              // Apply recommendation
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
        // Continue if recommendation query fails
      }
    }
  }

  // 4. Remaining Required Properties Fallback Fill
  // Check Meituan (100) facts for cross-channel inheritance
  const mtChannel = activeChannels.find(c => Number(c.channelId) === 100);
  const mtShelfProp = mtChannel?.categoryProperties?.find(p => p.attrName === '保质期');
  const mtShelfVal = mtShelfProp?.customValue?.[0]?.attrValue || '360天';

  for (const ch of activeChannels) {
    const cid = Number(ch.channelId);
    if (!ch.categoryProperties || ch.categoryProperties.length === 0) continue;

    for (const prop of ch.categoryProperties) {
      if (prop.isRequired === 1 && !isPropertyValid(prop)) {
        // Special case: 保质期 inheritance
        if (prop.attrName === '保质期') {
          if (String(prop.attrValueType) === '10') {
            const daysMatch = mtShelfVal.match(/(\d+)/);
            const days = daysMatch ? daysMatch[1] : '360';
            prop.customValue = [{
              attrValueId: null,
              attrValue: `${days}天`,
              douyinDiyType: null,
              structAttrValueList: [
                {
                  sequence: 1,
                  valueList: [{ value: String(days) }]
                },
                {
                  sequence: 2,
                  valueList: [{ value: '1' }] // 1 = 天
                }
              ]
            }];
            modifiedChannels.add(cid);
            fallbacksFilledCount++;
            continue;
          }
        }

        // Special case: 净含量 struct extraction
        if (prop.attrName === '净含量' && String(prop.attrValueType) === '10') {
          const m = spuName.match(/(\d+(?:\.\d+)?)\s*(g|克|kg|千克|ml|毫升|l|升)/i);
          const num = m ? m[1] : '500';
          const unit = m ? m[2].toLowerCase() : 'g';
          const unitId = (unit === 'kg' || unit === '千克' || unit === 'l' || unit === '升') ? '2' : '1';
          prop.customValue = [{
            attrValueId: null,
            attrValue: `${num}${unit}`,
            douyinDiyType: null,
            structAttrValueList: [
              {
                sequence: 1,
                valueList: [{ value: String(num) }]
              },
              {
                sequence: 2,
                valueList: [{ value: unitId }]
              }
            ]
          }];
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
          continue;
        }

        // General rule engine fill
        const filled = fillProperty(prop, spuName);
        if (filled) {
          prop.customValue = filled;
          modifiedChannels.add(cid);
          fallbacksFilledCount++;
        }
      }
    }
  }

  // 5. Save to QNH if modified
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
        error: updateRes.msg || 'Save failed',
        categoriesFilledCount,
        recommendationsAppliedCount,
        fallbacksFilledCount
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
    modifiedChannels: Array.from(modifiedChannels)
  };
}

async function main() {
  const args = parseArgs();
  console.log(`Starting category & recommendation cleaning with concurrency=${args.concurrency}, offset=${args.offset}, limit=${args.limit || 'all'}`);

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  const detailsFile = path.join(runDir, 'details-excel-2423-2423.json');
  const rawData = JSON.parse(await fs.readFile(detailsFile, 'utf8'));
  let targets = rawData.products || [];

  if (args.spuId) {
    targets = targets.filter(t => (t.spu_id || t.spuId || t) === args.spuId);
  } else {
    targets = targets.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  }

  console.log(`Target SPUs to process: ${targets.length}`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('qnh.meituan.com')) || context.pages()[0];

  let successCount = 0;
  let updatedCount = 0;
  let noChangeCount = 0;
  let failCount = 0;
  let totalCategoriesFilled = 0;
  let totalRecommendationsApplied = 0;
  let totalFallbacksFilled = 0;
  const failures = [];

  let currentIndex = 0;
  async function worker(workerId) {
    while (true) {
      const idx = currentIndex++;
      if (idx >= targets.length) break;

      const item = targets[idx];
      const spuId = item.spu_id || item.spuId || item;

      try {
        const result = await processSingleSpu(page, item);
        if (result.status === 'updated') {
          updatedCount++;
          successCount++;
          totalCategoriesFilled += result.categoriesFilledCount;
          totalRecommendationsApplied += result.recommendationsAppliedCount;
          totalFallbacksFilled += result.fallbacksFilledCount;
          console.log(`[Worker ${workerId}] [${idx + 1}/${targets.length}] SPU ${spuId} (${result.spuName?.slice(0, 20)}...) -> UPDATED (类目:${result.categoriesFilledCount}, 推荐属性:${result.recommendationsAppliedCount}, 兜底属性:${result.fallbacksFilledCount})`);
        } else if (result.status === 'no_change') {
          noChangeCount++;
          successCount++;
          console.log(`[Worker ${workerId}] [${idx + 1}/${targets.length}] SPU ${spuId} -> NO CHANGE`);
        } else {
          failCount++;
          failures.push({ spuId, error: result.error });
          console.error(`[Worker ${workerId}] [${idx + 1}/${targets.length}] SPU ${spuId} -> FAILED: ${result.error}`);
        }
      } catch (err) {
        failCount++;
        failures.push({ spuId, error: err.message });
        console.error(`[Worker ${workerId}] [${idx + 1}/${targets.length}] SPU ${spuId} -> ERROR: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 60));
    }
  }

  const workerPromises = [];
  for (let w = 1; w <= args.concurrency; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  const report = {
    generated_at: new Date().toISOString(),
    concurrency: args.concurrency,
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

  const reportPath = path.join(runDir, 'category_and_recommendation_report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================= 渠道类目与属性推荐优化执行完毕 =================`);
  console.log(`总商品数：${targets.length}`);
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
    console.error('Fatal error in cleaning:', err);
    process.exit(1);
  });
