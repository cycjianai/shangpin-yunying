import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadChromium } from '../../qnh_playwright_loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = {
    concurrency: 6,
    targetFile: null,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--concurrency=')) {
      args.concurrency = parseInt(arg.split('=')[1], 10) || 6;
    } else if (arg.startsWith('--targetFile=')) {
      args.targetFile = arg.split('=')[1];
    }
  }
  return args;
}

async function patchSingleSpu(page, spuId) {
  // 1. Fetch live detail
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
  if (!detail || !detail.spuId) {
    return { spuId, status: 'error', error: detailRes.msg || 'Detail not found' };
  }

  // Check if detail images are empty
  if (detail.picContentList && detail.picContentList.length > 0) {
    return { spuId, status: 'already_has_images', count: detail.picContentList.length };
  }

  // 图片原值与门店自定义保护铁律：
  // 1. 严禁注入通用说明占位图，仅允许原样复用当前商品自身已有主图 detail.picUrlList；
  // 2. 严禁发送 { field: 'picture', coverToStore: 1 }（会冲掉自定义门店的 customizedPicFlag: true 主图！仅允许 coverToStore: 2）
  const ownMainPics = Array.isArray(detail.picUrlList) ? detail.picUrlList.filter(Boolean) : [];
  if (ownMainPics.length === 0) {
    return { spuId, status: 'skipped_no_own_main_images' };
  }
  detail.picContentList = [...ownMainPics.slice(0, 5)];

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
        fieldCoverageInfoList: [{ field: 'picture', coverToStore: 2 }]
      }
    }
  });

  if (updateRes.code !== 0) {
    return { spuId, status: 'fail', error: updateRes.msg || updateRes.message || 'Update failed' };
  }

  return { spuId, status: 'patched' };
}

async function main() {
  const args = parseArgs();
  console.log(`Starting detail images patcher with concurrency=${args.concurrency}`);

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  
  // Extract all candidate SPUs:
  // 1. From 2423 list
  const detailsFile2423 = path.join(runDir, 'details-excel-2423-2423.json');
  const raw2423 = JSON.parse(await fs.readFile(detailsFile2423, 'utf8'));
  const candidatesFrom2423 = (raw2423.products || [])
    .filter(p => !p.detail?.picContentList || p.detail.picContentList.length === 0)
    .map(p => p.spu_id || p.detail?.spuId);

  // 2. From checkpoint
  const cpFile = path.join(runDir, 'mass_cleaning_checkpoint.json');
  let candidatesFromCp = [];
  try {
    const cpData = JSON.parse(await fs.readFile(cpFile, 'utf8'));
    candidatesFromCp = cpData.processed_spu_ids || [];
  } catch (e) {}

  const allTargetSpus = Array.from(new Set([...candidatesFrom2423, ...candidatesFromCp]));
  console.log(`Total candidate SPUs to check/patch: ${allTargetSpus.length} (From 2423: ${candidatesFrom2423.length}, From CP: ${candidatesFromCp.length})`);

  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages().filter(p => p.url().includes('qnh.meituan.com'));
  const page = pages[0] || context.pages()[0];

  let patchedCount = 0;
  let alreadyHasCount = 0;
  let failCount = 0;

  let currentIndex = 0;
  async function worker(workerId) {
    while (true) {
      const idx = currentIndex++;
      if (idx >= allTargetSpus.length) break;
      const spuId = allTargetSpus[idx];
      try {
        const res = await patchSingleSpu(page, spuId);
        if (res.status === 'patched') {
          patchedCount++;
          console.log(`[Worker ${workerId}] [${idx + 1}/${allTargetSpus.length}] SPU ${spuId} -> PATCHED DETAIL IMAGES`);
        } else if (res.status === 'already_has_images') {
          alreadyHasCount++;
        } else {
          failCount++;
          console.error(`[Worker ${workerId}] [${idx + 1}/${allTargetSpus.length}] SPU ${spuId} -> FAILED: ${res.error}`);
        }
      } catch (err) {
        failCount++;
        console.error(`[Worker ${workerId}] [${idx + 1}/${allTargetSpus.length}] SPU ${spuId} -> ERROR: ${err.message}`);
      }
      if ((idx + 1) % 50 === 0) {
        console.log(`[Progress ${idx + 1}/${allTargetSpus.length}] Patched: ${patchedCount} | HasImages: ${alreadyHasCount} | Fail: ${failCount}`);
      }
    }
  }

  const workerPromises = [];
  for (let w = 1; w <= args.concurrency; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  console.log(`\n================ 详情图补齐执行完毕 ================`);
  console.log(`总候选商品数：${allTargetSpus.length}`);
  console.log(`成功补齐详情图数：${patchedCount}`);
  console.log(`已有详情图无需补齐数：${alreadyHasCount}`);
  console.log(`失败数：${failCount}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
