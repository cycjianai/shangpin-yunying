#!/usr/bin/env node

/**
 * QNH direct-CDP operator.
 *
 * This file deliberately does not load or message any browser extension and
 * never persists cookies, mtgsig, request headers, or local/session storage.
 * All protected requests are signed and sent inside the already logged-in QNH
 * page, then only product/business data is returned to Node.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadChromium } from './qnh_playwright_loader.mjs';
import {
  assertManagedDirectBatchRuntime,
  resolveDirectBatchConcurrency,
  resolveInitialRuntimeConcurrency,
  resolveProgressiveRuntimeConcurrency,
  resolveRuntimeConcurrencyCeiling,
  shouldRecycleRuntimeProcess,
  shouldCollectSingleWorkerRenderer,
  shouldRunSynchronousGc,
} from './qnh_runtime_limits.mjs';
import { selectReadyMutationWindow } from './qnh_batch_window.mjs';
import { createBrowserResourceMonitor } from './qnh_browser_resource_monitor.mjs';
import { checkpointResumeDisposition } from './qnh_batch_resume.mjs';
import {
  bootstrapQnhWorkerPool,
  prewarmQnhWorkerPage,
} from './qnh_worker_prewarm.mjs';
import { createPreparedSaveBarrier } from './qnh_phase_barrier.mjs';
import {
  DETAIL_ENDPOINT,
  LIST_ENDPOINT,
  LIST_ROUTE,
  validateDirectSignature,
  validateNativeEditorEvidence,
  validateNativeListEvidence,
  withCsecVersion,
} from './qnh_protocol_profile.mjs';

const QUALIFICATION_IMAGE_POLICY = JSON.parse(
  await fs.readFile(new URL('./qualification_image_policy.json', import.meta.url), 'utf8'),
);
if (QUALIFICATION_IMAGE_POLICY?.schema !== 'qnh-qualification-image-policy-v1') {
  throw new Error('qualification_image_policy_schema_mismatch');
}
const QUALIFICATION_WRITEBACK_POLICY = QUALIFICATION_IMAGE_POLICY.writeback || {};

let chromium = null;

const DEFAULT_CDP = 'http://127.0.0.1:9292';
const DEFAULT_RUN_DIR = '/home/ubuntu/e2e-browser-lab/runs/qnh-channel-unavailable';
const APP_KEY = 'fe_recofesaascrm';
const LIST_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?yodaReady=h5&csecplatform=4&csecversion=4.2.0';
const DETAIL_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?yodaReady=h5&csecplatform=4&csecversion=4.2.0';
const UPDATE_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update?yodaReady=h5&csecplatform=4&csecversion=4.2.0';
const UPDATE_V2_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const GALLERY_QUERY_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/query-pics-by-sku-name?yodaReady=h5&csecplatform=4&csecversion=4.2.0';
const DYNAMIC_RECOMMEND_URL = 'https://qnh.meituan.com/qnh-gw5/api/storeSpu/queryRecommendDynamicInfoAndWeight?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const MASTER_BRAND_QUERY_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/support/query-brand-by-name?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const CHANNEL_BRAND_QUERY_URL = 'https://qnh.meituan.com/api/v1/channelBrand/queryByChannel?yodaReady=h5&csecplatform=4&csecversion=4.2.0';
const CHANNEL_CATEGORY_RECOMMEND_URL = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/batchRecommend?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const CHANNEL_CATEGORY_PROPERTY_BATCH_URL = 'https://qnh.meituan.com/qnh-gw5/api/v1/channelCategory/property/batchQuery?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const STORE_FRONT_CATEGORY_QUERY_URL = 'https://qnh.meituan.com/qnh-gw3/api/product/support/front-category/query?yodaReady=h5&csecplatform=4&csecversion=4.2.4';
const IMAGE_UPLOAD_URL = 'https://qnh.meituan.com/api/v1/image/uploadImageFullType';
const LIST_REFERRER = '/unifiedGoods/tenant/spu-list';
const LIST_PAGE_URL = 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list';
let runtimeProtocolProfile = null;

function effectiveRequestUrl(url) {
  return runtimeProtocolProfile?.csecversion === '4.3.0'
    ? withCsecVersion(url, '4.3.0')
    : url;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      out._.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      out[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[rawKey] = next;
      index += 1;
    } else {
      out[rawKey] = true;
    }
  }
  return out;
}

function isoNow() {
  return new Date().toISOString();
}

function traceId() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function matchesGeneratedSlotRule(rule, pictureType, pictureTitle, auditText) {
  if (Number(rule?.picture_type) !== Number(pictureType)) return false;
  const exactTitles = toArray(rule?.exact_titles).map(String);
  const titleContains = toArray(rule?.title_contains).map(String);
  if (exactTitles.length && !exactTitles.includes(String(pictureTitle))) return false;
  if (titleContains.length && !titleContains.some((token) => String(pictureTitle).includes(token))) {
    return false;
  }
  const allTokens = toArray(rule?.audit_all_tokens).map(String);
  const anyTokens = toArray(rule?.audit_any_tokens).map(String);
  const anyGroups = toArray(rule?.audit_any_token_groups)
    .map((group) => toArray(group).map(String));
  return (
    allTokens.every((token) => auditText.includes(token))
    && (!anyTokens.length || anyTokens.some((token) => auditText.includes(token)))
    && (!anyGroups.length || anyGroups.some((group) => group.every((token) => auditText.includes(token))))
  );
}

function synthesizeGeneratedPictureSlot(pictureType, pictureTitle, auditText) {
  const rule = toArray(QUALIFICATION_WRITEBACK_POLICY.synthetic_missing_slots).find(
    (candidate) => matchesGeneratedSlotRule(candidate, pictureType, pictureTitle, auditText),
  );
  if (!rule) return null;
  return {
    pictureType: Number(pictureType),
    pictureTitle: String(pictureTitle),
    pictureDesc: String(rule.picture_desc || ''),
    pictureExample: [],
    isRequired: 1,
    isDisplay: 1,
    numLimit: Number(QUALIFICATION_WRITEBACK_POLICY.default_num_limit || 4),
    pictureUrl: null,
    customized: null,
    deleted: false,
    numMin: Number(QUALIFICATION_WRITEBACK_POLICY.default_num_min || 1),
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function businessEnvelope(payload) {
  const outer = toObject(payload);
  const nested = toObject(outer.data);
  const code = firstNonEmpty(outer.code, outer.status, nested.code, nested.status);
  const message = firstNonEmpty(
    outer.msg,
    outer.message,
    outer.errorMsg,
    nested.msg,
    nested.message,
    nested.errorMsg,
  );
  return { code: String(code), message: String(message) };
}

function businessOk(payload) {
  const { code } = businessEnvelope(payload);
  return code === '' || code === '0' || code === '200';
}

function unwrapData(payload) {
  const outer = toObject(payload);
  const first = toObject(outer.data);
  return Object.keys(first).length ? first : outer;
}

function findRows(payload) {
  const data = unwrapData(payload);
  const candidates = [
    data.list,
    data.records,
    data.rows,
    data.spuList,
    data.productList,
    data.content,
    toObject(data.pageResult).list,
    toObject(data.pageResult).records,
  ];
  return candidates.find(Array.isArray) || [];
}

function findTotal(payload, fallback) {
  const data = unwrapData(payload);
  const candidates = [
    data.total,
    data.totalCount,
    data.count,
    toObject(data.pageResult).total,
    toObject(data.pageResult).totalCount,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return fallback;
}

function idOf(row) {
  return String(firstNonEmpty(row.spuId, row.spuID, row.id, row.productId));
}

function titleOf(row) {
  return String(firstNonEmpty(row.spuName, row.goodsName, row.productName, row.name, row.title));
}

function collectIssueText(row) {
  const texts = [];
  const seen = new Set();
  const visit = (value, key = '') => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (/abnormal|error|fail|reason|tip|message|no.?sale|missing|audit/i.test(childKey)) {
          visit(childValue, childKey);
        }
      }
      return;
    }
    if (!/abnormal|error|fail|reason|tip|message|no.?sale|missing|audit/i.test(key)) return;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 2000 || seen.has(text)) return;
    seen.add(text);
    texts.push(text);
  };
  visit(row);
  return texts;
}

function compactManifestRow(row) {
  const skuList = [
    ...toArray(row.skuList),
    ...toArray(row.tenantSkuList),
    ...toArray(row.storeSkuList),
  ];
  const skuIds = [...new Set(skuList.map((sku) => String(firstNonEmpty(sku.skuId, sku.id))).filter(Boolean))];
  const specs = [...new Set(skuList.map((sku) => String(firstNonEmpty(sku.specName, sku.spec, sku.skuName))).filter(Boolean))];
  return {
    spu_id: idOf(row),
    title: titleOf(row),
    category: String(firstNonEmpty(
      row.backendCategoryName,
      row.categoryName,
      row.storeCategoryName,
      row.categoryPathName,
    )),
    sku_ids: skuIds,
    specs,
    issue_text: collectIssueText(row),
    source: {
      abnormalCodeList: toArray(row.abnormalCodeList),
      abnormalMarkMsg: firstNonEmpty(row.abnormalMarkMsg, row.abnormalMsg),
      abnormalTips: firstNonEmpty(row.abnormalTips, row.abnormalTip),
      noSaleChannelInfoList: toArray(row.noSaleChannelInfoList),
      spuChannelInfoList: toArray(row.spuChannelInfoList),
    },
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writeJsonExclusive(filePath, value) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendLog(runDir, event, payload = {}) {
  const record = {
    timestamp: isoNow(),
    trace_id: traceId(),
    level: 'INFO',
    module: 'qnh_direct',
    action: event,
    event,
    payload: {
      feature_key: 'qnh_channel_unavailable_direct',
      stage: event,
      ...payload,
    },
    message: '牵牛花直连任务事件',
    error_stack: '',
  };
  await fs.appendFile(
    path.join(runDir, 'events.jsonl'),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
}

async function closeProductEditTabs(page, spuId = '') {
  const targetSpu = String(spuId || '');
  const closed = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tabs = page.locator(
      '#multiple-nav-tabs [data-sort-id*="/unifiedGoods/tenant/edit"]',
    );
    let selected = null;
    let selectedId = '';
    for (let index = 0; index < await tabs.count(); index += 1) {
      const tab = tabs.nth(index);
      const sortId = String(await tab.getAttribute('data-sort-id') || '');
      if (targetSpu && !sortId.includes(`spu=${targetSpu}`)) continue;
      selected = tab;
      selectedId = sortId;
      break;
    }
    if (!selected) break;
    const closeControl = selected.locator('div[class*="remove--"]').first();
    if (await closeControl.count() !== 1) {
      throw new Error(`商品编辑标签缺少关闭控件：${selectedId}`);
    }
    await closeControl.evaluate((element) => element.click());
    closed.push(selectedId);
    await page.waitForTimeout(120);
  }
  const remaining = await page.locator(
    '#multiple-nav-tabs [data-sort-id*="/unifiedGoods/tenant/edit"]',
  ).evaluateAll(
    (elements, expectedSpu) => elements
      .map((element) => String(element.getAttribute('data-sort-id') || ''))
      .filter((sortId) => !expectedSpu || sortId.includes(`spu=${expectedSpu}`)),
    targetSpu,
  );
  if (remaining.length) {
    throw new Error(`商品编辑标签关闭后仍有残留：${remaining.join(', ')}`);
  }
  return { closed_count: closed.length, closed, remaining_count: remaining.length };
}

async function attach(cdpUrl) {
  chromium ||= await loadChromium();
  const browser = await chromium.connectOverCDP(cdpUrl);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const qnhPages = pages.filter((candidate) => candidate.url().startsWith('https://qnh.meituan.com/'));
  const requestedIndex = Number(process.env.QNH_CDP_PAGE_INDEX || 0);
  const page = qnhPages[Number.isInteger(requestedIndex) && requestedIndex >= 0 ? requestedIndex : 0];
  if (!page) {
    await browser.close();
    throw new Error(`未找到已登录的牵牛花页面；需要页面索引 ${requestedIndex}，当前可用页面 ${qnhPages.length}`);
  }
  return { browser, page };
}

async function signedJson(page, { url, body, qnhReferrer, fetchReferrer = '' }) {
  const finalUrl = effectiveRequestUrl(url);
  return page.evaluate(async ({ requestUrl, requestBody, referrerHeader, explicitReferrer, appKey }) => {
    if (!window.H5guard || typeof window.H5guard.sign !== 'function') {
      throw new Error('H5guard 未就绪，禁止发送平台请求');
    }
    const bodyText = JSON.stringify(requestBody || {});
    const contentType = 'application/json;charset=UTF-8';
    const signature = await window.H5guard.sign({
      url: requestUrl,
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bodyText,
    });
    const signatureHeaders = signature && typeof signature === 'object' ? signature.headers || {} : {};
    const mtgsigHeader = Object.entries(signatureHeaders).find(
      ([key]) => String(key).toLowerCase() === 'mtgsig',
    );
    const mtgsig = typeof signature === 'string'
      ? signature
      : String(mtgsigHeader?.[1] || signature?.mtgsig || signature?.data?.mtgsig || '');
    if (!mtgsig) throw new Error('H5guard 未返回 mtgsig，禁止发送平台请求');
    const findA9 = (value, depth = 0) => {
      if (depth > 7 || value === null || value === undefined) return '';
      if (typeof value === 'object') {
        if (value.a9 !== undefined) return String(value.a9 || '');
        for (const child of Object.values(value)) {
          const found = findA9(child, depth + 1);
          if (found) return found;
        }
        return '';
      }
      if (typeof value !== 'string') return '';
      try {
        const parsed = JSON.parse(value);
        const found = findA9(parsed, depth + 1);
        if (found) return found;
      } catch { /* opaque signature string */ }
      return value.match(/(?:^|[,{\s])['"]?a9['"]?\s*[:=]\s*['"]?([^'",}\s]+)/i)?.[1] || '';
    };
    const a9 = findA9(mtgsig);
    if (!a9) throw new Error('H5guard mtgsig 缺少 a9，禁止发送平台请求');
    const requestedVersion = new URL(requestUrl).searchParams.get('csecversion') || '';
    const explicitVersion = a9.match(/\b4\.(?:2|3)\.\d+\b/)?.[0] || '';
    if (explicitVersion && explicitVersion !== requestedVersion) {
      throw new Error('H5guard a9 版本与精确请求 URL 不一致，禁止发送平台请求');
    }
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': contentType,
      'M-APPKEY': appKey,
      'M-TRACEID': String((Date.now() + Math.random() * -1e18) | 0),
      'X-Requested-With': 'XMLHttpRequest',
      qnhReferrer: referrerHeader,
      mtgsig,
    };
    const init = {
      method: 'POST',
      credentials: 'include',
      headers,
      body: bodyText,
    };
    if (explicitReferrer) init.referrer = explicitReferrer;
    const response = await fetch(requestUrl, init);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { rawText: text.slice(0, 2000) };
    }
    return {
      http_status: response.status,
      data,
      signature_evidence: {
        a9_present: true,
        a9_version: explicitVersion,
        requested_version: requestedVersion,
        binding_source: 'direct_h5guard_exact_request',
      },
    };
  }, {
    requestUrl: finalUrl,
    requestBody: body,
    referrerHeader: qnhReferrer,
    explicitReferrer: fetchReferrer,
    appKey: APP_KEY,
  });
}

async function signedJsonQueryWithSingleRetry(page, options, runDir, context = {}) {
  try {
    return await signedJson(page, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Failed to fetch|NetworkError|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/i.test(message)) {
      throw error;
    }
    await appendLog(runDir, 'query_only_same_profile_retry', {
      ...context,
      attempt: 2,
      csecversion: runtimeProtocolProfile?.csecversion || '',
      reason: message.slice(0, 300),
      mutation_calls: 0,
    });
    await page.waitForTimeout(500);
    return signedJson(page, options);
  }
}

function assertResponse(response, action) {
  const envelope = businessEnvelope(response.data);
  if (response.http_status < 200 || response.http_status >= 300 || !businessOk(response.data)) {
    throw new Error(`${action}失败：HTTP ${response.http_status}，业务码 ${envelope.code || '-'}，${envelope.message || '无错误文案'}`);
  }
}

function collectMeituanImageUrls(value, output = []) {
  if (typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol === 'https:'
        && (parsed.hostname === 'meituan.net' || parsed.hostname.endsWith('.meituan.net'))
      ) {
        output.push(value);
      }
    } catch {
      // Ignore non-URL strings in the upload envelope.
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMeituanImageUrls(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMeituanImageUrls(item, output);
  }
  return output;
}

async function uploadLocalImage(page, runDir, filePath) {
  const absolutePath = path.resolve(filePath);
  const bytes = await fs.readFile(absolutePath);
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
    throw new Error('待上传图片为空或超过 10MB');
  }
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeByExtension = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
  ]);
  const contentType = mimeByExtension.get(extension);
  if (!contentType) throw new Error(`不支持的图片扩展名：${extension}`);
  const digest = sha256(bytes);
  const response = await page.evaluate(async ({
    requestUrl,
    imageBase64,
    imageType,
    fileName,
    appKey,
    uploadTraceId,
  }) => {
    const binary = atob(imageBase64);
    const payload = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      payload[index] = binary.charCodeAt(index);
    }
    const form = new FormData();
    form.append('file', new File([payload], fileName, { type: imageType }), fileName);
    const result = await fetch(requestUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'M-APPKEY': appKey,
        'M-TRACEID': uploadTraceId,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: form,
    });
    const bodyText = await result.text();
    let data = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = { rawText: bodyText.slice(0, 2000) };
    }
    return { http_status: result.status, data };
  }, {
    requestUrl: IMAGE_UPLOAD_URL,
    imageBase64: bytes.toString('base64'),
    imageType: contentType,
    fileName: path.basename(absolutePath),
    appKey: APP_KEY,
    uploadTraceId: traceId(),
  });
  assertResponse(response, '上传牵牛花图片');
  const imageUrl = collectMeituanImageUrls(response.data)[0] || '';
  if (!imageUrl) throw new Error('图片上传成功但未返回可信美团图片 URL');
  const receipt = {
    generated_at: isoNow(),
    source_path: absolutePath,
    source_sha256: digest,
    source_bytes: bytes.length,
    content_type: contentType,
    upload_endpoint: IMAGE_UPLOAD_URL,
    image_url: imageUrl,
  };
  const receiptPath = path.join(runDir, `image-upload-${digest}.json`);
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'image_uploaded', {
    source_sha256: digest,
    source_bytes: bytes.length,
    content_type: contentType,
    image_url: imageUrl,
    receipt_path: receiptPath,
  });
  return { receiptPath, imageUrl, sourceSha256: digest, sourceBytes: bytes.length };
}

async function captureNativeListProfile(page) {
  if (page.url() !== LIST_PAGE_URL) {
    await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    try {
      return request.method() === 'POST'
        && new URL(request.url()).pathname === LIST_ENDPOINT;
    } catch { return false; }
  }, { timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  const response = await responsePromise;
  const request = response.request();
  const requestBody = request.postDataJSON();
  const payload = await response.json();
  const profile = validateNativeListEvidence({
    page_url: page.url(),
    request_url: request.url(),
    method: request.method(),
    http_status: response.status(),
  });
  if (!businessOk(payload)) throw new Error('当前文档原生列表请求业务失败，禁止自定义请求');
  return { profile, payload, request_body: requestBody };
}

async function preflight(page) {
  const native = await captureNativeListProfile(page);
  runtimeProtocolProfile = native.profile;
  const result = await signedJson(page, {
    url: LIST_URL,
    body: {
      labelInfoList: [],
      storeFrontGroupCategoryList: [],
      channelCategory: { channelId: 100, categoryProperty: {} },
      hasNoSaleAbnormal: 1,
      page: 1,
      pageSize: 1,
      backendCategoryList: [],
    },
    qnhReferrer: LIST_REFERRER,
  });
  assertResponse(result, '登录预检');
  const visibleIdentity = await page.evaluate(() => {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    // Tenant display names may themselves contain ASCII/full-width brackets,
    // for example “京东便利店(鄞州中心店)（租户ID:1009979）”.  The tenant
    // name is a single visible token, so only whitespace should terminate it.
    const match = text.match(/([^\s]{1,80})[（(]租户ID\s*[:：]\s*(\d+)[）)]/);
    return {
      tenant_name: match ? match[1] : '',
      tenant_id: match ? match[2] : '',
    };
  });
  const pageUrl = page.url();
  return {
    ok: true,
    generated_at: isoNow(),
    page_url: pageUrl,
    page_route: (() => {
      try { return new URL(pageUrl).hash.replace(/^#/, '').split('?')[0]; } catch { return ''; }
    })(),
    title: await page.title(),
    tenant_name: visibleIdentity.tenant_name,
    tenant_id: visibleIdentity.tenant_id,
    h5guard_ready: await page.evaluate(() => Boolean(window.H5guard && typeof window.H5guard.sign === 'function')),
    total: findTotal(result.data, findRows(result.data).length),
    context_profile: native.profile.context_profile,
    csecversion: native.profile.csecversion,
    native_profile_source: native.profile.source,
  };
}

async function freezeManifest(page, runDir, pageSize, label = '', allowDynamicTotal = false) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('清单 page-size 只允许 1–100；平台对更大值可能静默返回空清单');
  }
  const baseBody = {
    labelInfoList: [],
    storeFrontGroupCategoryList: [],
    channelCategory: { channelId: 100, categoryProperty: {} },
    hasNoSaleAbnormal: 1,
    backendCategoryList: [],
  };
  const allRows = [];
  let expectedTotal = null;
  for (let pageNumber = 1; expectedTotal === null || allRows.length < expectedTotal; pageNumber += 1) {
    const response = await signedJson(page, {
      url: LIST_URL,
      body: { ...baseBody, page: pageNumber, pageSize },
      qnhReferrer: LIST_REFERRER,
    });
    assertResponse(response, `读取第 ${pageNumber} 页`);
    const rows = findRows(response.data);
    expectedTotal = findTotal(response.data, expectedTotal ?? rows.length);
    allRows.push(...rows);
    await appendLog(runDir, 'manifest_page_read', {
      page: pageNumber,
      page_size: pageSize,
      rows: rows.length,
      expected_total: expectedTotal,
    });
    if (!rows.length || pageNumber > Math.ceil(Math.max(expectedTotal, 1) / pageSize) + 2) break;
  }
  const unique = new Map();
  for (const row of allRows) {
    const spuId = idOf(row);
    if (spuId) unique.set(spuId, row);
  }
  const products = [...unique.values()].map(compactManifestRow);
  const canonicalIds = products.map((product) => product.spu_id).sort();
  const manifest = {
    generated_at: isoNow(),
    filter: {
      channel_id: 100,
      has_no_sale_abnormal: 1,
    },
    expected_total: expectedTotal,
    raw_row_total: allRows.length,
    unique_total: products.length,
    dynamic_total_mismatch: expectedTotal !== products.length,
    spu_id_sha256: sha256(canonicalIds.join('\n')),
    products,
  };
  if (expectedTotal !== products.length && !allowDynamicTotal) {
    throw new Error(`清单冻结失败：平台 total=${expectedTotal}，唯一 SPU=${products.length}`);
  }
  if (label && !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('清单 label 只能包含字母、数字和连字符');
  }
  const manifestPath = path.join(
    runDir,
    `manifest-${label ? `${label}-` : ''}${products.length}.json`,
  );
  await writeJson(manifestPath, manifest);
  await appendLog(runDir, 'manifest_frozen', {
    total: products.length,
    expected_total: expectedTotal,
    raw_row_total: allRows.length,
    dynamic_total_mismatch: manifest.dynamic_total_mismatch,
    spu_id_sha256: manifest.spu_id_sha256,
    file: manifestPath,
  });
  return { manifestPath, manifest };
}

function detailSpu(payload) {
  const data = unwrapData(payload);
  return toObject(data.tenantSpu).spuId
    ? toObject(data.tenantSpu)
    : toObject(data.productSpu).spuId
      ? toObject(data.productSpu)
      : data;
}

function summarizeDetail(detail) {
  return {
    spu_id: String(detail.spuId || ''),
    title: titleOf(detail),
    selling_point: String(detail.sellPoint || ''),
    update_time: detail.updateTime || null,
    basic_brand: toObject(detail.brand).brandName || '',
    origin_place: detail.originPlace || '',
    product_place: detail.productPlace || '',
    main_image_count: toArray(detail.picUrlList).length,
    detail_image_count: toArray(detail.picContentList).length,
    qualification_image_count: toArray(
      firstNonEmpty(
        toObject(detail.medicalDeviceQuaInfo).quaPictures,
        toObject(detail.medicalDeviceQuaInfo).qualificationPictures,
      ),
    ).length,
    skus: toArray(detail.skus).map((sku) => ({
      sku_id: String(sku.skuId || ''),
      spec_name: String(sku.specName || ''),
      upc_list: toArray(sku.upcList).map(String),
    })),
    channels: toArray(detail.spuChannelInfoList).map((channel) => ({
      channel_id: Number(channel.channelId || 0),
      category_code: String(channel.categoryCode || ''),
      category_name: String(channel.categoryName || ''),
      brand_name: String(toObject(channel.brandInfo).brandName || ''),
      properties: toArray(channel.categoryProperties).map((attr) => ({
        attr_id: String(attr.attrId || ''),
        attr_name: String(attr.attrName || ''),
        values: propertyDisplayValues(attr),
        original_input_value: firstNonEmpty(attr.originalInputValue),
      })),
    })),
  };
}

function displayCustomValue(value) {
  const simple = String(firstNonEmpty(value?.attrValue, value?.customAttrValue));
  if (simple) return simple;
  const structured = toArray(value?.structAttrValueList).flatMap((group) => (
    toArray(group?.valueList).map((row) => toArray(row).map((part) => String(
      firstNonEmpty(part?.value, part?.optionValue),
    )).filter(Boolean).join(''))
  ));
  return structured.filter(Boolean).join(' / ');
}

function propertyDisplayValues(prop) {
  return toArray(prop?.customValue).map(displayCustomValue).filter(Boolean);
}

function channelPropertyContractMatches(prop, change) {
  if (!change?.contract_kind) return true;
  if (!prop || String(prop?.attrId || '') !== String(change?.attr_id || '')) return false;
  const values = toArray(prop.customValue);
  if (change.contract_kind === 'type9_number_unit') {
    const valueId = String(values[0]?.attrValueId ?? '');
    const allowedIds = new Set(toArray(prop.optionList).map((item) => String(item?.optionId ?? '')));
    return values.length === 1
      && (!valueId || (allowedIds.has(valueId) && valueId === String(change.expected_unit_id || '')))
      && JSON.stringify(propertyDisplayValues(prop)) === JSON.stringify(change.new_value);
  }
  if (change.contract_kind === 'type10_structure') {
    if (values.length !== 1 || String(values[0]?.attrValue || '').trim()) return false;
    const groups = toArray(values[0]?.structAttrValueList);
    const rows = groups.length === 1 ? toArray(groups[0]?.valueList) : [];
    return rows.length === 1
      && toArray(rows[0]).length > 0
      && propertyDisplayValues(prop).includes(String(change.new_value || ''));
  }
  return false;
}

function coverageField(channelId) {
  if (Number(channelId) === 100) return 'mt_channel_category_property';
  if (Number(channelId) === 200) return 'elm_channel_category_property';
  if (Number(channelId) === 300) return 'jd_channel_category_property';
  return '';
}

function normalizedImageUrl(value) {
  return String(value || '').trim().replace(/^http:\/\//i, 'https://');
}

const MAIN_IMAGE_WRITE_INTENT_SCHEMA = 'qnh-main-image-write-intent-v1';
const MAIN_IMAGE_WRITE_INTENT_DIR = (
  '/home/ubuntu/e2e-browser-lab/state/qnh-main-image-write-intents'
);

function exactImageUrlListEqual(left, right) {
  return JSON.stringify(toArray(left).map(normalizedImageUrl))
    === JSON.stringify(toArray(right).map(normalizedImageUrl));
}

function stableIntentPathToken(value, fieldName) {
  const text = String(value || '').trim();
  if (!/^[a-z0-9_-]{1,128}$/i.test(text)) {
    throw new Error(`生成主图 ${fieldName} 不能用于稳定写意图路径`);
  }
  return text;
}

async function mainImageWriteIntentPath(tenantId, spuId) {
  const tenantToken = stableIntentPathToken(tenantId, 'tenant_id');
  const spuToken = stableIntentPathToken(spuId, 'spu_id');
  await ensureDir(MAIN_IMAGE_WRITE_INTENT_DIR);
  return path.join(
    MAIN_IMAGE_WRITE_INTENT_DIR,
    `main-image-write-intent-${tenantToken}-${spuToken}.json`,
  );
}

function legacyMainImageWriteIntentPath(runDir, tenantId, spuId) {
  const tenantToken = stableIntentPathToken(tenantId, 'tenant_id');
  const spuToken = stableIntentPathToken(spuId, 'spu_id');
  return path.join(
    runDir,
    `main-image-write-intent-${tenantToken}-${spuToken}.json`,
  );
}

function assertMainImageOnlyPlan(plan) {
  const populatedMutationKeys = [];
  const arrayKeys = [
    'recommended_channel_category_fields',
    'channel_brand_info_fields',
    'main_image_reuse_urls',
    'main_image_order_urls',
    'main_image_replace_urls',
    'main_image_gallery_urls',
    'detail_image_reuse_urls',
    'special_picture_replace',
    'special_picture_reuse',
    'special_picture_gallery',
    'special_picture_uploaded',
    'sku_spec_fields',
    'sku_weight_fields',
    'sku_upc_fields',
    'sku_no_upc_fields',
    'sku_restore_upc_fields',
    'official_recommendation_fields',
    'exact_option_channel_fields',
    'extendable_option_channel_fields',
    'structured_channel_fields',
    'duration_channel_fields',
    'date_channel_fields',
    'free_text_channel_fields',
    'custom_text_channel_fields',
    'snapshot_brand_channel_fields',
    'tenant_snapshot_brand_channel_fields',
    'remote_brand_channel_fields',
  ];
  for (const key of arrayKeys) {
    if (toArray(plan[key]).length) populatedMutationKeys.push(key);
  }
  const objectKeys = [
    'basic_brand_field',
    'store_front_category_field',
    'text_fields',
    'select_fields',
    'medical_qualification',
  ];
  for (const key of objectKeys) {
    if (Object.keys(toObject(plan[key])).length) populatedMutationKeys.push(key);
  }
  if (plan.mirror_existing_special_pictures === true) {
    populatedMutationKeys.push('mirror_existing_special_pictures');
  }
  if (populatedMutationKeys.length) {
    throw new Error(
      `生成主图计划只能修改 main_images，发现其他字段：${populatedMutationKeys.join(', ')}`,
    );
  }
}

async function loadVerifiedMainImageMaterial(plan, spuId) {
  const requested = toObject(plan.main_image_uploaded);
  if (!Object.keys(requested).length) return null;
  assertMainImageOnlyPlan(plan);
  const expectedTenantId = String(plan.expected_tenant_id || '').trim();
  const planJobId = String(plan.job_id || '').trim();
  const nestedJobId = String(requested.job_id || '').trim();
  const nestedTenantId = String(requested.expected_tenant_id || requested.tenant_id || '').trim();
  if (!expectedTenantId) {
    throw new Error('生成主图计划缺少 expected_tenant_id');
  }
  if (!planJobId) {
    throw new Error('生成主图计划缺少 job_id');
  }
  if (nestedJobId && nestedJobId !== planJobId) {
    throw new Error('生成主图计划顶层与 main_image_uploaded.job_id 不一致');
  }
  if (nestedTenantId && nestedTenantId !== expectedTenantId) {
    throw new Error('生成主图计划顶层与 main_image_uploaded.tenant_id 不一致');
  }
  if (
    !requested.upload_receipt_path
    || !requested.generation_receipt_path
    || !requested.artifact_sha256
  ) {
    throw new Error('生成主图计划缺少生成回执、上传回执或 artifact_sha256');
  }
  const uploadReceiptPath = path.resolve(String(requested.upload_receipt_path));
  const generationReceiptPath = path.resolve(String(requested.generation_receipt_path));
  const uploadReceipt = JSON.parse(await fs.readFile(uploadReceiptPath, 'utf8'));
  const generationReceipt = JSON.parse(await fs.readFile(generationReceiptPath, 'utf8'));
  const requestedUrl = String(requested.url || '');
  const artifactPath = path.resolve(String(generationReceipt?.artifact_path || ''));
  const uploadedSourcePath = path.resolve(String(uploadReceipt?.source_path || ''));
  const artifactBytes = await fs.readFile(artifactPath);
  const artifactSha256 = sha256(artifactBytes);
  if (
    String(generationReceipt?.status || '') !== 'ready'
    || String(generationReceipt?.spu_id || '') !== String(spuId)
    || String(generationReceipt?.tenant_id || '') !== expectedTenantId
    || String(generationReceipt?.job_id || '') !== planJobId
    || Number(generationReceipt?.submit_attempt_count || 0) !== 1
    || artifactPath !== uploadedSourcePath
    || artifactSha256 !== String(generationReceipt?.artifact_sha256 || '')
    || artifactSha256 !== String(requested.artifact_sha256 || '')
    || artifactSha256 !== String(uploadReceipt?.source_sha256 || '')
    || normalizedImageUrl(String(uploadReceipt?.image_url || ''))
      !== normalizedImageUrl(requestedUrl)
    || !collectMeituanImageUrls(requestedUrl).length
  ) {
    throw new Error('生成主图的租户、任务、SPU、上传回执或制品哈希不一致');
  }
  return {
    expectedTenantId,
    jobId: planJobId,
    artifactSha256,
    uploadedUrl: String(uploadReceipt.image_url || ''),
    generationReceiptPath,
    uploadReceiptPath,
  };
}

function expectedMainImageReplacement(oldUrls, uploadedUrl) {
  const oldImages = toArray(oldUrls).map(String).filter(Boolean);
  const normalizedUploadedUrl = normalizedImageUrl(uploadedUrl);
  const seen = new Set([normalizedUploadedUrl]);
  const preservedTail = [];
  for (const url of oldImages.slice(1)) {
    const normalizedUrl = normalizedImageUrl(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    preservedTail.push(url);
  }
  return [
    String(uploadedUrl || ''),
    ...preservedTail,
  ];
}

function assertMainImageIntentIdentity(intent, expected) {
  if (
    String(intent?.schema || '') !== MAIN_IMAGE_WRITE_INTENT_SCHEMA
    || String(intent?.tenant_id || '') !== String(expected.tenant_id || '')
    || String(intent?.spu_id || '') !== String(expected.spu_id || '')
    || String(intent?.job_id || '') !== String(expected.job_id || '')
    || String(intent?.plan_sha256 || '') !== String(expected.plan_sha256 || '')
    || String(intent?.artifact_sha256 || '') !== String(expected.artifact_sha256 || '')
    || !exactImageUrlListEqual(
      intent?.expected_old_main_image_urls,
      expected.expected_old_main_image_urls,
    )
    || !exactImageUrlListEqual(
      intent?.expected_new_main_image_urls,
      expected.expected_new_main_image_urls,
    )
  ) {
    throw new Error('既有生成主图写意图与当前租户/SPU/任务/计划/制品不一致');
  }
}

async function loadMainImageWriteIntent(intentPath, expectedIdentity) {
  let intent;
  try {
    intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`生成主图写意图无法安全读取：${intentPath}`);
  }
  assertMainImageIntentIdentity(intent, expectedIdentity);
  return intent;
}

async function createMainImageWriteIntent(intentPath, identity) {
  const intent = {
    schema: MAIN_IMAGE_WRITE_INTENT_SCHEMA,
    status: 'authorized_once',
    created_at: isoNow(),
    updated_at: isoNow(),
    tenant_id: identity.tenant_id,
    spu_id: identity.spu_id,
    job_id: identity.job_id,
    plan_sha256: identity.plan_sha256,
    artifact_sha256: identity.artifact_sha256,
    expected_old_main_image_urls: identity.expected_old_main_image_urls,
    expected_new_main_image_urls: identity.expected_new_main_image_urls,
  };
  try {
    await writeJsonExclusive(intentPath, intent);
    return { created: true, intent };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await loadMainImageWriteIntent(intentPath, identity);
    return { created: false, intent: existing };
  }
}

async function updateMainImageWriteIntent(intentPath, identity, status, fields = {}) {
  const lockPath = `${intentPath}.lock`;
  let lockHandle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!lockHandle) {
    throw new Error('生成主图写意图状态锁被占用，停止推进');
  }
  try {
    const current = await loadMainImageWriteIntent(intentPath, identity);
    if (!current) throw new Error('生成主图写意图在保存链路中丢失');
    if (current.status === 'verified' && status !== 'verified') {
      return current;
    }
    const next = {
      ...current,
      ...fields,
      status,
      updated_at: isoNow(),
    };
    assertMainImageIntentIdentity(next, identity);
    await writeJsonAtomic(intentPath, next);
    return next;
  } finally {
    await lockHandle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function galleryImageUrls(payload) {
  return toArray(toObject(unwrapData(payload)).list)
    .map(String)
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));
}

async function queryGalleryImages(page, searchText, pageNumber = 1, pageSize = 10) {
  const normalizedSearch = String(searchText || '').replace(/\s+/g, ' ').trim();
  if (!normalizedSearch) throw new Error('牵牛花图库查询缺少商品名称');
  const response = await signedJson(page, {
    url: GALLERY_QUERY_URL,
    body: {
      page: Math.max(1, Math.floor(Number(pageNumber) || 1)),
      pageSize: Math.max(1, Math.min(50, Math.floor(Number(pageSize) || 10))),
      skuName: normalizedSearch,
    },
    qnhReferrer: '/unifiedGoods/tenant/edit',
  });
  const envelope = businessEnvelope(response.data);
  if (
    response.http_status >= 200
    && response.http_status < 300
    && envelope.code === '400'
    && /名称过长/.test(envelope.message)
    && normalizedSearch.length > 40
  ) {
    return queryGalleryImages(page, normalizedSearch.slice(0, 40), pageNumber, pageSize);
  }
  assertResponse(response, `查询牵牛花图库：${normalizedSearch.slice(0, 40)}`);
  return {
    search_text: normalizedSearch,
    page: Math.max(1, Math.floor(Number(pageNumber) || 1)),
    page_size: Math.max(1, Math.min(50, Math.floor(Number(pageSize) || 10))),
    urls: galleryImageUrls(response.data),
  };
}

function masterBrandCandidates(payload) {
  const outer = toObject(payload);
  const data = outer.data;
  const dataObject = toObject(data);
  const nestedData = dataObject.data;
  const rows = [
    data,
    nestedData,
    dataObject.brandInfoList,
    dataObject.candidates,
    dataObject.brandList,
    dataObject.list,
    outer.brandInfoList,
    outer.candidates,
    outer.brandList,
    outer.list,
  ].find(Array.isArray) || [];
  return rows.map((row) => ({
    brand_code: String(firstNonEmpty(row?.brandCode, row?.brandId, row?.id, row?.value)),
    brand_name: String(firstNonEmpty(row?.brandName, row?.name, row?.label)),
  })).filter((row) => row.brand_code && row.brand_name);
}

async function queryMasterBrand(page, runDir, searchText) {
  const normalizedSearch = String(searchText || '').replace(/\s+/g, ' ').trim();
  if (!normalizedSearch) throw new Error('品牌查询词为空');
  const response = await signedJson(page, {
    url: MASTER_BRAND_QUERY_URL,
    body: { brandName: normalizedSearch, page: 1, pageSize: 100 },
    qnhReferrer: '/unifiedGoods/tenant/edit',
  });
  assertResponse(response, `查询牵牛花总部品牌：${normalizedSearch}`);
  const candidates = masterBrandCandidates(response.data);
  const receipt = {
    generated_at: isoNow(),
    search_text: normalizedSearch,
    endpoint: MASTER_BRAND_QUERY_URL.replace(/[?].*$/, ''),
    candidates,
    response_data: response.data,
  };
  const receiptPath = path.join(
    runDir,
    `master-brand-query-${sha256(normalizedSearch).slice(0, 16)}.json`,
  );
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'master_brand_query_read_only', {
    search_text: normalizedSearch,
    candidate_count: candidates.length,
    receipt_path: receiptPath,
  });
  return { receiptPath, searchText: normalizedSearch, candidates };
}

