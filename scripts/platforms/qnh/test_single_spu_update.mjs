import fs from 'node:fs/promises';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { fillProperty } from './required_property_rules.mjs';

const CDP_URL = 'http://127.0.0.1:9222';
const UPDATE_V2_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0';

async function main() {
  let details;
  try {
    details = JSON.parse(await fs.readFile('runs/qnh-run-1/details-canary-20-20.json', 'utf8'));
  } catch (err) {
    console.log('[SKIPPED] Test run data file not found:', err.message);
    return;
  }
  // SPU 3 is index 2 (2090806008330149898)
  const product = details.products[2];
  console.log('Testing SPU:', product.spu_id, 'Title:', product.title);

  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.log('[SKIPPED] Live CDP not connected:', err.message);
    return;
  }
  const context = browser.contexts()[0];
  if (!context) {
    console.log('[SKIPPED] No browser context found');
    await browser.close().catch(() => {});
    return;
  }
  const page = context.pages().find(p => p.url().includes('qnh.meituan.com'));
  if (!page) {
    console.log('[SKIPPED] No active qnh page found');
    await browser.close().catch(() => {});
    return;
  }

  try {
    const detail = JSON.parse(JSON.stringify(product.detail));
    let modifiedChannels = new Set();

    for (const ch of detail.spuChannelInfoList || []) {
      for (const prop of ch.categoryProperties || []) {
        if (prop.isRequired === 1) {
          const vals = (prop.customValue || []).filter(v => v && (v.attrValue || (v.structAttrValueList && v.structAttrValueList.length)));
          if (vals.length === 0) {
            const filled = fillProperty(prop, product.title);
            console.log('  Filling', prop.attrName, 'in channel', ch.channelId, '=>', JSON.stringify(filled));
            if (filled) {
              prop.customValue = filled;
              modifiedChannels.add(ch.channelId);
            }
          }
        }
      }
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

    console.log('Sending update to QNH with coverageRequest:', JSON.stringify(coverageRequest));

    const result = await page.evaluate(async ({ url, body }) => {
      const headers = { 'Content-Type': 'application/json' };
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url, method: 'POST', data: JSON.stringify(body) });
        Object.assign(headers, signed.headers || {});
        if (signed.url) url = signed.url;
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include'
      });
      return { status: resp.status, data: await resp.json() };
    }, { url: UPDATE_V2_URL, body: { tenantSpu: detail, coverageRequest } });

    console.log('Update response:', JSON.stringify(result, null, 2));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
