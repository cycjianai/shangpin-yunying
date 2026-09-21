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
  const page = context.pages().find(p => p.url().includes('qnh.meituan.com')) || context.pages()[0];

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  await fs.mkdir(runDir, { recursive: true });

  const pageSize = 100;
  console.log(`Fetching full tenant SPU manifest (pageSize=${pageSize})...`);

  // 1. Initial query to get total
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
  console.log(`Total SPUs on platform: ${total}, total pages: ${totalPages}`);

  const allSpus = [];
  const firstRows = initialRes.data?.list || initialRes.data?.data || [];
  firstRows.forEach(r => allSpus.push({ spuId: String(r.spuId), spuName: r.spuName, upc: r.upc || r.skuList?.[0]?.upc || '' }));
  console.log(`[Page 1/${totalPages}] Loaded ${allSpus.length} SPUs.`);

  // 2. Fetch remaining pages with 5-page concurrency for speed
  let nextPage = 2;
  const pageConcurrency = 5;

  async function fetchWorker() {
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
        rows.forEach(r => allSpus.push({ spuId: String(r.spuId), spuName: r.spuName, upc: r.upc || r.skuList?.[0]?.upc || '' }));

        if (p % 20 === 0 || p === totalPages) {
          console.log(`[Page ${p}/${totalPages}] Total collected so far: ${allSpus.length} / ${total}`);
        }
      } catch (err) {
        console.error(`Error fetching page ${p}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 40));
    }
  }

  const workers = [];
  for (let i = 0; i < pageConcurrency; i++) {
    workers.push(fetchWorker());
  }
  await Promise.all(workers);

  console.log(`Finished collecting all SPUs. Total collected: ${allSpus.length}`);

  // Deduplicate against the 2,423 already processed
  const previousDetailsFile = path.join(runDir, 'details-excel-2423-2423.json');
  let processedSet = new Set();
  try {
    const prevData = JSON.parse(await fs.readFile(previousDetailsFile, 'utf8'));
    const prevList = prevData.products || [];
    prevList.forEach(p => processedSet.add(String(p.spu_id || p.spuId || p)));
    console.log(`Loaded ${processedSet.size} previously processed SPUs from details-excel-2423-2423.json`);
  } catch (e) {
    console.warn('Warning: Could not read previous details file for deduplication:', e.message);
  }

  // Filter out already processed
  const pendingSpus = allSpus.filter(s => !processedSet.has(s.spuId));
  console.log(`\n=== DEDUPLICATION SUMMARY ===`);
  console.log(`Total Master SPUs: ${allSpus.length}`);
  console.log(`Already Processed: ${processedSet.size}`);
  console.log(`New Pending SPUs:  ${pendingSpus.length}`);

  // Save all SPUs and pending SPUs
  const allSpusPath = path.join(runDir, 'all_tenant_spus_38914.json');
  await fs.writeFile(allSpusPath, JSON.stringify({ generated_at: new Date().toISOString(), total: allSpus.length, spus: allSpus }, null, 2), 'utf8');

  const pendingSpusPath = path.join(runDir, 'pending_spus_to_clean.json');
  await fs.writeFile(pendingSpusPath, JSON.stringify({ generated_at: new Date().toISOString(), total: pendingSpus.length, spus: pendingSpus }, null, 2), 'utf8');

  console.log(`Saved all SPUs to: ${allSpusPath}`);
  console.log(`Saved pending SPUs to: ${pendingSpusPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error dumping SPUs:', err);
    process.exit(1);
  });