async function queryChannelBrand(page, runDir, channelId, searchText) {
  const normalizedSearch = String(searchText || '').replace(/\s+/g, ' ').trim();
  const normalizedChannelId = Number(channelId);
  if (!normalizedSearch || !Number.isFinite(normalizedChannelId)) {
    throw new Error('渠道品牌查询缺少渠道或查询词');
  }
  const response = await signedJsonQueryWithSingleRetry(page, {
    url: CHANNEL_BRAND_QUERY_URL,
    body: { channelId: normalizedChannelId, searchText: normalizedSearch },
    qnhReferrer: runtimeProtocolProfile?.csecversion === '4.3.0'
      ? LIST_REFERRER
      : '/unifiedGoods/tenant/edit',
  }, runDir, { query: 'channel_brand', channel_id: normalizedChannelId });
  assertResponse(response, `查询渠道品牌：${normalizedChannelId}/${normalizedSearch}`);
  const rows = toArray(toObject(response.data?.data).list);
  const candidates = rows.map((row) => ({
    channel_id: String(firstNonEmpty(row?.channelId, normalizedChannelId)),
    brand_code: String(firstNonEmpty(row?.channelBrandId, row?.brandId, row?.id)),
    brand_name: String(firstNonEmpty(row?.channelBrandName, row?.brandName, row?.name)),
  })).filter((row) => row.brand_code && row.brand_name);
  const receipt = {
    generated_at: isoNow(),
    channel_id: normalizedChannelId,
    search_text: normalizedSearch,
    endpoint: CHANNEL_BRAND_QUERY_URL.replace(/[?].*$/, ''),
    candidates,
    response_data: response.data,
  };
  const receiptPath = path.join(
    runDir,
    `channel-brand-query-${normalizedChannelId}-${sha256(normalizedSearch).slice(0, 16)}.json`,
  );
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'channel_brand_query_read_only', {
    channel_id: normalizedChannelId,
    search_text: normalizedSearch,
    candidate_count: candidates.length,
    receipt_path: receiptPath,
  });
  return { receiptPath, channelId: normalizedChannelId, searchText: normalizedSearch, candidates };
}

async function queryChannelCategoryRecommendation(page, runDir, spuName, upc = '') {
  const normalizedName = String(spuName || '').replace(/\s+/g, ' ').trim();
  const normalizedUpc = String(upc || '').trim();
  if (!normalizedName) throw new Error('渠道类目推荐缺少商品名称');
  const response = await signedJson(page, {
    url: CHANNEL_CATEGORY_RECOMMEND_URL,
    body: {
      channelIds: [100, 200, 300],
      spuUpcNameInfoVOS: [{ upc: normalizedUpc, name: normalizedName }],
    },
    qnhReferrer: '/unifiedGoods/tenant/edit',
  });
  assertResponse(response, `查询渠道类目推荐：${normalizedName.slice(0, 40)}`);
  const rows = toArray(toObject(response.data).data);
  const matched = rows.find((row) => (
    String(row?.name || '') === normalizedName && String(row?.upc || '') === normalizedUpc
  )) || rows[0] || {};
  const candidates = toArray(matched.recommendChannelCategoryList).map((row) => ({
    channel_id: Number(row?.channelId || 0),
    category_code: String(row?.categoryId || ''),
    category_name: String(row?.categoryName || ''),
    category_code_path: String(row?.idPath || ''),
    category_name_path: String(row?.namePath || ''),
    upc_required: row?.upcRequired ?? null,
    resource_type: row?.resourceType ?? null,
    existed_in_retail_and_medicine: row?.existedInRetailAndMedicine ?? null,
    medical_device_qua_requirement: row?.medicalDeviceQuaRequirement ?? null,
  })).filter((row) => (
    row.channel_id && row.category_code && row.category_name
    && row.category_code_path && row.category_name_path
  ));
  const receipt = {
    generated_at: isoNow(),
    spu_name: normalizedName,
    upc: normalizedUpc,
    endpoint: CHANNEL_CATEGORY_RECOMMEND_URL.replace(/[?].*$/, ''),
    candidates,
    response_data: response.data,
  };
  const receiptPath = path.join(
    runDir,
    `channel-category-recommend-${sha256(`${normalizedName}\n${normalizedUpc}`).slice(0, 16)}.json`,
  );
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'channel_category_recommendation_read_only', {
    spu_name: normalizedName.slice(0, 120),
    upc: normalizedUpc,
    candidate_count: candidates.length,
    receipt_path: receiptPath,
  });
  return { receiptPath, spuName: normalizedName, upc: normalizedUpc, candidates };
}

async function queryChannelCategoryProperty(page, runDir, channelId, categoryCode) {
  const normalizedChannelId = Number(channelId);
  const normalizedCategoryCode = String(categoryCode || '').trim();
  if (!Number.isFinite(normalizedChannelId) || !normalizedCategoryCode) {
    throw new Error('渠道类目属性查询缺少渠道或类目编码');
  }
  const response = await signedJson(page, {
    url: CHANNEL_CATEGORY_PROPERTY_BATCH_URL,
    body: {
      channelCategoryCodeMapV2: {
        [String(normalizedChannelId)]: [{ channelCategoryId: normalizedCategoryCode }],
      },
    },
    qnhReferrer: '/unifiedGoods/tenant/edit',
  });
  assertResponse(response, `查询渠道类目属性：${normalizedChannelId}/${normalizedCategoryCode}`);
  const data = toObject(toObject(response.data).data);
  const contracts = toArray(data[String(normalizedChannelId)]).filter((row) => (
    Number(row?.channelId || 0) === normalizedChannelId
    && String(row?.channelCategoryId || '') === normalizedCategoryCode
  ));
  if (contracts.length !== 1) {
    throw new Error(
      `渠道类目属性合同不存在或不唯一：${normalizedChannelId}/${normalizedCategoryCode}/${contracts.length}`,
    );
  }
  const receipt = {
    generated_at: isoNow(),
    channel_id: normalizedChannelId,
    category_code: normalizedCategoryCode,
    endpoint: CHANNEL_CATEGORY_PROPERTY_BATCH_URL.replace(/[?].*$/, ''),
    contracts,
    response_data: response.data,
  };
  const receiptPath = path.join(
    runDir,
    `channel-category-property-${normalizedChannelId}-${sha256(normalizedCategoryCode).slice(0, 16)}.json`,
  );
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'channel_category_property_read_only', {
    channel_id: normalizedChannelId,
    category_code: normalizedCategoryCode,
    receipt_path: receiptPath,
  });
  return { receiptPath, channelId: normalizedChannelId, categoryCode: normalizedCategoryCode, contract: contracts[0] };
}

function flattenStoreCategories(categories, parentNames = []) {
  return toArray(categories).flatMap((row) => {
    const name = String(row?.name || '').trim();
    const namePath = [...parentNames, name].filter(Boolean).join('>');
    const children = [
      row?.children,
      row?.childList,
      row?.childCategoryList,
      row?.categoryList,
    ].find(Array.isArray) || [];
    const current = {
      category_code: String(firstNonEmpty(row?.categoryId, row?.categoryCode, row?.id)),
      parent_category_code: String(firstNonEmpty(row?.parentCategoryId, row?.parentCategoryCode)),
      name,
      name_path: namePath,
      level: Number(row?.level || 0),
      enable: Number(row?.enable ?? 1),
      type: Number(row?.type || 0),
      channel_id_list: toArray(row?.channelIdList).map(Number),
      is_leaf: children.length === 0,
    };
    return [current, ...flattenStoreCategories(children, [...parentNames, name])];
  });
}

async function queryStoreFrontCategories(page, runDir) {
  const response = await signedJson(page, {
    url: STORE_FRONT_CATEGORY_QUERY_URL,
    body: { storeGroupId: 0, sceneIdentity: 10, storeSpuCustomFlag: 0 },
    qnhReferrer: '/unifiedGoods/tenant/edit',
  });
  assertResponse(response, '查询店内分类');
  const rawData = toObject(response.data).data;
  const parsedData = typeof rawData === 'string' ? JSON.parse(rawData) : toObject(rawData);
  const categories = flattenStoreCategories(parsedData.categoryList);
  const receipt = {
    generated_at: isoNow(),
    endpoint: STORE_FRONT_CATEGORY_QUERY_URL.replace(/[?].*$/, ''),
    request: { storeGroupId: 0, sceneIdentity: 10, storeSpuCustomFlag: 0 },
    categories,
    response_data: parsedData,
  };
  const receiptPath = path.join(runDir, 'store-front-category-query.json');
  await writeJson(receiptPath, receipt);
  await appendLog(runDir, 'store_front_category_read_only', {
    category_count: categories.length,
    enabled_leaf_count: categories.filter((row) => row.enable === 1 && row.is_leaf).length,
    receipt_path: receiptPath,
  });
  return { receiptPath, categories };
}

function exactOption(prop, value) {
  return toArray(prop.attrValueList).find(
    (candidate) => String(candidate?.attrValue || '') === String(value),
  );
}

function structUnitOption(prop, value) {
  for (const template of toArray(prop.structAttrTemplateList)) {
    for (const format of toArray(template?.valueFormatList)) {
      for (const option of toArray(format?.optionList)) {
        if (String(option?.optionValue || '') === String(value)) return option;
      }
    }
  }
  return null;
}

