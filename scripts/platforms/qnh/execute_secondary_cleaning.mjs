import fs from 'node:fs/promises';
import path from 'node:path';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { fillProperty, isPropertyValid } from './required_property_rules.mjs';

const CDP_URL = 'http://127.0.0.1:9222';
const UPDATE_V2_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0';

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const CONCURRENCY = parseInt(getArg('concurrency', '3'), 10);
const OFFSET = parseInt(getArg('offset', '520'), 10);

async function main() {
  const runDir = path.resolve('runs/qnh-run-1');
  const detailsPath = path.join(runDir, 'details-excel-2423-2423.json');
  const detailsData = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const allProducts = detailsData.products || [];

  console.log(`[二次清洗并发启动] 读取到商品总数：${allProducts.length}`);
  console.log(`[配置] 并发数: ${CONCURRENCY}, 起始偏移 Offset: ${OFFSET}`);

  // 1. 深度筛选：包含未填写 或 包含历史失效/无效候选值的商品
  const targets = [];
  for (const prod of allProducts) {
    const detail = prod.detail;
    if (!detail) continue;
    let needsUpdate = false;
    for (const ch of detail.spuChannelInfoList || []) {
      for (const prop of ch.categoryProperties || []) {
        if (prop.isRequired === 1) {
          if (!isPropertyValid(prop)) {
            needsUpdate = true;
            break;
          }
        }
      }
      if (needsUpdate) break;
    }
    if (needsUpdate) {
      targets.push(prod);
    }
  }

  console.log(`[二次清洗筛选] 共有 ${targets.length} 项商品存在缺失或历史失效必填属性`);
  console.log(`[执行区间] 本次从第 ${OFFSET + 1} 项执行至第 ${targets.length} 项（剩余 ${targets.length - OFFSET} 项，3 并发加速执行）...`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('qnh.meituan.com')) || context.pages()[0];

  let successCount = 0;
  let failCount = 0;
  let totalPropertiesFilled = 0;
  const failures = [];

  const startTime = Date.now();
  let nextIndex = OFFSET;
  let completedCount = 0;
  const totalToRun = targets.length - OFFSET;

  const worker = async (workerId) => {
    while (true) {
      const i = nextIndex++;
      if (i >= targets.length) break;

      const prod = targets[i];
      const spuId = prod.spu_id;
      const title = prod.title || '';
      const detail = JSON.parse(JSON.stringify(prod.detail));
      const modifiedChannels = new Set();
      const filledList = [];

      for (const ch of detail.spuChannelInfoList || []) {
        for (const prop of ch.categoryProperties || []) {
          if (prop.isRequired === 1) {
            if (!isPropertyValid(prop)) {
              const filled = fillProperty(prop, title);
              if (filled) {
                prop.customValue = filled;
                modifiedChannels.add(ch.channelId);
                filledList.push({
                  channelId: ch.channelId,
                  attrName: prop.attrName,
                  attrValueType: prop.attrValueType,
                  filled,
                });
              }
            }
          }
        }
      }

      if (filledList.length === 0) {
        completedCount++;
        continue;
      }

      const coverageRequest = {
        fieldCoverageInfoList: Array.from(modifiedChannels).map(chId => {
          let field = '';
          if (chId === 100) field = 'mt_channel_category_property';
          if (chId === 200) field = 'elm_channel_category_property';
          if (chId === 300) field = 'jd_channel_category_property';
          return { field, coverToStore: 1 };
        }).filter(f => f.field)
      };

      try {
        const response = await page.evaluate(async ({ url, body }) => {
          let reqUrl = url;
          const headers = { 'Content-Type': 'application/json' };
          if (window.H5guard && typeof window.H5guard.sign === 'function') {
            const signed = await window.H5guard.sign({ url: reqUrl, method: 'POST', data: JSON.stringify(body) });
            Object.assign(headers, signed.headers || {});
            if (signed.url) reqUrl = signed.url;
          }
          const resp = await fetch(reqUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'include',
          });
          return { status: resp.status, data: await resp.json() };
        }, { url: UPDATE_V2_URL, body: { tenantSpu: detail, coverageRequest } });

        const resData = response.data || {};
        const innerData = resData.data || {};

        if (response.status === 200 && resData.code === 0 && (innerData.errorCode === 0 || !innerData.errorCode)) {
          successCount++;
          totalPropertiesFilled += filledList.length;
        } else {
          failCount++;
          const errMsg = innerData.errorMsg || resData.msg || resData.message || '未知业务错误';
          failures.push({ spuId, title, error: errMsg, response: resData });
          console.error(`[失败] SPU: ${spuId} (${i + 1}/${targets.length}): ${errMsg}`);
        }
      } catch (err) {
        failCount++;
        failures.push({ spuId, title, error: err.message });
        console.error(`[异常] SPU: ${spuId} (${i + 1}/${targets.length}): ${err.message}`);
      }

      completedCount++;
      if (completedCount % 30 === 0 || completedCount === totalToRun) {
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        const overallProgress = OFFSET + completedCount;
        const speed = (completedCount / (Date.now() - startTime) * 1000).toFixed(1);
        console.log(`[3并发进度] 已处理 ${overallProgress}/${targets.length} (本轮: ${completedCount}/${totalToRun}, 成功: ${successCount}, 失败: ${failCount}, 速度: ${speed}件/秒, 耗时: ${elapsedSec}s)`);
      }

      await new Promise(r => setTimeout(r, 40));
    }
  };

  // 启动 3 并发 worker
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => worker(id)));

  const report = {
    generated_at: new Date().toISOString(),
    concurrency: CONCURRENCY,
    offset_resumed: OFFSET,
    total_targets: targets.length,
    resumed_run_targets: totalToRun,
    success_count: successCount,
    fail_count: failCount,
    total_properties_filled: totalPropertiesFilled,
    failures,
  };

  const reportPath = path.join(runDir, 'fill_required_properties_pass2_resumed_report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================= 二次清洗并发执行完毕 =================`);
  console.log(`总商品数：${targets.length}（前 520 项已完成，本轮处理 ${totalToRun} 项）`);
  console.log(`本轮成功：${successCount}`);
  console.log(`本轮失败：${failCount}`);
  console.log(`本轮补齐属性：${totalPropertiesFilled}`);
  console.log(`详细报告已保存至：${reportPath}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error in concurrent pass 2:', err);
    process.exit(1);
  });

