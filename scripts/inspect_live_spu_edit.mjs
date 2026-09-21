import { loadChromium } from './qnh_playwright_loader.mjs';

async function main() {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=1970033001098366994', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.locator('#basicInfo_spuName').waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const text = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const items = [];
    document.querySelectorAll('.unifiedGoods-ant-form-item').forEach(item => {
      const isReq = Boolean(item.querySelector('.unifiedGoods-ant-form-item-required'));
      const label = text(item.querySelector('label')?.innerText).replace(/[\s*：:]/g, '');
      const input = item.querySelector('input, textarea');
      const val = input ? (input.value || '') : '';
      const fullText = text(item.innerText);
      items.push({ label, isReq, val, fullText: fullText.slice(0, 150) });
    });

    const abnormalAlerts = [...document.querySelectorAll('[class*="alert"], [class*="abnormal"], [class*="error"], [class*="warning"]')]
      .map(el => text(el.innerText))
      .filter(t => t.length > 2 && t.length < 300);

    return {
      items,
      abnormalAlerts: Array.from(new Set(abnormalAlerts)).slice(0, 20)
    };
  });

  console.log('Total Form Items on Edit Page:', data.items.length);
  const emptyRequired = data.items.filter(i => i.isReq && !i.val.trim() && !i.fullText.includes('已选择') && !i.fullText.includes('已添加'));
  console.log('Empty Required Form Items:', JSON.stringify(emptyRequired, null, 2));
  console.log('All Form Items:', JSON.stringify(data.items, null, 2));
  console.log('Abnormal Alerts:', JSON.stringify(data.abnormalAlerts, null, 2));

  await page.close();
}

main().catch(console.error);