function gtinValid(value) {
  const text = String(value || '');
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text)) return false;
  const digits = [...text].map(Number);
  let total = 0;
  for (let offset = 1; offset < digits.length; offset += 1) {
    total += digits[digits.length - 1 - offset] * (offset % 2 === 1 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10 === digits.at(-1);
}

function applyDirectPlanToDetail(detail, plan) {
  const patched = structuredClone(detail);
  const changedChannelIds = new Set();
  const changedCoverageFields = new Set();
  const requested = [];
  const basicBrand = toObject(plan.basic_brand_field);
  if (Object.keys(basicBrand).length) {
    const verifiedBrand = toObject(plan.__verified_basic_brand);
    const brandCode = String(basicBrand.brand_code || '');
    const brandName = String(basicBrand.brand_name || '').trim();
    const oldBrand = toObject(patched.brand);
    const oldBrandCode = String(firstNonEmpty(
      oldBrand.brandCode,
      oldBrand.brandId,
      patched.brandCode,
      patched.brandId,
    ));
    const oldBrandName = String(firstNonEmpty(oldBrand.brandName, patched.brandName));
    const expectedOld = toObject(basicBrand.expected_old_brand);
    if (
      !brandCode
      || !brandName
      || String(verifiedBrand.brand_code || '') !== brandCode
      || String(verifiedBrand.brand_name || '') !== brandName
    ) {
      throw new Error('总部品牌计划缺少经过查询回执验证的品牌编码和名称');
    }
    if (
      Object.prototype.hasOwnProperty.call(basicBrand, 'expected_old_brand')
      && (
        String(expectedOld.brand_code || '') !== oldBrandCode
        || String(expectedOld.brand_name || '') !== oldBrandName
      )
    ) {
      throw new Error('总部品牌旧值已变化，停止覆盖');
    }
    if (oldBrandCode !== brandCode || oldBrandName !== brandName) {
      patched.brand = { clean: null, brandName, brandCode };
      patched.brandInfo = { value: brandCode, label: brandName };
      patched.brandCode = brandCode;
      requested.push({
        field_path: 'basic.brand',
        old_value: { brand_code: oldBrandCode, brand_name: oldBrandName },
        new_value: { brand_code: brandCode, brand_name: brandName },
        source: 'qnh_master_brand_exact_query',
        evidence: String(basicBrand.evidence || '').slice(0, 500),
      });
      changedCoverageFields.add('brand');
    }
  }
  const title = toObject(plan.text_fields).basicInfo_spuName;
  const expectedOldTitle = String(plan.expected_old_title ?? '');
  if (
    title !== undefined
    && expectedOldTitle
    && String(patched.spuName || '') !== expectedOldTitle
  ) {
    throw new Error('商品标题已变化，停止覆盖');
  }
  if (title !== undefined && String(title).trim() && String(patched.spuName || '') !== String(title).trim()) {
    requested.push({
      field_path: 'title',
      old_value: String(patched.spuName || ''),
      new_value: String(title).trim(),
    });
    patched.spuName = String(title).trim();
    patched.goodsName = String(title).trim();
    changedCoverageFields.add('product_name');
  }
  const sellingPoint = toObject(plan.text_fields).sellingPoint;
  if (
    sellingPoint !== undefined
    && String(patched.sellPoint || '') !== String(sellingPoint).trim()
  ) {
    requested.push({
      field_path: 'selling_point',
      old_value: String(patched.sellPoint || ''),
      new_value: String(sellingPoint).trim(),
    });
    patched.sellPoint = String(sellingPoint).trim();
  }
  for (const item of toArray(plan.recommended_channel_category_fields)) {
    const channelId = Number(item?.channel_id || 0);
    const categoryCode = String(item?.category_code || '');
    const categoryName = String(item?.category_name || '');
    const categoryCodePath = String(item?.category_code_path || '');
    const categoryNamePath = String(item?.category_name_path || '');
    const expectedOldCategoryCode = String(item?.expected_old_category_code || '');
    const verified = toArray(plan.__verified_recommended_categories).find((candidate) => (
      Number(candidate?.channel_id || 0) === channelId
      && String(candidate?.category_code || '') === categoryCode
      && String(candidate?.category_name || '') === categoryName
      && String(candidate?.category_code_path || '') === categoryCodePath
      && String(candidate?.category_name_path || '') === categoryNamePath
    ));
    if (!channelId || !categoryCode || !categoryName || !categoryCodePath || !categoryNamePath || !verified) {
      throw new Error('渠道推荐类目计划缺少经过推荐/属性回执验证的完整类目路径');
    }
    const channel = toArray(patched.spuChannelInfoList).find(
      (candidate) => Number(candidate?.channelId || 0) === channelId,
    );
    if (!channel) throw new Error(`渠道推荐类目计划找不到渠道：${channelId}`);
    const oldCategory = {
      category_code: String(channel.categoryCode || ''),
      category_name: String(channel.categoryName || ''),
      category_code_path: String(channel.categoryCodePath || ''),
      category_name_path: String(channel.categoryNamePath || ''),
    };
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_category_code')
      && oldCategory.category_code !== expectedOldCategoryCode
    ) {
      throw new Error(`渠道 ${channelId} 类目旧值已变化，停止覆盖`);
    }
    const newCategory = {
      category_code: categoryCode,
      category_name: categoryName,
      category_code_path: categoryCodePath,
      category_name_path: categoryNamePath,
    };
    if (JSON.stringify(oldCategory) === JSON.stringify(newCategory)) continue;
    const contract = toObject(verified.contract);
    channel.categoryCode = categoryCode;
    channel.categoryName = categoryName;
    channel.categoryCodePath = categoryCodePath;
    channel.categoryNamePath = categoryNamePath;
    channel.categoryProperties = structuredClone(toArray(contract.channelDynamicInfoVOList));
    channel.supportSpecType = contract.supportSpecType ?? null;
    channel.saleAttrList = [];
    channel.upcRequired = verified.upc_required ?? null;
    channel.resourceType = verified.resource_type ?? null;
    channel.existedInRetailAndMedicine = verified.existed_in_retail_and_medicine ?? null;
    channel.medicalDeviceQuaRequirement = verified.medical_device_qua_requirement ?? null;
    changedChannelIds.add(channelId);
    requested.push({
      field_path: `channel_category.${channelId}`,
      old_value: oldCategory,
      new_value: newCategory,
      source: 'qnh_official_channel_category_recommendation',
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.channel_brand_info_fields)) {
    const channelId = Number(item?.channel_id || 0);
    const brandCode = String(item?.brand_code || '');
    const brandName = String(item?.brand_name || '').trim();
    const verified = toArray(plan.__verified_channel_brand_infos).some((candidate) => (
      Number(candidate?.channel_id || 0) === channelId
      && String(candidate?.brand_code || '') === brandCode
      && String(candidate?.brand_name || '') === brandName
    ));
    if (!channelId || !brandCode || !brandName || !verified) {
      throw new Error('渠道品牌主字段缺少经过查询回执验证的品牌编码和名称');
    }
    const channel = toArray(patched.spuChannelInfoList).find(
      (candidate) => Number(candidate?.channelId || 0) === channelId,
    );
    if (!channel) throw new Error(`渠道品牌主字段找不到渠道：${channelId}`);
    const oldBrand = {
      brand_code: String(toObject(channel.brandInfo).brandCode || ''),
      brand_name: String(toObject(channel.brandInfo).brandName || ''),
    };
    const expectedOld = toObject(item.expected_old_brand);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_brand')
      && (
        String(expectedOld.brand_code || '') !== oldBrand.brand_code
        || String(expectedOld.brand_name || '') !== oldBrand.brand_name
      )
    ) {
      throw new Error(`渠道 ${channelId} 品牌旧值已变化，停止覆盖`);
    }
    const newBrand = { brand_code: brandCode, brand_name: brandName };
    if (JSON.stringify(oldBrand) === JSON.stringify(newBrand)) continue;
    channel.brandInfo = { clean: null, brandName, brandCode };
    changedChannelIds.add(channelId);
    requested.push({
      field_path: `channel_brand.${channelId}`,
      old_value: oldBrand,
      new_value: newBrand,
      source: 'qnh_channel_brand_exact_query',
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  const storeCategory = toObject(plan.store_front_category_field);
  if (Object.keys(storeCategory).length) {
    const categoryCode = String(storeCategory.category_code || '');
    const categoryName = String(storeCategory.name || '').trim();
    const namePath = String(storeCategory.name_path || '').trim();
    const verified = toObject(plan.__verified_store_front_category);
    if (
      !categoryCode
      || !categoryName
      || !namePath
      || String(verified.category_code || '') !== categoryCode
      || String(verified.name || '') !== categoryName
      || String(verified.name_path || '') !== namePath
      || Number(verified.enable || 0) !== 1
      || verified.is_leaf !== true
    ) {
      throw new Error('店内分类计划缺少经过当前账号查询回执验证的启用叶子分类');
    }
    const oldStoreCategories = toArray(patched.storeFrontCategoryList);
    const expectedOldCodes = toArray(storeCategory.expected_old_category_codes).map(String);
    const oldCodes = oldStoreCategories.flatMap(
      (row) => toArray(row?.allCategoryCodeList).map(String),
    );
    if (
      Object.prototype.hasOwnProperty.call(storeCategory, 'expected_old_category_codes')
      && JSON.stringify(oldCodes) !== JSON.stringify(expectedOldCodes)
    ) {
      throw new Error('店内分类旧值已变化，停止覆盖');
    }
    const newStoreCategories = [{
      groupId: 0,
      storeCategoryList: [{
        categoryCode,
        name: categoryName,
        namePath,
        channelIdList: toArray(verified.channel_id_list).map(Number),
      }],
      auxiliaryStoreCategoryList: null,
      allCategoryCodeList: [categoryCode],
    }];
    if (JSON.stringify(oldStoreCategories) !== JSON.stringify(newStoreCategories)) {
      patched.storeFrontCategoryList = newStoreCategories;
      requested.push({
        field_path: 'store_front_category',
        old_value: oldStoreCategories,
        new_value: newStoreCategories,
        source: 'qnh_current_account_store_category_exact_query',
        evidence: String(storeCategory.evidence || '').slice(0, 500),
      });
    }
  }

  const requestedMainImages = toArray(plan.main_image_reuse_urls).map(String).filter(Boolean);
  if (requestedMainImages.length) {
    const current = toArray(patched.picUrlList).map(String).filter(Boolean);
    const allowedSources = [...current, ...toArray(patched.picContentList).map(String).filter(Boolean)];
    const sourceByNormalized = new Map(
      allowedSources.map((url) => [normalizedImageUrl(url), url]),
    );
    const next = [...current];
    for (const requestedUrl of requestedMainImages) {
      const sourceUrl = sourceByNormalized.get(normalizedImageUrl(requestedUrl));
      if (!sourceUrl) {
        throw new Error(`主图复用 URL 不属于当前商品已有主图/详情图：${requestedUrl}`);
      }
      if (!next.some((url) => normalizedImageUrl(url) === normalizedImageUrl(sourceUrl))) {
        next.push(sourceUrl);
      }
    }
    if (next.length > 10) throw new Error('主图复用后超过平台 10 张上限');
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      patched.picUrlList = next;
      requested.push({
        field_path: 'main_images',
        old_value: current,
        new_value: next,
      });
      changedCoverageFields.add('picture');
    }
  }
  const requestedUploadedMainImage = toObject(plan.main_image_uploaded);
  if (Object.keys(requestedUploadedMainImage).length) {
    const current = toArray(patched.picUrlList).map(String).filter(Boolean);
    const expectedOld = toArray(plan.expected_old_main_image_urls).map(String).filter(Boolean);
    if (!expectedOld.length) {
      throw new Error('生成主图计划必须提供 expected_old_main_image_urls');
    }
    if (
      JSON.stringify(current.map(normalizedImageUrl))
      !== JSON.stringify(expectedOld.map(normalizedImageUrl))
    ) {
      throw new Error('生成主图写回前主图集合或顺序已变化，停止替换');
    }
    const verifiedUrl = String(plan.__verified_main_image_uploaded_url || '');
    if (
      !verifiedUrl
      || normalizedImageUrl(verifiedUrl)
        !== normalizedImageUrl(requestedUploadedMainImage.url)
    ) {
      throw new Error('生成主图 URL 未通过生成物与上传回执绑定校验');
    }
    const mode = String(requestedUploadedMainImage.mode || 'replace_first');
    if (mode !== 'replace_first') {
      throw new Error('独立生成主图当前只允许 replace_first');
    }
    const next = expectedMainImageReplacement(current, verifiedUrl);
    if (
      next.length < 3
      || next.length > 10
      || new Set(next.map(normalizedImageUrl)).size !== next.length
    ) {
      throw new Error('生成主图替换后必须保留3–10张不重复主图');
    }
    if (
      JSON.stringify(current.map(normalizedImageUrl))
      !== JSON.stringify(next.map(normalizedImageUrl))
    ) {
      patched.picUrlList = next;
      requested.push({
        field_path: 'main_images',
        old_value: current,
        new_value: next,
        source: 'qnh_main_image_art_uploaded_receipt',
        evidence: String(requestedUploadedMainImage.evidence || '').slice(0, 500),
      });
      changedCoverageFields.add('picture');
    }
  }
  const requestedMainImageOrder = toArray(plan.main_image_order_urls).map(String).filter(Boolean);
  if (requestedMainImageOrder.length) {
    const current = toArray(patched.picUrlList).map(String).filter(Boolean);
    const expectedOld = toArray(plan.expected_old_main_image_urls).map(String).filter(Boolean);
    if (
      expectedOld.length
      && JSON.stringify(current.map(normalizedImageUrl))
        !== JSON.stringify(expectedOld.map(normalizedImageUrl))
    ) {
      throw new Error('主图集合或顺序已变化，停止重排');
    }
    if (
      requestedMainImageOrder.length !== current.length
      || new Set(requestedMainImageOrder.map(normalizedImageUrl)).size !== current.length
      || current.some((url) => !requestedMainImageOrder
        .some((candidate) => normalizedImageUrl(candidate) === normalizedImageUrl(url)))
    ) {
      throw new Error('主图重排必须保留当前同SPU完整图片集合且不得增删');
    }
    if (
      JSON.stringify(current.map(normalizedImageUrl))
      !== JSON.stringify(requestedMainImageOrder.map(normalizedImageUrl))
    ) {
      patched.picUrlList = requestedMainImageOrder;
      requested.push({
        field_path: 'main_images',
        old_value: current,
        new_value: requestedMainImageOrder,
        source: 'same_spu_reviewed_main_image_reorder',
        evidence: String(plan.main_image_order_evidence || '').slice(0, 500),
      });
      changedCoverageFields.add('picture');
    }
  }
  const requestedMainImageReplacement = toArray(plan.main_image_replace_urls)
    .map(String)
    .filter(Boolean);
  if (requestedMainImageReplacement.length) {
    const current = toArray(patched.picUrlList).map(String).filter(Boolean);
    const expectedOld = toArray(plan.expected_old_main_image_urls).map(String).filter(Boolean);
    if (
      expectedOld.length
      && JSON.stringify(current.map(normalizedImageUrl))
        !== JSON.stringify(expectedOld.map(normalizedImageUrl))
    ) {
      throw new Error('主图集合或顺序已变化，停止替换');
    }
    const currentByNormalized = new Map(
      current.map((url) => [normalizedImageUrl(url), url]),
    );
    const next = requestedMainImageReplacement.map((url) => {
      const currentUrl = currentByNormalized.get(normalizedImageUrl(url));
      if (!currentUrl) {
        throw new Error(`主图替换只能保留当前同SPU已有主图：${url}`);
      }
      return currentUrl;
    });
    if (
      next.length < 3
      || next.length > 10
      || new Set(next.map(normalizedImageUrl)).size !== next.length
    ) {
      throw new Error('主图替换后必须保留3–10张不重复的当前同SPU主图');
    }
    if (
      JSON.stringify(current.map(normalizedImageUrl))
      !== JSON.stringify(next.map(normalizedImageUrl))
    ) {
      patched.picUrlList = next;
      requested.push({
        field_path: 'main_images',
        old_value: current,
        new_value: next,
        source: 'same_spu_reviewed_main_image_replace',
        evidence: String(plan.main_image_replace_evidence || '').slice(0, 500),
      });
      changedCoverageFields.add('picture');
    }
  }

  const requestedGalleryImages = toArray(plan.main_image_gallery_urls).map(String).filter(Boolean);
  if (requestedGalleryImages.length) {
    const current = toArray(patched.picUrlList).map(String).filter(Boolean);
    const verifiedGalleryUrls = new Map(
      toArray(plan.__verified_gallery_urls)
        .map(String)
        .filter(Boolean)
        .map((url) => [normalizedImageUrl(url), url]),
    );
    const next = [...current];
    for (const requestedUrl of requestedGalleryImages) {
      const verifiedUrl = verifiedGalleryUrls.get(normalizedImageUrl(requestedUrl));
      if (!verifiedUrl) {
        throw new Error(`图库 URL 未通过本次商品名称查询回执校验：${requestedUrl}`);
      }
      if (!next.some((url) => normalizedImageUrl(url) === normalizedImageUrl(verifiedUrl))) {
        next.push(verifiedUrl);
      }
    }
    if (next.length > 10) throw new Error('牵牛花图库补图后超过美团闪购 10 张展示上限');
    const minimum = Math.max(1, Math.floor(Number(plan.minimum_main_image_count) || 3));
    if (next.length < minimum) {
      throw new Error(`牵牛花图库补图不足最低 ${minimum} 张要求：当前仅 ${next.length} 张`);
    }
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      patched.picUrlList = next;
      requested.push({
        field_path: 'main_images',
        old_value: current,
        new_value: next,
        source: 'qnh_gallery_exact_title_query',
        gallery_search_text: String(plan.gallery_search_text || ''),
      });
      changedCoverageFields.add('picture');
    }
  }

  const requestedDetailImages = toArray(plan.detail_image_reuse_urls).map(String).filter(Boolean);
  if (requestedDetailImages.length) {
    const current = toArray(patched.picContentList).map(String).filter(Boolean);
    const allowedSources = [...toArray(patched.picUrlList), ...current].map(String).filter(Boolean);
    const sourceByNormalized = new Map(
      allowedSources.map((url) => [normalizedImageUrl(url), url]),
    );
    const next = [...current];
    for (const requestedUrl of requestedDetailImages) {
      const sourceUrl = sourceByNormalized.get(normalizedImageUrl(requestedUrl));
      if (!sourceUrl) {
        throw new Error(`详情图复用 URL 不属于当前商品已有主图/详情图：${requestedUrl}`);
      }
      if (!next.some((url) => normalizedImageUrl(url) === normalizedImageUrl(sourceUrl))) {
        next.push(sourceUrl);
      }
    }
    if (next.length > 30) throw new Error('详情图复用后超过安全上限 30 张');
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      patched.picContentList = next;
      requested.push({
        field_path: 'detail_images',
        old_value: current,
        new_value: next,
      });
      changedCoverageFields.add('picture');
    }
  }

  const specialPictureReplace = toArray(plan.special_picture_replace);
  if (specialPictureReplace.length) {
    const allowedSources = [
      ...toArray(patched.picUrlList).map(String).filter(Boolean),
      ...toArray(patched.picContentList).map(String).filter(Boolean),
    ];
    const sourceByNormalized = new Map(
      allowedSources.map((url) => [normalizedImageUrl(url), url]),
    );
    const pictures = toArray(patched.mtSpecialPictureList);
    for (const item of specialPictureReplace) {
      const pictureType = Number(item?.picture_type);
      const pictureTitle = String(item?.picture_title || '');
      const picture = pictures.find((candidate) => (
        Number(candidate?.pictureType) === pictureType
        && (!pictureTitle || String(candidate?.pictureTitle || '') === pictureTitle)
      ));
      if (!picture) throw new Error(`未找到待替换资质图槽位：${pictureType}/${pictureTitle}`);
      const oldUrls = toArray(picture.pictureUrl).map(String).filter(Boolean);
      const expectedOldUrls = toArray(item?.expected_old_urls).map(String).filter(Boolean);
      if (
        Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_urls')
        && JSON.stringify(oldUrls.map(normalizedImageUrl))
          !== JSON.stringify(expectedOldUrls.map(normalizedImageUrl))
      ) {
        throw new Error(`资质图槽位旧值已变化：${pictureType}/${pictureTitle}`);
      }
      const finalUrls = toArray(item?.urls).map((url) => {
        const sourceUrl = sourceByNormalized.get(normalizedImageUrl(url));
        if (!sourceUrl) throw new Error('资质图替换来源必须是当前商品已有主图或详情图');
        return sourceUrl;
      });
      if (
        finalUrls.length < Number(picture.numMin || 1)
        || finalUrls.length > Number(picture.numLimit || 4)
      ) {
        throw new Error(`资质图替换数量不满足槽位限制：${pictureType}/${finalUrls.length}`);
      }
      if (
        new Set(finalUrls.map(normalizedImageUrl)).size !== finalUrls.length
      ) {
        throw new Error(`资质图替换集合存在重复 URL：${pictureType}`);
      }
      if (
        JSON.stringify(oldUrls.map(normalizedImageUrl))
        === JSON.stringify(finalUrls.map(normalizedImageUrl))
      ) {
        continue;
      }
      picture.pictureUrl = finalUrls;
      requested.push({
        field_path: `special_picture.${pictureType}`,
        old_value: oldUrls,
        new_value: finalUrls,
      });
    }
    patched.mtSpecialPictureList = pictures;
    const meituan = toArray(patched.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (meituan) meituan.specialPictureList = structuredClone(pictures);
    changedCoverageFields.add('mt_channel_category_property');
  }

  const specialPictureReuse = toArray(plan.special_picture_reuse);
  if (specialPictureReuse.length) {
    const allowedSources = [
      ...toArray(patched.picUrlList).map(String).filter(Boolean),
      ...toArray(patched.picContentList).map(String).filter(Boolean),
    ];
    const sourceByNormalized = new Map(
      allowedSources.map((url) => [normalizedImageUrl(url), url]),
    );
    const pictures = toArray(patched.mtSpecialPictureList);
    const currentAuditText = JSON.stringify([
      patched.abnormalMarkMsg,
      patched.abnormalTips,
      patched.noSaleChannelInfoList,
    ]);
    for (const item of specialPictureReuse) {
      const pictureType = Number(item?.picture_type);
      const pictureTitle = String(item?.picture_title || '');
      const sourceUrl = sourceByNormalized.get(normalizedImageUrl(item?.url));
      if (!Number.isFinite(pictureType) || !sourceUrl) {
        throw new Error('资质图复用必须提供当前商品已有图片 URL 和有效 picture_type');
      }
      let picture = pictures.find((candidate) => (
        Number(candidate?.pictureType) === pictureType
        && (!pictureTitle || String(candidate?.pictureTitle || '') === pictureTitle)
      ));
      if (
        !picture
        && pictureType === 13
        && pictureTitle === '尺寸图'
        && currentAuditText.includes('缺少尺寸图')
      ) {
        picture = {
          pictureType: 13,
          pictureTitle: '尺寸图',
          pictureDesc: '展示商品实际尺寸，尺寸信息须清晰、准确且与所售商品一致。',
          pictureExample: [],
          isRequired: 1,
          isDisplay: 1,
          numLimit: 4,
          pictureUrl: null,
          customized: null,
          deleted: false,
          numMin: 1,
        };
        pictures.push(picture);
      }
      if (!picture) throw new Error(`未找到资质图槽位：${pictureType}/${pictureTitle}`);
      const oldUrls = toArray(picture.pictureUrl).map(String).filter(Boolean);
      if (oldUrls.some((url) => normalizedImageUrl(url) === normalizedImageUrl(sourceUrl))) continue;
      picture.pictureUrl = [sourceUrl, ...oldUrls].slice(0, Number(picture.numLimit || 4));
      requested.push({
        field_path: `special_picture.${pictureType}`,
        old_value: oldUrls,
        new_value: picture.pictureUrl,
      });
    }
    patched.mtSpecialPictureList = pictures;
    const meituan = toArray(patched.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (meituan) meituan.specialPictureList = structuredClone(pictures);
    changedCoverageFields.add('mt_channel_category_property');
  }

  const specialPictureGallery = toArray(plan.special_picture_gallery);
  if (specialPictureGallery.length) {
    const verifiedGalleryUrls = new Map(
      toArray(plan.__verified_gallery_urls)
        .map(String)
        .filter(Boolean)
        .map((url) => [normalizedImageUrl(url), url]),
    );
    const pictures = toArray(patched.mtSpecialPictureList);
    for (const item of specialPictureGallery) {
      const pictureType = Number(item?.picture_type);
      const pictureTitle = String(item?.picture_title || '');
      const verifiedUrl = verifiedGalleryUrls.get(normalizedImageUrl(item?.url));
      if (!Number.isFinite(pictureType) || !verifiedUrl) {
        throw new Error('图库资质图必须提供本次商品名称查询命中的 URL 和有效 picture_type');
      }
      const picture = pictures.find((candidate) => (
        Number(candidate?.pictureType) === pictureType
        && (!pictureTitle || String(candidate?.pictureTitle || '') === pictureTitle)
      ));
      if (!picture) throw new Error(`未找到图库资质图槽位：${pictureType}/${pictureTitle}`);
      const oldUrls = toArray(picture.pictureUrl).map(String).filter(Boolean);
      if (oldUrls.some((url) => normalizedImageUrl(url) === normalizedImageUrl(verifiedUrl))) continue;
      picture.pictureUrl = [verifiedUrl, ...oldUrls].slice(0, Number(picture.numLimit || 4));
      requested.push({
        field_path: `special_picture.${pictureType}`,
        old_value: oldUrls,
        new_value: picture.pictureUrl,
        source: 'qnh_gallery_exact_title_ocr_evidence',
        evidence: String(item?.evidence || '').slice(0, 500),
      });
    }
    patched.mtSpecialPictureList = pictures;
    const meituan = toArray(patched.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (meituan) meituan.specialPictureList = structuredClone(pictures);
    changedCoverageFields.add('mt_channel_category_property');
  }

  const specialPictureUploaded = toArray(plan.special_picture_uploaded);
  if (specialPictureUploaded.length) {
    const verifiedUploadedUrls = new Map(
      toArray(plan.__verified_uploaded_urls)
        .map(String)
        .filter(Boolean)
        .map((url) => [normalizedImageUrl(url), url]),
    );
    const pictures = toArray(patched.mtSpecialPictureList);
    const currentAuditText = JSON.stringify([
      patched.abnormalMarkMsg,
      patched.abnormalTips,
      patched.noSaleChannelInfoList,
    ]);
    for (const item of specialPictureUploaded) {
      const pictureType = Number(item?.picture_type);
      const pictureTitle = String(item?.picture_title || '');
      const verifiedUrl = verifiedUploadedUrls.get(normalizedImageUrl(item?.url));
      if (!Number.isFinite(pictureType) || !verifiedUrl) {
        throw new Error('生成资质图必须提供本次上传回执验证的 URL 和有效 picture_type');
      }
      if (!toArray(QUALIFICATION_WRITEBACK_POLICY.allowed_generated_picture_types)
        .map(Number).includes(pictureType)) {
        throw new Error(`生成资质图类型未被统一策略允许：${pictureType}/${pictureTitle}`);
      }
      let picture = pictures.find((candidate) => (
        Number(candidate?.pictureType) === pictureType
        && (!pictureTitle || String(candidate?.pictureTitle || '') === pictureTitle)
      ));
      if (!picture) {
        picture = synthesizeGeneratedPictureSlot(
          pictureType,
          pictureTitle,
          currentAuditText,
        );
        if (picture) pictures.push(picture);
      }
      if (!picture) throw new Error(`未找到生成资质图槽位：${pictureType}/${pictureTitle}`);
      const oldUrls = toArray(picture.pictureUrl).map(String).filter(Boolean);
      const expectedOldUrls = toArray(item?.expected_old_urls).map(String).filter(Boolean);
      if (
        QUALIFICATION_WRITEBACK_POLICY.require_expected_old_urls_match_when_present !== false
        && Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_urls')
        && JSON.stringify(oldUrls.map(normalizedImageUrl))
          !== JSON.stringify(expectedOldUrls.map(normalizedImageUrl))
      ) {
        throw new Error(`生成资质图槽位旧值已变化：${pictureType}/${pictureTitle}`);
      }
      const candidateUrls = item?.replace_existing === true
        ? [verifiedUrl]
        : [verifiedUrl, ...oldUrls];
      const uniqueUrls = QUALIFICATION_WRITEBACK_POLICY.deduplicate_urls === false
        ? candidateUrls
        : candidateUrls.filter((url, index, values) => (
          values.findIndex((candidate) => normalizedImageUrl(candidate) === normalizedImageUrl(url))
          === index
        ));
      const numLimit = QUALIFICATION_WRITEBACK_POLICY.use_live_slot_num_min_and_num_limit === false
        ? Number(QUALIFICATION_WRITEBACK_POLICY.default_num_limit || 4)
        : Number(picture.numLimit || QUALIFICATION_WRITEBACK_POLICY.default_num_limit || 4);
      const numMin = QUALIFICATION_WRITEBACK_POLICY.use_live_slot_num_min_and_num_limit === false
        ? Number(QUALIFICATION_WRITEBACK_POLICY.default_num_min || 1)
        : Number(picture.numMin || QUALIFICATION_WRITEBACK_POLICY.default_num_min || 1);
      const finalUrls = uniqueUrls.slice(0, numLimit);
      if (finalUrls.length < Math.max(1, numMin)) {
        throw new Error(`生成资质图数量不满足槽位限制：${pictureType}/${finalUrls.length}`);
      }
      if (
        JSON.stringify(oldUrls.map(normalizedImageUrl))
        === JSON.stringify(finalUrls.map(normalizedImageUrl))
      ) {
        continue;
      }
      picture.pictureUrl = finalUrls;
      requested.push({
        field_path: `special_picture.${pictureType}`,
        old_value: oldUrls,
        new_value: finalUrls,
        source: 'generated_picture_uploaded_receipt_and_fact_review',
        evidence: String(item?.evidence || '').slice(0, 500),
      });
    }
    patched.mtSpecialPictureList = pictures;
    const meituan = toArray(patched.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (meituan) meituan.specialPictureList = structuredClone(pictures);
    changedCoverageFields.add('mt_channel_category_property');
  }

  const requestedMedicalQualification = toObject(plan.medical_qualification);
  if (Object.keys(requestedMedicalQualification).length) {
    const verified = toObject(plan.__verified_medical_qualification);
    const pictureUrl = String(verified.picture_url || '');
    const approvalDate = String(verified.approval_date || '');
    const effectiveDate = verified.long_term === true
      ? '-1'
      : String(verified.effective_date || '');
    if (!pictureUrl || !approvalDate || !effectiveDate) {
      throw new Error('医疗器械资质计划未通过上传回执与日期证据校验');
    }
    const oldValue = toObject(patched.medicalDeviceQuaInfo);
    const newValue = {
      ...oldValue,
      quaPictures: [pictureUrl],
      quaApprovalDate: approvalDate,
      quaEffectiveDate: effectiveDate,
    };
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      patched.medicalDeviceQuaInfo = newValue;
      requested.push({
        field_path: 'medical_qualification',
        old_value: oldValue,
        new_value: newValue,
        source: 'trusted_public_registration_record',
        evidence: String(requestedMedicalQualification.evidence || '').slice(0, 500),
      });
      changedCoverageFields.add('mt_channel_category_property');
    }
  }

  if (plan.mirror_existing_special_pictures === true) {
    const pictures = toArray(patched.mtSpecialPictureList);
    const requiredPictures = pictures.filter((picture) => (
      Number(picture?.isRequired || 0) === 1 && picture?.deleted !== true
    ));
    const allRequiredFilled = requiredPictures.length > 0 && requiredPictures.every((picture) => (
      toArray(picture?.pictureUrl).map(String).filter(Boolean).length
      >= Math.max(1, Number(picture?.numMin || 1))
    ));
    if (!allRequiredFilled) {
      throw new Error('专项图双契约镜像仅允许全部必填槽位已有真实图片 URL 的商品');
    }
    const meituan = toArray(patched.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (!meituan) throw new Error('专项图双契约镜像未找到美团闪购渠道');
    const oldChannelPictures = toArray(meituan.specialPictureList);
    if (JSON.stringify(oldChannelPictures) !== JSON.stringify(pictures)) {
      meituan.specialPictureList = structuredClone(pictures);
      requested.push({
        field_path: 'special_picture_contract.channel100',
        old_value: oldChannelPictures,
        new_value: pictures,
        source: 'existing_top_level_special_picture_receipt',
      });
      changedCoverageFields.add('picture');
    }
  }

  for (const item of toArray(plan.sku_spec_fields)) {
    const skuId = String(item?.sku_id || '');
    const newSpecName = String(item?.new_spec_name || '').trim();
    if (!skuId || !newSpecName) throw new Error('SKU 规格计划缺少 sku_id/new_spec_name');
    const sku = toArray(patched.skus).find(
      (candidate) => String(candidate?.skuId || '') === skuId,
    );
    if (!sku) throw new Error(`SKU 规格计划找不到 SKU：${skuId}`);
    const oldSpecName = String(sku.specName || '');
    const expectedOld = String(item?.expected_old_spec_name || '');
    if (expectedOld && oldSpecName !== expectedOld) {
      throw new Error(`SKU ${skuId} 规格已变化：期望 ${expectedOld}，实际 ${oldSpecName}`);
    }
    if (oldSpecName === newSpecName) continue;
    sku.specName = newSpecName;
    if (item?.preserve_channel_sale_attrs !== true) {
      for (const channelInfo of toArray(sku.skuChannelInfoList)) {
        for (const saleAttr of toArray(channelInfo?.saleAttrValueList)) {
          if (String(saleAttr?.attrValue || '') === oldSpecName) {
            saleAttr.attrValue = newSpecName;
          }
        }
      }
    }
    requested.push({
      field_path: `sku.${skuId}.spec_name`,
      old_value: oldSpecName,
      new_value: newSpecName,
    });
    changedCoverageFields.add('spec');
  }

  for (const item of toArray(plan.sku_weight_fields)) {
    const skuId = String(item?.sku_id || '');
    const newWeight = String(item?.new_weight_for_unit || '').trim();
    const newWeightUnit = String(item?.new_weight_unit || '').trim();
    if (!skuId || !newWeight || !newWeightUnit || !Number.isFinite(Number(newWeight))) {
      throw new Error('SKU 重量计划缺少 sku_id/new_weight_for_unit/new_weight_unit');
    }
    const sku = toArray(patched.skus).find(
      (candidate) => String(candidate?.skuId || '') === skuId,
    );
    if (!sku) throw new Error(`SKU 重量计划找不到 SKU：${skuId}`);
    const oldWeight = String(sku.weightForUnit ?? '');
    const oldWeightUnit = String(sku.weightUnit ?? '');
    const expectedOldWeight = String(item?.expected_old_weight_for_unit ?? '');
    const expectedOldWeightUnit = String(item?.expected_old_weight_unit ?? '');
    if (
      (expectedOldWeight && oldWeight !== expectedOldWeight)
      || (expectedOldWeightUnit && oldWeightUnit !== expectedOldWeightUnit)
    ) {
      throw new Error(
        `SKU ${skuId} 重量已变化：期望 ${expectedOldWeight}${expectedOldWeightUnit}，实际 ${oldWeight}${oldWeightUnit}`,
      );
    }
    if (oldWeight === newWeight && oldWeightUnit === newWeightUnit) continue;
    sku.weightForUnit = newWeight;
    sku.weightUnit = newWeightUnit;
    sku.weight = Number(newWeight);
    requested.push({
      field_path: `sku.${skuId}.weight`,
      old_value: `${oldWeight}${oldWeightUnit}`,
      new_value: `${newWeight}${newWeightUnit}`,
    });
    changedCoverageFields.add('spec');
  }

  for (const item of toArray(plan.sku_upc_fields)) {
    const skuId = String(item?.sku_id || '');
    const upc = String(item?.upc || '').trim();
    if (!skuId || !gtinValid(upc)) {
      throw new Error('SKU 条码计划缺少 sku_id 或 GTIN 校验位不合法');
    }
    if (!String(item?.evidence_url || '').startsWith('http')) {
      throw new Error('SKU 条码计划必须提供可审计 evidence_url');
    }
    const sku = toArray(patched.skus).find(
      (candidate) => String(candidate?.skuId || '') === skuId,
    );
    if (!sku) throw new Error(`SKU 条码计划找不到 SKU：${skuId}`);
    const oldUpcList = toArray(sku.upcList).map(String).filter(Boolean);
    const expectedOldUpcList = toArray(item?.expected_old_upc_list).map(String).filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_upc_list')
      && JSON.stringify(oldUpcList) !== JSON.stringify(expectedOldUpcList)
    ) {
      throw new Error(`SKU ${skuId} 条码旧值已变化，停止覆盖`);
    }
    if (JSON.stringify(oldUpcList) === JSON.stringify([upc])) continue;
    sku.upcList = [upc];
    sku.goodsUpcList = [];
    sku.customizeNoUpcCode = 0;
    sku.useSkuAsUpc = 0;
    requested.push({
      field_path: `sku.${skuId}.upc_list`,
      old_value: oldUpcList,
      new_value: [upc],
    });
    changedCoverageFields.add('spec');
  }

  for (const item of toArray(plan.sku_no_upc_fields)) {
    const skuId = String(item?.sku_id || '');
    const scannedImageCount = Number(item?.scanned_image_count || 0);
    const evidence = String(item?.evidence || '').trim();
    const source = String(
      item?.source || 'same_spu_multi_image_no_gtin_and_generic_product',
    ).trim();
    if (!skuId || scannedImageCount < 3 || !evidence) {
      throw new Error('SKU 无条码计划必须提供 sku_id、至少 3 张同 SPU 扫描证据和 evidence');
    }
    const sku = toArray(patched.skus).find(
      (candidate) => String(candidate?.skuId || '') === skuId,
    );
    if (!sku) throw new Error(`SKU 无条码计划找不到 SKU：${skuId}`);
    const oldUpcList = toArray(sku.upcList).map(String).filter(Boolean);
    const oldNoUpcCode = Number(sku.customizeNoUpcCode || 0);
    const expectedOldUpcList = toArray(item?.expected_old_upc_list).map(String).filter(Boolean);
    if (
      expectedOldUpcList.length
      && JSON.stringify(oldUpcList) !== JSON.stringify(expectedOldUpcList)
    ) {
      throw new Error(`SKU ${skuId} 条码已变化，停止套用无条码计划`);
    }
    if (oldUpcList.length) {
      sku.upcList = [];
      sku.goodsUpcList = [];
      requested.push({
        field_path: `sku.${skuId}.upc_list`,
        old_value: oldUpcList,
        new_value: [],
        source,
        evidence,
      });
    }
    if (oldNoUpcCode !== 1) {
      sku.customizeNoUpcCode = 1;
      sku.useSkuAsUpc = 0;
      requested.push({
        field_path: `sku.${skuId}.customize_no_upc_code`,
        old_value: oldNoUpcCode,
        new_value: 1,
        source,
        evidence,
      });
    }
    if (oldUpcList.length || oldNoUpcCode !== 1) changedCoverageFields.add('spec');
  }

  for (const item of toArray(plan.sku_restore_upc_fields)) {
    const skuId = String(item?.sku_id || '');
    const restoreUpcList = toArray(item?.restore_upc_list).map(String).filter(Boolean);
    const expectedCurrentUpcList = toArray(item?.expected_current_upc_list).map(String).filter(Boolean);
    const expectedCurrentNoUpcCode = Number(item?.expected_current_no_upc_code);
    const rollbackReason = String(item?.rollback_reason || '').trim();
    if (
      !skuId
      || !restoreUpcList.length
      || expectedCurrentNoUpcCode !== 1
      || rollbackReason !== 'rollback_unsupported_no_upc_after_conflict'
    ) {
      throw new Error('SKU 条码回滚计划缺少受限回滚参数');
    }
    const sku = toArray(patched.skus).find(
      (candidate) => String(candidate?.skuId || '') === skuId,
    );
    if (!sku) throw new Error(`SKU 条码回滚计划找不到 SKU：${skuId}`);
    const oldUpcList = toArray(sku.upcList).map(String).filter(Boolean);
    const oldNoUpcCode = Number(sku.customizeNoUpcCode || 0);
    if (
      JSON.stringify(oldUpcList) !== JSON.stringify(expectedCurrentUpcList)
      || oldNoUpcCode !== expectedCurrentNoUpcCode
    ) {
      throw new Error(`SKU ${skuId} 当前状态不等于本轮无条码写入结果，停止回滚`);
    }
    sku.upcList = restoreUpcList;
    sku.goodsUpcList = [];
    sku.customizeNoUpcCode = 0;
    sku.useSkuAsUpc = 0;
    requested.push({
      field_path: `sku.${skuId}.upc_list`,
      old_value: oldUpcList,
      new_value: restoreUpcList,
      source: rollbackReason,
      evidence: String(item?.evidence || ''),
    });
    requested.push({
      field_path: `sku.${skuId}.customize_no_upc_code`,
      old_value: oldNoUpcCode,
      new_value: 0,
      source: rollbackReason,
      evidence: String(item?.evidence || ''),
    });
    changedCoverageFields.add('spec');
  }

  const pendingStructs = new Map();
  const fieldEntries = [
    ...Object.entries(toObject(plan.text_fields)),
    ...Object.entries(toObject(plan.select_fields)),
  ];
  for (const [fieldId, rawValue] of fieldEntries) {
    if (fieldId === 'basicInfo_spuName') continue;
    const match = fieldId.match(/^channelDynamicInfos_(\d+)___formData_([^_]+?)(?:_([12]))?$/);
    if (!match) continue;
    const channelIndex = Number(match[1]);
    const attrId = String(match[2]);
    const structPart = match[3] || '';
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel) throw new Error(`直连计划渠道索引不存在：${fieldId}`);
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连计划属性不存在：${fieldId}`);
    if (structPart) {
      const key = `${channelIndex}:${attrId}`;
      const current = pendingStructs.get(key) || { channelIndex, channel, prop };
      current[structPart === '1' ? 'number' : 'unit'] = String(rawValue);
      pendingStructs.set(key, current);
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)];
    const normalized = values.map((value) => {
      const option = exactOption(prop, value);
      if (!option) throw new Error(`直连计划值不在平台选项中：${prop.attrName}=${value}`);
      return {
        attrValueId: option.attrValueId ?? null,
        attrValue: option.attrValue,
        douyinDiyType: option.douyinDiyType ?? null,
        structAttrValueList: toArray(option.structAttrValueList),
        childrenJson: option.childrenJson ?? null,
      };
    });
    const oldValue = toArray(prop.customValue).map((value) => String(value?.attrValue || '')).filter(Boolean);
    if (JSON.stringify(oldValue) === JSON.stringify(values)) continue;
    prop.customValue = normalized;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: values,
    });
  }
  for (const item of pendingStructs.values()) {
    if (!item.number || !item.unit) {
      throw new Error(`直连结构化字段缺少数值或单位：${item.prop.attrName}`);
    }
    const unitOption = structUnitOption(item.prop, item.unit);
    if (!unitOption) throw new Error(`直连结构化单位不在平台选项中：${item.prop.attrName}=${item.unit}`);
    const normalized = [{
      structAttrValueList: [{
        valueList: [[
          { sequence: 1, value: item.number },
          {
            sequence: 2,
            optionId: unitOption.optionId ?? null,
            optionValue: unitOption.optionValue,
          },
        ]],
        formatType: 1,
      }],
    }];
    const oldValue = toArray(item.prop.customValue);
    if (JSON.stringify(oldValue) === JSON.stringify(normalized)) continue;
    item.prop.customValue = normalized;
    changedChannelIds.add(Number(item.channel.channelId || 0));
    requested.push({
      field_path: `channel.${item.channel.channelId}.${item.prop.attrName}`,
      old_value: oldValue,
      new_value: `${item.number}${item.unit}`,
    });
  }
  for (const item of toArray(plan.free_text_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const newValue = String(item?.new_value ?? '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !newValue) {
      throw new Error('直连自由文本渠道字段缺少 channel_index/attr_id/new_value');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连自由文本渠道属性不存在：${channelIndex}/${attrId}`);
    if (String(prop.attrValueType || '') !== '3') {
      throw new Error(`直连自由文本渠道属性类型不匹配：${prop.attrName}/${prop.attrValueType}`);
    }
    if (Number(prop.maxTextLength || 0) > 0 && newValue.length > Number(prop.maxTextLength)) {
      throw new Error(`直连自由文本渠道字段超过长度限制：${prop.attrName}/${newValue.length}`);
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`直连自由文本渠道字段旧值已变化：${prop.attrName}`);
    }
    if (JSON.stringify(oldValue) === JSON.stringify([newValue])) continue;
    prop.customValue = [{
      attrValueId: null,
      attrValue: newValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    // QNH type-8 scalar/date fields are only durable when the edit-form
    // mirror is populated as well; update/v2 otherwise accepts the payload
    // but the independent detail read drops the value.
    prop.originalInputValue = newValue;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [newValue],
    });
  }
  for (const item of toArray(plan.date_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const newValue = String(item?.new_value ?? '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !/^\d{4}-\d{2}-\d{2}$/.test(newValue)) {
      throw new Error('直连日期渠道字段缺少 channel_index/attr_id 或 YYYY-MM-DD 日期');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连日期渠道属性不存在：${channelIndex}/${attrId}`);
    if (String(prop.attrValueType || '') !== '8') {
      throw new Error(`直连日期渠道属性类型不匹配：${prop.attrName}/${prop.attrValueType}`);
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`直连日期渠道字段旧值已变化：${prop.attrName}`);
    }
    const currentDateValue = toArray(prop.customValue)[0];
    if (
      JSON.stringify(oldValue) === JSON.stringify([newValue])
      && String(currentDateValue?.attrValueId ?? '') === '0'
      && String(prop.originalInputValue || '') === newValue
    ) continue;
    prop.customValue = [{
      attrValueId: '0',
      attrValue: newValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    prop.originalInputValue = newValue;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [newValue],
      source: 'explicit_date_default',
    });
  }
  for (const item of toArray(plan.custom_text_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const newValue = String(item?.new_value ?? '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const source = String(item?.source || 'explicit_product_identity').trim();
    const evidence = String(item?.evidence || '').trim();
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !newValue || !evidence) {
      throw new Error('直连自定义文本渠道字段缺少 channel_index/attr_id/new_value/evidence');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连自定义文本渠道属性不存在：${channelIndex}/${attrId}`);
    if (String(prop.attrValueType || '') !== '4') {
      throw new Error(`直连自定义文本渠道属性类型不匹配：${prop.attrName}/${prop.attrValueType}`);
    }
    if (Number(prop.maxTextLength || 0) > 0 && newValue.length > Number(prop.maxTextLength)) {
      throw new Error(`直连自定义文本渠道字段超过长度限制：${prop.attrName}/${newValue.length}`);
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`直连自定义文本渠道字段旧值已变化：${prop.attrName}`);
    }
    if (JSON.stringify(oldValue) === JSON.stringify([newValue])) continue;
    prop.customValue = [{
      // QNH type-4 custom text uses the sentinel id "0". A null id can be
      // accepted by update/v2 yet disappear from the independent readback.
      attrValueId: '0',
      attrValue: newValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    prop.originalInputValue = newValue;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [newValue],
      source,
      evidence,
    });
  }
  for (const item of toArray(plan.snapshot_brand_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const brandCode = String(item?.brand_code || '');
    const brandName = String(item?.brand_name || '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const verifiedBrands = toArray(plan.__verified_snapshot_brands);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !brandCode || !brandName) {
      throw new Error('快照品牌渠道字段缺少 channel_index/attr_id/brand_code/brand_name');
    }
    const verified = verifiedBrands.some((candidate) => (
      Number(candidate?.channel_id || 0) === Number(channel.channelId || 0)
      && String(candidate?.attr_id || '') === attrId
      && String(candidate?.brand_code || '') === brandCode
      && String(candidate?.brand_name || '') === brandName
    ));
    if (!verified) throw new Error('渠道品牌不在同租户同 SPU 历史详情快照中');
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop || String(prop.attrName || '') !== '品牌' || String(prop.attrValueType || '') !== '4') {
      throw new Error('快照品牌渠道字段契约不匹配');
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error('快照品牌渠道字段旧值已变化');
    }
    if (JSON.stringify(oldValue) === JSON.stringify([brandName])) continue;
    prop.customValue = [{
      attrValueId: brandCode,
      attrValue: brandName,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [brandName],
      source: 'same_tenant_same_spu_detail_snapshot',
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.tenant_snapshot_brand_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const brandCode = String(item?.brand_code || '');
    const brandName = String(item?.brand_name || '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const verifiedBrands = toArray(plan.__verified_tenant_snapshot_brands);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !brandCode || !brandName) {
      throw new Error('同租户快照品牌字段缺少 channel_index/attr_id/brand_code/brand_name');
    }
    const verified = verifiedBrands.some((candidate) => (
      Number(candidate?.channel_id || 0) === Number(channel.channelId || 0)
      && String(candidate?.attr_id || '') === attrId
      && String(candidate?.brand_code || '') === brandCode
      && String(candidate?.brand_name || '') === brandName
    ));
    if (!verified) throw new Error('品牌不在同租户同渠道详情快照中');
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop || String(prop.attrName || '') !== '品牌' || String(prop.attrValueType || '') !== '4') {
      throw new Error('同租户快照品牌字段契约不匹配');
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error('同租户快照品牌字段旧值已变化');
    }
    if (JSON.stringify(oldValue) === JSON.stringify([brandName])) continue;
    prop.customValue = [{
      attrValueId: brandCode,
      attrValue: brandName,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [brandName],
      source: 'same_tenant_same_channel_detail_snapshot',
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.remote_brand_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const brandCode = String(item?.brand_code || '');
    const brandName = String(item?.brand_name || '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const verifiedBrands = toArray(plan.__verified_channel_brands);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !brandCode || !brandName) {
      throw new Error('直连渠道品牌字段缺少 channel_index/attr_id/brand_code/brand_name');
    }
    const verified = verifiedBrands.some((candidate) => (
      String(candidate?.channel_id || '') === String(channel.channelId || '')
      && String(candidate?.brand_code || '') === brandCode
      && String(candidate?.brand_name || '') === brandName
    ));
    if (!verified) throw new Error('渠道品牌不在当前查询回执的精确候选中');
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop || String(prop.attrName || '') !== '品牌' || String(prop.attrValueType || '') !== '4') {
      throw new Error('直连渠道品牌字段契约不匹配');
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error('直连渠道品牌旧值已变化');
    }
    if (JSON.stringify(oldValue) === JSON.stringify([brandName])) continue;
    prop.customValue = [{
      attrValueId: brandCode,
      attrValue: brandName,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [brandName],
      source: 'qnh_channel_brand_exact_query',
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.exact_option_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const wanted = toArray(item?.values).map((value) => ({
      attrValueId: String(value?.attr_value_id || ''),
      attrValue: String(value?.value || ''),
    }));
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (
      !channel
      || !attrId
      || !wanted.length
      || wanted.some((value) => !value.attrValueId || !value.attrValue)
    ) {
      throw new Error('精确选项渠道字段缺少 channel_index/attr_id/values');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`精确选项渠道属性不存在：${channelIndex}/${attrId}`);
    const normalized = wanted.map((value) => {
      const option = toArray(prop.attrValueList).find((candidate) => (
        String(candidate?.attrValueId || '') === value.attrValueId
        && String(candidate?.attrValue || '') === value.attrValue
      ));
      if (!option) {
        throw new Error(`精确选项不在当前类目合同中：${prop.attrName}=${value.attrValue}`);
      }
      return {
        attrValueId: option.attrValueId ?? null,
        attrValue: option.attrValue,
        douyinDiyType: option.douyinDiyType ?? null,
        structAttrValueList: toArray(option.structAttrValueList),
        childrenJson: option.childrenJson ?? null,
      };
    });
    const oldValue = propertyDisplayValues(prop);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`精确选项渠道字段旧值已变化：${prop.attrName}`);
    }
    const newValues = wanted.map((value) => value.attrValue);
    const oldCanonicalValues = toArray(prop.customValue).map((value) => ({
      attrValueId: String(value?.attrValueId || ''),
      attrValue: String(value?.attrValue || ''),
    }));
    if (
      JSON.stringify(oldValue) === JSON.stringify(newValues)
      && JSON.stringify(oldCanonicalValues) === JSON.stringify(wanted)
    ) continue;
    prop.customValue = normalized;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: newValues,
      source: String(item?.source || 'exact_current_category_option'),
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.extendable_option_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const newValue = String(item?.new_value ?? '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !newValue) {
      throw new Error('可扩展选项渠道字段缺少 channel_index/attr_id/new_value');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`可扩展选项渠道属性不存在：${channelIndex}/${attrId}`);
    if (
      !['1', '2'].includes(String(prop.attrValueType || ''))
      || toArray(prop.attrValueList).length !== 0
    ) {
      throw new Error(`可扩展选项渠道属性合同不匹配：${prop.attrName}/${prop.attrValueType}`);
    }
    const oldValue = propertyDisplayValues(prop);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`可扩展选项渠道字段旧值已变化：${prop.attrName}`);
    }
    if (JSON.stringify(oldValue) === JSON.stringify([newValue])) continue;
    prop.customValue = [{
      attrValueId: '0',
      attrValue: newValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    prop.originalInputValue = newValue;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [newValue],
      source: String(item?.source || 'extendable_current_category_option'),
      evidence: String(item?.evidence || '').slice(0, 500),
    });
  }
  for (const item of toArray(plan.duration_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const number = String(item?.number ?? '').trim();
    const unit = String(item?.unit || '').trim();
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !/^\d+(?:\.\d+)?$/.test(number) || !unit) {
      throw new Error('直连期限渠道字段缺少 channel_index/attr_id/number/unit');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连期限渠道属性不存在：${channelIndex}/${attrId}`);
    if (String(prop.attrValueType || '') !== '9') {
      throw new Error(`直连期限渠道属性类型不匹配：${prop.attrName}/${prop.attrValueType}`);
    }
    const unitOption = toArray(prop.optionList).find(
      (option) => String(option?.optionValue || '') === unit,
    );
    if (!unitOption) {
      throw new Error(`直连期限渠道字段单位不在平台选项中：${prop.attrName}=${unit}`);
    }
    const newValue = `${number}${unit}`;
    if (Number(prop.maxTextLength || 0) > 0 && newValue.length > Number(prop.maxTextLength)) {
      throw new Error(`直连期限渠道字段超过长度限制：${prop.attrName}/${newValue.length}`);
    }
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`直连期限渠道字段旧值已变化：${prop.attrName}`);
    }
    const currentDurationValue = toArray(prop.customValue)[0];
    if (
      JSON.stringify(oldValue) === JSON.stringify([newValue])
      && String(currentDurationValue?.attrValueId ?? '') === String(unitOption.optionId ?? '')
    ) continue;
    prop.customValue = [{
      attrValueId: unitOption.optionId ?? null,
      attrValue: newValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }];
    prop.originalInputValue = newValue;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: [newValue],
      contract_kind: 'type9_number_unit',
      expected_unit_id: String(unitOption.optionId ?? ''),
    });
  }
  for (const item of toArray(plan.official_recommendation_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const recommendedValues = toArray(item?.values).map((value) => ({
      attrValueId: String(value?.attr_value_id || ''),
      attrValue: String(value?.value || ''),
    }));
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (
      !channel
      || !attrId
      || !recommendedValues.length
      || recommendedValues.some((value) => !value.attrValueId || !value.attrValue)
    ) {
      throw new Error('官方推荐渠道字段缺少 channel_index/attr_id/values');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`官方推荐渠道属性不存在：${channelIndex}/${attrId}`);
    const oldValue = toArray(prop.customValue)
      .map((value) => String(value?.attrValue ?? ''))
      .filter(Boolean);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldValue) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`官方推荐渠道字段旧值已变化：${prop.attrName}`);
    }
    const newValues = recommendedValues.map((value) => value.attrValue);
    const oldCanonicalValues = toArray(prop.customValue).map((value) => ({
      attrValueId: String(value?.attrValueId || ''),
      attrValue: String(value?.attrValue || ''),
    }));
    if (
      JSON.stringify(oldValue) === JSON.stringify(newValues)
      && JSON.stringify(oldCanonicalValues) === JSON.stringify(recommendedValues)
    ) continue;
    prop.customValue = recommendedValues.map((value) => ({
      attrValueId: value.attrValueId,
      attrValue: value.attrValue,
      douyinDiyType: null,
      structAttrValueList: [],
      childrenJson: null,
    }));
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: newValues,
      source: 'official_recommendation',
    });
  }
  for (const item of toArray(plan.structured_channel_fields)) {
    const channelIndex = Number(item?.channel_index);
    const attrId = String(item?.attr_id || '');
    const displayValue = String(item?.display_value || '');
    const parts = toArray(item?.parts);
    const expectedOldValues = toArray(item?.expected_old_values).map(String);
    const channel = toArray(patched.spuChannelInfoList)[channelIndex];
    if (!channel || !attrId || !displayValue || !parts.length) {
      throw new Error('直连结构化渠道字段缺少 channel_index/attr_id/display_value/parts');
    }
    const prop = toArray(channel.categoryProperties).find(
      (candidate) => String(candidate?.attrId || '') === attrId,
    );
    if (!prop) throw new Error(`直连结构化渠道属性不存在：${channelIndex}/${attrId}`);
    const oldDisplayValues = propertyDisplayValues(prop);
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'expected_old_values')
      && JSON.stringify(oldDisplayValues) !== JSON.stringify(expectedOldValues)
    ) {
      throw new Error(`直连结构化渠道字段旧值已变化：${prop.attrName}`);
    }
    const templateParts = toArray(prop.structAttrTemplateList)[0]?.valueFormatList;
    if (!Array.isArray(templateParts) || !templateParts.length) {
      throw new Error(`直连结构化渠道属性缺少平台模板：${prop.attrName}`);
    }
    const normalizedParts = parts.map((part) => {
      const sequence = Number(part?.sequence);
      const templatePart = templateParts.find(
        (candidate) => Number(candidate?.sequence) === sequence,
      );
      if (!templatePart) {
        throw new Error(`直连结构化字段序号不在平台模板中：${prop.attrName}/${sequence}`);
      }
      if (Number(templatePart.inputType) === 5) {
        const optionValue = String(part?.option_value || '');
        const option = toArray(templatePart.optionList).find(
          (candidate) => String(candidate?.optionValue || '') === optionValue,
        );
        if (!option) {
          throw new Error(`直连结构化字段单位不在平台选项中：${prop.attrName}=${optionValue}`);
        }
        return {
          sequence,
          value: null,
          optionId: option.optionId ?? null,
          optionValue: option.optionValue,
        };
      }
      const value = Number(templatePart.inputType) === 3
        ? String(templatePart.fixValue || '')
        : String(part?.value || '');
      if (!value) throw new Error(`直连结构化字段值为空：${prop.attrName}/${sequence}`);
      return {
        sequence,
        value,
        optionId: null,
        optionValue: null,
      };
    }).sort((left, right) => left.sequence - right.sequence);
    const expectedSequences = templateParts.map((part) => Number(part?.sequence));
    const actualSequences = normalizedParts.map((part) => part.sequence);
    if (JSON.stringify(actualSequences) !== JSON.stringify(expectedSequences)) {
      throw new Error(`直连结构化字段未完整覆盖平台模板：${prop.attrName}`);
    }
    const normalized = [{
      attrValueId: null,
      attrValue: null,
      douyinDiyType: null,
      structAttrValueList: [{
        formatType: 1,
        valueList: [normalizedParts],
        templateId: null,
      }],
      childrenJson: null,
    }];
    const oldValue = toArray(prop.customValue);
    if (JSON.stringify(oldValue) === JSON.stringify(normalized)) continue;
    prop.customValue = normalized;
    changedChannelIds.add(Number(channel.channelId || 0));
    requested.push({
      field_path: `channel.${channel.channelId}.${prop.attrName}`,
      attr_id: attrId,
      old_value: oldValue,
      new_value: displayValue,
      contract_kind: 'type10_structure',
    });
  }
  return {
    patched,
    requested,
    changedChannelIds: [...changedChannelIds],
    changedCoverageFields: [...changedCoverageFields],
  };
}

async function applyDirectPlanCore(
  page,
  runDir,
  planPath,
  dryRun,
  resultPrefix = 'direct',
  phaseBarrier = null,
) {
  const totalStartedAt = Date.now();
  const planLoadStartedAt = Date.now();
  const planRaw = await fs.readFile(planPath, 'utf8');
  const planSha256 = sha256(planRaw);
  const plan = JSON.parse(planRaw);
  const spuId = String(plan.spu_id || '');
  if (!spuId) throw new Error('直连计划缺少 spu_id');
  const stageTimings = {
    plan_load_ms: Date.now() - planLoadStartedAt,
  };
  const timedStage = async (stage, operation) => {
    const startedAt = Date.now();
    await appendLog(runDir, 'direct_plan_stage_started', {
      spu_id: spuId,
      stage,
      dry_run: dryRun,
    }).catch(() => {});
    try {
      return await operation();
    } finally {
      const elapsedMs = Date.now() - startedAt;
      stageTimings[`${stage}_ms`] = elapsedMs;
      await appendLog(runDir, 'direct_plan_stage_finished', {
        spu_id: spuId,
        stage,
        dry_run: dryRun,
        elapsed_ms: elapsedMs,
      }).catch(() => {});
    }
  };
  const mainImageMaterial = await timedStage(
    'material_precheck',
    () => loadVerifiedMainImageMaterial(plan, spuId),
  );
  const beforeDetail = await timedStage(
    'before_detail_read',
    () => fetchDetail(page, spuId),
  );
  const planPreparationStartedAt = Date.now();
  const beforeTenantId = String(beforeDetail.tenantId || '');
  if (
    mainImageMaterial
    && (
      String(beforeDetail.spuId || '') !== spuId
      || beforeTenantId !== mainImageMaterial.expectedTenantId
    )
  ) {
    throw new Error('生成主图计划的 SPU/expected_tenant_id 与当前商品不一致');
  }
  const beforeSummary = summarizeDetail(beforeDetail);
  let executionPlan = plan;
  const requestedCategories = toArray(plan.recommended_channel_category_fields);
  if (requestedCategories.length) {
    const verifiedCategories = [];
    for (const item of requestedCategories) {
      if (!item?.recommendation_receipt_path || !item?.property_receipt_path) {
        throw new Error('渠道推荐类目计划缺少 recommendation_receipt_path/property_receipt_path');
      }
      const recommendationReceipt = JSON.parse(await fs.readFile(
        path.resolve(String(item.recommendation_receipt_path)),
        'utf8',
      ));
      const propertyReceipt = JSON.parse(await fs.readFile(
        path.resolve(String(item.property_receipt_path)),
        'utf8',
      ));
      if (
        String(recommendationReceipt.spu_name || '') !== String(beforeDetail.spuName || '')
        || String(recommendationReceipt.upc || '') !== String(item.upc || '')
      ) {
        throw new Error('渠道类目推荐回执与当前商品名称/UPC 不一致');
      }
      const recommendation = toArray(recommendationReceipt.candidates).find((candidate) => (
        Number(candidate?.channel_id || 0) === Number(item?.channel_id || 0)
        && String(candidate?.category_code || '') === String(item?.category_code || '')
        && String(candidate?.category_name || '') === String(item?.category_name || '')
        && String(candidate?.category_code_path || '') === String(item?.category_code_path || '')
        && String(candidate?.category_name_path || '') === String(item?.category_name_path || '')
      ));
      const contract = toArray(propertyReceipt.contracts).find((candidate) => (
        Number(candidate?.channelId || 0) === Number(item?.channel_id || 0)
        && String(candidate?.channelCategoryId || '') === String(item?.category_code || '')
      ));
      if (!recommendation || !contract) {
        throw new Error('渠道类目不在官方推荐与属性合同的精确交集中');
      }
      verifiedCategories.push({ ...recommendation, contract });
    }
    executionPlan = {
      ...executionPlan,
      __verified_recommended_categories: verifiedCategories,
    };
  }
  const requestedBrandInfos = toArray(plan.channel_brand_info_fields);
  if (requestedBrandInfos.length) {
    const verifiedBrandInfos = [];
    for (const item of requestedBrandInfos) {
      if (!item?.query_receipt_path) throw new Error('渠道品牌主字段缺少 query_receipt_path');
      const receipt = JSON.parse(await fs.readFile(
        path.resolve(String(item.query_receipt_path)),
        'utf8',
      ));
      const exact = toArray(receipt.candidates).find((candidate) => (
        Number(candidate?.channel_id || 0) === Number(item?.channel_id || 0)
        && String(candidate?.brand_code || '') === String(item?.brand_code || '')
        && String(candidate?.brand_name || '') === String(item?.brand_name || '')
      ));
      if (!exact) throw new Error('渠道品牌主字段不在查询回执的精确候选中');
      verifiedBrandInfos.push(exact);
    }
    executionPlan = {
      ...executionPlan,
      __verified_channel_brand_infos: verifiedBrandInfos,
    };
  }
  const requestedSnapshotBrands = toArray(plan.snapshot_brand_channel_fields);
  if (requestedSnapshotBrands.length) {
    const verifiedSnapshotBrands = [];
    for (const item of requestedSnapshotBrands) {
      if (!item?.snapshot_receipt_path) {
        throw new Error('快照品牌渠道字段缺少 snapshot_receipt_path');
      }
      const receipt = JSON.parse(await fs.readFile(
        path.resolve(String(item.snapshot_receipt_path)),
        'utf8',
      ));
      const product = toArray(receipt.products).find((candidate) => (
        String(candidate?.spu_id || candidate?.detail?.spuId || '') === spuId
      ));
      const snapshotDetail = toObject(product?.detail);
      if (
        String(snapshotDetail.spuId || '') !== spuId
        || String(snapshotDetail.tenantId || '') !== String(beforeDetail.tenantId || '')
      ) {
        throw new Error('快照品牌回执与当前租户/SPU 不一致');
      }
      const channel = toArray(snapshotDetail.spuChannelInfoList).find((candidate) => (
        Number(candidate?.channelId || 0) === Number(item?.channel_id || 0)
      ));
      const prop = toArray(channel?.categoryProperties).find((candidate) => (
        String(candidate?.attrId || '') === String(item?.attr_id || '')
        && String(candidate?.attrName || '') === '品牌'
        && String(candidate?.attrValueType || '') === '4'
      ));
      const exact = toArray(prop?.customValue).find((candidate) => (
        String(candidate?.attrValueId || '') === String(item?.brand_code || '')
        && String(candidate?.attrValue || '') === String(item?.brand_name || '')
      ));
      if (!channel || !prop || !exact) {
        throw new Error('快照品牌回执未找到同渠道同属性的精确品牌编码');
      }
      verifiedSnapshotBrands.push({
        channel_id: Number(channel.channelId || 0),
        attr_id: String(prop.attrId || ''),
        brand_code: String(exact.attrValueId || ''),
        brand_name: String(exact.attrValue || ''),
      });
    }
    executionPlan = {
      ...executionPlan,
      __verified_snapshot_brands: verifiedSnapshotBrands,
    };
  }
  const requestedTenantSnapshotBrands = toArray(plan.tenant_snapshot_brand_channel_fields);
  if (requestedTenantSnapshotBrands.length) {
    const verifiedTenantSnapshotBrands = [];
    for (const item of requestedTenantSnapshotBrands) {
      if (!item?.snapshot_receipt_path || !item?.snapshot_source_spu_id) {
        throw new Error('同租户快照品牌字段缺少 snapshot_receipt_path/snapshot_source_spu_id');
      }
      const receipt = JSON.parse(await fs.readFile(
        path.resolve(String(item.snapshot_receipt_path)),
        'utf8',
      ));
      const sourceProduct = toArray(receipt.products).find((candidate) => (
        String(candidate?.spu_id || candidate?.detail?.spuId || '')
          === String(item.snapshot_source_spu_id || '')
      ));
      const sourceDetail = toObject(sourceProduct?.detail);
      if (
        !sourceProduct
        || String(sourceDetail.tenantId || '') !== String(beforeDetail.tenantId || '')
      ) {
        throw new Error('同租户快照品牌回执的来源商品或租户不匹配');
      }
      const sourceChannel = toArray(sourceDetail.spuChannelInfoList).find((candidate) => (
        Number(candidate?.channelId || 0) === Number(item?.channel_id || 0)
      ));
      const sourceProp = toArray(sourceChannel?.categoryProperties).find((candidate) => (
        String(candidate?.attrId || '') === String(item?.attr_id || '')
        && String(candidate?.attrName || '') === '品牌'
        && String(candidate?.attrValueType || '') === '4'
      ));
      const exact = toArray(sourceProp?.customValue).find((candidate) => (
        String(candidate?.attrValueId || '') === String(item?.brand_code || '')
        && String(candidate?.attrValue || '') === String(item?.brand_name || '')
      ));
      if (!sourceChannel || !sourceProp || !exact) {
        throw new Error('同租户快照品牌回执未找到同渠道同属性的精确品牌编码');
      }
      verifiedTenantSnapshotBrands.push({
        channel_id: Number(sourceChannel.channelId || 0),
        attr_id: String(sourceProp.attrId || ''),
        brand_code: String(exact.attrValueId || ''),
        brand_name: String(exact.attrValue || ''),
      });
    }
    executionPlan = {
      ...executionPlan,
      __verified_tenant_snapshot_brands: verifiedTenantSnapshotBrands,
    };
  }
  const requestedStoreCategory = toObject(plan.store_front_category_field);
  if (Object.keys(requestedStoreCategory).length) {
    if (!requestedStoreCategory.query_receipt_path) {
      throw new Error('店内分类计划缺少 query_receipt_path');
    }
    const receipt = JSON.parse(await fs.readFile(
      path.resolve(String(requestedStoreCategory.query_receipt_path)),
      'utf8',
    ));
    const exact = toArray(receipt.categories).find((candidate) => (
      String(candidate?.category_code || '') === String(requestedStoreCategory.category_code || '')
      && String(candidate?.name || '') === String(requestedStoreCategory.name || '')
      && String(candidate?.name_path || '') === String(requestedStoreCategory.name_path || '')
      && Number(candidate?.enable || 0) === 1
      && candidate?.is_leaf === true
    ));
    if (!exact) throw new Error('店内分类不在当前账号查询回执的精确启用叶子候选中');
    executionPlan = {
      ...executionPlan,
      __verified_store_front_category: exact,
    };
  }
  const requestedBasicBrand = toObject(plan.basic_brand_field);
  if (Object.keys(requestedBasicBrand).length) {
    if (!requestedBasicBrand.query_receipt_path) {
      throw new Error('总部品牌计划缺少 query_receipt_path');
    }
    const receipt = JSON.parse(
      await fs.readFile(path.resolve(String(requestedBasicBrand.query_receipt_path)), 'utf8'),
    );
    const brandCode = String(requestedBasicBrand.brand_code || '');
    const brandName = String(requestedBasicBrand.brand_name || '');
    const exact = toArray(receipt.candidates).find((candidate) => (
      String(candidate?.brand_code || '') === brandCode
      && String(candidate?.brand_name || '') === brandName
    ));
    if (!exact) throw new Error('总部品牌不在查询回执的精确候选中');
    executionPlan = { ...executionPlan, __verified_basic_brand: exact };
  }
  const requestedChannelBrands = toArray(plan.remote_brand_channel_fields);
  if (requestedChannelBrands.length) {
    const verifiedChannelBrands = [];
    for (const item of requestedChannelBrands) {
      if (!item?.query_receipt_path) throw new Error('渠道品牌计划缺少 query_receipt_path');
      const receipt = JSON.parse(
        await fs.readFile(path.resolve(String(item.query_receipt_path)), 'utf8'),
      );
      const exact = toArray(receipt.candidates).find((candidate) => (
        String(candidate?.channel_id || '') === String(item?.channel_id || '')
        && String(candidate?.brand_code || '') === String(item?.brand_code || '')
        && String(candidate?.brand_name || '') === String(item?.brand_name || '')
      ));
      if (!exact) throw new Error('渠道品牌不在查询回执的精确候选中');
      verifiedChannelBrands.push(exact);
    }
    executionPlan = { ...executionPlan, __verified_channel_brands: verifiedChannelBrands };
  }
  const requestedUploadedMainImage = toObject(plan.main_image_uploaded);
  if (Object.keys(requestedUploadedMainImage).length) {
    executionPlan = {
      ...executionPlan,
      __verified_main_image_uploaded_url: String(mainImageMaterial.uploadedUrl || ''),
    };
  }
  const requestedGalleryUrls = [
    ...toArray(plan.main_image_gallery_urls).map(String).filter(Boolean),
    ...toArray(plan.special_picture_gallery).map((item) => String(item?.url || '')).filter(Boolean),
  ];
  if (requestedGalleryUrls.length) {
    const gallery = await queryGalleryImages(
      page,
      String(plan.gallery_search_text || titleOf(beforeDetail)),
      Number(plan.gallery_page || 1),
      Number(plan.gallery_page_size || 10),
    );
    const returned = new Set(gallery.urls.map(normalizedImageUrl));
    const missing = requestedGalleryUrls.filter((url) => !returned.has(normalizedImageUrl(url)));
    if (missing.length) {
      throw new Error(`计划中的图库图片已不在本次查询回执：${missing.join(', ')}`);
    }
    executionPlan = {
      ...executionPlan,
      gallery_search_text: gallery.search_text,
      __verified_gallery_urls: gallery.urls,
    };
  }
  const requestedUploadedPictures = toArray(plan.special_picture_uploaded);
  if (requestedUploadedPictures.length) {
    const verifiedUploadedUrls = [];
    for (const item of requestedUploadedPictures) {
      if (
        QUALIFICATION_WRITEBACK_POLICY.require_upload_receipt !== false
        && !item?.upload_receipt_path
      ) {
        throw new Error('生成资质图计划缺少 upload_receipt_path');
      }
      const receipt = item?.upload_receipt_path
        ? JSON.parse(await fs.readFile(path.resolve(String(item.upload_receipt_path)), 'utf8'))
        : {};
      const receiptUrl = String(receipt?.image_url || item?.url || '');
      if (
        (
          QUALIFICATION_WRITEBACK_POLICY.require_upload_receipt_url_match !== false
          && normalizedImageUrl(receiptUrl) !== normalizedImageUrl(item?.url)
        )
        || !collectMeituanImageUrls(receiptUrl).length
      ) {
        throw new Error('生成资质图 URL 与上传回执不一致');
      }
      verifiedUploadedUrls.push(receiptUrl);
    }
    executionPlan = {
      ...executionPlan,
      __verified_uploaded_urls: verifiedUploadedUrls,
    };
  }
  const requestedMedicalQualification = toObject(plan.medical_qualification);
  if (Object.keys(requestedMedicalQualification).length) {
    if (!requestedMedicalQualification.upload_receipt_path) {
      throw new Error('医疗器械资质计划缺少 upload_receipt_path');
    }
    const receipt = JSON.parse(await fs.readFile(
      path.resolve(String(requestedMedicalQualification.upload_receipt_path)),
      'utf8',
    ));
    const pictureUrl = String(requestedMedicalQualification.picture_url || '');
    if (
      normalizedImageUrl(String(receipt?.image_url || '')) !== normalizedImageUrl(pictureUrl)
      || !collectMeituanImageUrls(pictureUrl).length
    ) {
      throw new Error('医疗器械资质图片 URL 与上传回执不一致');
    }
    const approvalDate = String(requestedMedicalQualification.approval_date || '');
    const effectiveDate = String(requestedMedicalQualification.effective_date || '');
    const longTerm = requestedMedicalQualification.long_term === true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(approvalDate)) {
      throw new Error('医疗器械资质批准日期格式无效');
    }
    if (
      (!longTerm && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate))
      || (!longTerm && effectiveDate <= approvalDate)
    ) {
      throw new Error('医疗器械资质有效期证据无效');
    }
    const evidenceFields = [
      requestedMedicalQualification.registration_number,
      requestedMedicalQualification.registered_product_name,
      requestedMedicalQualification.registrant,
      requestedMedicalQualification.source_url,
    ].map((value) => String(value || '').trim());
    if (
      evidenceFields.some((value) => !value)
      || !/^https:\/\//.test(evidenceFields[3])
      || !String(requestedMedicalQualification.evidence || '').trim()
    ) {
      throw new Error('医疗器械资质计划缺少可追溯的产品、注册人或公开来源证据');
    }
    executionPlan = {
      ...executionPlan,
      __verified_medical_qualification: {
        picture_url: pictureUrl,
        approval_date: approvalDate,
        effective_date: effectiveDate,
        long_term: longTerm,
      },
    };
  }
  let mainImageIntentContext = null;
  if (mainImageMaterial) {
    const expectedOldMainImages = toArray(plan.expected_old_main_image_urls)
      .map(String)
      .filter(Boolean);
    if (!expectedOldMainImages.length) {
      throw new Error('生成主图计划必须提供 expected_old_main_image_urls');
    }
    const expectedNewMainImages = expectedMainImageReplacement(
      expectedOldMainImages,
      mainImageMaterial.uploadedUrl,
    );
    if (
      expectedNewMainImages.length < 3
      || expectedNewMainImages.length > 10
      || new Set(expectedNewMainImages.map(normalizedImageUrl)).size
        !== expectedNewMainImages.length
    ) {
      throw new Error('生成主图替换后必须保留3–10张不重复主图');
    }
    const intentIdentity = {
      tenant_id: mainImageMaterial.expectedTenantId,
      spu_id: spuId,
      job_id: mainImageMaterial.jobId,
      plan_sha256: planSha256,
      artifact_sha256: mainImageMaterial.artifactSha256,
      expected_old_main_image_urls: expectedOldMainImages,
      expected_new_main_image_urls: expectedNewMainImages,
    };
    const intentPath = await mainImageWriteIntentPath(
      intentIdentity.tenant_id,
      spuId,
    );
    const existingIntent = await loadMainImageWriteIntent(intentPath, intentIdentity);
    if (existingIntent) {
      const observedImages = toArray(beforeDetail.picUrlList).map(String).filter(Boolean);
      if (exactImageUrlListEqual(observedImages, expectedNewMainImages)) {
        const verification = [{
          field_path: 'main_images',
          expected: expectedNewMainImages,
          actual: observedImages,
          verified: true,
        }];
        const requestedChanges = [{
          field_path: 'main_images',
          old_value: expectedOldMainImages,
          new_value: expectedNewMainImages,
          source: 'qnh_main_image_art_uploaded_receipt',
          evidence: String(requestedUploadedMainImage.evidence || '').slice(0, 500),
        }];
        const result = {
          spu_id: spuId,
          tenant_id: intentIdentity.tenant_id,
          job_id: intentIdentity.job_id,
          plan_sha256: planSha256,
          dry_run: false,
          recovered_from_write_intent: true,
          save_attempted: false,
          requested_changes: requestedChanges,
          coverage_request: {
            fieldCoverageInfoList: [{
              field: 'picture',
              coverToStore: plan.coverage_scope === 'all_stores' ? 1 : 2,
            }],
          },
          before: beforeSummary,
          update_http_status: existingIntent.update_http_status ?? null,
          update_business: toObject(existingIntent.update_business),
          update_endpoint: String(
            existingIntent.update_endpoint
            || (plan.update_profile === 'tenant_edit_v424' ? UPDATE_V2_URL : UPDATE_URL)
              .replace(/[?].*$/, ''),
          ),
          after: beforeSummary,
          changed_fields: [],
          verification,
          verified: true,
          verified_at: isoNow(),
        };
        const resultPath = path.join(runDir, `${resultPrefix}-${spuId}-result.json`);
        await writeJsonAtomic(resultPath, result);
        await updateMainImageWriteIntent(
          intentPath,
          intentIdentity,
          'verified',
          {
            verified_at: result.verified_at,
            last_readback_at: result.verified_at,
          },
        );
        await appendLog(runDir, 'main_image_write_intent_readback_recovered', {
          spu_id: spuId,
          tenant_id: intentIdentity.tenant_id,
          plan_sha256: planSha256,
          result_file: resultPath,
          verified: true,
          save_attempted: false,
        });
        return {
          ok: true,
          dry_run: false,
          recovered_from_write_intent: true,
          resultPath,
          requested_changes: requestedChanges,
          changed_fields: [],
        };
      }
      await updateMainImageWriteIntent(
        intentPath,
        intentIdentity,
        'pending_verify',
        {
          last_readback_at: isoNow(),
          last_observed_main_image_urls: observedImages,
        },
      );
      throw new Error(
        `生成主图已有稳定写意图但回读尚未命中新图，仅允许继续回读，禁止再次保存：${intentPath}`,
      );
    }
    mainImageIntentContext = {
      intentIdentity,
      intentPath,
    };
  }
  stageTimings.plan_preparation_ms = Date.now() - planPreparationStartedAt;
  const materializationStartedAt = Date.now();
  const {
    patched,
    requested,
    changedChannelIds,
    changedCoverageFields,
  } = applyDirectPlanToDetail(beforeDetail, executionPlan);
  stageTimings.plan_materialization_ms = Date.now() - materializationStartedAt;
  if (
    mainImageMaterial
    && (
      requested.length !== 1
      || requested[0]?.field_path !== 'main_images'
    )
  ) {
    throw new Error('生成主图计划的有效修改必须且只能是 main_images 单字段');
  }
  if (!requested.length) {
    if (phaseBarrier) {
      throw new Error('prepared_save_barrier_plan_no_longer_requires_change');
    }
    stageTimings.total_ms = Date.now() - totalStartedAt;
    return {
      ok: true,
      dry_run: dryRun,
      no_change: true,
      spu_id: spuId,
      stage_timings: stageTimings,
    };
  }
  const coverageRequest = {
    fieldCoverageInfoList: [
      ...changedChannelIds.map(coverageField),
      ...changedCoverageFields,
    ].filter(Boolean).filter((field, index, values) => values.indexOf(field) === index).map((field) => ({
      field,
      coverToStore: plan.coverage_scope === 'all_stores' ? 1 : 2,
    })),
  };
  const preview = {
    spu_id: spuId,
    tenant_id: beforeTenantId,
    job_id: mainImageMaterial?.jobId || '',
    plan_sha256: planSha256,
    dry_run: dryRun,
    requested_changes: requested,
    coverage_request: coverageRequest,
    before: beforeSummary,
    stage_timings: stageTimings,
  };
  if (dryRun) {
    const previewPath = path.join(runDir, `${resultPrefix}-${spuId}-preview.json`);
    stageTimings.total_ms = Date.now() - totalStartedAt;
    await writeJson(previewPath, preview);
    return {
      ok: true,
      dry_run: true,
      previewPath,
      requested_changes: requested,
      stage_timings: stageTimings,
    };
  }
  if (phaseBarrier) {
    await phaseBarrier.arrivePrepared({
      spu_id: spuId,
      tenant_id: beforeTenantId,
      plan_sha256: planSha256,
      requested_change_count: requested.length,
      prepared_at: isoNow(),
    });
  }
  const updateUrl = plan.update_profile === 'tenant_edit_v424' ? UPDATE_V2_URL : UPDATE_URL;
  if (mainImageIntentContext) {
    const claim = await createMainImageWriteIntent(
      mainImageIntentContext.intentPath,
      mainImageIntentContext.intentIdentity,
    );
    if (!claim.created) {
      return applyDirectPlan(page, runDir, planPath, dryRun, resultPrefix);
    }
  }
  let response = null;
  let saveError = null;
  try {
    response = await timedStage(
      'save_request',
      () => signedJson(page, {
        url: updateUrl,
        body: { tenantSpu: patched, coverageRequest },
        qnhReferrer: '/unifiedGoods/tenant/edit',
        fetchReferrer: `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`,
      }),
    );
    assertResponse(response, `直连保存 SPU ${spuId}`);
  } catch (error) {
    saveError = error;
  } finally {
    if (phaseBarrier) {
      await phaseBarrier.arriveSaveSettled({
        spu_id: spuId,
        ok: !saveError,
        http_status: response?.http_status ?? null,
        settled_at: isoNow(),
      });
    }
  }
  if (saveError) throw saveError;
  if (mainImageIntentContext) {
    await updateMainImageWriteIntent(
      mainImageIntentContext.intentPath,
      mainImageIntentContext.intentIdentity,
      'accepted',
      {
        accepted_at: isoNow(),
        update_http_status: response.http_status,
        update_business: businessEnvelope(response.data),
        update_endpoint: updateUrl.replace(/[?].*$/, ''),
      },
    );
  }
  await timedStage('post_save_settle', () => page.waitForTimeout(1200));
  const afterDetail = await timedStage(
    'readback_detail',
    () => fetchDetail(page, spuId),
  );
  if (
    mainImageIntentContext
    && (
      String(afterDetail.spuId || '') !== spuId
      || String(afterDetail.tenantId || '')
        !== mainImageIntentContext.intentIdentity.tenant_id
    )
  ) {
    await updateMainImageWriteIntent(
      mainImageIntentContext.intentPath,
      mainImageIntentContext.intentIdentity,
      'pending_verify',
      {
        last_readback_at: isoNow(),
        readback_identity_mismatch: true,
      },
    );
    throw new Error('生成主图保存后的回读 SPU/tenant 与写意图不一致');
  }
  const afterSummary = summarizeDetail(afterDetail);
  const verificationStartedAt = Date.now();
  const verification = requested.map((change) => {
    let actual = null;
    let contractVerified = true;
    if (change.field_path === 'title') {
      actual = String(afterDetail.spuName || '');
    } else if (change.field_path === 'basic.brand') {
      const brand = toObject(afterDetail.brand);
      actual = {
        brand_code: String(firstNonEmpty(
          brand.brandCode,
          brand.brandId,
          afterDetail.brandCode,
          afterDetail.brandId,
        )),
        brand_name: String(firstNonEmpty(brand.brandName, afterDetail.brandName)),
      };
    } else if (change.field_path === 'selling_point') {
      actual = String(afterDetail.sellPoint || '');
    } else if (change.field_path === 'main_images') {
      actual = toArray(afterDetail.picUrlList).map(String).filter(Boolean);
    } else if (change.field_path === 'detail_images') {
      actual = toArray(afterDetail.picContentList).map(String).filter(Boolean);
    } else if (change.field_path.startsWith('channel_category.')) {
      const channelId = Number(change.field_path.split('.')[1]);
      const channel = toArray(afterDetail.spuChannelInfoList).find(
        (candidate) => Number(candidate?.channelId || 0) === channelId,
      );
      actual = {
        category_code: String(channel?.categoryCode || ''),
        category_name: String(channel?.categoryName || ''),
        category_code_path: String(channel?.categoryCodePath || ''),
        category_name_path: String(channel?.categoryNamePath || ''),
      };
    } else if (change.field_path.startsWith('channel_brand.')) {
      const channelId = Number(change.field_path.split('.')[1]);
      const channel = toArray(afterDetail.spuChannelInfoList).find(
        (candidate) => Number(candidate?.channelId || 0) === channelId,
      );
      actual = {
        brand_code: String(toObject(channel?.brandInfo).brandCode || ''),
        brand_name: String(toObject(channel?.brandInfo).brandName || ''),
      };
    } else if (change.field_path === 'store_front_category') {
      actual = toArray(afterDetail.storeFrontCategoryList);
    } else if (change.field_path.startsWith('special_picture.')) {
      const pictureType = Number(change.field_path.split('.')[1]);
      const picture = toArray(afterDetail.mtSpecialPictureList).find(
        (candidate) => Number(candidate?.pictureType) === pictureType,
      );
      actual = toArray(picture?.pictureUrl).map(String).filter(Boolean);
    } else if (change.field_path === 'special_picture_contract.channel100') {
      // The modern v4.2.4 save request carries the same DTO in both the
      // top-level and channel-100 containers. The public tenant/detail response
      // normalizes it back to top-level only, so authoritative readback can
      // prove the exact URLs there while the saved request body proves the
      // channel contract was submitted.
      actual = toArray(afterDetail.mtSpecialPictureList);
    } else if (change.field_path === 'medical_qualification') {
      const qualification = toObject(afterDetail.medicalDeviceQuaInfo);
      actual = {
        quaPictures: toArray(qualification.quaPictures).map(String).filter(Boolean),
        quaApprovalDate: String(qualification.quaApprovalDate || ''),
        quaEffectiveDate: String(qualification.quaEffectiveDate || ''),
      };
    } else if (change.field_path.startsWith('sku.')) {
      const specMatch = change.field_path.match(/^sku[.]([^.]+)[.]spec_name$/);
      const weightMatch = change.field_path.match(/^sku[.]([^.]+)[.]weight$/);
      const upcMatch = change.field_path.match(/^sku[.]([^.]+)[.]upc_list$/);
      const noUpcMatch = change.field_path.match(/^sku[.]([^.]+)[.]customize_no_upc_code$/);
      const skuId = specMatch?.[1] || weightMatch?.[1] || upcMatch?.[1] || noUpcMatch?.[1] || '';
      const sku = skuId
        ? toArray(afterDetail.skus).find(
          (candidate) => String(candidate?.skuId || '') === skuId,
        )
        : null;
      actual = specMatch
        ? String(sku?.specName || '')
        : weightMatch
          ? `${String(sku?.weightForUnit ?? '')}${String(sku?.weightUnit ?? '')}`
        : noUpcMatch
          ? Number(sku?.customizeNoUpcCode || 0)
          : toArray(sku?.upcList).map(String).filter(Boolean);
    } else {
      const match = change.field_path.match(/^channel[.](\d+)[.](.+)$/);
      if (match) {
        const channel = toArray(afterDetail.spuChannelInfoList).find(
          (candidate) => Number(candidate?.channelId || 0) === Number(match[1]),
        );
        const prop = toArray(channel?.categoryProperties).find(
          (candidate) => (
            change.attr_id
              ? String(candidate?.attrId || '') === String(change.attr_id)
              : String(candidate?.attrName || '') === match[2]
          ),
        );
        actual = propertyDisplayValues(prop);
        contractVerified = channelPropertyContractMatches(prop, change);
      }
    }
    const expected = change.new_value;
    const normalizedNoBrand = (
      /^channel[.]\d+[.]品牌$/.test(change.field_path)
      && Array.isArray(expected)
      && JSON.stringify(expected) === JSON.stringify(['无品牌'])
      && Array.isArray(actual)
      && actual.length === 0
    );
    const verified = contractVerified && (normalizedNoBrand
      || (expected && typeof expected === 'object' && !Array.isArray(expected)
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : Array.isArray(expected)
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : Array.isArray(actual)
        ? actual.includes(String(expected))
        : String(actual) === String(expected)));
    return {
      field_path: change.field_path,
      expected,
      actual,
      contract_verified: contractVerified,
      verified,
    };
  });
  stageTimings.verification_ms = Date.now() - verificationStartedAt;
  stageTimings.total_ms = Date.now() - totalStartedAt;
  const result = {
    ...preview,
    dry_run: false,
    update_http_status: response.http_status,
    update_business: businessEnvelope(response.data),
    update_endpoint: updateUrl.replace(/[?].*$/, ''),
    after: afterSummary,
    changed_fields: diffSummaries(beforeSummary, afterSummary),
    verification,
    verified: verification.every((item) => item.verified),
    verified_at: isoNow(),
  };
  const resultPath = path.join(runDir, `${resultPrefix}-${spuId}-result.json`);
  const persistStartedAt = Date.now();
  await writeJsonAtomic(resultPath, result);
  stageTimings.result_persist_ms = Date.now() - persistStartedAt;
  if (mainImageIntentContext) {
    await updateMainImageWriteIntent(
      mainImageIntentContext.intentPath,
      mainImageIntentContext.intentIdentity,
      result.verified ? 'verified' : 'pending_verify',
      result.verified
        ? {
          verified_at: result.verified_at,
          last_readback_at: result.verified_at,
        }
        : {
          last_readback_at: result.verified_at,
          last_observed_main_image_urls: toArray(afterDetail.picUrlList)
            .map(String)
            .filter(Boolean),
        },
    );
  }
  await appendLog(runDir, 'direct_plan_saved_and_read_back', {
    spu_id: spuId,
    requested_change_count: requested.length,
    changed_field_count: result.changed_fields.length,
    result_file: resultPath,
    verified: result.verified,
    stage_timings: stageTimings,
  });
  if (!result.verified) {
    throw new Error(`直连保存 SPU ${spuId} 后存在回读不一致，结果已保存：${resultPath}`);
  }
  return {
    ok: true,
    dry_run: false,
    resultPath,
    requested_changes: requested,
    changed_fields: result.changed_fields,
    stage_timings: stageTimings,
  };
}

async function applyDirectPlan(
  page,
  runDir,
  planPath,
  dryRun,
  resultPrefix = 'direct',
  keepWorkerPage = false,
) {
  if (runtimeProtocolProfile?.csecversion !== '4.3.0') {
    return applyDirectPlanCore(page, runDir, planPath, dryRun, resultPrefix);
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  const spuId = String(plan.spu_id || '');
  if (!spuId) throw new Error('直连计划缺少 spu_id');
  try {
    const native = await readExactNativeEditorDetail(page, spuId);
    if (native.profile.context_profile !== 'tenant_edit_v430') {
      throw new Error('未取得当前精确 SPU 的 4.3.0 编辑页证据，禁止写入');
    }
    return await applyDirectPlanCore(page, runDir, planPath, dryRun, resultPrefix);
  } finally {
    if (keepWorkerPage) {
      await closeProductEditTabs(page, spuId).catch(() => ({ closed_count: 0 }));
    } else {
      await returnToListAndCloseEditor(page, spuId);
    }
  }
}

function verificationActualMatchesExpected(fieldPath, expected, actual) {
  const normalizedNoBrand = (
    /^channel[.]\d+[.]品牌$/.test(fieldPath)
    && Array.isArray(expected)
    && JSON.stringify(expected) === JSON.stringify(['无品牌'])
    && Array.isArray(actual)
    && actual.length === 0
  );
  return normalizedNoBrand
    || (expected && typeof expected === 'object' && !Array.isArray(expected)
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : Array.isArray(expected)
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : Array.isArray(actual)
          ? actual.includes(String(expected))
          : String(actual) === String(expected));
}

function hasStrictGenericResultEvidence(result) {
  const requestedChanges = toArray(result.requested_changes);
  const verification = toArray(result.verification);
  if (
    !requestedChanges.length
    || requestedChanges.length !== verification.length
  ) {
    return false;
  }
  const requestedFields = requestedChanges.map((item) => String(item?.field_path || ''));
  const verificationFields = verification.map((item) => String(item?.field_path || ''));
  if (
    requestedFields.some((field) => !field)
    || verificationFields.some((field) => !field)
    || JSON.stringify([...requestedFields].sort())
      !== JSON.stringify([...verificationFields].sort())
  ) {
    return false;
  }
  const matchedRequestedIndexes = new Set();
  return verification.every((item) => {
    const fieldPath = String(item.field_path || '');
    const requestedIndex = requestedChanges.findIndex((change, index) => (
      !matchedRequestedIndexes.has(index)
      && String(change?.field_path || '') === fieldPath
      && Object.prototype.hasOwnProperty.call(item, 'expected')
      && JSON.stringify(item.expected) === JSON.stringify(change?.new_value)
    ));
    const requested = requestedIndex >= 0 ? requestedChanges[requestedIndex] : null;
    if (requested) matchedRequestedIndexes.add(requestedIndex);
    return (
      requested
      && item.verified === true
      && Object.prototype.hasOwnProperty.call(item, 'expected')
      && Object.prototype.hasOwnProperty.call(item, 'actual')
      && JSON.stringify(item.expected) === JSON.stringify(requested.new_value)
      && (!requested.contract_kind || item.contract_verified === true)
      && verificationActualMatchesExpected(fieldPath, item.expected, item.actual)
    );
  });
}

async function inspectExistingDirectResult(planPath, resultPaths, expectedSpuId) {
  const planRaw = await fs.readFile(planPath, 'utf8');
  const plan = JSON.parse(planRaw);
  const planSha256 = sha256(planRaw);
  const planSpuId = String(plan.spu_id || '');
  if (!planSpuId || planSpuId !== String(expectedSpuId || '')) {
    throw new Error('批次索引 SPU 与计划 SPU 不一致');
  }
  const isMainImagePlan = Object.keys(toObject(plan.main_image_uploaded)).length > 0;
  const expectedTenantId = String(
    plan.expected_tenant_id || plan.tenant_id || '',
  ).trim();
  const expectedJobId = String(plan.job_id || '').trim();
  if (isMainImagePlan && (!expectedTenantId || !expectedJobId)) {
    throw new Error('生成主图批次计划缺少 expected_tenant_id/job_id');
  }
  let mainImageExpectedOld = [];
  let mainImageExpectedNew = [];
  if (isMainImagePlan) {
    const material = await loadVerifiedMainImageMaterial(plan, planSpuId);
    mainImageExpectedOld = toArray(plan.expected_old_main_image_urls)
      .map(String)
      .filter(Boolean);
    mainImageExpectedNew = expectedMainImageReplacement(
      mainImageExpectedOld,
      material.uploadedUrl,
    );
    if (
      !mainImageExpectedOld.length
      || mainImageExpectedNew.length < 3
      || mainImageExpectedNew.length > 10
      || new Set(mainImageExpectedNew.map(normalizedImageUrl)).size
        !== mainImageExpectedNew.length
    ) {
      throw new Error('生成主图批次计划的旧图/目标图集合无效');
    }
  }
  let foundPath = '';
  let invalidReason = '';
  for (const candidate of [
    ...new Set(resultPaths.filter(Boolean).map((resultPath) => path.resolve(resultPath))),
  ]) {
    let raw;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      foundPath = candidate;
      invalidReason = '既有结果文件无法读取';
      break;
    }
    foundPath = candidate;
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      invalidReason = '既有结果文件不是合法 JSON';
      break;
    }
    const verification = toArray(result.verification);
    const requestedChanges = toArray(result.requested_changes);
    const resultTenantId = String(result.tenant_id || '').trim();
    const resultJobId = String(result.job_id || '').trim();
    const hasStrictEvidence = isMainImagePlan
      ? (
        requestedChanges.length === 1
        && requestedChanges[0]?.field_path === 'main_images'
        && exactImageUrlListEqual(
          requestedChanges[0]?.old_value,
          mainImageExpectedOld,
        )
        && exactImageUrlListEqual(
          requestedChanges[0]?.new_value,
          mainImageExpectedNew,
        )
        && verification.length === 1
        && verification[0]?.field_path === 'main_images'
        && verification[0]?.verified === true
        && exactImageUrlListEqual(
          verification[0]?.expected,
          mainImageExpectedNew,
        )
        && exactImageUrlListEqual(
          verification[0]?.actual,
          mainImageExpectedNew,
        )
      )
      : hasStrictGenericResultEvidence(result);
    const valid = (
      String(result.spu_id || '') === planSpuId
      && String(result.plan_sha256 || '') === planSha256
      && Boolean(resultTenantId)
      && (!expectedTenantId || resultTenantId === expectedTenantId)
      && (!isMainImagePlan || resultJobId === expectedJobId)
      && result.verified === true
      && hasStrictEvidence
    );
    if (valid) {
      return {
        found: true,
        valid: true,
        resultPath: candidate,
        result,
        plan,
        planSha256,
      };
    }
    invalidReason = (
      '既有结果未通过 SPU/tenant/job/plan_sha/requested_changes/verification 完整校验'
    );
    break;
  }
  return {
    found: Boolean(foundPath),
    valid: false,
    resultPath: foundPath,
    invalidReason,
    plan,
    planSha256,
  };
}

async function loadBoundMainImageIntentForPlan(
  plan,
  planSha256,
  spuId,
) {
  if (!Object.keys(toObject(plan.main_image_uploaded)).length) return null;
  const material = await loadVerifiedMainImageMaterial(plan, spuId);
  const expectedOldMainImages = toArray(plan.expected_old_main_image_urls)
    .map(String)
    .filter(Boolean);
  if (!expectedOldMainImages.length) {
    throw new Error('生成主图计划缺少 expected_old_main_image_urls');
  }
  const intentIdentity = {
    tenant_id: material.expectedTenantId,
    spu_id: spuId,
    job_id: material.jobId,
    plan_sha256: planSha256,
    artifact_sha256: material.artifactSha256,
    expected_old_main_image_urls: expectedOldMainImages,
    expected_new_main_image_urls: expectedMainImageReplacement(
      expectedOldMainImages,
      material.uploadedUrl,
    ),
  };
  const intentPath = await mainImageWriteIntentPath(material.expectedTenantId, spuId);
  const intent = await loadMainImageWriteIntent(intentPath, intentIdentity);
  return intent ? { intentPath, intentIdentity, intent } : null;
}

async function applyDirectBatch(
  page,
  runDir,
  indexPath,
  offset,
  limit,
  batchName = 'direct-batch',
  requestedConcurrency = 2,
  dryRun = false,
) {
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const selected = selectReadyMutationWindow(index.rows, offset, limit);
  const modernEditorPool = runtimeProtocolProfile?.csecversion === '4.3.0';
  const concurrency = resolveDirectBatchConcurrency(requestedConcurrency);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(batchName)) {
    throw new Error('batch-name 只能包含字母、数字和连字符');
  }
  const checkpointPath = path.join(runDir, `${batchName}-checkpoint.json`);
  const checkpointIdentity = {
    index_path: indexPath,
    window_offset: offset,
    window_limit: limit,
  };
  let checkpoint = { ...checkpointIdentity, updated_at: isoNow(), rows: [] };
  try {
    checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    if (
      checkpoint.index_path !== indexPath
      || Number(checkpoint.window_offset) !== Number(offset)
      || Number(checkpoint.window_limit) !== Number(limit)
      || !Array.isArray(checkpoint.rows)
    ) {
      checkpoint = { ...checkpointIdentity, updated_at: isoNow(), rows: [] };
    }
  } catch {
    // A missing checkpoint is the normal first-run path.
  }
  const statusBySpu = new Map(toArray(checkpoint.rows).map((row) => [String(row.spu_id), row]));
  const batchStartedAt = Date.now();
  const editorPoolBootstrap = modernEditorPool && selected.length
    ? await bootstrapQnhWorkerPool(page.context(), { listPageUrl: LIST_PAGE_URL })
    : { completed: false, elapsed_ms: 0, settle_ms: 0 };
  let nextIndex = 0;
  let completedCount = 0;
  let runtimeCompletedCount = 0;
  let runtimeConcurrency = resolveInitialRuntimeConcurrency(concurrency, {
    modernEditorPool,
  });
  let runtimePeakConcurrency = runtimeConcurrency;
  let runtimePeakRssBytes = process.memoryUsage().rss;
  const browserResourceMonitor = await createBrowserResourceMonitor(
    page.context().browser(),
  );
  let runtimePeakBrowserWorkerRssBytes = 0;
  let runtimePeakBrowserTotalRssBytes = Number(
    browserResourceMonitor.baseline?.browser_total_rss_bytes || 0,
  );
  let runtimePeakCombinedRssBytes = runtimePeakRssBytes;
  let runtimeMinMemAvailableKib = Number.POSITIVE_INFINITY;
  let runtimeMemoryPressureStop = false;
  let runtimePressureObserved = false;
  let runtimeSingleWorkerGcCount = 0;
  let runtimeSingleWorkerGcMs = 0;
  let runtimeSingleWorkerRendererGcCount = 0;
  let runtimeSingleWorkerRendererGcMs = 0;
  let runtimeSingleWorkerRendererGcFailures = 0;
  const editorPages = [];
  const availableEditorPages = [];
  const waitingEditorPageResolvers = [];
  let reservedEditorPageSlots = 0;
  let editorPageCreationQueue = Promise.resolve();
  const runtimeLimitHistory = [{
    completed: 0,
    concurrency: runtimeConcurrency,
    reason: modernEditorPool
      ? 'one_item_editor_warm_canary'
      : (concurrency > 2 ? 'two_item_memory_canary' : 'configured_limit'),
  }];
  const progressEvery = Math.max(1, Math.min(100, Number(process.env.QNH_PROGRESS_EVERY || 25) || 25));
  let checkpointQueue = Promise.resolve();
  const persistProgress = (spuId) => {
    checkpointQueue = checkpointQueue.then(async () => {
      checkpoint = {
        ...checkpointIdentity,
        updated_at: isoNow(),
        selected_total: selected.length,
        concurrency,
        dry_run: dryRun,
        batch_started_at: new Date(batchStartedAt).toISOString(),
        elapsed_ms: Date.now() - batchStartedAt,
        rows: [...statusBySpu.values()],
      };
      await writeJson(checkpointPath, checkpoint);
      const current = statusBySpu.get(spuId);
      if (
        completedCount === selected.length
        || completedCount % progressEvery === 0
        || current?.status === 'failed'
      ) process.stderr.write(`${JSON.stringify({
        event: 'direct_batch_progress',
        done: completedCount,
        total: selected.length,
        concurrency,
        dry_run: dryRun,
        spu_id: spuId,
        status: current?.status || 'unknown',
        duration_ms: current?.duration_ms || 0,
        previewed: [...statusBySpu.values()].filter((item) => item.status === 'previewed').length,
        verified: [...statusBySpu.values()].filter((item) => item.status === 'verified').length,
        failed: [...statusBySpu.values()].filter((item) => item.status === 'failed').length,
      })}\n`);
    });
    return checkpointQueue;
  };
  const createAndPrewarmEditorPage = async () => {
    const creation = editorPageCreationQueue.then(async () => {
      const workerPage = await page.context().newPage();
      try {
        await prewarmQnhWorkerPage(workerPage, { listPageUrl: LIST_PAGE_URL });
      } catch (error) {
        await workerPage.close().catch(() => {});
        throw error;
      }
      editorPages.push(workerPage);
      return workerPage;
    });
    editorPageCreationQueue = creation.then(() => undefined, () => undefined);
    return creation;
  };
  const acquireEditorPage = async () => {
    if (!modernEditorPool) return page;
    const reusable = availableEditorPages.pop();
    if (reusable) return reusable;
    if (reservedEditorPageSlots < concurrency) {
      reservedEditorPageSlots += 1;
      try {
        return await createAndPrewarmEditorPage();
      } catch (error) {
        reservedEditorPageSlots -= 1;
        throw error;
      }
    }
    return new Promise((resolve) => waitingEditorPageResolvers.push(resolve));
  };
  const releaseEditorPage = (workerPage) => {
    if (!modernEditorPool || workerPage === page || workerPage.isClosed()) return;
    const waiter = waitingEditorPageResolvers.shift();
    if (waiter) waiter(workerPage);
    else availableEditorPages.push(workerPage);
  };
  const processRow = async (indexNumber) => {
    const row = selected[indexNumber];
    const spuId = String(row.spu_id || '');
    const itemStartedAt = Date.now();
    const prior = statusBySpu.get(spuId);
    const planPath = path.resolve(String(row.plan_path));
    const knownResultPaths = [
      path.join(runDir, `${batchName}-${spuId}-result.json`),
      prior?.result_path ? path.resolve(String(prior.result_path)) : '',
    ];
    let existingInspection = null;
    let performedPlatformWork = false;
    try {
      existingInspection = await inspectExistingDirectResult(
        planPath,
        knownResultPaths,
        spuId,
      );
    } catch (error) {
      statusBySpu.set(spuId, {
        spu_id: spuId,
        title: String(row.title || ''),
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        duration_ms: Date.now() - itemStartedAt,
      });
    }
    if (!statusBySpu.has(spuId) || statusBySpu.get(spuId) === prior) {
      const resumeDisposition = checkpointResumeDisposition({
        priorStatus: prior?.status,
        dryRun,
      });
      if (resumeDisposition === 'reuse_terminal') {
        statusBySpu.set(spuId, {
          ...prior,
          skipped_existing: true,
          duration_ms: Number(prior.duration_ms || 0),
        });
      } else if (resumeDisposition === 'defer_to_readback') {
        // A previous failure may have happened after an accepted save whose
        // response was lost.  Re-entering the same checkpoint must therefore
        // process only rows that never started; the next independent full
        // read decides whether this SPU still needs a new plan/save.
        statusBySpu.set(spuId, {
          ...prior,
          prior_failed_deferred_to_readback: true,
          duration_ms: Number(prior.duration_ms || 0),
        });
      } else {
        const hasInvalidCompletionEvidence = (
        !dryRun
        && (
          existingInspection?.found
          || prior?.status === 'verified'
        )
        );
        let allowIntentReadbackRecovery = false;
        let intentRecoveryError = '';
        if (
          hasInvalidCompletionEvidence
          && !existingInspection?.valid
          && existingInspection?.plan
        ) {
          try {
            allowIntentReadbackRecovery = Boolean(
              await loadBoundMainImageIntentForPlan(
                existingInspection.plan,
                existingInspection.planSha256,
                spuId,
              ),
            );
          } catch (error) {
            intentRecoveryError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!dryRun && existingInspection?.valid) {
          statusBySpu.set(spuId, {
            spu_id: spuId,
            status: 'verified',
            result_path: existingInspection.resultPath,
            skipped_existing: true,
            duration_ms: Date.now() - itemStartedAt,
          });
        } else if (hasInvalidCompletionEvidence && !allowIntentReadbackRecovery) {
          statusBySpu.set(spuId, {
            spu_id: spuId,
            title: String(row.title || ''),
            status: 'failed',
            result_path: existingInspection?.resultPath || String(prior?.result_path || ''),
            error: String(
              existingInspection?.invalidReason
              || '检查点标记 verified，但缺少可完整校验的结果文件',
            ).concat(
              intentRecoveryError ? `；主图写意图不可用于只读恢复：${intentRecoveryError}` : '',
            ).slice(0, 1000),
            skipped_existing: false,
            blocked_unverified_existing_result: true,
            duration_ms: Date.now() - itemStartedAt,
          });
        } else {
          let workerPage = null;
          try {
            performedPlatformWork = true;
            workerPage = await acquireEditorPage();
            const result = await applyDirectPlan(
              workerPage,
              runDir,
              planPath,
              dryRun,
              batchName,
              modernEditorPool,
            );
            statusBySpu.set(spuId, {
              spu_id: spuId,
              title: String(row.title || ''),
              status: result.no_change ? 'no_change' : (dryRun ? 'previewed' : 'verified'),
              result_path: result.resultPath || result.previewPath || '',
              requested_change_count: toArray(result.requested_changes).length,
              intent_readback_recovery: allowIntentReadbackRecovery,
              stage_timings: toObject(result.stage_timings),
              duration_ms: Date.now() - itemStartedAt,
            });
          } catch (error) {
            statusBySpu.set(spuId, {
              spu_id: spuId,
              title: String(row.title || ''),
              status: 'failed',
              error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
              intent_readback_recovery: allowIntentReadbackRecovery,
              duration_ms: Date.now() - itemStartedAt,
            });
          } finally {
            if (
              workerPage
              && !workerPage.isClosed()
              && shouldCollectSingleWorkerRenderer({
                adaptive_approved: process.env.QNH_DIRECT_ADAPTIVE_APPROVED === '1',
                runtime_concurrency: runtimeConcurrency,
                performed_platform_work: performedPlatformWork,
              })
            ) {
              const rendererGcStartedAt = Date.now();
              let rendererSession = null;
              try {
                rendererSession = await workerPage.context().newCDPSession(workerPage);
                await rendererSession.send('HeapProfiler.collectGarbage');
                runtimeSingleWorkerRendererGcCount += 1;
              } catch {
                runtimeSingleWorkerRendererGcFailures += 1;
              } finally {
                runtimeSingleWorkerRendererGcMs += Date.now() - rendererGcStartedAt;
                await rendererSession?.detach().catch(() => {});
              }
            }
            if (workerPage) releaseEditorPage(workerPage);
          }
        }
      }
    }
    completedCount += 1;
    await persistProgress(spuId);
    // Large three-channel product details can temporarily occupy hundreds of
    // megabytes per worker.  The durable result and compact checkpoint have
    // already been written above, so an explicitly enabled GC may reclaim
    // those transient response graphs before the next SPU.  This is opt-in
    // via `node --expose-gc` and does not change normal execution semantics.
    // Once RSS is already high, a synchronous full-heap GC can itself spend
    // minutes under cgroup MemoryHigh. The adaptive scheduler will recycle
    // this short process after the durable checkpoint, so let process exit
    // reclaim the heap instead of forcing an expensive collection.
    if (
      typeof global.gc === 'function'
      && shouldRunSynchronousGc({
        rss_bytes: process.memoryUsage().rss,
        adaptive_approved: process.env.QNH_DIRECT_ADAPTIVE_APPROVED === '1',
        runtime_concurrency: runtimeConcurrency,
      })
    ) {
      const gcStartedAt = Date.now();
      global.gc();
      runtimeSingleWorkerGcCount += 1;
      runtimeSingleWorkerGcMs += Date.now() - gcStartedAt;
    }
    return performedPlatformWork;
  };
  const worker = async () => {
    while (true) {
      const indexNumber = nextIndex;
      nextIndex += 1;
      if (indexNumber >= selected.length) return;
      await processRow(indexNumber);
    }
  };
  const sampleRuntimeMetrics = async (performedPlatformWork = false) => {
    if (performedPlatformWork) runtimeCompletedCount += 1;
    const rssBytes = process.memoryUsage().rss;
    runtimePeakRssBytes = Math.max(runtimePeakRssBytes, rssBytes);
    const browserMetrics = await browserResourceMonitor.sample();
    const browserWorkerRssBytes = Number(
      browserMetrics.worker_renderer_rss_bytes || 0,
    );
    const browserTotalRssBytes = Number(
      browserMetrics.browser_total_rss_bytes || 0,
    );
    const combinedRssBytes = rssBytes + browserWorkerRssBytes;
    runtimePeakBrowserWorkerRssBytes = Math.max(
      runtimePeakBrowserWorkerRssBytes,
      browserWorkerRssBytes,
    );
    runtimePeakBrowserTotalRssBytes = Math.max(
      runtimePeakBrowserTotalRssBytes,
      browserTotalRssBytes,
    );
    runtimePeakCombinedRssBytes = Math.max(
      runtimePeakCombinedRssBytes,
      combinedRssBytes,
    );
    let memAvailableKib = 0;
    try {
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      memAvailableKib = match ? Number(match[1]) : 0;
    } catch {
      // The cgroup remains the hard safety boundary if host metrics disappear.
    }
    if (memAvailableKib > 0) {
      runtimeMinMemAvailableKib = Math.min(runtimeMinMemAvailableKib, memAvailableKib);
    }
    if (shouldRecycleRuntimeProcess({
      rss_bytes: rssBytes,
      browser_worker_rss_bytes: browserWorkerRssBytes,
      mem_available_kib: memAvailableKib,
    })) {
      runtimeMemoryPressureStop = true;
      runtimePressureObserved = true;
      runtimeConcurrency = 1;
      if (runtimeLimitHistory.at(-1)?.reason !== 'memory_pressure_recycle') {
        runtimeLimitHistory.push({
          completed: completedCount,
          runtime_completed: runtimeCompletedCount,
          concurrency: 0,
          rss_bytes: rssBytes,
          browser_worker_rss_bytes: browserWorkerRssBytes,
          combined_rss_bytes: combinedRssBytes,
          mem_available_kib: memAvailableKib,
          reason: 'memory_pressure_recycle',
        });
      }
      return;
    }
    const resourceCeiling = resolveRuntimeConcurrencyCeiling(
      concurrency,
      {
        rss_bytes: rssBytes,
        browser_worker_rss_bytes: browserWorkerRssBytes,
        mem_available_kib: memAvailableKib,
      },
      concurrency,
    );
    const progressiveCeiling = resolveProgressiveRuntimeConcurrency(
      concurrency,
      runtimeCompletedCount,
    );
    const nextConcurrency = Math.min(resourceCeiling, progressiveCeiling);
    if (nextConcurrency < runtimeConcurrency) {
      runtimePressureObserved = true;
      runtimeConcurrency = nextConcurrency;
      runtimeLimitHistory.push({
        completed: completedCount,
        runtime_completed: runtimeCompletedCount,
        concurrency: runtimeConcurrency,
        rss_bytes: rssBytes,
        browser_worker_rss_bytes: browserWorkerRssBytes,
        combined_rss_bytes: combinedRssBytes,
        mem_available_kib: memAvailableKib,
        reason: 'memory_pressure_step_down',
      });
    } else if (!runtimePressureObserved && nextConcurrency > runtimeConcurrency) {
      runtimeConcurrency = nextConcurrency;
      runtimePeakConcurrency = Math.max(runtimePeakConcurrency, runtimeConcurrency);
      runtimeLimitHistory.push({
        completed: completedCount,
        runtime_completed: runtimeCompletedCount,
        concurrency: runtimeConcurrency,
        rss_bytes: rssBytes,
        browser_worker_rss_bytes: browserWorkerRssBytes,
        combined_rss_bytes: combinedRssBytes,
        mem_available_kib: memAvailableKib,
        reason: 'progressive_step_up',
      });
    }
  };
  try {
    await new Promise((resolve, reject) => {
      let activeWorkers = 0;
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const pump = () => {
        if (settled) return;
        if ((nextIndex >= selected.length || runtimeMemoryPressureStop) && activeWorkers === 0) {
          finish();
          return;
        }
        if (runtimeMemoryPressureStop) return;
        while (
          nextIndex < selected.length
          && activeWorkers < runtimeConcurrency
        ) {
          const indexNumber = nextIndex;
          nextIndex += 1;
          activeWorkers += 1;
          processRow(indexNumber)
            .then(sampleRuntimeMetrics)
            .then(() => {
              activeWorkers -= 1;
              pump();
            })
            .catch(finish);
        }
      };
      pump();
    });
    await checkpointQueue;
  } finally {
    await Promise.allSettled(editorPages.map((workerPage) => workerPage.close()));
    await browserResourceMonitor.close();
  }
  const rows = [...statusBySpu.values()];
  const selectedSpus = new Set(selected.map((row) => String(row.spu_id || '')));
  const selectedRows = rows.filter((row) => selectedSpus.has(String(row.spu_id || '')));
  const durations = selectedRows
    .map((row) => Number(row.duration_ms || 0))
    .filter((duration) => duration >= 0)
    .sort((left, right) => left - right);
  const elapsedMs = Date.now() - batchStartedAt;
  const p95Index = durations.length ? Math.ceil(durations.length * 0.95) - 1 : 0;
  return {
    checkpointPath,
    selectedTotal: selected.length,
    concurrency,
    dryRun,
    previewed: selectedRows.filter((item) => item.status === 'previewed').length,
    verified: selectedRows.filter((item) => item.status === 'verified').length,
    noChange: selectedRows.filter((item) => item.status === 'no_change').length,
    failed: selectedRows.filter((item) => item.status === 'failed').length,
    elapsedMs,
    processedTotal: selectedRows.length,
    throughputAverageMsPerProduct: selectedRows.length
      ? Math.round(elapsedMs / selectedRows.length)
      : 0,
    itemAverageMs: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : 0,
    itemP95Ms: durations.length ? durations[p95Index] : 0,
    runtimePeakRssBytes,
    runtimePeakBrowserWorkerRssBytes,
    runtimePeakBrowserTotalRssBytes,
    runtimeBrowserBaselineRendererRssBytes: Number(
      browserResourceMonitor.baseline?.renderer_rss_bytes || 0,
    ),
    runtimePeakCombinedRssBytes,
    runtimePeakConcurrency,
    runtimeMinMemAvailableKib: Number.isFinite(runtimeMinMemAvailableKib)
      ? runtimeMinMemAvailableKib
      : 0,
    runtimeFinalConcurrency: runtimeConcurrency,
    runtimeMemoryPressureStop,
    runtimePressureObserved,
    runtimeSingleWorkerGcCount,
    runtimeSingleWorkerGcMs,
    runtimeSingleWorkerRendererGcCount,
    runtimeSingleWorkerRendererGcMs,
    runtimeSingleWorkerRendererGcFailures,
    runtimeLimitHistory,
    editorPoolBootstrap,
  };
}

async function readMemAvailableKib() {
  const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) : 0;
}

function preparedBarrierResourceCeiling(memAvailableKib) {
  if (memAvailableKib < 5 * 1024 * 1024) return 0;
  if (memAvailableKib < 7 * 1024 * 1024) return 2;
  if (memAvailableKib < 8 * 1024 * 1024) return 4;
  if (memAvailableKib < 9 * 1024 * 1024) return 6;
  return 10;
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  return results;
}

async function applyPreparedBarrierBatch(
  page,
  runDir,
  indexPath,
  offset,
  limit,
  batchName,
  preloadConcurrency,
) {
  assertManagedDirectBatchRuntime();
  if (runtimeProtocolProfile?.csecversion !== '4.3.0') {
    throw new Error('prepared_save_barrier_requires_csecversion_4_3_0');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(batchName)) {
    throw new Error('batch-name 只能包含字母、数字和连字符');
  }
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const selected = selectReadyMutationWindow(index.rows, offset, limit);
  if (!selected.length) throw new Error('prepared_save_barrier_requires_ready_plans');
  if (selected.length > 10) throw new Error('prepared_save_barrier_maximum_is_10');
  const memAvailableBeforeKib = await readMemAvailableKib();
  const resourceCeiling = preparedBarrierResourceCeiling(memAvailableBeforeKib);
  if (selected.length > resourceCeiling) {
    throw new Error(
      `prepared_save_barrier_resource_gate:requested=${selected.length},ceiling=${resourceCeiling},mem_available_kib=${memAvailableBeforeKib}`,
    );
  }
  const requestedPreloadConcurrency = Math.max(1, Math.min(
    Number(preloadConcurrency || 2),
    selected.length,
    resourceCeiling,
  ));
  const checkpointPath = path.join(runDir, `${batchName}-checkpoint.json`);
  try {
    await fs.access(checkpointPath);
    throw new Error('prepared_save_barrier_checkpoint_already_exists');
  } catch (error) {
    if (error?.message === 'prepared_save_barrier_checkpoint_already_exists') throw error;
  }
  const startedAt = Date.now();
  const bootstrap = await bootstrapQnhWorkerPool(page.context(), { listPageUrl: LIST_PAGE_URL });
  const browserMonitor = await createBrowserResourceMonitor(page.context().browser());
  const preparedPages = [];
  let checkpoint = {
    index_path: indexPath,
    window_offset: offset,
    window_limit: limit,
    batch_name: batchName,
    mode: 'prepared_save_barrier',
    preload_concurrency: requestedPreloadConcurrency,
    selected_total: selected.length,
    started_at: new Date(startedAt).toISOString(),
    mem_available_before_kib: memAvailableBeforeKib,
    rows: selected.map((row) => ({ spu_id: String(row.spu_id || ''), status: 'selected' })),
  };
  await writeJsonAtomic(checkpointPath, checkpoint);
  const updateCheckpoint = async (updates = {}) => {
    checkpoint = { ...checkpoint, ...updates, updated_at: isoNow() };
    await writeJsonAtomic(checkpointPath, checkpoint);
  };
  const preloadStartedAt = Date.now();
  try {
    const bindings = await mapWithConcurrency(
      selected,
      requestedPreloadConcurrency,
      async (row) => {
        const spuId = String(row.spu_id || '');
        const workerPage = await page.context().newPage();
        preparedPages.push(workerPage);
        await prewarmQnhWorkerPage(workerPage, { listPageUrl: LIST_PAGE_URL });
        const native = await readExactNativeEditorDetail(workerPage, spuId);
        if (
          native.profile.context_profile !== 'tenant_edit_v430'
          || !workerPage.url().includes(`spu=${encodeURIComponent(spuId)}`)
        ) {
          throw new Error(`prepared_save_barrier_exact_binding_failed:${spuId}`);
        }
        return {
          row,
          spuId,
          planPath: path.resolve(String(row.plan_path)),
          page: workerPage,
          native_http_status: Number(native?.response?.http_status || 0),
        };
      },
    );
    const preloadElapsedMs = Date.now() - preloadStartedAt;
    const afterPreloadResources = await browserMonitor.sample();
    await updateCheckpoint({
      preload_elapsed_ms: preloadElapsedMs,
      browser_after_preload: afterPreloadResources,
      rows: bindings.map((binding) => ({
        spu_id: binding.spuId,
        status: 'editor_bound',
        native_http_status: binding.native_http_status,
      })),
    });
    let preparedCheckpointWrittenAt = '';
    const barrier = createPreparedSaveBarrier(bindings.length, {
      async onAllPrepared(receipts) {
        preparedCheckpointWrittenAt = isoNow();
        await updateCheckpoint({
          prepared_at: preparedCheckpointWrittenAt,
          rows: receipts.map((receipt) => ({ ...receipt, status: 'prepared' })),
        });
      },
      async onAllSavesSettled(receipts) {
        await updateCheckpoint({
          saves_settled_at: isoNow(),
          rows: receipts.map((receipt) => ({
            spu_id: receipt.spu_id,
            status: receipt.ok ? 'save_accepted' : 'save_failed_or_unknown',
            http_status: receipt.http_status,
          })),
        });
      },
    });
    const settled = await Promise.allSettled(bindings.map(async (binding) => {
      try {
        return await applyDirectPlanCore(
          binding.page,
          runDir,
          binding.planPath,
          false,
          batchName,
          barrier,
        );
      } catch (error) {
        if (barrier.metrics().prepared_count < bindings.length) barrier.abort(error);
        throw error;
      }
    }));
    const rows = settled.map((result, indexNumber) => {
      const binding = bindings[indexNumber];
      if (result.status === 'fulfilled') {
        return {
          spu_id: binding.spuId,
          status: result.value.no_change ? 'no_change' : 'verified',
          result_path: result.value.resultPath || '',
          stage_timings: toObject(result.value.stage_timings),
        };
      }
      return {
        spu_id: binding.spuId,
        status: 'failed',
        error: String(result.reason?.message || result.reason || '').slice(0, 1000),
      };
    });
    const resourcesAfter = await browserMonitor.sample();
    const metrics = barrier.metrics();
    await updateCheckpoint({
      completed_at: isoNow(),
      elapsed_ms: Date.now() - startedAt,
      prepared_checkpoint_written_at: preparedCheckpointWrittenAt,
      barrier_metrics: metrics,
      browser_after_completion: resourcesAfter,
      mem_available_after_kib: await readMemAvailableKib(),
      rows,
    });
    return {
      checkpointPath,
      selectedTotal: selected.length,
      verified: rows.filter((row) => row.status === 'verified').length,
      noChange: rows.filter((row) => row.status === 'no_change').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      preloadElapsedMs,
      saveBurstMs: metrics.save_burst_ms,
      totalElapsedMs: Date.now() - startedAt,
      throughputAverageMsPerProduct: Math.round((Date.now() - startedAt) / selected.length),
      memAvailableBeforeKib,
      memAvailableAfterKib: await readMemAvailableKib(),
      resourceCeiling,
      preloadConcurrency: requestedPreloadConcurrency,
      bootstrap,
    };
  } catch (error) {
    await updateCheckpoint({
      failed_at: isoNow(),
      elapsed_ms: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 1000),
    }).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled(preparedPages.map((workerPage) => workerPage.close()));
    await browserMonitor.close();
  }
}

function diffSummaries(before, after) {
  const changes = [];
  const walk = (left, right, currentPath) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left === null
      || right === null
      || typeof left !== 'object'
      || typeof right !== 'object'
    ) {
      changes.push({ field_path: currentPath, old_value: left, new_value: right });
      return;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      changes.push({ field_path: currentPath, old_value: left, new_value: right });
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) walk(left[key], right[key], currentPath ? `${currentPath}.${key}` : key);
  };
  walk(before, after, '');
  return changes.filter((change) => change.field_path !== 'update_time');
}

async function readExactNativeEditorDetail(page, spuId) {
  const expectedSpu = String(spuId);
  const targetUrl = `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(expectedSpu)}`;
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== 'POST') return false;
    try {
      if (new URL(request.url()).pathname !== DETAIL_ENDPOINT) return false;
      return String(request.postDataJSON()?.spuId || '') === expectedSpu;
    } catch { return false; }
  }, { timeout: 45000 });
  if (page.url() === targetUrl) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  } else {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  const response = await responsePromise;
  const request = response.request();
  const profile = validateNativeEditorEvidence({
    page_url: page.url(),
    request_url: request.url(),
    method: request.method(),
    http_status: response.status(),
    body: request.postDataJSON(),
  }, expectedSpu);
  if (runtimeProtocolProfile?.csecversion === '4.3.0' && profile.csecversion !== '4.3.0') {
    throw new Error('当前冻结 4.3.0 profile 与编辑页原生 profile 不一致，禁止继续');
  }
  return { profile };
}

async function probeExactEditorFrames(
  page,
  runDir,
  manifestPath,
  requestedLimit = 5,
  requestedConcurrency = 1,
) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const limit = Math.max(1, Math.min(10, Math.floor(Number(requestedLimit) || 5)));
  const targets = toArray(manifest.products)
    .map((item) => String(item?.spu_id || item?.spuId || '').trim())
    .filter((spuId) => /^\d+$/.test(spuId))
    .slice(0, limit);
  if (targets.length < 5) {
    throw new Error('精确执行区只读实验至少需要 5 个有效 SPU');
  }
  if (!page.url().includes('#/unifiedGoods/tenant/spu-list')) {
    await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.waitForFunction(
    () => Boolean(window.H5guard && typeof window.H5guard.sign === 'function'),
    null,
    { timeout: 30000 },
  );
  const topUrl = page.url();
  const pageCountBefore = page.context().pages().length;
  const monitor = await createBrowserResourceMonitor(page.context().browser());
  const rows = [];
  const concurrency = Math.max(
    1,
    Math.min(5, targets.length, Math.floor(Number(requestedConcurrency) || 1)),
  );
  let nextTargetIndex = 0;
  const probeWorker = async () => {
    while (true) {
      const index = nextTargetIndex;
      nextTargetIndex += 1;
      if (index >= targets.length) return;
      const spuId = targets[index];
      const startedAt = Date.now();
      const frameId = `codex-qnh-exact-frame-probe-${index}`;
      const targetUrl = `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`;
      const responsePromise = page.waitForResponse((response) => {
        const request = response.request();
        if (request.method() !== 'POST') return false;
        try {
          return new URL(request.url()).pathname === DETAIL_ENDPOINT
            && String(request.postDataJSON()?.spuId || '') === spuId;
        } catch { return false; }
      }, { timeout: 45000 });
      await page.evaluate(({ id, src }) => {
        document.getElementById(id)?.remove();
        const frame = document.createElement('iframe');
        frame.id = id;
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;opacity:0;pointer-events:none;border:0;';
        frame.src = src;
        (document.body || document.documentElement).appendChild(frame);
      }, { id: frameId, src: targetUrl });
      try {
        const response = await responsePromise;
        const request = response.request();
        const frame = page.frames().find((candidate) => candidate.url() === targetUrl);
        if (!frame) throw new Error('精确执行区已发详情请求但 frame 未绑定');
        const profile = validateNativeEditorEvidence({
          page_url: frame.url(),
          request_url: request.url(),
          method: request.method(),
          http_status: response.status(),
          body: request.postDataJSON(),
        }, spuId);
        if (profile.context_profile !== 'tenant_edit_v430') {
          throw new Error('精确执行区未取得 4.3.0 原生详情证据');
        }
        const signatureEvidence = await frame.evaluate(async ({ requestUrl, requestBody }) => {
          if (!window.H5guard || typeof window.H5guard.sign !== 'function') {
            throw new Error('frame_h5guard_unavailable');
          }
          const bodyText = JSON.stringify(requestBody);
          const signature = await window.H5guard.sign({
            url: requestUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: bodyText,
          });
          const headers = signature && typeof signature === 'object' ? signature.headers || {} : {};
          const header = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'mtgsig');
          const raw = typeof signature === 'string'
            ? signature
            : String(header?.[1] || signature?.mtgsig || signature?.data?.mtgsig || '');
          const findA9 = (value, depth = 0) => {
            if (depth > 7 || value === null || value === undefined) return '';
            if (typeof value === 'object') {
              if (value.a9 !== undefined) return String(value.a9 || '');
              for (const child of Object.values(value)) {
                const found = findA9(child, depth + 1);
                if (found) return found;
              }
              return '';
            }
            if (typeof value !== 'string') return '';
            try {
              const parsed = JSON.parse(value);
              const found = findA9(parsed, depth + 1);
              if (found) return found;
            } catch { /* opaque signature */ }
            return value.match(/(?:^|[,{\s])['"]?a9['"]?\s*[:=]\s*['"]?([^'",}\s]+)/i)?.[1] || '';
          };
          const a9 = findA9(raw);
          const explicitVersion = a9.match(/\b4\.(?:2|3)\.\d+\b/)?.[0] || '';
          return {
            present: Boolean(raw && a9),
            explicit_version: explicitVersion,
            opaque: Boolean(raw && a9 && !explicitVersion),
          };
        }, {
          requestUrl: effectiveRequestUrl(DETAIL_URL),
          requestBody: { spuId },
        });
        if (!signatureEvidence.present) throw new Error('精确执行区签名证据为空');
        if (signatureEvidence.explicit_version && signatureEvidence.explicit_version !== '4.3.0') {
          throw new Error('精确执行区签名版本与 4.3.0 不一致');
        }
        const resources = await monitor.sample();
        rows.push({
          ordinal: index + 1,
          spu_id: spuId,
          ok: true,
          http_status: response.status(),
          context_profile: profile.context_profile,
          signature_present: true,
          signature_version: signatureEvidence.explicit_version,
          signature_opaque: signatureEvidence.opaque,
          elapsed_ms: Date.now() - startedAt,
          browser_worker_rss_bytes: Number(resources.worker_renderer_rss_bytes || 0),
          browser_total_rss_bytes: Number(resources.browser_total_rss_bytes || 0),
        });
      } catch (error) {
        rows.push({
          ordinal: index + 1,
          spu_id: spuId,
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          elapsed_ms: Date.now() - startedAt,
        });
      } finally {
        await page.evaluate((id) => document.getElementById(id)?.remove(), frameId).catch(() => {});
        await page.waitForTimeout(150);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, () => probeWorker()));
  } finally {
    await monitor.close();
  }
  rows.sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
  const receipt = {
    schema: 'qnh-exact-editor-frame-readonly-probe-v1',
    created_at: isoNow(),
    manifest_path: manifestPath,
    requested: targets.length,
    concurrency,
    passed: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    platform_mutation_count: 0,
    top_url_unchanged: page.url() === topUrl,
    page_count_before: pageCountBefore,
    page_count_after: page.context().pages().length,
    rows,
  };
  const receiptPath = path.join(runDir, 'exact-editor-frame-readonly-probe.json');
  await writeJsonAtomic(receiptPath, receipt);
  await appendLog(runDir, 'exact_editor_frame_readonly_probe_completed', {
    requested: receipt.requested,
    concurrency: receipt.concurrency,
    passed: receipt.passed,
    failed: receipt.failed,
    platform_mutation_count: 0,
    top_url_unchanged: receipt.top_url_unchanged,
    page_count_before: receipt.page_count_before,
    page_count_after: receipt.page_count_after,
  });
  return { ...receipt, receipt_path: receiptPath };
}

async function returnToListAndCloseEditor(page, spuId) {
  await closeProductEditTabs(page, String(spuId)).catch(() => ({ closed_count: 0 }));
  if (!page.url().includes('#/unifiedGoods/tenant/spu-list')) {
    await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}

async function fetchDetail(page, spuId) {
  const modernEditor = runtimeProtocolProfile?.csecversion === '4.3.0';
  const response = await signedJson(page, {
    url: DETAIL_URL,
    body: { spuId: String(spuId) },
    qnhReferrer: modernEditor
      ? '/unifiedGoods/tenant/edit'
      : `/unifiedGoods/tenant/spu-edit?spuId=${encodeURIComponent(String(spuId))}`,
    fetchReferrer: modernEditor
      ? `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(String(spuId))}`
      : `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-edit?id=${encodeURIComponent(String(spuId))}`,
  });
  assertResponse(response, `读取 SPU ${spuId} 详情`);
  return detailSpu(response.data);
}

async function uiControlSnapshot(page) {
  return page.evaluate(() => [...document.querySelectorAll('input[id],textarea[id]')]
    .map((element) => ({
      id: element.id,
      value: element.value || '',
      checked: Boolean(element.checked),
      context: String(
        (element.closest('.unifiedGoods-ant-form-item') || element.parentElement)?.innerText || '',
      ).replace(/\s+/g, ' ').trim().slice(0, 500),
    }))
    .filter((item) => item.id && !item.id.startsWith('rc_select_')));
}

function locatorForFieldId(page, id) {
  if (id.endsWith('*')) {
    return page.locator(`input[id^="${id.slice(0, -1).replaceAll('"', '\\"')}"]`);
  }
  const exact = page.locator(`#${id}`);
  const labelled = page.locator(`label[for="${id.replaceAll('"', '\\"')}"]`)
    .locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," unifiedGoods-ant-form-item ")][1]')
    .locator('input[role="combobox"],input:not([type="hidden"]),textarea')
    .first();
  return exact.or(labelled);
}

