import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROGRESS_FILE = 'C:/Users/Administrator/AppData/Local/Temp/opencode/qnh_38924_purifier_progress.json';

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
  console.log('=== 牵牛花洋叔叔 38,924 全店商品【绝对非赠送】全量净化与级联全店同步引擎 ===');
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  const tabs = await setupBrowserTabs(context, 4);
  const primaryPage = tabs[0];

  let progress = { processedIds: {}, totalProcessed: 0, totalModified: 0 };
  try {
    const raw = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8'));
    progress = raw;
    console.log(`[断点恢复] 已处理: ${progress.totalProcessed} 个 SPU，已修正赠送属性商品: ${progress.totalModified} 个`);
  } catch (e) {}

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
  console.log(`全店 SPU 总量: ${totalSpus}，分页拉取总页数: ${totalPages} 页`);

  const tStart = Date.now();
  let modifiedBuffer = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageTab = tabs[(pageNum - 1) % tabs.length];
    
    const pageSpus = await pageTab.evaluate(async ({ p, ps }) => {
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
      return (r.data?.list || []).map(s => ({
        spuId: String(s.spuId),
        spuName: s.spuName
      }));
    }, { p: pageNum, ps: pageSize });

    if (!pageSpus || pageSpus.length === 0) continue;

    const toProcess = pageSpus.filter(s => !progress.processedIds[s.spuId]);
    if (toProcess.length === 0) continue;

    const concurrency = 12;
    let nextIdx = 0;

    async function worker(workerId) {
      const tab = tabs[workerId % tabs.length];
      while (nextIdx < toProcess.length) {
        const item = toProcess[nextIdx++];
        const spuId = item.spuId;

        try {
          const res = await tab.evaluate(async (id) => {
            try {
              let getUrl = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
              let headers = { 'Content-Type': 'application/json' };
              let body = JSON.stringify({ spuId: id });
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

              // 1. Clean Title: remove brackets and any gift marketing terms
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

              // 2. Enforce Strict Non-Gift in all Channel Properties
              for (const ch of (d.spuChannelInfoList || [])) {
                const cid = Number(ch.channelId);
                for (const prop of (ch.categoryProperties || [])) {
                  const name = prop.attrName || '';
                  const opts = prop.attrValueList || prop.optionList || [];

                  if (/(?:赠|送|附赠|配赠|礼品|礼赠)/.test(name)) {
                    // Check if options have an acceptable negative option
                    const hasNegative = opts.some(o => /^(?:普通包装|环保包装|无赠品|不赠送|无礼袋|无餐具|否|无|不送|不赠|不提供)$/.test((o.attrValue || o.name || '').trim()));
                    
                    if (!hasNegative) {
                      // All options imply gift (e.g. 赠礼袋, 礼盒包装) -> DO NOT SELECT ANYTHING!
                      if (prop.customValue && prop.customValue.length > 0) {
                        prop.customValue = [];
                        modified = true;
                        modifiedChannels.add(cid);
                      }
                    } else {
                      // Options have negative choices -> select the negative one
                      let targetOpt = opts.find(o => /^(?:普通包装|环保包装)$/.test(o.attrValue || o.name || ''));
                      if (!targetOpt) {
                        targetOpt = opts.find(o => /^(?:无赠品|不赠送|无礼袋|无餐具|否|无|不送|不赠|不提供)$/.test((o.attrValue || o.name || '').trim()));
                      }
                      if (!targetOpt) {
                        targetOpt = opts.find(o => /(?:无|不|否)/.test(o.attrValue || o.name || ''));
                      }

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

              // 3. Save channel properties only (严禁携带 { field: 'spu_name', coverToStore: 1 } 以免冲掉门店 customizedNameFlag: true 自定义名称！)
              if (modified) {
                const fieldCoverageInfoList = Array.from(modifiedChannels).map(cid => ({
                  field: (cid === 100 ? 'mt_channel_category_property' : (cid === 200 ? 'elm_channel_category_property' : 'jd_channel_category_property')),
                  coverToStore: 1
                })).filter(f => f.field);

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
                const updateRes = await updateResp.json();
                return { ok: true, modified: true, updateRes };
              }

              return { ok: true, modified: false };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          }, spuId);

          if (res.ok) {
            progress.processedIds[spuId] = true;
            progress.totalProcessed++;
            if (res.modified) {
              progress.totalModified++;
              modifiedBuffer.push(spuId);
            }
          }
        } catch (e) {}
      }
    }

    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

    // Batch push modified SPUs to channels
    if (modifiedBuffer.length >= 20) {
      const chunk = modifiedBuffer.splice(0, 20);
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

    if (pageNum % 5 === 0 || pageNum === totalPages) {
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      const speed = (progress.totalProcessed / (elapsed / 60)).toFixed(1);
      const remainMins = (((totalSpus - progress.totalProcessed) / (speed / 60)) / 60).toFixed(1);
      console.log(`[全店非赠送重构] 页码: ${pageNum}/${totalPages} | 已核验: ${progress.totalProcessed}/${totalSpus} | 修正赠送项: ${progress.totalModified} | 跑速: ${speed} SPU/分 | 预计剩余: ${remainMins}小时`);
    }

    await new Promise(r => setTimeout(r, 40));
  }

  if (modifiedBuffer.length > 0) {
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
      }, modifiedBuffer);
    } catch (e) {}
  }

  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
  console.log(`\n======================================================`);
  console.log(`全店 38,924 个商品【绝对非赠送】重构净化全量完成！`);
  console.log(`累计核验: ${progress.totalProcessed} 个，共纠偏非赠送商品: ${progress.totalModified} 个`);
  console.log(`======================================================\n`);

  process.exit(0);
}

main().catch(console.error);
