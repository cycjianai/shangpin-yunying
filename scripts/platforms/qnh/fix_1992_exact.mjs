import { loadChromium } from '../../qnh_playwright_loader.mjs';

const SPU_ID = '1992965618776891426';

async function main() {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const qnhPage = context.pages().find(p => p.url().includes('qnh.meituan.com'));

  const fixRes = await qnhPage.evaluate(async (spuId) => {
    let getUrl = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
    let headers = { 'Content-Type': 'application/json' };
    let body = JSON.stringify({ spuId });
    if (window.H5guard && typeof window.H5guard.sign === 'function') {
      const signed = await window.H5guard.sign({ url: getUrl, method: 'POST', data: body });
      Object.assign(headers, signed.headers || {});
      if (signed.url) getUrl = signed.url;
    }
    const resp = await fetch(getUrl, { method: 'POST', headers, body, credentials: 'include' });
    const r = await resp.json();
    const d = r.data || {};

    let modified = false;

    for (const ch of (d.spuChannelInfoList || [])) {
      for (const p of (ch.categoryProperties || [])) {
        const name = p.attrName || '';
        const isGiftAttr = /(?:赠|送|礼赠|礼品|礼袋|礼盒|杯子|开瓶器|餐具|吸管)/.test(name);

        if (isGiftAttr) {
          const opts = (p.attrValueList || p.optionList || []).map(o => ({
            id: String(o.attrValueId || o.optionId || o.id || ''),
            name: String(o.attrValue || o.optionValue || o.name || '').trim()
          }));

          // Look for any negative option (不赠 / 不送 / 无 / 否 / 普通包装)
          const negOpt = opts.find(o => /(?:不赠|不送|无|否|普通包装|环保包装|不提供)/.test(o.name));

          if (negOpt) {
            // Found a negative option -> MUST SELECT IT!
            p.customValue = [{
              attrValueId: negOpt.id,
              attrValue: negOpt.name,
              structAttrValueList: []
            }];
            modified = true;
          } else {
            // ALL options imply affirmative gifts -> MUST LEAVE EMPTY!
            p.customValue = [];
            modified = true;
          }
        }
      }
    }

    if (modified) {
      let updateUrl = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
      let updateHeaders = { 'Content-Type': 'application/json' };
      let updateBody = JSON.stringify({
        tenantSpu: d,
        coverageRequest: {
          fieldCoverageInfoList: [
            { field: 'mt_channel_category_property', coverToStore: 1 },
            { field: 'elm_channel_category_property', coverToStore: 1 },
            { field: 'jd_channel_category_property', coverToStore: 1 }
          ]
        }
      });
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url: updateUrl, method: 'POST', data: updateBody });
        Object.assign(updateHeaders, signed.headers || {});
        if (signed.url) updateUrl = signed.url;
      }
      const updateResp = await fetch(updateUrl, { method: 'POST', headers: updateHeaders, body: updateBody, credentials: 'include' });
      const updateResult = await updateResp.json();

      let pushUrl = 'https://qnh.meituan.com/qnh-gw5/api/v1/tenant/spu/generalMultiSelectPush?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
      let pushHeaders = { 'Content-Type': 'application/json' };
      let pushBody = JSON.stringify({ spuIds: [spuId] });
      if (window.H5guard && typeof window.H5guard.sign === 'function') {
        const signed = await window.H5guard.sign({ url: pushUrl, method: 'POST', data: pushBody });
        Object.assign(pushHeaders, signed.headers || {});
        if (signed.url) pushUrl = signed.url;
      }
      await fetch(pushUrl, { method: 'POST', headers: pushHeaders, body: pushBody, credentials: 'include' });

      return { ok: true, updateResult };
    }

    return { ok: true, modified: false };
  }, SPU_ID);

  console.log('Result for SPU 1992965618776891426:', fixRes);
  process.exit(0);
}

main().catch(console.error);