async function applySelectValues(page, locator, fieldLabel, rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  await locator.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  if (await locator.count() !== 1) throw new Error(`选择字段不存在或不唯一：${fieldLabel}`);
  for (const rawValue of values) {
    const value = String(rawValue);
    let selected = false;
    for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
      await locator.click({ force: true });
      const readonly = await locator.getAttribute('readonly');
      if (readonly === null) await locator.fill(value);
      await page.waitForTimeout(800);
      const option = page.locator(
        `.unifiedGoods-ant-select-dropdown:visible .unifiedGoods-ant-select-item-option[title="${value.replaceAll('"', '\\"')}"]`,
      ).last();
      const optionVisible = await option.waitFor({ state: 'visible', timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (!optionVisible) continue;
      await option.click();
      await page.waitForTimeout(150);
      selected = true;
    }
    if (!selected) {
      const visibleOptions = await page.locator(
        '.unifiedGoods-ant-select-dropdown:visible .unifiedGoods-ant-select-item-option',
      ).allInnerTexts();
      throw new Error(`未找到选择候选：${fieldLabel}=${value}；可见候选：${visibleOptions.join(' | ')}`);
    }
  }
}

async function clearSelectValues(page, locator, fieldLabel) {
  if (await locator.count() !== 1) throw new Error(`清空选择字段不存在或不唯一：${fieldLabel}`);
  const select = locator.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," unifiedGoods-ant-select ")][1]');
  const clear = select.locator('.unifiedGoods-ant-select-clear').first();
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await page.waitForTimeout(150);
    return;
  }
  const removes = select.locator('.unifiedGoods-ant-select-selection-item-remove');
  let removed = false;
  while (await removes.count()) {
    const candidate = removes.last();
    if (!(await candidate.isVisible().catch(() => false))) break;
    await candidate.click();
    removed = true;
    await page.waitForTimeout(100);
  }
  if (removed) return;
  await locator.click({ force: true });
  await locator.press('Control+A');
  await locator.press('Backspace');
  await page.waitForTimeout(150);
}

