import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('Connecting to QNH Chrome instance via CDP...');
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const qnhPage = context.pages().find(p => p.url().includes('qnh.meituan.com'));

  if (!qnhPage) {
    console.error('No QNH page found on port 9222!');
    process.exit(1);
  }

  console.log('Pulling all 596 渠道不可售 SPUs from QNH...');
  const res = await qnhPage.evaluate(async () => {
    let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.3.0';

    async function queryPage(p) {
      let headers = { 'Content-Type': 'application/json' };
      let body = JSON.stringify({ page: p, pageSize: 100, hasNoSaleAbnormal: 1 });
      let callUrl = url;
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url: callUrl, method: 'POST', data: body });
        Object.assign(headers, signed.headers || {});
        if (signed.url) callUrl = signed.url;
      }
      const resp = await fetch(callUrl, { method: 'POST', headers, body, credentials: 'include' });
      return await resp.json();
    }

    const first = await queryPage(1);
    const total = first.data?.total || 596;
    const pages = Math.ceil(total / 100);
    const all = [...(first.data?.list || [])];

    for (let p = 2; p <= pages; p++) {
      const next = await queryPage(p);
      all.push(...(next.data?.list || []));
    }

    return {
      total,
      spus: all.map(s => ({
        spuId: String(s.spuId),
        spuName: s.spuName,
        upc: s.upc || s.skus?.[0]?.upcList?.[0] || '',
        categoryCode: s.categoryCode,
        categoryName: s.categoryName
      }))
    };
  });

  console.log(`Successfully fetched ${res.spus.length} SPUs (total: ${res.total})!`);

  // Target run directory
  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  await fs.mkdir(runDir, { recursive: true });

  const targetFile = path.join(runDir, 'pending_spus_to_clean.json');
  await fs.writeFile(targetFile, JSON.stringify({ total: res.spus.length, spus: res.spus }, null, 2));
  console.log(`Saved to: ${targetFile}`);

  // Also save to Temp for backup
  await fs.writeFile('C:/Users/Administrator/AppData/Local/Temp/opencode/qnh_596_spus.json', JSON.stringify(res.spus, null, 2));

  process.exit(0);
}

main().catch(console.error);
