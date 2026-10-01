#!/usr/bin/env node
/**
 * Restore product data from local snapshot.
 * Usage:
 *   node scripts/platforms/minicheng/restore_product_snapshot.mjs --sku-id <skuId>
 *   node scripts/platforms/minicheng/restore_product_snapshot.mjs --all
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(__dirname, '../../../artifacts/snapshots/minicheng_33280018');

async function getAuthToken() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const pages = browser.contexts().flatMap(c => c.pages());
  const miniPage = pages.find(p => p.url().includes('mini.guodongcheng.cn'));
  if (!miniPage) {
    await browser.close();
    throw new Error('MiniCheng page not found on port 9223');
  }
  const token = await miniPage.evaluate(() => localStorage.getItem('token'));
  await browser.close();
  return token;
}

async function restoreOne(token, snapshotFile) {
  const content = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
  const detail = content.rawDetail;
  const storeCode = content.storeCode || '33280018';
  const skuId = content.skuId;

  const payload = {
    ...detail,
    storeCode,
    mtCatAttr: typeof detail.mtCatAttr === 'string' ? detail.mtCatAttr : JSON.stringify(detail.mtCatAttr || []),
    eleCatPropertyList: Array.isArray(detail.eleCatPropertyList) ? detail.eleCatPropertyList : (detail.eleCatPropertyList ? JSON.parse(detail.eleCatPropertyList) : []),
    eleCatAttr: typeof detail.eleCatAttr === 'string' ? detail.eleCatAttr : JSON.stringify(detail.eleCatAttr || []),
    skuList: (detail.skuList || []).map(sku => ({
      ...sku,
      weight: (sku.weight && Number(sku.weight) > 0) ? Number(sku.weight) : 10
    }))
  };

  const res = await fetch('https://emallopen.guodongcheng.cn/merchant_api/store/product/updateProductDetail', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const resData = await res.json();
  if (resData.code === 200) {
    console.log(`[Restored] Successfully restored product skuId=${skuId} (${detail.productName})`);
    return true;
  } else {
    console.error(`[Restore Failed] skuId=${skuId}: ${resData.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const skuIdArgIdx = args.indexOf('--sku-id');
  const allArg = args.includes('--all');

  const token = await getAuthToken();

  if (skuIdArgIdx !== -1 && args[skuIdArgIdx + 1]) {
    const targetSkuId = args[skuIdArgIdx + 1];
    const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.includes(targetSkuId));
    if (!files.length) {
      console.error(`No snapshot found for skuId: ${targetSkuId}`);
      process.exit(1);
    }
    await restoreOne(token, path.join(SNAPSHOT_DIR, files[0]));
  } else if (allArg) {
    const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json'));
    console.log(`Found ${files.length} snapshots to restore...`);
    for (const f of files) {
      await restoreOne(token, path.join(SNAPSHOT_DIR, f));
    }
  } else {
    console.log('Usage: node restore_product_snapshot.mjs --sku-id <skuId> | --all');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