async function clickRecommendations(page, expectedTexts) {
  const accepted = [];
  for (const expectedText of toArray(expectedTexts)) {
    const formItem = page.locator('.unifiedGoods-ant-form-item')
      .filter({ hasText: String(expectedText) })
      .filter({ hasText: '使用推荐' })
      .last();
    await formItem.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    if (await formItem.count() !== 1) throw new Error(`未找到指定平台推荐：${expectedText}`);
    const context = String(await formItem.innerText()).replace(/\s+/g, ' ').trim();
    const candidate = formItem.getByText('使用推荐', { exact: true }).last();
    if (await candidate.count() !== 1) throw new Error(`推荐入口不存在或不唯一：${expectedText}`);
    await candidate.click();
    accepted.push(context);
    await page.waitForTimeout(300);
  }
  return accepted;
}

async function clickUseAllRecommendations(page, enabled) {
  if (!enabled) return [];
  const accepted = [];
  await page.getByText('使用全部', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: 6000 })
    .catch(() => {});
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidates = page.getByText('使用全部', { exact: true });
    let selected = null;
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      selected = candidate;
      break;
    }
    if (!selected) break;
    const context = await selected.evaluate((element) => {
      let current = element;
      for (let index = 0; index < 5 && current; index += 1) {
        const text = String(current.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 15) return text.slice(0, 700);
        current = current.parentElement;
      }
      return '使用全部';
    });
    await selected.click();
    accepted.push(context);
    await page.waitForTimeout(500);
  }
  return accepted;
}

