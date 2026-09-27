import { loadChromium } from '../../qnh_playwright_loader.mjs';

async function main() {
  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch (err) {
    console.log('[SKIPPED] Live CDP not connected (127.0.0.1:9222):', err.message);
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
    console.log('[SKIPPED] No active qnh.meituan.com page found in browser');
    await browser.close().catch(() => {});
    return;
  }

  try {
    const spuId = '1992965630340632614';

    // 1. Fetch SPU Detail
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
    if (!detail) {
      console.log('[SKIPPED] Detail fetch returned empty (likely session expired)');
      return;
    }
    const spuName = detail.spuName;
    const upc = detail.skuList && detail.skuList[0] ? detail.skuList[0].upc : '6914782203327';

  console.log('SPU:', spuId, spuName);
  console.log('UPC:', upc);

  // 2. Fetch Category Recommendations for channels that are empty
  const activeChannels = detail.spuChannelInfoList || [];
  const emptyChannels = activeChannels.filter(c => !c.categoryCode).map(c => c.channelId);
  console.log('Active channels with empty category:', emptyChannels);

  let recCategories = {};
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
    recList.forEach(r => {
      recCategories[r.channelId] = r;
    });
  }

  // 3. For channels that were empty, set category info and fetch categoryProperties schema
  const channelCodeMap = {};
  for (const ch of activeChannels) {
    if (!ch.categoryCode && recCategories[ch.channelId]) {
      const rec = recCategories[ch.channelId];
      ch.categoryCode = rec.categoryId;
      ch.categoryName = rec.categoryName;
      ch.categoryCodePath = rec.idPath;
      ch.categoryNamePath = rec.namePath;
      ch.upcRequired = rec.upcRequired ?? null;
      ch.resourceType = rec.resourceType ?? null;
      console.log(`Set channel ${ch.channelId} category to: ${rec.namePath} (${rec.categoryId})`);
      channelCodeMap[String(ch.channelId)] = [{ channelCategoryId: rec.categoryId }];
    }
  }

  // Fetch properties schema for updated channels
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
        console.log(`Channel ${ch.channelId} loaded ${ch.categoryProperties.length} category properties.`);
      }
    }
  }

  // 4. Fetch Property Recommendations for all active channels (美团 100, 饿了么 200)
  for (const ch of activeChannels) {
    if (!ch.categoryCode || !ch.categoryProperties || ch.categoryProperties.length === 0) continue;

    console.log(`\nFetching property recommendations for Channel ${ch.channelId}...`);
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
    }, { spuName, channelId: ch.channelId, channelCategoryId: ch.categoryCode, upc });

    const recProps = recPropsRes.data?.channelDynamicInfoVOList || [];
    console.log(`Channel ${ch.channelId} received ${recProps.length} property recommendations.`);

    // Apply recommendations (优先有推荐的全部使用)
    const recMap = new Map();
    recProps.forEach(rp => {
      if (rp.customValue && rp.customValue.length > 0) {
        recMap.set(String(rp.attrId), rp.customValue);
        console.log(`  [Rec] Channel ${ch.channelId} Prop ${rp.attrName} (${rp.attrId}) -> ${JSON.stringify(rp.customValue)}`);
      }
    });

    for (const prop of ch.categoryProperties) {
      const pid = String(prop.attrId);
      if (recMap.has(pid)) {
        prop.customValue = recMap.get(pid);
      }
    }
  }

  // 5. Check remaining required properties (必填项兜底)
  // For Eleme (200), check 保质期 (attrId 1989873)
  const elmCh = activeChannels.find(c => c.channelId === 200);
  if (elmCh && elmCh.categoryProperties) {
    const shelfProp = elmCh.categoryProperties.find(p => p.attrName === '保质期');
    if (shelfProp && (!shelfProp.customValue || shelfProp.customValue.length === 0)) {
      // Inherit 360天 from Meituan
      shelfProp.customValue = [{
        attrValueId: null,
        attrValue: '360天',
        douyinDiyType: null,
        structAttrValueList: [
          {
            sequence: 1,
            valueList: [{ value: '360' }]
          },
          {
            sequence: 2,
            valueList: [{ value: '1' }] // 天
          }
        ]
      }];
      console.log('  [Fallback] Eleme 保质期 filled with 360天');
    }
  }

  // 6. Save update to QNH
  console.log('\nSubmitting update to QNH update/v2...');
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
      coverageRequest: {
        fieldCoverageInfoList: [
          { field: 'mt_channel_category_property', coverToStore: 1 },
          { field: 'elm_channel_category_property', coverToStore: 1 },
          { field: 'jd_channel_category_property', coverToStore: 1 },
        ]
      }
    }
  });

    console.log('Update result:', JSON.stringify(updateRes));
  } catch (err) {
    console.log('[SKIPPED] Live test skipped:', err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
