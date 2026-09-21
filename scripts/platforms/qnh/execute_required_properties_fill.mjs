import fs from 'node:fs/promises';
import path from 'node:path';
import { loadChromium } from '../../qnh_playwright_loader.mjs';
import { fillProperty } from './required_property_rules.mjs';

const CDP_URL = 'http://127.0.0.1:9222';
const UPDATE_V2_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.3.0';

async function main() {
  const runDir = path.resolve('runs/qnh-run-1');
  const detailsPath = path.join(runDir, 'details-excel-2423-2423.json');
  const detailsData = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const allProducts = detailsData.products || [];

  console.log(`[启动] 读取到商品总数：${allProducts.length}`);

  // 1. 筛选出存在必填属性缺失的商品
  const targets = [];
  for (const prod of allProducts) {
    const detail = prod.detail;
    if (!detail) continue;
    let needsUpdate = false;
    for (const ch of detail.spuChannelInfoList || []) {
      for (const prop of ch.categoryProperties || []) {
        if (prop.isRequired === 1) {
          const vals = (prop.customValue || []).filter(
            v => v && (v.attrValue || (v.structAttrValueList && v.structAttrValueList.length))
          );
          if (vals.length === 0) {
            needsUpdate = true;
            break;
          }
        }
      }
      if (needsUpdate) break;
    }
    if (needsUpdate) {
      targets.push(prod);
    }
  }

  console.log(`[筛选] 共有 ${targets.length} 项商品存在缺失的必填属性，准备开始批量修复...`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('qnh.meituan.com')) || context.pages()[0];

  let successCount = 0;
  let failCount = 0;
  let totalPropertiesFilled = 0;
  const failures = [];
  const results = [];

  const startTime = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const prod = targets[i];
    const spuId = prod.spu_id;
    const title = prod.title || '';
    const detail = JSON.parse(JSON.stringify(prod.detail));
    const modifiedChannels = new Set();
    const filledList = [];

    for (const ch of detail.spuChannelInfoList || []) {
      for (const prop of ch.categoryProperties || []) {
        if (prop.isRequired === 1) {
          const vals = (prop.customValue || []).filter(
            v => v && (v.attrValue || (v.structAttrValueList && v.structAttrValueList.length))
          );
          if (vals.length === 0) {
            const filled = fillProperty(prop, title);
            if (filled) {
              prop.customValue = filled;
              modifiedChannels.add(ch.channelId);
              filledList.push({
                channelId: ch.channelId,
                attrName: prop.attrName,
                attrValueType: prop.attrValueType,
                filled,
              });
            }
          }
        }
      }
    }

    if (filledList.length === 0) {
      continue;
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

    try {
      const response = await page.evaluate(async ({ url, body }) => {
        let reqUrl = url;
        const headers = { 'Content-Type': 'application/json' };
        if (window.H5guard && typeof window.H5guard.sign === 'function') {
          const signed = await window.H5guard.sign({ url: reqUrl, method: 'POST', data: JSON.stringify(body) });
          Object.assign(headers, signed.headers || {});
          if (signed.url) reqUrl = signed.url;
        }
        const resp = await fetch(reqUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include',
        });
        return { status: resp.status, data: await resp.json() };
      }, { url: UPDATE_V2_URL, body: { tenantSpu: detail, coverageRequest } });

      const resData = response.data || {};
      const innerData = resData.data || {};

      if (response.status === 200 && resData.code === 0 && (innerData.errorCode === 0 || !innerData.errorCode)) {
        successCount++;
        totalPropertiesFilled += filledList.length;
        results.push({
          spuId,
          title,
          status: 'success',
          filledPropertiesCount: filledList.length,
          filledList,
        });
      } else {
        failCount++;
        const errMsg = innerData.errorMsg || resData.msg || resData.message || '未知业务错误';
        failures.push({ spuId, title, error: errMsg, response: resData });
        console.error(`[失败] SPU: ${spuId} (${i + 1}/${targets.length}): ${errMsg}`);
      }
    } catch (err) {
      failCount++;
      failures.push({ spuId, title, error: err.message });
      console.error(`[异常] SPU: ${spuId} (${i + 1}/${targets.length}): ${err.message}`);
    }

    if ((i + 1) % 20 === 0 || i === targets.length - 1) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[进度] 已处理 ${i + 1}/${targets.length} (成功: ${successCount}, 失败: ${failCount}, 耗时: ${elapsedSec}s)`);
    }

    // 适度微延迟，保持网络与签名平稳
    await new Promise(r => setTimeout(r, 60));
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_targets: targets.length,
    success_count: successCount,
    fail_count: failCount,
    total_properties_filled: totalPropertiesFilled,
    failures,
  };

  const reportPath = path.join(runDir, 'fill_required_properties_report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n================= 执行完毕 =================`);
  console.log(`目标商品数：${targets.length}`);
  console.log(`成功保存数：${successCount}`);
  console.log(`失败数：${failCount}`);
  console.log(`累计补齐必填属性项：${totalPropertiesFilled}`);
  console.log(`详细报告已保存至：${reportPath}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