async function applyUiPlan(page, runDir, planPath, dryRun, validateOnly = false) {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  const spuId = String(plan.spu_id || '');
  if (!spuId) throw new Error('UI 计划缺少 spu_id');
  const beforeDetail = await fetchDetail(page, spuId);
  const beforeSummary = summarizeDetail(beforeDetail);
  await page.goto(`https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  // A same-hash SPA navigation can retain an unsaved React form. A hard reload
  // guarantees every plan starts from the last authoritative platform state.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('#basicInfo_spuName').waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForTimeout(2000);
  const uiBefore = await uiControlSnapshot(page);
  const acceptedRecommendations = await clickRecommendations(page, plan.recommendation_contains);
  acceptedRecommendations.push(
    ...await clickUseAllRecommendations(page, Boolean(plan.use_all_official_recommendations)),
  );
  for (const spec of toArray(plan.cascader_fields)) {
    const id = String(spec.id || '');
    const search = String(spec.search || '');
    const pathText = String(spec.path || '');
    if (!id || !search || !pathText) throw new Error('cascader_fields 缺少 id/search/path');
    const input = page.locator(`#${id}`);
    await input.click({ force: true });
    await input.fill(search);
    const item = page.locator('.unifiedGoods-ant-cascader-dropdown:visible li[role="menuitemcheckbox"]')
      .filter({ hasText: pathText })
      .last();
    const itemVisible = await item.waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!itemVisible) {
      const visibleOptions = await page.locator(
        '.unifiedGoods-ant-cascader-dropdown:visible li[role="menuitemcheckbox"]',
      ).allInnerTexts();
      throw new Error(`未找到级联类目候选：${pathText}；可见候选：${visibleOptions.join(' | ')}`);
    }
    const actualText = String(await item.innerText()).replace(/\s+/g, ' ').trim();
    const normalizedExpected = pathText.replace(/\s+/g, ' ').trim();
    if (actualText !== normalizedExpected) {
      throw new Error(`级联类目候选不精确：期望 ${normalizedExpected}，实际 ${actualText}`);
    }
    await item.click();
    await page.waitForTimeout(3000);
  }
  acceptedRecommendations.push(
    ...await clickRecommendations(page, plan.post_category_recommendation_contains),
  );
  // QNH collapses lower-priority channel properties. Expand every visible
  // property group before addressing a plan by stable input id.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const expanders = page.getByText(/展开输入项、选择项更多\d+项参数/);
    let clicked = false;
    for (let index = 0; index < await expanders.count(); index += 1) {
      const candidate = expanders.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = String(await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!/^展开输入项、选择项更多\d+项参数$/.test(label)) continue;
      await candidate.click();
      await page.waitForTimeout(200);
      clicked = true;
      break;
    }
    if (!clicked) break;
  }
  for (const [id, value] of Object.entries(toObject(plan.text_fields))) {
    const locator = locatorForFieldId(page, id);
    await locator.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    if (await locator.count() !== 1) throw new Error(`文本字段不存在或不唯一：${id}`);
    await locator.fill(String(value));
  }
  const replaceSelectFields = new Set(toArray(plan.replace_select_fields).map(String));
  for (const [id, rawValues] of Object.entries(toObject(plan.select_fields))) {
    const locator = locatorForFieldId(page, id);
    if (replaceSelectFields.has(id)) await clearSelectValues(page, locator, id);
    await applySelectValues(page, locator, id, rawValues);
  }
  for (const spec of toArray(plan.select_context_fields)) {
    const idPrefix = String(spec.id_prefix || '');
    const contextStarts = String(spec.context_starts || '');
    if (!idPrefix || !contextStarts) throw new Error('select_context_fields 缺少 id_prefix/context_starts');
    const candidates = await page.locator(`input[id^="${idPrefix.replaceAll('"', '\\"')}"]`).all();
    let matched = null;
    for (const candidate of candidates) {
      const context = await candidate.evaluate((element) => (
        element.closest('.unifiedGoods-ant-form-item')?.innerText || ''
      ).replace(/\s+/g, ' ').trim());
      if (context.startsWith(contextStarts)) {
        if (matched) throw new Error(`上下文选择字段不唯一：${idPrefix}/${contextStarts}`);
        matched = candidate;
      }
    }
    if (!matched) throw new Error(`未找到上下文选择字段：${idPrefix}/${contextStarts}`);
    await applySelectValues(page, matched, `${idPrefix}/${contextStarts}`, spec.values ?? spec.value);
  }
  for (const spec of toArray(plan.tree_select_fields)) {
    const id = String(spec.id || '');
    const value = String(spec.value || '').replace(/\s+/g, ' ').trim();
    if (!id || !value) throw new Error('tree_select_fields 缺少 id/value');
    const input = page.locator(`#${id.replaceAll('"', '\\"')}`);
    if (await input.count() !== 1) throw new Error(`树形选择字段不存在或不唯一：${id}`);
    await input.click({ force: true });
    const dropdown = page.locator(
      '.unifiedGoods-ant-tree-select-dropdown:visible,.unifiedGoods-ant-select-dropdown:visible',
    ).last();
    await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
    const nodes = dropdown.locator('.unifiedGoods-ant-select-tree-treenode');
    const exactMatches = [];
    for (let index = 0; index < await nodes.count(); index += 1) {
      const node = nodes.nth(index);
      const text = String(await node.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (text === value) exactMatches.push(node);
    }
    if (exactMatches.length !== 1) {
      const visibleValues = (await nodes.allInnerTexts())
        .map((text) => text.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      throw new Error(
        `树形选择候选不存在或不唯一：${id}=${value}；可见候选：${visibleValues.join(' | ')}`,
      );
    }
    const node = exactMatches[0];
    if (String(await node.getAttribute('class') || '').includes('switcher-close')) {
      throw new Error(`树形选择候选不是叶子节点：${id}=${value}`);
    }
    await node.locator('.unifiedGoods-ant-select-tree-title').first().click();
    await page.waitForTimeout(200);
  }
  for (const spec of toArray(plan.numeric_unit_context_fields)) {
    const contextStarts = String(spec.context_starts || '').replace(/\s+/g, ' ').trim();
    const number = String(spec.number ?? '').trim();
    const unit = String(spec.unit || '').trim();
    if (!contextStarts || !number || !unit) {
      throw new Error('numeric_unit_context_fields 缺少 context_starts/number/unit');
    }
    const items = await page.locator('.unifiedGoods-ant-form-item').all();
    const matches = [];
    for (const item of items) {
      const context = String(await item.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (!context.startsWith(contextStarts)) continue;
      matches.push(item);
    }
    if (!matches.length) throw new Error(`未找到上下文数值单位字段：${contextStarts}`);
    const hasMatchIndex = Object.prototype.hasOwnProperty.call(spec || {}, 'match_index');
    if (matches.length > 1 && !hasMatchIndex) {
      throw new Error(`上下文数值单位字段不唯一：${contextStarts}/${matches.length}`);
    }
    const matchIndex = Number(spec.match_index || 0);
    if (!Number.isInteger(matchIndex) || matchIndex < 0 || matchIndex >= matches.length) {
      throw new Error(`上下文数值单位字段索引无效：${contextStarts}/${matchIndex}/${matches.length}`);
    }
    const matched = matches[matchIndex];
    const numericInput = matched.locator(
      'input[placeholder="请输入数值"],input[placeholder="请输入数字"]',
    ).first();
    if (await numericInput.count() !== 1) {
      throw new Error(`上下文数值输入不存在或不唯一：${contextStarts}`);
    }
    await numericInput.fill(number);
    const unitInput = matched.locator('input[role="combobox"]').first();
    if (await unitInput.count() !== 1) {
      throw new Error(`上下文单位选择不存在或不唯一：${contextStarts}`);
    }
    const unitSelect = unitInput.locator(
      'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," unifiedGoods-ant-select ")][1]',
    );
    await unitSelect.click({ force: true });
    await page.waitForTimeout(500);
    const unitOption = page.locator(
      `.unifiedGoods-ant-select-dropdown:visible .unifiedGoods-ant-select-item-option[title="${unit.replaceAll('"', '\\"')}"]`,
    ).last();
    if (!await unitOption.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)) {
      const visibleOptions = await page.locator(
        '.unifiedGoods-ant-select-dropdown:visible .unifiedGoods-ant-select-item-option',
      ).allInnerTexts();
      throw new Error(
        `未找到上下文单位候选：${contextStarts}/${number}${unit}；可见候选：${visibleOptions.join(' | ')}`,
      );
    }
    await unitOption.click();
    await page.waitForTimeout(150);
  }
  for (const replacement of toArray(plan.sale_attribute_replacements)) {
    const oldValue = String(replacement.old_value || '');
    const newValue = String(replacement.new_value || '');
    if (!oldValue || !newValue) throw new Error('销售属性替换缺少 old_value/new_value');
    await page.getByText('设置规格值', { exact: true }).click();
    const modal = page.locator('.unifiedGoods-ant-modal:visible')
      .filter({ hasText: '批量设置规格值' })
      .last();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    const oldRow = modal.locator('.unifiedGoods-ant-col-6').filter({ hasText: oldValue }).first();
    const oldCheckbox = oldRow.locator('input[type="checkbox"]').first();
    if (await oldCheckbox.isChecked().catch(() => false)) await oldCheckbox.uncheck();
    let customInput = modal.locator('input[placeholder="自定义值"]').last();
    if (!(await customInput.isVisible().catch(() => false))) {
      await modal.getByText('自定义规格值', { exact: true }).click();
      customInput = modal.locator('input[placeholder="自定义值"]').last();
      await customInput.waitFor({ state: 'visible', timeout: 5000 });
    }
    await customInput.fill(newValue);
    const customRow = customInput.locator('xpath=ancestor::div[contains(@class,"ant-col-6")][1]');
    const customCheckbox = customRow.locator('input[type="checkbox"]').first();
    if (!(await customCheckbox.isChecked())) await customCheckbox.check();
    await modal.getByRole('button', { name: '确定', exact: true }).click();
    const deleteConfirm = page.locator('.unifiedGoods-ant-modal:visible')
      .filter({ hasText: '确认删除' })
      .last();
    if (await deleteConfirm.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) {
      await deleteConfirm.getByRole('button', { name: /确\s*认/, exact: true }).click();
      await deleteConfirm.waitFor({ state: 'hidden', timeout: 5000 });
      if (await modal.isVisible().catch(() => false)) {
        await modal.getByRole('button', { name: '确定', exact: true }).click();
      }
    }
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
    const specNameInputs = await page.locator('input[id^="specSettings_"][id$="_specName"]').all();
    let specIndex = '';
    for (const input of specNameInputs) {
      if (String(await input.inputValue()) !== newValue) continue;
      specIndex = String(await input.getAttribute('id')).match(/^specSettings_(\d+)_specName$/)?.[1] || '';
      break;
    }
    if (!specIndex) throw new Error(`新销售规格未出现在规格表：${newValue}`);
    const enable = page.locator(`#specSettings_${specIndex}_enable`);
    if (!(await enable.isChecked())) await enable.check();
    const history = page.locator(`#specSettings_${specIndex}_historySpec`);
    await history.click();
    const historyOption = page.locator(
      `.unifiedGoods-ant-select-dropdown:visible .unifiedGoods-ant-select-item-option[title^="${oldValue.replaceAll('"', '\\"')} ("]`,
    ).last();
    await historyOption.waitFor({ state: 'visible', timeout: 5000 });
    await historyOption.click();
    await page.waitForTimeout(300);
  }
  for (const spec of toArray(plan.sku_upc_fields)) {
    const specName = String(spec.spec_name || '');
    const upc = String(spec.upc || '');
    if (!specName || !/^\d{8,32}$/.test(upc)) throw new Error('sku_upc_fields 缺少合法 spec_name/upc');
    const tables = await page.locator('table').all();
    let input = null;
    for (const table of tables) {
      const headers = (await table.locator('thead th').allInnerTexts()).map((value) => value.replace(/\s+/g, ' ').trim());
      const upcIndex = headers.findIndex((value) => value.includes('商品条码'));
      const rows = await table.locator('tbody tr').all();
      for (const row of rows) {
        if (!String(await row.innerText()).replace(/\s+/g, ' ').includes(specName)) continue;
        if (upcIndex >= 0) {
          const cells = await row.locator('td').all();
          const candidate = cells[upcIndex]?.locator('input').first();
          if (candidate && await candidate.count() === 1) input = candidate;
        }
        if (!input) {
          const candidate = row.locator('input[id^="upcList_"]').first();
          if (await candidate.count() === 1) input = candidate;
        }
      }
    }
    if (!input) throw new Error(`未找到 SKU 条码输入：${specName}`);
    await input.fill(upc);
  }
  const uiPrepared = await uiControlSnapshot(page);
  const requiredFields = await page.evaluate(() => [
    ...document.querySelectorAll('.unifiedGoods-ant-form-item-label > label.unifiedGoods-ant-form-item-required'),
  ].map((label) => {
    const item = label.closest('.unifiedGoods-ant-form-item');
    return {
      label: String(label.textContent || '').replace(/\s+/g, ' ').trim(),
      controls: [...(item?.querySelectorAll('input[id],textarea[id]') || [])].map((control) => ({
        id: control.id,
        value: control.value || '',
        disabled: Boolean(control.disabled),
      })),
      context: String(item?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }));
  const preparation = {
    spu_id: spuId,
    dry_run: dryRun,
    accepted_recommendations: acceptedRecommendations,
    use_all_official_recommendations: Boolean(plan.use_all_official_recommendations),
    text_fields: toObject(plan.text_fields),
    select_fields: toObject(plan.select_fields),
    replace_select_fields: [...replaceSelectFields],
    select_context_fields: toArray(plan.select_context_fields),
    tree_select_fields: toArray(plan.tree_select_fields),
    numeric_unit_context_fields: toArray(plan.numeric_unit_context_fields),
    cascader_fields: toArray(plan.cascader_fields),
    sale_attribute_replacements: toArray(plan.sale_attribute_replacements),
    ui_before: uiBefore,
    ui_prepared: uiPrepared,
    required_fields: requiredFields,
  };
  if (dryRun) {
    let validation = null;
    if (validateOnly) {
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(900);
      validation = await page.evaluate(() => ({
        errors: [...document.querySelectorAll('.unifiedGoods-ant-form-item-has-error')]
          .map((element) => ({
            context: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
            inputs: [...element.querySelectorAll('input[id],textarea[id]')].map((input) => ({
              id: input.id,
              value: input.value || '',
              placeholder: input.placeholder || '',
            })),
          })),
        dialogs: [...document.querySelectorAll('[role=dialog],.unifiedGoods-ant-modal')]
          .filter((element) => getComputedStyle(element).display !== 'none')
          .map((element) => String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800)),
      }));
      const visibleModal = page.locator('.unifiedGoods-ant-modal:visible').last();
      if (await visibleModal.count()) {
        const cancel = visibleModal.getByRole('button', { name: /取消/ }).last();
        if (await cancel.count()) await cancel.click();
      }
      validation.valid = validation.errors.length === 0 && validation.dialogs.some(
        (text) => text.includes('确认提交修改'),
      );
    }
    const screenshotPath = path.join(runDir, `poc-${spuId}-prepared.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const preparationPath = path.join(runDir, `poc-${spuId}-prepared.json`);
    await writeJson(preparationPath, { ...preparation, validation });
    return {
      ok: true,
      dry_run: true,
      validate_only: validateOnly,
      valid: validation?.valid ?? null,
      validation_errors: validation?.errors ?? [],
      preparationPath,
      screenshotPath,
    };
  }
  const networkEvents = [];
  const responseTasks = [];
  const onResponse = (response) => {
    if (response.request().method() !== 'POST' || !response.url().startsWith('https://qnh.meituan.com/')) return;
    responseTasks.push((async () => {
      let payload = null;
      try {
        const raw = await response.text();
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      networkEvents.push({
        url: response.url().replace(/[?].*$/, ''),
        http_status: response.status(),
        business: businessEnvelope(payload),
        ...(/\/qnh-gw3\/api\/product\/tenant\/update(?:\/v2)?(?:\?|$)/.test(response.url())
          ? { request_body: response.request().postDataJSON() }
          : {}),
      });
    })());
  };
  page.on('response', onResponse);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const confirmDialog = page.locator('[role=dialog],.unifiedGoods-ant-modal')
    .filter({ hasText: '确认提交修改' })
    .last();
  const dialogVisible = await confirmDialog.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  let activityConflictPolicy = '';
  if (dialogVisible) {
    const policyRadios = confirmDialog.locator('input[type="radio"]');
    if (await policyRadios.count()) {
      const requestedPolicy = String(plan.activity_conflict_policy || '');
      if (requestedPolicy !== 'update_product' && requestedPolicy !== 'keep_activity') {
        throw new Error('平台要求选择活动冲突策略；计划必须显式设置 activity_conflict_policy');
      }
      activityConflictPolicy = requestedPolicy;
      const policyValue = requestedPolicy === 'update_product' ? '2' : '1';
      const policyRadio = confirmDialog.locator(`input[type="radio"][value="${policyValue}"]`);
      if (await policyRadio.count() !== 1) {
        throw new Error(`活动冲突策略选项不存在：${requestedPolicy}`);
      }
      await policyRadio.check();
      if (!(await policyRadio.isChecked())) throw new Error('活动冲突策略未成功选中，停止保存');
    } else {
      activityConflictPolicy = 'not_present';
    }
    await confirmDialog.getByRole('button', { name: '确认修改', exact: true }).click();
  }
  const coverageDialog = page.locator('.unifiedGoods-ant-modal:visible')
    .filter({ hasText: '以下商品信息发生变更，请确定覆盖范围' })
    .last();
  const coverageVisible = await coverageDialog.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  let coverageScope = '';
  if (coverageVisible) {
    const requestedScope = String(plan.coverage_scope || '');
    if (requestedScope !== 'all_stores' && requestedScope !== 'no_store_sync') {
      throw new Error('平台要求选择覆盖范围；计划必须显式设置 coverage_scope');
    }
    coverageScope = requestedScope;
    const scopeValue = requestedScope === 'all_stores' ? '1' : '2';
    const scopeRadios = await coverageDialog.locator(
      `input[type="radio"][value="${scopeValue}"]`,
    ).all();
    if (!scopeRadios.length) throw new Error(`覆盖范围没有可选项：${requestedScope}`);
    for (const radio of scopeRadios) {
      await radio.check();
      if (!(await radio.isChecked())) throw new Error('覆盖范围未成功选中，停止保存');
    }
    await coverageDialog.getByRole('button', { name: /确\s*定/, exact: true }).click();
  }
  await page.waitForTimeout(12000);
  await Promise.allSettled(responseTasks);
  page.off('response', onResponse);
  const updateEvent = [...networkEvents].reverse().find((event) => (
    /(?:update|save|submit|modify)/i.test(event.url)
    && !/(?:query|detail|recommend|validate|check)/i.test(event.url)
  ));
  if (!updateEvent) {
    const validationSnapshot = await page.evaluate(() => ({
      errors: [...document.querySelectorAll('.unifiedGoods-ant-form-item-has-error')]
        .map((element) => ({
          context: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900),
          inputs: [...element.querySelectorAll('input[id],textarea[id]')].map((input) => ({
            id: input.id,
            value: input.value || '',
            placeholder: input.placeholder || '',
          })),
        })),
      dialogs: [...document.querySelectorAll('[role=dialog],.unifiedGoods-ant-modal')]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800)),
    }));
    const screenshotPath = path.join(runDir, `poc-${spuId}-save-debug.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const debugPath = path.join(runDir, `poc-${spuId}-save-debug.json`);
    await writeJson(debugPath, {
      spu_id: spuId,
      network_events: networkEvents,
      dialog_visible: dialogVisible,
      activity_conflict_policy: activityConflictPolicy,
      coverage_visible: coverageVisible,
      coverage_scope: coverageScope,
      validation: validationSnapshot,
      screenshot_path: screenshotPath,
    });
    throw new Error(`保存未出现可识别写请求，低敏网络轨迹已保存：${debugPath}`);
  }
  assertResponse({ http_status: updateEvent.http_status, data: updateEvent.business }, `保存 SPU ${spuId}`);
  await page.waitForTimeout(1200);
  const afterDetail = await fetchDetail(page, spuId);
  const afterSummary = summarizeDetail(afterDetail);
  const result = {
    ...preparation,
    dry_run: false,
    update_http_status: updateEvent.http_status,
    update_business: updateEvent.business,
    update_endpoint: updateEvent.url,
    network_events: networkEvents,
    activity_conflict_policy: activityConflictPolicy,
    coverage_scope: coverageScope,
    before: beforeSummary,
    after: afterSummary,
    changed_fields: diffSummaries(beforeSummary, afterSummary),
    verified_at: isoNow(),
  };
  const resultPath = path.join(runDir, `poc-${spuId}-result.json`);
  await writeJson(resultPath, result);
  await appendLog(runDir, 'ui_plan_saved_and_read_back', {
    spu_id: spuId,
    changed_field_count: result.changed_fields.length,
    result_file: resultPath,
  });
  return { ok: true, dry_run: false, resultPath, changed_fields: result.changed_fields };
}

async function readDetails(page, runDir, manifestPath, limit, label = '', offset = 0) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const normalizedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const products = toArray(manifest.products).slice(
    normalizedOffset,
    limit > 0 ? normalizedOffset + limit : undefined,
  );
  const details = new Array(products.length);
  const requestedConcurrency = Number(process.env.QNH_DETAIL_CONCURRENCY || 10);
  const concurrency = runtimeProtocolProfile?.csecversion === '4.3.0'
    ? Math.max(1, Math.min(5, Math.floor(requestedConcurrency) || 5))
    : Math.max(1, Math.min(10, Math.floor(requestedConcurrency) || 10));
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= products.length) return;
      const product = products[index];
      const spuId = String(product.spu_id);
      if (runtimeProtocolProfile?.csecversion === '4.3.0') {
        const response = await signedJsonQueryWithSingleRetry(page, {
          url: DETAIL_URL,
          body: { spuId },
          qnhReferrer: LIST_REFERRER,
          fetchReferrer: LIST_PAGE_URL,
        }, runDir, { query: 'tenant_detail', spu_id: spuId });
        assertResponse(response, `读取 SPU ${spuId} 详情`);
        const detail = detailSpu(response.data);
        details[index] = {
          spu_id: spuId,
          title: titleOf(detail) || product.title,
          detail,
          protocol_profile: runtimeProtocolProfile.context_profile,
        };
        await appendLog(runDir, 'detail_read', {
          index: normalizedOffset + index + 1,
          total: products.length,
          spu_id: spuId,
          title: titleOf(detail) || product.title,
          concurrency,
          protocol_profile: runtimeProtocolProfile.context_profile,
          query_only_shared_list_page: true,
        });
        continue;
      }
      const response = await signedJson(page, {
        url: DETAIL_URL,
        body: { spuId },
        qnhReferrer: `/unifiedGoods/tenant/spu-edit?spuId=${encodeURIComponent(spuId)}`,
        fetchReferrer: `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-edit?id=${encodeURIComponent(spuId)}`,
      });
      const envelope = businessEnvelope(response.data);
      if (
        response.http_status === 200
        && String(envelope.code || '') === '2000'
        && String(envelope.message || '').includes('记录不存在')
      ) {
        details[index] = {
          spu_id: spuId,
          title: product.title || '',
          missing_on_platform: true,
          missing_reason: '记录不存在',
          detail: { spuChannelInfoList: [] },
        };
        await appendLog(runDir, 'detail_missing_on_platform', {
          index: normalizedOffset + index + 1,
          total: products.length,
          spu_id: spuId,
          reason: '记录不存在',
          concurrency,
        });
        continue;
      }
      assertResponse(response, `读取 SPU ${spuId} 详情`);
      const detail = detailSpu(response.data);
      details[index] = {
        spu_id: spuId,
        title: titleOf(detail) || product.title,
        detail,
      };
      await appendLog(runDir, 'detail_read', {
        index: normalizedOffset + index + 1,
        total: products.length,
        spu_id: spuId,
        title: titleOf(detail) || product.title,
        concurrency,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker));
  if (label && !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('详情 label 只能包含字母、数字和连字符');
  }
  const detailPath = path.join(
    runDir,
    `details-${label ? `${label}-` : ''}${details.length}.json`,
  );
  await writeJson(detailPath, {
    generated_at: isoNow(),
    manifest_path: manifestPath,
    products: details,
  });
  return { detailPath, count: details.length };
}

async function buildCategoryCompletionPlans(
  page,
  runDir,
  detailsPath,
  limit,
  concurrency,
  label = 'channel-category-completion',
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('渠道类目补全计划 label 只能包含字母、数字和连字符');
  }
  const payload = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const candidates = toArray(payload.products).filter((product) => {
    const detail = toObject(product.detail);
    return toArray(detail.spuChannelInfoList).some((channel) => (
      Number(channel?.channelId || 0) === 300 && !String(channel?.categoryCode || '')
    ));
  }).slice(0, limit > 0 ? limit : undefined);
  const safeConcurrency = Math.max(1, Math.min(10, Math.floor(Number(concurrency) || 10)));
  const plansDir = path.join(runDir, `plans-${label}`);
  await ensureDir(plansDir);
  const storeReceipt = await queryStoreFrontCategories(page, runDir);
  const storeCategory = storeReceipt.categories.find((row) => (
    row.name === '未分类1' && row.name_path === '未分类1'
    && row.enable === 1 && row.is_leaf === true
  ));
  if (!storeCategory) throw new Error('当前账号店内分类回执没有启用叶子“未分类1”');
  const brandReceipt = await queryChannelBrand(page, runDir, 300, '无品牌');
  const noBrand = brandReceipt.candidates.find((row) => (
    Number(row.channel_id) === 300 && row.brand_name === '无品牌'
  ));
  if (!noBrand) throw new Error('当前账号京东渠道品牌回执没有精确候选“无品牌”');
  const propertyPromises = new Map();
  const propertyReceiptFor = (channelId, categoryCode) => {
    const key = `${channelId}:${categoryCode}`;
    if (!propertyPromises.has(key)) {
      propertyPromises.set(
        key,
        queryChannelCategoryProperty(page, runDir, channelId, categoryCode),
      );
    }
    return propertyPromises.get(key);
  };
  const rows = new Array(candidates.length);
  let nextIndex = 0;
  const processProduct = async (index) => {
    const product = candidates[index];
    const detail = toObject(product.detail);
    const spuId = String(detail.spuId || product.spu_id || '');
    const title = String(detail.spuName || product.title || '');
    try {
      const recommendation = await queryChannelCategoryRecommendation(page, runDir, title, '');
      const jdCategory = recommendation.candidates.find((row) => Number(row.channel_id) === 300);
      if (!jdCategory) throw new Error('官方 batchRecommend 未返回京东到家类目');
      const property = await propertyReceiptFor(300, jdCategory.category_code);
      const jdChannel = toArray(detail.spuChannelInfoList).find(
        (channel) => Number(channel?.channelId || 0) === 300,
      );
      if (!jdChannel) throw new Error('商品详情缺少京东到家渠道容器');
      const plan = {
        spu_id: spuId,
        activity_conflict_policy: 'update_product',
        coverage_scope: 'all_stores',
        update_profile: 'tenant_edit_v424',
        recommended_channel_category_fields: [{
          channel_id: 300,
          category_code: jdCategory.category_code,
          category_name: jdCategory.category_name,
          category_code_path: jdCategory.category_code_path,
          category_name_path: jdCategory.category_name_path,
          expected_old_category_code: String(jdChannel.categoryCode || ''),
          upc: '',
          recommendation_receipt_path: recommendation.receiptPath,
          property_receipt_path: property.receiptPath,
          evidence: '当前商品完整标题触发牵牛花官方 batchRecommend，并以同类目 property/batchQuery 合同复核。',
        }],
        audit_decisions: [{
          field: '京东到家渠道类目',
          status: 'accepted',
          source: 'qnh_official_channel_category_recommendation',
          new_value: jdCategory,
        }],
      };
      const oldBrand = toObject(jdChannel.brandInfo);
      if (!String(oldBrand.brandCode || '') || !String(oldBrand.brandName || '')) {
        plan.channel_brand_info_fields = [{
          channel_id: 300,
          brand_code: noBrand.brand_code,
          brand_name: noBrand.brand_name,
          expected_old_brand: {
            brand_code: String(oldBrand.brandCode || ''),
            brand_name: String(oldBrand.brandName || ''),
          },
          query_receipt_path: brandReceipt.receiptPath,
          evidence: '用户明确要求京东品牌为空时选择当前账号精确候选“无品牌”。',
        }];
      }
      const oldStoreCodes = toArray(detail.storeFrontCategoryList).flatMap(
        (row) => toArray(row?.allCategoryCodeList).map(String),
      );
      if (!oldStoreCodes.length) {
        plan.store_front_category_field = {
          category_code: storeCategory.category_code,
          name: storeCategory.name,
          name_path: storeCategory.name_path,
          expected_old_category_codes: [],
          query_receipt_path: storeReceipt.receiptPath,
          evidence: '用户允许店内分类任选；固定选择当前账号启用叶子分类“未分类1”。',
        };
      }
      const currentMainImages = toArray(detail.picUrlList).map(String).filter(Boolean);
      if (currentMainImages.length < 3) {
        const gallery = await queryGalleryImages(page, title, 1, 10);
        const currentNormalized = new Set(currentMainImages.map(normalizedImageUrl));
        const chosen = gallery.urls.filter((url) => (
          !currentNormalized.has(normalizedImageUrl(url))
        )).slice(0, 3 - currentMainImages.length);
        if (currentMainImages.length + chosen.length >= 3) {
          plan.gallery_search_text = gallery.search_text;
          plan.gallery_page = gallery.page;
          plan.gallery_page_size = gallery.page_size;
          plan.minimum_main_image_count = 3;
          plan.main_image_gallery_urls = chosen;
        } else {
          plan.audit_decisions.push({
            field: '商品主图',
            status: 'blocked',
            source: 'qnh_gallery_exact_title_query',
            reason: `图库精确标题查询后仍不足3张：当前${currentMainImages.length}张/候选${chosen.length}张`,
          });
        }
      }
      const requiredPictures = toArray(detail.mtSpecialPictureList).filter((picture) => (
        Number(picture?.isRequired || 0) === 1 && picture?.deleted !== true
      ));
      const allRequiredPicturesFilled = requiredPictures.length > 0 && requiredPictures.every(
        (picture) => toArray(picture?.pictureUrl).map(String).filter(Boolean).length
          >= Math.max(1, Number(picture?.numMin || 1)),
      );
      if (allRequiredPicturesFilled) plan.mirror_existing_special_pictures = true;
      const planPath = path.join(plansDir, `${spuId}.json`);
      await writeJson(planPath, plan);
      rows[index] = {
        spu_id: spuId,
        title,
        status: 'ready',
        plan_path: planPath,
        recommended_category: jdCategory,
        property_receipt_path: property.receiptPath,
        main_image_add_count: toArray(plan.main_image_gallery_urls).length,
        store_category_added: Boolean(plan.store_front_category_field),
        no_brand_added: Boolean(toArray(plan.channel_brand_info_fields).length),
        mirrored_special_pictures: plan.mirror_existing_special_pictures === true,
        decisions: plan.audit_decisions,
      };
    } catch (error) {
      rows[index] = {
        spu_id: spuId,
        title,
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await appendLog(runDir, 'category_completion_plan_built', {
      index: index + 1,
      total: candidates.length,
      spu_id: spuId,
      status: rows[index].status,
      reason: String(rows[index].reason || '').slice(0, 300),
    });
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      await processProduct(index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, Math.max(1, candidates.length)) }, worker),
  );
  const indexPath = path.join(plansDir, 'index.json');
  await writeJson(indexPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    selected_total: candidates.length,
    concurrency: safeConcurrency,
    ready_count: rows.filter((row) => row?.status === 'ready').length,
    blocked_count: rows.filter((row) => row?.status === 'blocked').length,
    rows,
  });
  return {
    indexPath,
    selectedTotal: candidates.length,
    ready: rows.filter((row) => row?.status === 'ready').length,
    blocked: rows.filter((row) => row?.status === 'blocked').length,
    concurrency: safeConcurrency,
  };
}

