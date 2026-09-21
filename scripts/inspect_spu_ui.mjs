import { loadChromium } from './qnh_playwright_loader.mjs';

async function main() {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-edit?id=1970033001098366994', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const analysis = await page.evaluate(() => {
    const emptyFormItems = [];
    const allLabels = [];
    document.querySelectorAll('.el-form-item').forEach(item => {
      const labelElem = item.querySelector('.el-form-item__label');
      const label = (labelElem?.innerText || '').replace(/[\s*：:]/g, '');
      const isRequired = item.classList.contains('is-required') || Boolean(labelElem?.querySelector('.is-required'));
      const text = item.innerText || '';
      const input = item.querySelector('input, textarea');
      const val = input ? (input.value || '') : '';
      allLabels.push({ label, isRequired, hasInput: Boolean(input), val: val.trim() });
      if (isRequired && !val.trim()) {
        emptyFormItems.push({ label, isRequired, text: text.slice(0, 100) });
      }
    });

    return {
      title: document.title,
      url: window.location.href,
      emptyFormItems,
      allLabels: allLabels.filter(l => l.label)
    };
  });

  console.log('Page Title:', analysis.title);
  console.log('Page URL:', analysis.url);
  console.log('Empty Required Form Items:', JSON.stringify(analysis.emptyFormItems, null, 2));
  console.log('All Form Items:', JSON.stringify(analysis.allLabels, null, 2));

  await page.close();
}

main().catch(console.error);
