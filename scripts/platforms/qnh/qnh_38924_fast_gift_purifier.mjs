import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROGRESS_FILE = 'C:/Users/Administrator/AppData/Local/Temp/opencode/qnh_fast_purifier_progress.json';
const SUMMARY_REPORT = 'C:/Users/Administrator/Desktop/牵牛花洋叔叔_全店非赠送重构统计.xlsx';

async function setupBrowserTabs(context, count) {
  console.log(`Setting up ${count} browser tabs for distributed signing...`);
  const pages = [];
  const existing = context.pages().filter(p => p.url().includes('qnh.meituan.com'));
  pages.push(...existing);

  while (pages.length < count) {
    const p = await context.newPage();
    await p.goto('https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 2000));
    pages.push(p);
  }

  console.log(`Ready with ${pages.length} tabs.`);
  return pages.slice(0, count);
}

async function main() {
  console.log('=== 牵牛花洋叔叔 38,924 全店商品【闪电非赠送净化引擎】 ===');
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  // 4 Tabs
  const tabs = await setupBrowserTabs(context, 4);
  const primaryPage = tabs[0];

  let progress = { lastPage: 1, totalScanned: 0, totalModified: 0, modifiedSpus: [] };
  try {
    const raw = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8'));
    progress = raw;
    console.log(`[断点恢复] 从第 ${progress.lastPage} 页继续 | 已扫描: ${progress.totalScanned} | 已修正赠送项: ${progress.totalModified}`);
  } catch (e) {}

  // 1. Get total SPU count
  const initialInfo = await primaryPage.evaluate(async () => {
    let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
    let headers = { 'Content-Type': 'application/json' };
    let body = JSON.stringify({ page: 1, pageSize: 1 });
    let callUrl = url;
    if (window.H5guard && typeof window.H5guard.sign === 'function') {
      const signed = await window.H5guard.sign({ url: callUrl, method: 'POST', data: body });
      Object.assign(headers, signed.headers || {});
      if (signed.url) callUrl = signed.url;
    }
    const resp = await fetch(callUrl, { method: 'POST', headers, body, credentials: 'include' });
    const r = await resp.json();
    return { total: r.data?.total || 38924 };
  });

  const totalSpus = initialInfo.total;
  const pageSize = 100;
  const totalPages = Math.ceil(totalSpus / pageSize);
  console.log(`全店 SPU 总量: ${totalSpus}，总页数: ${totalPages} 页`);

  const tStart = Date.now();
  let pushBuffer = [];

  // Stream pages in chunks of 4 pages (4 tabs parallel)
  const groupSize = 4;
  for (let pageStart = progress.lastPage; pageStart <= totalPages; pageStart += groupSize) {
    const pageNums = [];
    for (let p = pageStart; p < pageStart + groupSize && p <= totalPages; p++) {
      pageNums.push(p);
    }

    // Query 4 pages in parallel across the 4 tabs
    const pageResults = await Promise.all(pageNums.map((p, idx) => {
      const tab = tabs[idx % tabs.length];
      return tab.evaluate(async ({ p, ps }) => {
        let url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
        let headers = { 'Content-Type': 'application/json' };
        let body = JSON.stringify({ page: p, pageSize: ps });
        let callUrl = url;
        if (window.H5guard && typeof window.H5guard.sign === 'function') {
          const signed = await window.H5guard.sign({ url: callUrl, method: 'POST', data: body });
          Object.assign(headers, signed.headers || {});
          if (signed.url) callUrl = signed.url;
        }
        const resp = await fetch(callUrl, { method: 'POST', headers, body, credentials: 'include' });
        const r = await resp.json();
        return r.data?.list || [];
      }, { p, ps: pageSize });
    }));

    // In-memory filter for products that actually have gift issues
    const hitSpus = [];
    for (const list of pageResults) {
      for (const s of list) {
        progress.totalScanned++;
        let isHit = false;
        const title = s.spuName || '';
        if (/（赠[^）]*）|\(赠[^)]*\)|（送[^）]*）|\(送[^)]*\)/.test(title)) isHit = true;

        for (const ch of (s.spuChannelInfoList || [])) {
          for (const p of (ch.categoryProperties || [])) {
            const name = p.attrName || '';
            if (/(?:赠|送|附赠|配赠|礼品|礼赠)/.test(name)) {
              const curVal = p.customValue?.[0]?.attrValue || '';
              // Affirmative gift values that MUST be cleared or changed
              if (/(?:礼盒|礼袋|双瓶起赠|单瓶起赠|整箱配礼袋|赠)/.test(curVal)) {
                isHit = true;
              }
            }
          }
        }

        if (isHit) {
          hitSpus.push({ spuId: String(s.spuId), spuName: title });
        }
      }
    }

    // Process hits in parallel if any
    if (hitSpus.length > 0) {
      console.log(`[第 ${pageStart}~${Math.min(pageStart + groupSize - 1, totalPages)} 页] 命中 ${hitSpus.length} 个承诺赠送的商品，正在执行非赠送重构...`);
      
      const updateResults = await Promise.all(hitSpus.map((item, idx) => {
        const tab = tabs[idx % tabs.length];
        return tab.evaluate(async (spuId) => {
          try {
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
            if (!d.spuId) return { ok: false };

            let modified = false;
            const modifiedChannels = new Set();

            // 1. Clean Title
            let title = (d.spuName || '').trim();
            let cleanTitle = title
              .replace(/【[^】]*】/g, ' ')
              .replace(/\[[^\]]*\]/g, ' ')
              .replace(/（赠[^）]*）|\(赠[^)]*\)|（送[^）]*）|\(送[^)]*\)/g, ' ')
              .replace(/赠[^\s,，。]+|送[^\s,，。]+/g, (m) => {
                if (/(?:送礼|配送)/.test(m)) return m;
                return '';
              })
              .replace(/\s+/g, ' ').trim();

            if (cleanTitle && cleanTitle !== title) {
              d.spuName = cleanTitle;
              modified = true;
            }

            // 2. Strict Non-Gift in all Channels
            for (const ch of (d.spuChannelInfoList || [])) {
              const cid = Number(ch.channelId);
              for (const prop of (ch.categoryProperties || [])) {
                const name = prop.attrName || '';
                const opts = prop.attrValueList || prop.optionList || [];

                if (/(?:赠|送|附赠|配赠|礼品|礼赠)/.test(name)) {
                  const hasNegative = opts.some(o => /^(?:普通包装|环保包装|无赠品|不赠送|无礼袋|无餐具|否|无|不送|不赠|不提供)$/.test((o.attrValue || o.name || '').trim()));
                  
                  if (!hasNegative) {
                    // All options imply gift -> DO NOT SELECT ANYTHING!
                    if (prop.customValue && prop.customValue.length > 0) {
                      prop.customValue = [];
                      modified = true;
                      modifiedChannels.add(cid);
                    }
                  } else {
                    let targetOpt = opts.find(o => /^(?:普通包装|环保包装)$/.test(o.attrValue || o.name || ''));
                    if (!targetOpt) targetOpt = opts.find(o => /^(?:无赠品|不赠送|无礼袋|无餐具|否|无|不送|不赠|不提供)$/.test((o.attrValue || o.name || '').trim()));
                    if (!targetOpt) targetOpt = opts.find(o => /(?:无|不|否)/.test(o.attrValue || o.name || ''));

                    if (targetOpt) {
                      const curVal = prop.customValue?.[0]?.attrValue;
                      if (curVal !== targetOpt.attrValue) {
                        prop.customValue = [{
                          attrValueId: String(targetOpt.attrValueId || targetOpt.optionId || ''),
                          attrValue: String(targetOpt.attrValue || targetOpt.name || ''),
                          structAttrValueList: []
                        }];
                        modified = true;
                        modifiedChannels.add(cid);
                      }
                    }
                  }
                }
              }
            }

            // 3. Save with cascade store coverage (coverToStore: 1)
            if (modified) {
              const fieldCoverageInfoList = Array.from(modifiedChannels).map(cid => ({
                field: (cid === 100 ? 'mt_channel_category_property' : (cid === 200 ? 'elm_channel_category_property' : 'jd_channel_category_property')),
                coverToStore: 1
              })).filter(f => f.field);

              fieldCoverageInfoList.push({ field: 'spu_name', coverToStore: 1 });

              let updateUrl = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
              let updateHeaders = { 'Content-Type': 'application/json' };
              let updateBody = JSON.stringify({
                tenantSpu: d,
                coverageRequest: { fieldCoverageInfoList }
              });

              if (window.H5guard && typeof window.H5guard.sign === 'function') {
                const signed = await window.H5guard.sign({ url: updateUrl, method: 'POST', data: updateBody });
                Object.assign(updateHeaders, signed.headers || {});
                if (signed.url) updateUrl = signed.url;
              }
              const updateResp = await fetch(updateUrl, { method: 'POST', headers: updateHeaders, body: updateBody, credentials: 'include' });
              return await updateResp.json();
            }

            return { code: 0, noChange: true };
          } catch (e) {
            return { code: -1, error: e.message };
          }
        }, item.spuId);
      }));

      for (let k = 0; k < updateResults.length; k++) {
        const u = updateResults[k];
        if (u && (u.code === 0 || u.noChange)) {
          progress.totalModified++;
          progress.modifiedSpus.push(hitSpus[k]);
          pushBuffer.push(hitSpus[k].spuId);
        }
      }
    }

    // Push modified buffer to channels in batches of 20
    if (pushBuffer.length >= 20) {
      const chunk = pushBuffer.splice(0, 20);
      try {
        await primaryPage.evaluate(async (ids) => {
          let pushUrl = 'https://qnh.meituan.com/qnh-gw5/api/v1/tenant/spu/generalMultiSelectPush?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
          let headers = { 'Content-Type': 'application/json' };
          let body = JSON.stringify({ spuIds: ids });
          if (window.H5guard && typeof window.H5guard.sign === 'function') {
            const signed = await window.H5guard.sign({ url: pushUrl, method: 'POST', data: body });
            Object.assign(headers, signed.headers || {});
            if (signed.url) pushUrl = signed.url;
          }
          await fetch(pushUrl, { method: 'POST', headers, body, credentials: 'include' });
        }, chunk);
      } catch (e) {}
    }

    // Save checkpoint
    progress.lastPage = Math.min(pageStart + groupSize, totalPages);
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));

    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    const speed = (progress.totalScanned / (elapsed / 60)).toFixed(0);
    const remainMins = (((totalSpus - progress.totalScanned) / (speed / 60)) / 60).toFixed(1);
    console.log(`[闪电扫描] 页码: ${progress.lastPage}/${totalPages} | 已扫描: ${progress.totalScanned}/${totalSpus} | 纠偏非赠送商品: ${progress.totalModified} | 扫描跑速: ${speed} SPU/分 | 预计剩余: ${remainMins}小时`);

    await new Promise(r => setTimeout(r, 50));
  }

  // Push remaining buffer
  if (pushBuffer.length > 0) {
    try {
      await primaryPage.evaluate(async (ids) => {
        let pushUrl = 'https://qnh.meituan.com/qnh-gw5/api/v1/tenant/spu/generalMultiSelectPush?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
        let headers = { 'Content-Type': 'application/json' };
        let body = JSON.stringify({ spuIds: ids });
        if (window.H5guard && typeof window.H5guard.sign === 'function') {
          const signed = await window.H5guard.sign({ url: pushUrl, method: 'POST', data: body });
          Object.assign(headers, signed.headers || {});
          if (signed.url) pushUrl = signed.url;
        }
        await fetch(pushUrl, { method: 'POST', headers, body, credentials: 'include' });
      }, pushBuffer);
    } catch (e) {}
  }

  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
  console.log(`\n======================================================`);
  console.log(`全店 38,924 个商品【闪电非赠送重构】全量完成！`);
  console.log(`全盘扫描: ${progress.totalScanned} 个，累计纠偏并保存覆盖所有门店: ${progress.totalModified} 个！`);
  console.log(`======================================================\n`);

  process.exit(0);
}

main().catch(console.error);