function normalizedBrandLabel(value) {
  return String(value || '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '')
    .replace(/[!！]/g, '')
    .toLowerCase();
}

function brandLabelWithoutAlias(value) {
  return normalizedBrandLabel(value).replace(/\([^)]*\)$/g, '');
}

function brandLabelAliases(value) {
  return String(value || '')
    .split(/[/／,，、;；]/)
    .flatMap((part) => {
      const normalized = normalizedBrandLabel(part);
      const withoutAlias = brandLabelWithoutAlias(part);
      return [normalized, withoutAlias];
    })
    .filter(Boolean);
}

function normalizedTitleForBrand(value) {
  const title = String(value || '');
  const withoutLeadingPromotions = title
    .replace(/^(?:\s*[【[][^】\]]*[】]])+\s*/g, '')
    .trim();
  return normalizedBrandLabel(withoutLeadingPromotions || title);
}

function existingBrandSearchTokens(detail) {
  const title = String(detail?.spuName || '');
  const rawValues = [
    toObject(detail?.brand).brandName,
    detail?.brandName,
  ];
  for (const channel of toArray(detail?.spuChannelInfoList)) {
    if (Number(channel?.channelId || 0) !== 100) continue;
    rawValues.push(toObject(channel?.brandInfo).brandName);
    for (const prop of toArray(channel?.categoryProperties)) {
      if (String(prop?.attrName || '') !== '品牌') continue;
      rawValues.push(
        ...toArray(prop?.customValue).map((value) => String(value?.attrValue || '')),
      );
    }
  }
  const excluded = new Set(['', '其他品牌', '其它品牌', '无品牌']);
  const tokens = [];
  for (const rawValue of rawValues) {
    for (const token of String(rawValue || '').split(/[,，、;；]/)) {
      const trimmed = token.replace(/\s+/g, ' ').trim();
      if (excluded.has(trimmed) || tokens.includes(trimmed)) continue;
      tokens.push(trimmed);
      const withoutAlias = trimmed.replace(/\s*[（(][^）)]*[）)]\s*$/g, '').trim();
      if (
        withoutAlias
        && !excluded.has(withoutAlias)
        && !tokens.includes(withoutAlias)
      ) {
        tokens.push(withoutAlias);
      }
      const withoutPunctuation = withoutAlias.replace(/[!！]/g, '').trim();
      if (
        withoutPunctuation
        && !excluded.has(withoutPunctuation)
        && !tokens.includes(withoutPunctuation)
      ) {
        tokens.push(withoutPunctuation);
      }
    }
  }
  return tokens.sort((left, right) => {
    const leftCore = brandLabelWithoutAlias(left);
    const rightCore = brandLabelWithoutAlias(right);
    const normalizedTitle = normalizedTitleForBrand(title);
    const leftIndex = leftCore ? normalizedTitle.indexOf(leftCore) : -1;
    const rightIndex = rightCore ? normalizedTitle.indexOf(rightCore) : -1;
    const leftRank = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const rightRank = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

async function buildChannelBrandCompletionPlans(
  page,
  runDir,
  detailsPath,
  limit,
  concurrency,
  channelId = 200,
  label = 'channel-brand-completion',
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('渠道品牌补全计划 label 只能包含字母、数字和连字符');
  }
  const payload = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const candidates = toArray(payload.products).filter((product) => {
    const detail = toObject(product.detail);
    return toArray(detail.spuChannelInfoList).some((channel) => (
      Number(channel?.channelId || 0) === Number(channelId)
      && toArray(channel?.categoryProperties).some((prop) => (
        String(prop?.attrName || '') === '品牌'
        && String(prop?.attrValueType || '') === '4'
        && Number(prop?.isRequired || 0) === 1
        && propertyDisplayValues(prop).length === 0
      ))
    ));
  }).slice(0, limit > 0 ? limit : undefined);
  const safeConcurrency = Math.max(1, Math.min(10, Math.floor(Number(concurrency) || 10)));
  const plansDir = path.join(runDir, `plans-${label}`);
  await ensureDir(plansDir);
  const queryPromises = new Map();
  const queryFor = (searchText) => {
    const key = `${channelId}:${searchText}`;
    if (!queryPromises.has(key)) {
      queryPromises.set(key, queryChannelBrand(page, runDir, channelId, searchText));
    }
    return queryPromises.get(key);
  };
  const rows = new Array(candidates.length);
  let nextIndex = 0;
  const processProduct = async (index) => {
    const product = candidates[index];
    const detail = toObject(product.detail);
    const spuId = String(detail.spuId || product.spu_id || '');
    const title = String(detail.spuName || product.title || '');
    const channelIndex = toArray(detail.spuChannelInfoList).findIndex(
      (channel) => Number(channel?.channelId || 0) === Number(channelId),
    );
    const channel = toArray(detail.spuChannelInfoList)[channelIndex];
    const prop = toArray(channel?.categoryProperties).find((candidate) => (
      String(candidate?.attrName || '') === '品牌'
      && String(candidate?.attrValueType || '') === '4'
      && Number(candidate?.isRequired || 0) === 1
      && propertyDisplayValues(candidate).length === 0
    ));
    const searchTokens = existingBrandSearchTokens(detail);
    const queryReceipts = [];
    let selected = null;
    let ambiguous = false;
    try {
      const normalizedTitle = normalizedTitleForBrand(title);
      const mentionedTokens = searchTokens.filter((token) => {
        const tokenCore = brandLabelWithoutAlias(token);
        return tokenCore && normalizedTitle.includes(tokenCore);
      });
      const eligibleTokens = mentionedTokens.length ? mentionedTokens : (
        new Set(searchTokens.map(brandLabelWithoutAlias).filter(Boolean)).size === 1
          ? searchTokens
          : []
      );
      for (const searchText of eligibleTokens) {
        const query = await queryFor(searchText);
        queryReceipts.push(query.receiptPath);
        const tokenLabel = normalizedBrandLabel(searchText);
        const tokenCore = brandLabelWithoutAlias(searchText);
        const exact = query.candidates.filter((candidate) => {
          if (Number(candidate.channel_id || 0) !== Number(channelId)) return false;
          const aliases = brandLabelAliases(candidate.brand_name);
          return aliases.includes(tokenLabel) || aliases.includes(tokenCore);
        });
        const unique = [...new Map(exact.map((item) => [item.brand_code, item])).values()];
        if (unique.length === 1) {
          selected = { ...unique[0], query, searchText };
          break;
        }
        if (unique.length > 1) ambiguous = true;
      }
      if (!selected || !prop || channelIndex < 0) {
        rows[index] = {
          spu_id: spuId,
          title,
          status: 'blocked',
          reason: !searchTokens.length
            ? '同 SPU 没有已存品牌事实'
            : !eligibleTokens.length
              ? '同 SPU 存在多个品牌事实但标题无法唯一指向'
            : ambiguous
              ? '官方渠道品牌目录返回多个同名编码'
              : '官方渠道品牌目录没有唯一精确匹配',
          search_tokens: searchTokens,
          query_receipt_paths: queryReceipts,
        };
      } else {
        const plan = {
          spu_id: spuId,
          activity_conflict_policy: 'update_product',
          coverage_scope: 'all_stores',
          update_profile: 'tenant_edit_v424',
          remote_brand_channel_fields: [{
            channel_id: Number(channelId),
            channel_index: channelIndex,
            attr_id: String(prop.attrId || ''),
            brand_code: selected.brand_code,
            brand_name: selected.brand_name,
            expected_old_values: [],
            query_receipt_path: selected.query.receiptPath,
            evidence: `同 SPU 已存品牌“${selected.searchText}”与渠道 ${channelId} 官方品牌目录唯一精确匹配。`,
          }],
          audit_decisions: [{
            field: `${channelId}:品牌`,
            status: 'accepted',
            source: 'same_spu_brand_and_qnh_channel_brand_exact_query',
            new_value: selected.brand_name,
            query_receipt_path: selected.query.receiptPath,
          }],
        };
        const planPath = path.join(plansDir, `${spuId}.json`);
        await writeJson(planPath, plan);
        rows[index] = {
          spu_id: spuId,
          title,
          status: 'ready',
          plan_path: planPath,
          brand_code: selected.brand_code,
          brand_name: selected.brand_name,
          search_text: selected.searchText,
          query_receipt_path: selected.query.receiptPath,
        };
      }
    } catch (error) {
      rows[index] = {
        spu_id: spuId,
        title,
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
        search_tokens: searchTokens,
        query_receipt_paths: queryReceipts,
      };
    }
    await appendLog(runDir, 'channel_brand_completion_plan_built', {
      index: index + 1,
      total: candidates.length,
      spu_id: spuId,
      channel_id: Number(channelId),
      status: rows[index].status,
      reason: String(rows[index].reason || '').slice(0, 300),
    });
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      await processProduct(index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, Math.max(1, candidates.length)) }, worker),
  );
  const indexPath = path.join(plansDir, 'index.json');
  await writeJson(indexPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    channel_id: Number(channelId),
    selected_total: candidates.length,
    concurrency: safeConcurrency,
    ready_count: rows.filter((row) => row?.status === 'ready').length,
    blocked_count: rows.filter((row) => row?.status === 'blocked').length,
    rows,
  });
  return {
    indexPath,
    selectedTotal: candidates.length,
    ready: rows.filter((row) => row?.status === 'ready').length,
    blocked: rows.filter((row) => row?.status === 'blocked').length,
    concurrency: safeConcurrency,
  };
}

