import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { isPropertyValid, fillProperty } from './required_property_rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DETAIL_IMAGES = [
  'https://img.meituan.net/sgfn/6f244c5f3cb8b26399bbf31116c40de81422507.png',
  'https://img.meituan.net/sgfn/064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png'
];

function parseArgs() {
  const args = {
    concurrency: 12,
    tabs: 4,
    offset: 0,
    limit: null,
    source: '2423', // '2423' or 'checkpoint' or 'all'
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--concurrency=')) {
      args.concurrency = parseInt(arg.split('=')[1], 10) || 12;
    } else if (arg.startsWith('--tabs=')) {
      args.tabs = parseInt(arg.split('=')[1], 10) || 4;
    } else if (arg.startsWith('--offset=')) {
      args.offset = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--source=')) {
      args.source = arg.split('=')[1];
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

async function processSingleSpu(page, spuId) {
  const startTime = Date.now();

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
  const upc = String(detail.skuList?.[0]?.upc || '');
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

  // 3. Official Property Recommendations (美团 100, 饿了么 200) - 优先点掉全部推荐 (含非必填)
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

  // 3.5 Detail Images Check & Fill (若详情图为空，自动补齐2张标准合规详情图)
  let detailImagesFilled = false;
  if (!detail.picContentList || detail.picContentList.length === 0) {
    detail.picContentList = [...DEFAULT_DETAIL_IMAGES];
    detailImagesFilled = true;
  }

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

        // 通用规则引擎 (含 包装方式, 是否有机, 国产/进口, 储藏条件 等语义推导)
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
  if (modifiedChannels.size > 0 || detailImagesFilled) {
    const fieldCoverageInfoList = Array.from(modifiedChannels).map(cid => ({
      field: coverageField(cid),
      coverToStore: 1,
    })).filter(f => f.field);

    if (detailImagesFilled) {
      fieldCoverageInfoList.push({ field: 'picture', coverToStore: 1 });
    }

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
    await p.waitForTimeout(1500);
    pages.push(p);
  }

  console.log(`Ready with ${pages.length} tabs.`);
  return pages.slice(0, count);
}

async function main() {
  const args = parseArgs();
  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');

  // Load targets
  let targets = [];
  if (args.source === '2423' || args.source === 'all') {
    const detailsFile2423 = path.join(runDir, 'details-excel-2423-2423.json');
    const raw2423 = JSON.parse(await fs.readFile(detailsFile2423, 'utf8'));
    const spus2423 = (raw2423.products || []).map(p => p.spu_id || p.detail?.spuId).filter(Boolean);
    targets.push(...spus2423);
  }

  if (args.source === 'first12704') {
    const firstFile = path.join(runDir, 'first_batch_12704_spus.json');
    try {
      const raw = JSON.parse(await fs.readFile(firstFile, 'utf8'));
      targets.push(...(raw.spu_ids || []));
    } catch (e) {}
  }

  if (args.source === 'checkpoint' || args.source === 'all') {
    const cpFile = path.join(runDir, 'mass_cleaning_checkpoint.json');
    try {
      const cpData = JSON.parse(await fs.readFile(cpFile, 'utf8'));
      const cpSpus = cpData.processed_spu_ids || [];
      targets.push(...cpSpus);
    } catch (e) {}
  }

  targets = Array.from(new Set(targets));

  // Checkpoint support
  const cpFile = path.join(runDir, `reclean_${args.source}_checkpoint.json`);
  let processedSpuSet = new Set();
  let successCount = 0;
  let updatedCount = 0;
  let noChangeCount = 0;
  let failCount = 0;
  let totalCategoriesFilled = 0;
  let totalRecommendationsApplied = 0;
  let totalFallbacksFilled = 0;
  let totalDetailImagesFilled = 0;
  const failures = [];

  try {
    const cpRaw = JSON.parse(await fs.readFile(cpFile, 'utf8'));
    if (cpRaw.processed_spu_ids) {
      processedSpuSet = new Set(cpRaw.processed_spu_ids.map(String));
      successCount = cpRaw.success_count || 0;
      updatedCount = cpRaw.updated_count || 0;
      noChangeCount = cpRaw.no_change_count || 0;
      failCount = cpRaw.fail_count || 0;
      totalCategoriesFilled = cpRaw.total_categories_filled || 0;
      totalRecommendationsApplied = cpRaw.total_recommendations_applied || 0;
      totalFallbacksFilled = cpRaw.total_fallbacks_filled || 0;
      totalDetailImagesFilled = cpRaw.total_detail_images_filled || 0;
      if (cpRaw.failures) failures.push(...cpRaw.failures);
      console.log(`[Checkpoint] 发现已存在断点记录，已处理 ${processedSpuSet.size} 个 SPU，自动续跑...`);
    }
  } catch (e) {}

  if (processedSpuSet.size > 0) {
    targets = targets.filter(id => !processedSpuSet.has(String(id)));
  }

  if (args.limit) {
    targets = targets.slice(args.offset, args.offset + args.limit);
  } else if (args.offset > 0) {
    targets = targets.slice(args.offset);
  }

  console.log(`================ 历史跑过 SPU 全量回填重扫启动 ================`);
  console.log(`数据源：${args.source} | 待重扫商品数：${targets.length} | 并发：${args.concurrency} | 标签页：${args.tabs}`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = await setupBrowserTabs(context, args.tabs);

  const durations = [];
  const runStartTime = Date.now();

  let saveTimer = null;
  const saveCheckpoint = async () => {
    try {
      const data = {
        updated_at: new Date().toISOString(),
        source: args.source,
        processed_spu_ids: Array.from(processedSpuSet),
        success_count: successCount,
        updated_count: updatedCount,
        no_change_count: noChangeCount,
        fail_count: failCount,
        total_categories_filled: totalCategoriesFilled,
        total_recommendations_applied: totalRecommendationsApplied,
        total_fallbacks_filled: totalFallbacksFilled,
        total_detail_images_filled: totalDetailImagesFilled,
        failures: failures.slice(-50),
      };
      await fs.writeFile(cpFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
  };

  let currentIndex = 0;
  async function worker(workerId) {
    while (true) {
      const idx = currentIndex++;
      if (idx >= targets.length) break;

      const spuId = String(targets[idx]);
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
          const result = await processSingleSpu(page, spuId);
          durations.push(result.durationMs);

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
            failures.push({ spuId, error: err.message });
          } else {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }

      processedSpuSet.add(spuId);

      // Periodic checkpoint saving
      if (processedSpuSet.size % 20 === 0) {
        saveCheckpoint().catch(() => {});
      }

      // Live progress
      if ((idx + 1) % 10 === 0 || idx === targets.length - 1) {
        const elapsedSec = (Date.now() - runStartTime) / 1000;
        const rate = Math.round(((idx + 1) / elapsedSec) * 60);
        const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1));
        console.log(`[Progress ${idx + 1}/${targets.length}] Rate: ${rate} SPU/min | Avg: ${avgDuration}ms | Updated: ${updatedCount} | NoChange: ${noChangeCount} | Fail: ${failCount} (补类目:${totalCategoriesFilled}, 补图:${totalDetailImagesFilled}, 补属性:${totalFallbacksFilled})`);
      }

      await new Promise(r => setTimeout(r, 40));
    }
  }

  const workerPromises = [];
  for (let w = 1; w <= args.concurrency; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  const report = {
    generated_at: new Date().toISOString(),
    source: args.source,
    total_targets: targets.length,
    success_count: successCount,
    updated_count: updatedCount,
    no_change_count: noChangeCount,
    fail_count: failCount,
    total_categories_filled: totalCategoriesFilled,
    total_recommendations_applied: totalRecommendationsApplied,
    total_fallbacks_filled: totalFallbacksFilled,
    total_detail_images_filled: totalDetailImagesFilled,
    failures,
  };

  const reportFile = path.join(runDir, `reclean_previous_${args.source}_report.json`);
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================ 历史跑过商品全量回填重扫完毕 ================`);
  console.log(`总处理商品数：${targets.length}`);
  console.log(`成功更新商品数：${updatedCount}`);
  console.log(`无需改动商品数：${noChangeCount}`);
  console.log(`失败数：${failCount}`);
  console.log(`补齐渠道类目数：${totalCategoriesFilled}`);
  console.log(`采纳官方推荐数：${totalRecommendationsApplied}`);
  console.log(`回填补齐属性数：${totalFallbacksFilled}`);
  console.log(`补齐详情图片数：${totalDetailImagesFilled}`);
  console.log(`详细报告已保存至：${reportFile}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
