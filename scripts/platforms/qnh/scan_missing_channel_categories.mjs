import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('Connecting to Chrome via CDP...');
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('qnh.meituan.com') && !p.isClosed());
  if (!page) {
    page = await context.newPage();
    await page.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
  }

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  await fs.mkdir(runDir, { recursive: true });

  const pageSize = 100;
  console.log(`Querying first page to determine total SPUs...`);

  const initialRes = await page.evaluate(async (ps) => {
    let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
    let headers = { 'Content-Type': 'application/json' };
    let body = JSON.stringify({ page: 1, pageSize: ps });
    if (window.H5guard && typeof window.H5guard.sign === 'function') {
      const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
      Object.assign(headers, signed.headers || {});
      if (signed.url) url = signed.url;
    }
    const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
    return await resp.json();
  }, pageSize);

  const total = initialRes.data?.total || 38914;
  const totalPages = Math.ceil(total / pageSize);
  console.log(`Total SPUs: ${total}, Total pages: ${totalPages}`);

  const missingList = [];
  let totalScanned = 0;

  function analyzeRows(rows) {
    for (const r of rows) {
      totalScanned++;
      const spuId = String(r.spuId);
      const spuName = r.spuName || '';
      const upc = r.skus?.[0]?.upcList?.[0] || r.upc || '';
      const activeChannels = r.spuChannelInfoList || [];

      const emptyChannels = [];
      const presentChannels = {};
      for (const ch of activeChannels) {
        const cid = Number(ch.channelId);
        if (!ch.categoryCode || !ch.categoryName) {
          emptyChannels.push(cid);
        } else {
          presentChannels[cid] = {
            code: ch.categoryCode,
            name: ch.categoryName,
            path: ch.categoryNamePath
          };
        }
      }

      if (emptyChannels.length > 0) {
        missingList.push({
          spuId,
          spuName,
          upc,
          emptyChannels,
          presentChannels,
        });
      }
    }
  }

  // Analyze page 1
  analyzeRows(initialRes.data?.list || initialRes.data?.data || []);

  // Concurrent pagination
  let nextPage = 2;
  const pageConcurrency = 6;

  async function pageWorker(workerId) {
    while (true) {
      const p = nextPage++;
      if (p > totalPages) break;

      try {
        const res = await page.evaluate(async ({ pageNum, ps }) => {
          let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
          let headers = { 'Content-Type': 'application/json' };
          let body = JSON.stringify({ page: pageNum, pageSize: ps });
          if (window.H5guard && typeof window.H5guard.sign === 'function') {
            const signed = await window.H5guard.sign({ url, method: 'POST', data: body });
            Object.assign(headers, signed.headers || {});
            if (signed.url) url = signed.url;
          }
          const resp = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
          return await resp.json();
        }, { pageNum: p, ps: pageSize });

        const rows = res.data?.list || res.data?.data || [];
        analyzeRows(rows);

        if (p % 25 === 0 || p === totalPages) {
          console.log(`[Page ${p}/${totalPages}] Scanned: ${totalScanned}/${total} | Found with missing categories: ${missingList.length}`);
        }
      } catch (e) {
        console.error(`Page ${p} error:`, e.message);
      }
      await new Promise(r => setTimeout(r, 30));
    }
  }

  const workers = [];
  for (let i = 0; i < pageConcurrency; i++) {
    workers.push(pageWorker(i + 1));
  }
  await Promise.all(workers);

  console.log(`\n================ 扫描完毕 ================`);
  console.log(`总扫描商品数：${totalScanned}`);
  console.log(`存在渠道类目缺失的商品数：${missingList.length}`);

  const channelStats = {};
  missingList.forEach(item => {
    item.emptyChannels.forEach(cid => {
      channelStats[cid] = (channelStats[cid] || 0) + 1;
    });
  });
  console.log('缺失渠道分布:', channelStats);

  const outputFile = path.join(runDir, 'spus_with_missing_channel_categories.json');
  await fs.writeFile(outputFile, JSON.stringify({
    scanned_at: new Date().toISOString(),
    total_scanned: totalScanned,
    missing_count: missingList.length,
    channel_stats: channelStats,
    items: missingList
  }, null, 2), 'utf8');

  console.log(`详细清单已保存至：${outputFile}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