async function buildGalleryMinimumPlans(
  page,
  runDir,
  detailsPath,
  limit,
  minimumCount = 3,
  requestedConcurrency = 10,
  label = 'gallery-minimum',
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('图库计划 label 只能包含字母、数字和连字符');
  }
  const snapshot = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const minimum = Math.max(1, Math.min(10, Math.floor(Number(minimumCount) || 3)));
  const candidates = toArray(snapshot.products).filter((product) => (
    toArray(toObject(product.detail).picUrlList).map(String).filter(Boolean).length < minimum
  ));
  const selected = candidates.slice(0, limit > 0 ? limit : undefined);
  const concurrency = Math.max(
    1,
    Math.min(20, Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 10),
  );
  const outputDir = path.join(runDir, label);
  await ensureDir(outputDir);
  const rows = new Array(selected.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const product = selected[index];
      const detail = toObject(product.detail);
      const spuId = String(detail.spuId || product.spu_id || '');
      const title = String(titleOf(detail) || product.title || '').replace(/\s+/g, ' ').trim();
      const current = toArray(detail.picUrlList).map(String).filter(Boolean);
      try {
        const gallery = await queryGalleryImages(page, title, 1, 10);
        const currentSet = new Set(current.map(normalizedImageUrl));
        const usable = gallery.urls.filter((url, urlIndex, urls) => (
          !currentSet.has(normalizedImageUrl(url))
          && urls.findIndex((candidate) => normalizedImageUrl(candidate) === normalizedImageUrl(url)) === urlIndex
        ));
        const needed = minimum - current.length;
        const chosen = usable.slice(0, needed);
        if (chosen.length < needed) {
          rows[index] = {
            spu_id: spuId,
            title,
            status: 'insufficient_gallery_results',
            current_image_count: current.length,
            needed_count: needed,
            gallery_result_count: gallery.urls.length,
          };
          continue;
        }
        const plan = {
          spu_id: spuId,
          activity_conflict_policy: 'update_product',
          coverage_scope: 'all_stores',
          minimum_main_image_count: minimum,
          gallery_search_text: gallery.search_text,
          gallery_page: gallery.page,
          gallery_page_size: gallery.page_size,
          main_image_gallery_urls: chosen,
          audit_decisions: [{
            field: '商品图片',
            old_value: current,
            new_value: [...current, ...chosen],
            status: 'accepted',
            source: 'qnh_gallery_exact_title_query',
            evidence: `牵牛花图库按当前商品完整标题查询，取平台排序最靠前且未重复的 ${chosen.length} 张，使主图达到最低 ${minimum} 张`,
          }],
        };
        const planPath = path.join(outputDir, `${spuId}.json`);
        await writeJson(planPath, plan);
        rows[index] = {
          spu_id: spuId,
          title,
          status: 'ready',
          current_image_count: current.length,
          selected_count: chosen.length,
          final_image_count: current.length + chosen.length,
          plan_path: planPath,
        };
      } catch (error) {
        rows[index] = {
          spu_id: spuId,
          title,
          status: 'failed',
          current_image_count: current.length,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, selected.length)) },
    () => worker(),
  ));
  const indexPath = path.join(outputDir, 'index.json');
  await writeJson(indexPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    minimum_main_image_count: minimum,
    concurrency,
    rows,
  });
  await appendLog(runDir, 'gallery_minimum_plans_built', {
    details_path: detailsPath,
    index_path: indexPath,
    selected_total: selected.length,
    ready_count: rows.filter((row) => row?.status === 'ready').length,
    insufficient_count: rows.filter((row) => row?.status === 'insufficient_gallery_results').length,
    failed_count: rows.filter((row) => row?.status === 'failed').length,
  });
  return {
    indexPath,
    selectedTotal: selected.length,
    readyCount: rows.filter((row) => row?.status === 'ready').length,
    insufficientCount: rows.filter((row) => row?.status === 'insufficient_gallery_results').length,
    failedCount: rows.filter((row) => row?.status === 'failed').length,
  };
}

async function buildSpecialPictureMirrorPlans(
  runDir,
  detailsPath,
  limit,
  label = 'special-picture-mirror',
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('专项图镜像计划 label 只能包含字母、数字和连字符');
  }
  const snapshot = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const eligible = [];
  for (const product of toArray(snapshot.products)) {
    const detail = toObject(product.detail);
    const pictures = toArray(detail.mtSpecialPictureList);
    const requiredPictures = pictures.filter((picture) => (
      Number(picture?.isRequired || 0) === 1 && picture?.deleted !== true
    ));
    const allRequiredFilled = requiredPictures.length > 0 && requiredPictures.every((picture) => (
      toArray(picture?.pictureUrl).map(String).filter(Boolean).length
      >= Math.max(1, Number(picture?.numMin || 1))
    ));
    if (!allRequiredFilled) continue;
    const meituan = toArray(detail.spuChannelInfoList).find(
      (channel) => Number(channel?.channelId || 0) === 100,
    );
    if (!meituan || JSON.stringify(toArray(meituan.specialPictureList)) === JSON.stringify(pictures)) {
      continue;
    }
    eligible.push({
      spu_id: String(detail.spuId || product.spu_id || ''),
      title: String(titleOf(detail) || product.title || '').replace(/\s+/g, ' ').trim(),
      pictures,
    });
  }
  const selected = eligible.slice(0, limit > 0 ? limit : undefined);
  const outputDir = path.join(runDir, label);
  await ensureDir(outputDir);
  const rows = [];
  for (const product of selected) {
    const plan = {
      spu_id: product.spu_id,
      activity_conflict_policy: 'update_product',
      coverage_scope: 'all_stores',
      update_profile: 'tenant_edit_v424',
      mirror_existing_special_pictures: true,
      audit_decisions: [{
        field: '美团闪购专项图双契约',
        status: 'accepted',
        source: 'existing_top_level_special_picture_receipt',
        evidence: `主档 mtSpecialPictureList 的全部必填槽位已有图片 URL，镜像到渠道 100 specialPictureList；不生成、不替换原图`,
      }],
    };
    const planPath = path.join(outputDir, `${product.spu_id}.json`);
    await writeJson(planPath, plan);
    rows.push({
      spu_id: product.spu_id,
      title: product.title,
      status: 'ready',
      required_picture_count: product.pictures.filter(
        (picture) => Number(picture?.isRequired || 0) === 1 && picture?.deleted !== true,
      ).length,
      existing_picture_url_count: product.pictures.reduce(
        (total, picture) => total + toArray(picture?.pictureUrl).map(String).filter(Boolean).length,
        0,
      ),
      plan_path: planPath,
    });
  }
  const indexPath = path.join(outputDir, 'index.json');
  await writeJson(indexPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    rows,
  });
  await appendLog(runDir, 'special_picture_mirror_plans_built', {
    details_path: detailsPath,
    index_path: indexPath,
    ready_count: rows.length,
  });
  return { indexPath, readyCount: rows.length };
}

async function snapshotSpecialPictureCandidates(
  page,
  runDir,
  detailsPath,
  limit,
  requestedConcurrency = 10,
  label = 'special-picture-candidates',
  manifestPath = '',
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('专项图候选 label 只能包含字母、数字和连字符');
  }
  const snapshot = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const auditBySpu = new Map();
  if (manifestPath) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    for (const product of toArray(manifest.products)) {
      const spuId = String(product?.spu_id || product?.spuId || '').trim();
      if (!spuId) continue;
      const issueText = toArray(product?.issue_text)
        .map(String)
        .filter(Boolean)
        .join(' ');
      auditBySpu.set(spuId, issueText);
    }
  }
  const auditRequiresPicture = (picture, auditText) => {
    const text = String(auditText || '');
    if (!text) return false;
    const title = String(picture?.pictureTitle || '');
    if (title && text.includes(title)) return true;
    const tokensByType = QUALIFICATION_IMAGE_POLICY.candidate_selection
      ?.audit_tokens_by_picture_type || {};
    return toArray(tokensByType[Number(picture?.pictureType || 0)])
      .some((token) => text.includes(token));
  };
  const candidates = [];
  for (const product of toArray(snapshot.products)) {
    const detail = toObject(product.detail);
    const spuId = String(detail.spuId || product.spu_id || '');
    const auditText = auditBySpu.get(spuId) || '';
    const missingPictures = toArray(detail.mtSpecialPictureList).filter((picture) => {
      if (Number(picture?.isRequired || 0) !== 1 || picture?.deleted === true) return false;
      const belowMinimum = toArray(picture?.pictureUrl).map(String).filter(Boolean).length
        < Math.max(1, Number(picture?.numMin || 1));
      return belowMinimum || auditRequiresPicture(picture, auditText);
    });
    if (!missingPictures.length) continue;
    candidates.push({ product, detail, missingPictures, auditText });
  }
  const selected = candidates.slice(0, limit > 0 ? limit : undefined);
  const selectionPolicy = QUALIFICATION_IMAGE_POLICY.candidate_selection || {};
  const concurrency = Math.max(
    Number(selectionPolicy.minimum_concurrency || 1),
    Math.min(
      Number(selectionPolicy.maximum_concurrency || 20),
      Number.isFinite(requestedConcurrency)
        ? Math.floor(requestedConcurrency)
        : Number(selectionPolicy.default_concurrency || 10),
    ),
  );
  const rows = new Array(selected.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const { product, detail, missingPictures, auditText } = selected[index];
      const spuId = String(detail.spuId || product.spu_id || '');
      const title = String(titleOf(detail) || product.title || '').replace(/\s+/g, ' ').trim();
      try {
        const gallery = await queryGalleryImages(page, title, 1, 10);
        rows[index] = {
          spu_id: spuId,
          title,
          basic_brand: String(toObject(detail.brand).brandName || ''),
          current_main_urls: toArray(detail.picUrlList).map(String).filter(Boolean),
          current_detail_urls: toArray(detail.picContentList).map(String).filter(Boolean),
          gallery_search_text: gallery.search_text,
          gallery_page: gallery.page,
          gallery_page_size: gallery.page_size,
          gallery_urls: gallery.urls,
          audit_rejected: Boolean(auditText),
          missing_pictures: missingPictures.map((picture) => ({
            picture_type: Number(picture?.pictureType),
            picture_title: String(picture?.pictureTitle || ''),
            picture_desc: String(picture?.pictureDesc || ''),
            num_min: Math.max(1, Number(picture?.numMin || 1)),
            num_limit: Math.max(1, Number(picture?.numLimit || 4)),
            existing_urls: toArray(picture?.pictureUrl).map(String).filter(Boolean),
          })),
          status: 'ready',
        };
      } catch (error) {
        rows[index] = {
          spu_id: spuId,
          title,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, selected.length)) },
    () => worker(),
  ));
  const outputPath = path.join(runDir, `${label}.json`);
  await writeJson(outputPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    concurrency,
    rows,
  });
  await appendLog(runDir, 'special_picture_candidates_snapshotted', {
    details_path: detailsPath,
    output_path: outputPath,
    selected_total: selected.length,
    ready_count: rows.filter((row) => row?.status === 'ready').length,
    failed_count: rows.filter((row) => row?.status === 'failed').length,
  });
  return {
    outputPath,
    selectedTotal: selected.length,
    readyCount: rows.filter((row) => row?.status === 'ready').length,
    failedCount: rows.filter((row) => row?.status === 'failed').length,
  };
}

async function inspectEditors(page, runDir, manifestPath, limit) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const products = toArray(manifest.products).slice(0, limit > 0 ? limit : undefined);
  const inspections = [];
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    const spuId = String(product.spu_id);
    await page.goto(`https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.locator('#basicInfo_spuName').waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(800);
    const snapshot = await page.evaluate(() => {
      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const controls = [...document.querySelectorAll('input[id],textarea[id]')]
        .map((element) => {
          const formItem = element.closest('.unifiedGoods-ant-form-item') || element.parentElement;
          return {
            id: element.id,
            tag: element.tagName.toLowerCase(),
            type: element.type || '',
            value: element.value || '',
            placeholder: element.placeholder || '',
            disabled: Boolean(element.disabled),
            checked: Boolean(element.checked),
            context: text(formItem?.innerText).slice(0, 300),
          };
        })
        .filter((item) => item.id && !item.id.startsWith('rc_select_'));
      const recommendations = [...document.querySelectorAll('button,a,span')]
        .filter((element) => text(element.textContent) === '使用推荐')
        .map((element) => {
          const formItem = element.closest('.unifiedGoods-ant-form-item') || element.parentElement?.parentElement;
          return text(formItem?.innerText).slice(0, 500);
        });
      const problemText = text(document.querySelector('[class*="abnormal"]')?.innerText)
        || text(document.body.innerText).slice(0, 1800);
      return {
        page_url: window.location.href,
        controls,
        recommendations,
        problem_text: problemText,
      };
    });
    inspections.push({
      spu_id: spuId,
      title: product.title,
      ...snapshot,
    });
    await appendLog(runDir, 'editor_inspected', {
      index: index + 1,
      total: products.length,
      spu_id: spuId,
      controls: snapshot.controls.length,
      recommendations: snapshot.recommendations.length,
    });
    const tabCleanup = await closeProductEditTabs(page, spuId);
    await appendLog(runDir, 'product_edit_tab_closed', {
      spu_id: spuId,
      closed_count: tabCleanup.closed_count,
      remaining_count: tabCleanup.remaining_count,
    });
  }
  const inspectionPath = path.join(runDir, `editor-inspections-${inspections.length}.json`);
  await writeJson(inspectionPath, {
    generated_at: isoNow(),
    manifest_path: manifestPath,
    products: inspections,
  });
  return { inspectionPath, count: inspections.length };
}

async function readOfficialRecommendations(page, runDir, detailsPath, limit, label = '') {
  const snapshot = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const products = toArray(snapshot.products).slice(0, limit > 0 ? limit : undefined);
  const recommendations = new Array(products.length);
  const needsChannel200NoBrandReceipt = products.some((product) => (
    toArray(toObject(product.detail).spuChannelInfoList).some((channel) => (
      Number(channel.channelId || 0) === 200
      && toArray(channel.categoryProperties).some((attr) => (
        String(attr.attrName || '') === '品牌'
        && String(attr.attrValueType || '') === '4'
        && propertyDisplayValues(attr).length === 0
      ))
    ))
  ));
  if (needsChannel200NoBrandReceipt) {
    const brandReceipt = await queryChannelBrand(page, runDir, 200, '无品牌');
    if (!brandReceipt.candidates.some((item) => String(item.brand_name || '') === '无品牌')) {
      throw new Error('渠道 200 未返回可验证的无品牌候选，禁止使用猜测品牌编码');
    }
  }
  const recommendationConcurrency = runtimeProtocolProfile?.csecversion === '4.3.0' ? 5 : 1;
  let nextRecommendationIndex = 0;
  let completedRecommendations = 0;
  const worker = async () => {
    while (true) {
      const index = nextRecommendationIndex;
      nextRecommendationIndex += 1;
      if (index >= products.length) return;
    const product = products[index];
    const detail = toObject(product.detail);
    const channel = toArray(detail.spuChannelInfoList).find(
      (candidate) => Number(candidate.channelId || 0) === 100,
    );
    const categoryCode = String(channel?.categoryCode || '');
    const firstSku = toArray(detail.skus)[0] || {};
    const upc = String(toArray(firstSku.upcList)[0] || '');
    let responseData = null;
    let error = '';
    if (categoryCode) {
      try {
        const response = await signedJsonQueryWithSingleRetry(page, {
          url: DYNAMIC_RECOMMEND_URL,
          body: {
            spuName: String(detail.spuName || product.title || ''),
            channelId: 100,
            channelCategoryId: categoryCode,
            upc,
          },
          qnhReferrer: runtimeProtocolProfile?.csecversion === '4.3.0'
            ? LIST_REFERRER
            : '/unifiedGoods/tenant/edit',
          fetchReferrer: runtimeProtocolProfile?.csecversion === '4.3.0'
            ? LIST_PAGE_URL
            : `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(String(detail.spuId || product.spu_id || ''))}`,
        }, runDir, {
          query: 'official_recommendation',
          spu_id: String(detail.spuId || product.spu_id || ''),
        });
        assertResponse(response, `读取 SPU ${detail.spuId || product.spu_id} 官方属性推荐`);
        responseData = unwrapData(response.data);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else {
      error = '美团渠道类目为空';
    }
    recommendations[index] = {
      spu_id: String(detail.spuId || product.spu_id || ''),
      title: String(detail.spuName || product.title || ''),
      category_code: categoryCode,
      upc,
      recommendation: responseData,
      error,
    };
    await appendLog(runDir, 'official_dynamic_recommendation_read', {
      index: index + 1,
      total: products.length,
      spu_id: String(detail.spuId || product.spu_id || ''),
      ok: Boolean(responseData),
      error: error.slice(0, 300),
    });
    completedRecommendations += 1;
    if (completedRecommendations % 25 === 0) {
      process.stderr.write(`${JSON.stringify({
        event: 'official_recommendation_progress',
        done: completedRecommendations,
        total: products.length,
      })}\n`);
    }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(recommendationConcurrency, products.length) },
    worker,
  ));
  if (label && !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw new Error('推荐读取 label 只能包含字母、数字和连字符');
  }
  const outputPath = path.join(
    runDir,
    `official-recommendations-${label ? `${label}-` : ''}${recommendations.length}.json`,
  );
  await writeJson(outputPath, {
    generated_at: isoNow(),
    details_path: detailsPath,
    products: recommendations,
  });
  return {
    outputPath,
    count: recommendations.length,
    okCount: recommendations.filter((item) => item.recommendation).length,
  };
}

async function backfillVerifiedMainImageIntent(runDir, planPath, resultPath) {
  const planRaw = await fs.readFile(planPath, 'utf8');
  const planSha256 = sha256(planRaw);
  const plan = JSON.parse(planRaw);
  const spuId = String(plan.spu_id || '');
  if (!spuId) throw new Error('回填生成主图写意图时计划缺少 spu_id');
  const material = await loadVerifiedMainImageMaterial(plan, spuId);
  if (!material) throw new Error('回填生成主图写意图时计划缺少 main_image_uploaded');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const requestedChanges = toArray(result.requested_changes);
  const verification = toArray(result.verification);
  const mainChange = requestedChanges[0];
  const mainVerification = verification[0];
  const expectedOldMainImages = toArray(plan.expected_old_main_image_urls)
    .map(String)
    .filter(Boolean);
  const expectedNewMainImages = expectedMainImageReplacement(
    expectedOldMainImages,
    material.uploadedUrl,
  );
  const resultTenantId = String(result.tenant_id || '');
  const resultJobId = String(result.job_id || '');
  const resultPlanSha256 = String(result.plan_sha256 || '');
  const updateBusinessCode = String(toObject(result.update_business).code || '');
  if (
    String(result.spu_id || '') !== spuId
    || result.verified !== true
    || Number(result.update_http_status || 0) < 200
    || Number(result.update_http_status || 0) >= 300
    || (updateBusinessCode && !['0', '200'].includes(updateBusinessCode))
    || requestedChanges.length !== 1
    || mainChange?.field_path !== 'main_images'
    || !exactImageUrlListEqual(mainChange?.old_value, expectedOldMainImages)
    || !exactImageUrlListEqual(mainChange?.new_value, expectedNewMainImages)
    || verification.length !== 1
    || verification.some((item) => item?.verified !== true)
    || mainVerification?.field_path !== 'main_images'
    || !exactImageUrlListEqual(mainVerification.expected, expectedNewMainImages)
    || !exactImageUrlListEqual(mainVerification.actual, expectedNewMainImages)
    || (resultTenantId && resultTenantId !== material.expectedTenantId)
    || (resultJobId && resultJobId !== material.jobId)
    || (resultPlanSha256 && resultPlanSha256 !== planSha256)
  ) {
    throw new Error('历史生成主图结果未通过租户/SPU/任务/计划/HTTP/逐字段回读校验');
  }
  const intentIdentity = {
    tenant_id: material.expectedTenantId,
    spu_id: spuId,
    job_id: material.jobId,
    plan_sha256: planSha256,
    artifact_sha256: material.artifactSha256,
    expected_old_main_image_urls: expectedOldMainImages,
    expected_new_main_image_urls: expectedNewMainImages,
  };
  const intentPath = await mainImageWriteIntentPath(material.expectedTenantId, spuId);
  const legacyIntentPath = legacyMainImageWriteIntentPath(
    runDir,
    material.expectedTenantId,
    spuId,
  );
  const legacyIntent = await loadMainImageWriteIntent(
    legacyIntentPath,
    intentIdentity,
  );
  if (legacyIntent && legacyIntent.status !== 'verified') {
    throw new Error('旧 run-dir 生成主图写意图不是 verified，禁止迁移为全局 fence');
  }
  await createMainImageWriteIntent(intentPath, intentIdentity);
  await updateMainImageWriteIntent(
    intentPath,
    intentIdentity,
    'verified',
    {
      accepted_at: String(result.verified_at || isoNow()),
      verified_at: String(result.verified_at || isoNow()),
      last_readback_at: String(result.verified_at || isoNow()),
      update_http_status: Number(result.update_http_status || 0),
      update_business: toObject(result.update_business),
      update_endpoint: String(result.update_endpoint || ''),
      backfilled_from_verified_result: true,
      migrated_from_legacy_run_dir_intent: Boolean(legacyIntent),
      backfilled_at: isoNow(),
    },
  );
  const upgradedResult = {
    ...result,
    tenant_id: material.expectedTenantId,
    job_id: material.jobId,
    plan_sha256: planSha256,
    identity_backfilled_at: isoNow(),
  };
  await writeJsonAtomic(resultPath, upgradedResult);
  await appendLog(runDir, 'main_image_write_intent_backfilled', {
    spu_id: spuId,
    tenant_id: material.expectedTenantId,
    plan_sha256: planSha256,
    intent_file: intentPath,
    result_file: resultPath,
    verified: true,
    network_calls: 0,
  });
  return {
    ok: true,
    network_calls: 0,
    spu_id: spuId,
    tenant_id: material.expectedTenantId,
    plan_sha256: planSha256,
    intent_path: intentPath,
    legacy_intent_path: legacyIntent ? legacyIntentPath : '',
    migrated_from_legacy_intent: Boolean(legacyIntent),
    result_path: resultPath,
    result_upgraded: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'preflight';
  if (command === 'apply-direct-batch' || command === 'apply-prepared-barrier-batch') {
    // This check intentionally happens before ensureDir/CDP attach so an
    // unmanaged invocation has zero filesystem, page, provider, or platform side effects.
    assertManagedDirectBatchRuntime();
    // The hard 50-SPU boundary is also checked before run-dir creation and
    // CDP attach.  An oversized invocation therefore sends zero platform calls.
    selectReadyMutationWindow(
      [],
      Number(args.offset || 0),
      Number(args.limit || (command === 'apply-prepared-barrier-batch' ? 10 : 50)),
    );
  }
  const cdpUrl = String(args.cdp || DEFAULT_CDP);
  const runDir = path.resolve(String(args['run-dir'] || DEFAULT_RUN_DIR));
  await ensureDir(runDir);
  if (command === 'backfill-verified-main-image-intent') {
    if (!args.plan || !args.result) {
      throw new Error(
        'backfill-verified-main-image-intent 命令需要 --plan 和 --result',
      );
    }
    const result = await backfillVerifiedMainImageIntent(
      runDir,
      path.resolve(String(args.plan)),
      path.resolve(String(args.result)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const { browser, page } = await attach(cdpUrl);
  try {
    if (command !== 'preflight') {
      const identityPath = path.join(runDir, 'session_identity.json');
      const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
      if (identity.csecversion === '4.3.0') {
        runtimeProtocolProfile = {
          context_profile: String(identity.context_profile || 'tenant_list_v430'),
          csecversion: '4.3.0',
          qnh_referrer: LIST_ROUTE,
          source: String(identity.native_profile_source || ''),
        };
      }
    }
    if (command === 'preflight') {
      const result = await preflight(page);
      const sessionIdentity = {
        ...result,
        cdp_url: cdpUrl,
        run_dir: runDir,
        profile_dir: String(args['profile-dir'] || ''),
      };
      await writeJsonAtomic(path.join(runDir, 'session_identity.json'), sessionIdentity);
      await appendLog(runDir, 'preflight_ok', sessionIdentity);
      process.stdout.write(`${JSON.stringify(sessionIdentity, null, 2)}\n`);
      return;
    }
    if (command === 'gallery-search') {
      const searchText = String(args.search || '').replace(/\s+/g, ' ').trim();
      if (!searchText) throw new Error('gallery-search 命令需要 --search');
      const result = await queryGalleryImages(
        page,
        searchText,
        Number(args.page || 1),
        Number(args['page-size'] || 10),
      );
      await appendLog(runDir, 'gallery_search_read_only', {
        search_text: result.search_text,
        page: result.page,
        page_size: result.page_size,
        result_count: result.urls.length,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'master-brand-search') {
      const searchText = String(args.search || '').replace(/\s+/g, ' ').trim();
      if (!searchText) throw new Error('master-brand-search 命令需要 --search');
      const result = await queryMasterBrand(page, runDir, searchText);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'channel-brand-search') {
      const searchText = String(args.search || '').replace(/\s+/g, ' ').trim();
      const channelId = Number(args.channel || 100);
      if (!searchText) throw new Error('channel-brand-search 命令需要 --search');
      const result = await queryChannelBrand(page, runDir, channelId, searchText);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'channel-category-recommend') {
      const spuName = String(args.name || '').replace(/\s+/g, ' ').trim();
      if (!spuName) throw new Error('channel-category-recommend 命令需要 --name');
      const result = await queryChannelCategoryRecommendation(
        page,
        runDir,
        spuName,
        String(args.upc || ''),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'channel-category-property') {
      const channelId = Number(args.channel || 0);
      const categoryCode = String(args.category || '').trim();
      if (!channelId || !categoryCode) {
        throw new Error('channel-category-property 命令需要 --channel、--category');
      }
      const result = await queryChannelCategoryProperty(
        page,
        runDir,
        channelId,
        categoryCode,
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'store-category-query') {
      const result = await queryStoreFrontCategories(page, runDir);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'upload-image') {
      if (!args.file) throw new Error('upload-image 命令需要 --file');
      const result = await uploadLocalImage(page, runDir, String(args.file));
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'close-edit-tabs') {
      const result = await closeProductEditTabs(page);
      await appendLog(runDir, 'product_edit_tabs_closed', result);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'freeze') {
      const allowDynamicTotal = ['1', 'true', 'yes'].includes(
        String(args['allow-dynamic-total'] || '').toLowerCase(),
      );
      const result = await freezeManifest(
        page,
        runDir,
        Number(args['page-size'] || 100),
        String(args.label || ''),
        allowDynamicTotal,
      );
      process.stdout.write(`${JSON.stringify({
        ok: true,
        manifest_path: result.manifestPath,
        total: result.manifest.unique_total,
        expected_total: result.manifest.expected_total,
        raw_row_total: result.manifest.raw_row_total,
        dynamic_total_mismatch: result.manifest.dynamic_total_mismatch,
        spu_id_sha256: result.manifest.spu_id_sha256,
      }, null, 2)}\n`);
      return;
    }
    if (command === 'details') {
      const manifestPath = path.resolve(String(args.manifest || ''));
      if (!args.manifest) throw new Error('details 命令需要 --manifest');
      const result = await readDetails(
        page,
        runDir,
        manifestPath,
        Number(args.limit || 10),
        String(args.label || ''),
        Number(args.offset || 0),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'probe-exact-editor-frames') {
      if (!args.manifest) throw new Error('probe-exact-editor-frames 命令需要 --manifest');
      const result = await probeExactEditorFrames(
        page,
        runDir,
        path.resolve(String(args.manifest)),
        Number(args.limit || 5),
        Number(args.concurrency || 1),
      );
      process.stdout.write(`${JSON.stringify({ ok: result.failed === 0, ...result }, null, 2)}\n`);
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    if (command === 'build-category-completion-plans') {
      if (!args.details) throw new Error('build-category-completion-plans 命令需要 --details');
      const result = await buildCategoryCompletionPlans(
        page,
        runDir,
        path.resolve(String(args.details)),
        Number(args.limit || 0),
        Number(args.concurrency || 10),
        String(args.label || 'channel-category-completion'),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'build-channel-brand-completion-plans') {
      if (!args.details) {
        throw new Error('build-channel-brand-completion-plans 命令需要 --details');
      }
      const result = await buildChannelBrandCompletionPlans(
        page,
        runDir,
        path.resolve(String(args.details)),
        Number(args.limit || 0),
        Number(args.concurrency || 10),
        Number(args.channel || 200),
        String(args.label || 'channel-brand-completion'),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'build-gallery-plans') {
      if (!args.details) throw new Error('build-gallery-plans 命令需要 --details');
      const result = await buildGalleryMinimumPlans(
        page,
        runDir,
        path.resolve(String(args.details)),
        Number(args.limit || 0),
        Number(args.minimum || 3),
        Number(args.concurrency || 10),
        String(args.label || 'gallery-minimum'),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'build-special-picture-mirror-plans') {
      if (!args.details) throw new Error('build-special-picture-mirror-plans 命令需要 --details');
      const result = await buildSpecialPictureMirrorPlans(
        runDir,
        path.resolve(String(args.details)),
        Number(args.limit || 0),
        String(args.label || 'special-picture-mirror'),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'snapshot-special-picture-candidates') {
      if (!args.details) throw new Error('snapshot-special-picture-candidates 命令需要 --details');
      const result = await snapshotSpecialPictureCandidates(
        page,
        runDir,
        path.resolve(String(args.details)),
        Number(args.limit || 0),
        Number(args.concurrency || 10),
        String(args.label || 'special-picture-candidates'),
        args.manifest ? path.resolve(String(args.manifest)) : '',
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'inspect-ui') {
      const manifestPath = path.resolve(String(args.manifest || ''));
      if (!args.manifest) throw new Error('inspect-ui 命令需要 --manifest');
      const result = await inspectEditors(page, runDir, manifestPath, Number(args.limit || 10));
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'recommendations') {
      if (!args.details) throw new Error('recommendations 命令需要 --details');
      const detailsPath = path.resolve(String(args.details));
      const result = await readOfficialRecommendations(
        page,
        runDir,
        detailsPath,
        Number(args.limit || 0),
        String(args.label || ''),
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'recommendation-query') {
      const spuId = String(args.spu || '').trim();
      const spuName = String(args.name || '').trim();
      const categoryCode = String(args['category-code'] || '').trim();
      const upc = String(args.upc || '').trim();
      if (!spuId || !spuName || !categoryCode) {
        throw new Error('recommendation-query 命令需要 --spu、--name、--category-code');
      }
      const response = await signedJson(page, {
        url: DYNAMIC_RECOMMEND_URL,
        body: {
          spuName,
          channelId: 100,
          channelCategoryId: categoryCode,
          upc,
        },
        qnhReferrer: '/unifiedGoods/tenant/edit',
        fetchReferrer: `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`,
      });
      assertResponse(response, `读取 SPU ${spuId} 目标类目官方属性推荐`);
      const recommendation = unwrapData(response.data);
      await appendLog(runDir, 'official_dynamic_recommendation_target_category_read', {
        spu_id: spuId,
        category_code: categoryCode,
        has_recommendation: Boolean(Object.keys(toObject(recommendation)).length),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        spu_id: spuId,
        category_code: categoryCode,
        recommendation,
      }, null, 2)}\n`);
      return;
    }
    if (command === 'apply-ui-plan') {
      if (!args.plan) throw new Error('apply-ui-plan 命令需要 --plan');
      const planPath = path.resolve(String(args.plan));
      const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
      const spuId = String(plan.spu_id || '');
      let result;
      let tabCleanup;
      try {
        result = await applyUiPlan(
          page,
          runDir,
          planPath,
          args['dry-run'] === true
            || String(args['dry-run'] || '') === '1'
            || args.validate === true
            || String(args.validate || '') === '1',
          args.validate === true || String(args.validate || '') === '1',
        );
      } finally {
        tabCleanup = await closeProductEditTabs(page, spuId);
        await appendLog(runDir, 'product_edit_tab_closed', {
          spu_id: spuId,
          closed_count: tabCleanup.closed_count,
          remaining_count: tabCleanup.remaining_count,
        });
      }
      result.tab_cleanup = tabCleanup;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === 'apply-direct-plan') {
      if (!args.plan) throw new Error('apply-direct-plan 命令需要 --plan');
      const result = await applyDirectPlan(
        page,
        runDir,
        path.resolve(String(args.plan)),
        args['dry-run'] === true || String(args['dry-run'] || '') === '1',
        String(args['result-prefix'] || 'direct'),
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === 'apply-direct-batch') {
      if (!args.index) throw new Error('apply-direct-batch 命令需要 --index');
      const result = await applyDirectBatch(
        page,
        runDir,
        path.resolve(String(args.index)),
        Number(args.offset || 0),
        Number(args.limit || 50),
        String(args['batch-name'] || 'direct-batch'),
        Number(args.concurrency || 2),
        args['dry-run'] === true || String(args['dry-run'] || '') === '1',
      );
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (command === 'apply-prepared-barrier-batch') {
      if (!args.index) throw new Error('apply-prepared-barrier-batch 命令需要 --index');
      const result = await applyPreparedBarrierBatch(
        page,
        runDir,
        path.resolve(String(args.index)),
        Number(args.offset || 0),
        Number(args.limit || 2),
        String(args['batch-name'] || 'prepared-barrier-batch'),
        Number(args['preload-concurrency'] || 2),
      );
      process.stdout.write(`${JSON.stringify({ ok: result.failed === 0, ...result }, null, 2)}\n`);
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    throw new Error(`未知命令：${command}`);
  } finally {
    // CDP attach is to the user's long-lived browser.  Closing a Playwright
    // CDP connection here can terminate that browser (and the VNC session),
    // so keep it alive by default; explicit teardown is opt-in for isolated
    // smoke runs only.
    if (process.env.QNH_CLOSE_BROWSER === '1') {
      await browser.close();
    } else if (browser._connection && typeof browser._connection.close === 'function') {
      // Playwright has no public CDP disconnect method; closing only its
      // transport leaves the user's Chrome/VNC process running.
      browser._connection.close();
    }
  }
}

export {
  applyDirectPlanToDetail,
  businessEnvelope,
  businessOk,
  channelPropertyContractMatches,
  coverageField,
  detailSpu,
  diffSummaries,
  findTotal,
  propertyDisplayValues,
  summarizeDetail,
  titleOf,
  unwrapData,
};

const invokedAsScript = Boolean(
  process.argv?.[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (invokedAsScript) {
  main()
    .then(() => {
      // Do not leave a Playwright transport/timer alive after the command has
      // finished; this exits the Node client while preserving the attached
      // Chrome process.
      process.exit(Number(process.exitCode || 0));
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 1);
    });
}
