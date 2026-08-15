import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
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
} from './qnh_direct.mjs';

const APP_KEY = 'fe_recofesaascrm';
const LIST_PAGE_URL = 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list';
const LIST_ENDPOINT = '/qnh-gw3/api/product/tenant/page-query';
const DETAIL_ENDPOINT = '/qnh-gw3/api/product/tenant/detail';
const BASE = 'https://qnh.meituan.com';
const LIST_URL = `${BASE}${LIST_ENDPOINT}?yodaReady=h5&csecplatform=4&csecversion=4.2.0`;
const DETAIL_URL = `${BASE}${DETAIL_ENDPOINT}?yodaReady=h5&csecplatform=4&csecversion=4.2.0`;
const UPDATE_URL = `${BASE}/qnh-gw3/api/product/tenant/update?yodaReady=h5&csecplatform=4&csecversion=4.2.0`;
const UPDATE_V2_URL = `${BASE}/qnh-gw3/api/product/tenant/update/v2?yodaReady=h5&csecplatform=4&csecversion=4.2.4`;
const RECOMMEND_URL = `${BASE}/qnh-gw5/api/storeSpu/queryRecommendDynamicInfoAndWeight?yodaReady=h5&csecplatform=4&csecversion=4.2.4`;
const CHANNEL_BRAND_URL = `${BASE}/api/v1/channelBrand/queryByChannel?yodaReady=h5&csecplatform=4&csecversion=4.2.0`;

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value) !== '') ?? '';
}

function withVersion(url, version) {
  const parsed = new URL(url);
  parsed.searchParams.set('csecversion', version);
  return parsed.toString();
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

async function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function prepareBrandExecutionPlan(plan, beforeDetail, spuId) {
  let executionPlan = plan;
  const requestedSnapshotBrands = toArray(plan.snapshot_brand_channel_fields);
  if (requestedSnapshotBrands.length) {
    const verifiedSnapshotBrands = [];
    for (const item of requestedSnapshotBrands) {
      if (!item?.snapshot_receipt_path) throw new Error('快照品牌渠道字段缺少 snapshot_receipt_path');
      const receipt = JSON.parse(await fs.readFile(path.resolve(String(item.snapshot_receipt_path)), 'utf8'));
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
      if (!channel || !prop || !exact) throw new Error('快照品牌回执未找到同渠道同属性的精确品牌编码');
      verifiedSnapshotBrands.push({
        channel_id: Number(channel.channelId || 0),
        attr_id: String(prop.attrId || ''),
        brand_code: String(exact.attrValueId || ''),
        brand_name: String(exact.attrValue || ''),
      });
    }
    executionPlan = { ...executionPlan, __verified_snapshot_brands: verifiedSnapshotBrands };
  }

  const requestedTenantSnapshotBrands = toArray(plan.tenant_snapshot_brand_channel_fields);
  if (requestedTenantSnapshotBrands.length) {
    const verifiedTenantSnapshotBrands = [];
    for (const item of requestedTenantSnapshotBrands) {
      if (!item?.snapshot_receipt_path || !item?.snapshot_source_spu_id) {
        throw new Error('同租户快照品牌字段缺少 snapshot_receipt_path/snapshot_source_spu_id');
      }
      const receipt = JSON.parse(await fs.readFile(path.resolve(String(item.snapshot_receipt_path)), 'utf8'));
      const sourceProduct = toArray(receipt.products).find((candidate) => (
        String(candidate?.spu_id || candidate?.detail?.spuId || '') === String(item.snapshot_source_spu_id || '')
      ));
      const sourceDetail = toObject(sourceProduct?.detail);
      if (!sourceProduct || String(sourceDetail.tenantId || '') !== String(beforeDetail.tenantId || '')) {
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
    executionPlan = { ...executionPlan, __verified_tenant_snapshot_brands: verifiedTenantSnapshotBrands };
  }

  const requestedChannelBrands = toArray(plan.remote_brand_channel_fields);
  if (requestedChannelBrands.length) {
    const verifiedChannelBrands = [];
    for (const item of requestedChannelBrands) {
      if (!item?.query_receipt_path) throw new Error('渠道品牌计划缺少 query_receipt_path');
      const receipt = JSON.parse(await fs.readFile(path.resolve(String(item.query_receipt_path)), 'utf8'));
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
  return executionPlan;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function writeChromeExtensionReceipt({
  runDir,
  command,
  artifacts,
  dryRun = false,
  summary = {},
}) {
  const normalizedArtifacts = [];
  for (const artifact of artifacts) {
    const artifactPath = path.resolve(String(artifact));
    if (artifactPath !== path.resolve(runDir) && !artifactPath.startsWith(`${path.resolve(runDir)}${path.sep}`)) {
      throw new Error('扩展动作制品不在 run-dir 内');
    }
    normalizedArtifacts.push({ path: artifactPath, sha256: await sha256File(artifactPath) });
  }
  const enginePath = new URL(import.meta.url).pathname;
  const receipt = {
    schema: 'qnh-chrome-extension-receipt-v1',
    generated_at: nowIso(),
    run_dir: path.resolve(runDir),
    browser_transport: 'chrome_extension_current_tab',
    command,
    dry_run: Boolean(dryRun),
    outcome: 'succeeded',
    engine_sha256: await sha256File(enginePath),
    artifacts: normalizedArtifacts,
    summary,
  };
  const receiptPath = path.join(runDir, `chrome-extension-${command}-${crypto.randomUUID()}.receipt.json`);
  await writeJsonAtomic(receiptPath, receipt);
  return receiptPath;
}

async function evaluate(cdp, expression, timeoutMs = 45000) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  }, { timeoutMs });
  if (response?.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Runtime.evaluate failed';
    throw new Error(String(text));
  }
  return response?.result?.value;
}

async function waitForH5guard(cdp, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      cdp,
      'Boolean(window.H5guard && typeof window.H5guard.sign === "function")',
      5000,
    ).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('H5guard 未就绪');
}

async function closeInternalEditTabs(cdp, spuId = '') {
  const targetSpu = String(spuId || '');
  const expression = `(() => {
    const targetSpu = ${JSON.stringify(targetSpu)};
    const tabs = Array.from(document.querySelectorAll('[data-sort-id^="/unifiedGoods/tenant/edit"]'))
      .filter((tab) => !targetSpu || String(tab.getAttribute('data-sort-id') || '').includes('spu=' + targetSpu));
    for (const tab of tabs) tab.querySelector('[class*="remove--"]')?.click();
    return tabs.length;
  })()`;
  const closed = Number(await evaluate(cdp, expression, 5000) || 0);
  if (closed) await new Promise((resolve) => setTimeout(resolve, 150));
  return closed;
}

function signedRequestExpression({ url, body, qnhReferrer, fetchReferrer = '' }) {
  const payload = JSON.stringify({ url, body, qnhReferrer, fetchReferrer, appKey: APP_KEY });
  return `(${async function signedRequest(input) {
    if (!window.H5guard || typeof window.H5guard.sign !== 'function') {
      throw new Error('H5guard 未就绪');
    }
    const bodyText = JSON.stringify(input.body || {});
    const contentType = 'application/json;charset=UTF-8';
    const signature = await window.H5guard.sign({
      url: input.url,
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bodyText,
    });
    const signatureHeaders = signature && typeof signature === 'object' ? signature.headers || {} : {};
    const entry = Object.entries(signatureHeaders).find(([key]) => String(key).toLowerCase() === 'mtgsig');
    const mtgsig = typeof signature === 'string'
      ? signature
      : String(entry?.[1] || signature?.mtgsig || signature?.data?.mtgsig || '');
    if (!mtgsig) throw new Error('H5guard 未返回 mtgsig');
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
      } catch {}
      return value.match(/(?:^|[,{\s])['"]?a9['"]?\s*[:=]\s*['"]?([^'",}\s]+)/i)?.[1] || '';
    };
    const a9 = findA9(mtgsig);
    if (!a9) throw new Error('H5guard mtgsig 缺少 a9');
    const requestedVersion = new URL(input.url).searchParams.get('csecversion') || '';
    const explicitVersion = a9.match(/\b4\.(?:2|3)\.\d+\b/)?.[0] || '';
    if (explicitVersion && explicitVersion !== requestedVersion) {
      throw new Error('H5guard a9 版本与精确请求 URL 不一致');
    }
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': contentType,
      'M-APPKEY': input.appKey,
      'M-TRACEID': String((Date.now() + Math.random() * -1e18) | 0),
      'X-Requested-With': 'XMLHttpRequest',
      qnhReferrer: input.qnhReferrer,
      mtgsig,
    };
    const init = { method: 'POST', credentials: 'include', headers, body: bodyText };
    if (input.fetchReferrer) init.referrer = input.fetchReferrer;
    const response = await fetch(input.url, init);
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { rawText: text.slice(0, 2000) }; }
    return {
      http_status: response.status,
      data,
      signature_evidence: {
        a9_present: true,
        a9_version: explicitVersion,
        requested_version: requestedVersion,
        binding_source: 'chrome_extension_h5guard_exact_request',
      },
    };
  }.toString()})(${payload})`;
}

async function signedRequest(cdp, options, timeoutMs = 45000) {
  return evaluate(cdp, signedRequestExpression(options), timeoutMs);
}

function assertBusiness(response, action) {
  if (Number(response?.http_status || 0) !== 200 || !businessOk(response?.data)) {
    const envelope = businessEnvelope(response?.data);
    throw new Error(`${action}失败：http=${response?.http_status || 0}, code=${envelope.code || ''}, message=${envelope.message || ''}`);
  }
}

async function captureNativeRequest({ tab, cdp, endpoint, navigate, expectedSpu = '' }) {
  await cdp.send('Network.enable', {});
  const initial = await cdp.readEvents({ limit: 1, timeoutMs: 0 });
  let cursor = initial.cursor;
  const requests = new Map();
  const responses = new Map();
  await navigate();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const batch = await cdp.readEvents({
      afterSequence: cursor,
      limit: 1000,
      methods: ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished'],
      timeoutMs: Math.min(3000, Math.max(1, deadline - Date.now())),
    });
    cursor = batch.cursor;
    for (const event of batch.events || []) {
      const params = event.params || {};
      if (event.method === 'Network.requestWillBeSent') requests.set(params.requestId, params.request || {});
      if (event.method === 'Network.responseReceived') responses.set(params.requestId, params.response || {});
      if (event.method !== 'Network.loadingFinished') continue;
      const request = requests.get(params.requestId);
      const response = responses.get(params.requestId);
      if (!request || !response) continue;
      let parsed;
      try { parsed = new URL(String(request.url || '')); } catch { continue; }
      if (parsed.pathname !== endpoint || String(request.method || '') !== 'POST') continue;
      let requestBody = {};
      try { requestBody = JSON.parse(String(request.postData || '{}')); } catch {}
      if (expectedSpu && String(requestBody.spuId || '') !== String(expectedSpu)) continue;
      if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) continue;
      const version = parsed.searchParams.get('csecversion') || '';
      if (!['4.2.0', '4.2.4', '4.3.0'].includes(version)) {
        throw new Error(`未知 csecversion：${version}`);
      }
      return {
        request_url: request.url,
        method: request.method,
        request_body: requestBody,
        http_status: response.status,
        csecversion: version,
        page_url: String(await tab.url() || ''),
      };
    }
  }
  throw new Error(`未捕获当前文档原生 ${endpoint} HTTP 2xx`);
}

export async function preflightChromeExtension({ tab, cdp, runDir }) {
  if (!String(await tab.url() || '').startsWith(BASE)) throw new Error('当前标签页不是牵牛花');
  if (String(await tab.url() || '') !== LIST_PAGE_URL) await tab.goto(LIST_PAGE_URL);
  await waitForH5guard(cdp);
  const native = await captureNativeRequest({
    tab,
    cdp,
    endpoint: LIST_ENDPOINT,
    navigate: () => tab.reload(),
  });
  await waitForH5guard(cdp);
  const url = withVersion(LIST_URL, native.csecversion);
  const response = await signedRequest(cdp, {
    url,
    body: {
      labelInfoList: [],
      storeFrontGroupCategoryList: [],
      channelCategory: { channelId: 100, categoryProperty: {} },
      hasNoSaleAbnormal: 1,
      page: 1,
      pageSize: 1,
      backendCategoryList: [],
    },
    qnhReferrer: '/unifiedGoods/tenant/spu-list',
  });
  assertBusiness(response, '登录预检');
  const identity = await evaluate(cdp, `(() => {
    const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const match = text.match(/([^\\s]{1,80})[（(]租户ID\\s*[:：]\\s*(\\d+)[）)]/);
    return { tenant_name: match ? match[1] : '', tenant_id: match ? match[2] : '' };
  })()`);
  if (!identity?.tenant_id || !identity?.tenant_name) throw new Error('未取得可见租户身份');
  const result = {
    ok: true,
    generated_at: nowIso(),
    page_url: String(await tab.url() || ''),
    page_route: '/unifiedGoods/tenant/spu-list',
    title: String(await tab.title() || ''),
    tenant_name: identity.tenant_name,
    tenant_id: identity.tenant_id,
    h5guard_ready: true,
    total: findTotal(response.data, 0),
    context_profile: `tenant_list_v${native.csecversion.replaceAll('.', '')}`,
    csecversion: native.csecversion,
    native_profile_source: 'chrome_extension_current_tab_native_list_post',
    browser_transport: 'chrome_extension_current_tab',
    cdp_url: '',
    profile_dir: 'existing_chrome_extension',
    run_dir: path.resolve(runDir),
  };
  await writeJsonAtomic(path.join(runDir, 'session_identity.json'), result);
  return result;
}

function detailReadBody(spuId) {
  return { spuId: String(spuId) };
}

export async function readDetailsChromeExtension({
  tab,
  cdp,
  runDir,
  manifestPath,
  outputPath,
  offset = 0,
  limit = 25,
}) {
  const identity = await readJsonOr(path.join(runDir, 'session_identity.json'), null);
  if (!identity?.tenant_id) throw new Error('缺少 session_identity.json');
  if (!String(await tab.url() || '').includes('/unifiedGoods/tenant/spu-list')) await tab.goto(LIST_PAGE_URL);
  await waitForH5guard(cdp);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const source = toArray(manifest.products);
  const selected = source.slice(offset, offset + limit);
  const existing = await readJsonOr(outputPath, {
    generated_at: nowIso(),
    manifest_path: path.resolve(manifestPath),
    products: [],
  });
  const bySpu = new Map(toArray(existing.products).map((item) => [String(item.spu_id), item]));
  const detailUrl = withVersion(DETAIL_URL, identity.csecversion);
  let dirty = 0;
  const persist = async () => {
    const ordered = source.map((row) => bySpu.get(String(row.spu_id || row.spuId || ''))).filter(Boolean);
    await writeJsonAtomic(outputPath, { ...existing, generated_at: nowIso(), products: ordered });
    dirty = 0;
  };
  for (const product of selected) {
    const spuId = String(product.spu_id || product.spuId || '');
    if (!spuId || bySpu.has(spuId)) continue;
    const response = await signedRequest(cdp, {
      url: detailUrl,
      body: detailReadBody(spuId),
      qnhReferrer: '/unifiedGoods/tenant/spu-list',
      fetchReferrer: LIST_PAGE_URL,
    });
    const envelope = businessEnvelope(response?.data);
    if (
      Number(response?.http_status || 0) === 200
      && String(envelope.code || '') === '2000'
      && String(envelope.message || '').includes('记录不存在')
    ) {
      bySpu.set(spuId, {
        spu_id: spuId,
        title: String(product.title || ''),
        missing_on_platform: true,
        missing_reason: '记录不存在',
        detail: { spuChannelInfoList: [] },
      });
    } else {
      assertBusiness(response, `读取 SPU ${spuId} 详情`);
      const detail = detailSpu(response.data);
      if (String(detail.spuId || '') !== spuId) throw new Error(`详情 SPU 不一致：${spuId}`);
      if (String(detail.tenantId || '') !== String(identity.tenant_id)) throw new Error(`详情租户不一致：${spuId}`);
      bySpu.set(spuId, {
        spu_id: spuId,
        title: titleOf(detail) || String(product.title || ''),
        detail,
        protocol_profile: identity.context_profile,
      });
    }
    dirty += 1;
    if (dirty >= 10) await persist();
  }
  if (dirty) await persist();
  return { output_path: path.resolve(outputPath), completed: bySpu.size, source_total: source.length };
}

export async function readRecommendationsChromeExtension({
  tab,
  cdp,
  runDir,
  detailsPath,
  outputPath,
  offset = 0,
  limit = 25,
}) {
  const identity = await readJsonOr(path.join(runDir, 'session_identity.json'), null);
  if (!identity?.tenant_id) throw new Error('缺少 session_identity.json');
  if (!String(await tab.url() || '').includes('/unifiedGoods/tenant/spu-list')) await tab.goto(LIST_PAGE_URL);
  await waitForH5guard(cdp);
  const details = JSON.parse(await fs.readFile(detailsPath, 'utf8'));
  const source = toArray(details.products);
  const selected = source.slice(offset, offset + limit);
  const existing = await readJsonOr(outputPath, {
    generated_at: nowIso(),
    details_path: path.resolve(detailsPath),
    products: [],
  });
  const bySpu = new Map(toArray(existing.products).map((item) => [String(item.spu_id), item]));
  const url = withVersion(RECOMMEND_URL, identity.csecversion);
  let dirty = 0;
  const persist = async () => {
    const ordered = source.map((row) => bySpu.get(String(row.spu_id || row.detail?.spuId || ''))).filter(Boolean);
    await writeJsonAtomic(outputPath, { ...existing, generated_at: nowIso(), products: ordered });
    dirty = 0;
  };
  for (const product of selected) {
    const detail = toObject(product.detail);
    const spuId = String(product.spu_id || detail.spuId || '');
    if (!spuId || bySpu.has(spuId)) continue;
    if (product.missing_on_platform) {
      bySpu.set(spuId, { spu_id: spuId, title: product.title || '', category_code: '', upc: '', recommendation: null, error: '记录不存在' });
      dirty += 1;
      if (dirty >= 10) await persist();
      continue;
    }
    const channel = toArray(detail.spuChannelInfoList).find((candidate) => Number(candidate?.channelId || 0) === 100);
    const categoryCode = String(channel?.categoryCode || '');
    const upc = String(toArray(toArray(detail.skus)[0]?.upcList)[0] || '');
    let recommendation = null;
    let error = '';
    if (categoryCode) {
      try {
        const response = await signedRequest(cdp, {
          url,
          body: { spuName: String(detail.spuName || product.title || ''), channelId: 100, channelCategoryId: categoryCode, upc },
          qnhReferrer: '/unifiedGoods/tenant/spu-list',
          fetchReferrer: LIST_PAGE_URL,
        });
        assertBusiness(response, `读取 SPU ${spuId} 官方属性推荐`);
        recommendation = unwrapData(response.data);
      } catch (caught) {
        error = String(caught?.message || caught);
      }
    } else {
      error = '美团渠道类目为空';
    }
    bySpu.set(spuId, { spu_id: spuId, title: String(detail.spuName || product.title || ''), category_code: categoryCode, upc, recommendation, error });
    dirty += 1;
    if (dirty >= 10) await persist();
  }
  if (dirty) await persist();
  return { output_path: path.resolve(outputPath), completed: bySpu.size, source_total: source.length };
}

export async function queryChannelBrandChromeExtension({
  tab,
  cdp,
  runDir,
  channelId,
  searchText,
}) {
  const identity = await readJsonOr(path.join(runDir, 'session_identity.json'), null);
  if (!identity?.tenant_id) throw new Error('缺少 session_identity.json');
  const normalizedChannelId = Number(channelId);
  const normalizedSearch = String(searchText || '').replace(/\s+/g, ' ').trim();
  if (!Number.isFinite(normalizedChannelId) || !normalizedSearch) throw new Error('渠道品牌查询缺少渠道或查询词');
  if (!String(await tab.url() || '').includes('/unifiedGoods/tenant/spu-list')) await tab.goto(LIST_PAGE_URL);
  await waitForH5guard(cdp);
  const response = await signedRequest(cdp, {
    url: withVersion(CHANNEL_BRAND_URL, identity.csecversion),
    body: { channelId: normalizedChannelId, searchText: normalizedSearch },
    qnhReferrer: '/unifiedGoods/tenant/spu-list',
    fetchReferrer: LIST_PAGE_URL,
  });
  assertBusiness(response, `查询渠道品牌：${normalizedChannelId}/${normalizedSearch}`);
  const rows = toArray(toObject(response.data?.data).list);
  const candidates = rows.map((row) => ({
    channel_id: String(firstNonEmpty(row?.channelId, normalizedChannelId)),
    brand_code: String(firstNonEmpty(row?.channelBrandId, row?.brandId, row?.id)),
    brand_name: String(firstNonEmpty(row?.channelBrandName, row?.brandName, row?.name)),
  })).filter((row) => row.brand_code && row.brand_name);
  const receipt = {
    generated_at: nowIso(),
    channel_id: normalizedChannelId,
    search_text: normalizedSearch,
    endpoint: CHANNEL_BRAND_URL.replace(/[?].*$/, ''),
    candidates,
    response_data: response.data,
    browser_transport: 'chrome_extension_current_tab',
  };
  const token = crypto.createHash('sha256').update(normalizedSearch).digest('hex').slice(0, 16);
  const receiptPath = path.join(runDir, `channel-brand-query-${normalizedChannelId}-${token}.json`);
  await writeJsonAtomic(receiptPath, receipt);
  return { receipt_path: receiptPath, channel_id: normalizedChannelId, search_text: normalizedSearch, candidates };
}

function actualForChange(detail, change) {
  const match = String(change.field_path || '').match(/^channel[.](\d+)[.](.+)$/);
  if (!match) return null;
  const channel = toArray(detail.spuChannelInfoList).find((item) => Number(item?.channelId || 0) === Number(match[1]));
  const prop = toArray(channel?.categoryProperties).find((item) => (
    change.attr_id
      ? String(item?.attrId || '') === String(change.attr_id)
      : String(item?.attrName || '') === match[2]
  ));
  return { actual: propertyDisplayValues(prop), contractVerified: channelPropertyContractMatches(prop, change) };
}

function verifyChanges(detail, requested) {
  return requested.map((change) => {
    const resolved = actualForChange(detail, change);
    const actual = resolved?.actual ?? null;
    const expected = change.new_value;
    const normalizedNoBrand = (
      /^channel[.]\d+[.]品牌$/.test(change.field_path)
      && Array.isArray(expected)
      && JSON.stringify(expected) === JSON.stringify(['无品牌'])
      && Array.isArray(actual)
      && actual.length === 0
    );
    const valueMatches = normalizedNoBrand || (
      Array.isArray(expected)
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : Array.isArray(actual)
          ? actual.includes(String(expected))
          : String(actual) === String(expected)
    );
    return {
      field_path: change.field_path,
      expected,
      actual,
      contract_verified: Boolean(resolved?.contractVerified),
      verified: Boolean(resolved?.contractVerified && valueMatches),
    };
  });
}

async function readExactEditor({ tab, cdp, identity, spuId }) {
  const targetUrl = `${BASE}/home.html#/unifiedGoods/tenant/edit?spu=${encodeURIComponent(spuId)}`;
  const native = await captureNativeRequest({
    tab,
    cdp,
    endpoint: DETAIL_ENDPOINT,
    expectedSpu: spuId,
    navigate: async () => {
      if (String(await tab.url() || '') === targetUrl) await tab.reload();
      else await tab.goto(targetUrl);
    },
  });
  if (native.csecversion !== identity.csecversion) throw new Error(`编辑页协议漂移：${spuId}`);
  await waitForH5guard(cdp);
  const response = await signedRequest(cdp, {
    url: withVersion(DETAIL_URL, identity.csecversion),
    body: detailReadBody(spuId),
    qnhReferrer: '/unifiedGoods/tenant/edit',
    fetchReferrer: targetUrl,
  });
  assertBusiness(response, `读取编辑页 SPU ${spuId}`);
  const detail = detailSpu(response.data);
  if (String(detail.spuId || '') !== spuId || String(detail.tenantId || '') !== String(identity.tenant_id)) {
    throw new Error(`编辑页身份不一致：${spuId}`);
  }
  return { targetUrl, native, detail };
}

export async function applyPlansChromeExtension({
  tab,
  cdp,
  runDir,
  indexPath,
  offset = 0,
  limit = 5,
  batchName = 'chrome-extension-batch',
  dryRun = true,
}) {
  const identity = await readJsonOr(path.join(runDir, 'session_identity.json'), null);
  if (!identity?.tenant_id) throw new Error('缺少 session_identity.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const rows = toArray(index.rows).filter((row) => String(row.status || 'ready') === 'ready').slice(offset, offset + limit);
  const checkpointPath = path.join(runDir, `${batchName}-checkpoint.json`);
  const checkpoint = await readJsonOr(checkpointPath, { rows: [], offset, limit, dry_run: dryRun });
  const statuses = new Map(toArray(checkpoint.rows).map((row) => [String(row.spu_id), row]));
  if (!String(await tab.url() || '').includes('/unifiedGoods/tenant/spu-list')) await tab.goto(LIST_PAGE_URL);
  await closeInternalEditTabs(cdp);
  await waitForH5guard(cdp);
  await new Promise((resolve) => setTimeout(resolve, 10000));
  for (const row of rows) {
    const spuId = String(row.spu_id || '');
    if (!spuId || ['previewed', 'verified', 'no_change'].includes(statuses.get(spuId)?.status)) continue;
    const startedAt = Date.now();
    try {
      const planPath = path.resolve(String(row.plan_path || ''));
      const planRaw = await fs.readFile(planPath, 'utf8');
      const plan = JSON.parse(planRaw);
      if (String(plan.spu_id || '') !== spuId) throw new Error('计划 SPU 不一致');
      const { targetUrl, detail: beforeDetail } = await readExactEditor({ tab, cdp, identity, spuId });
      const beforeSummary = summarizeDetail(beforeDetail);
      const executionPlan = await prepareBrandExecutionPlan(plan, beforeDetail, spuId);
      const { patched, requested, changedChannelIds, changedCoverageFields } = applyDirectPlanToDetail(beforeDetail, executionPlan);
      const coverageRequest = {
        fieldCoverageInfoList: [
          ...changedChannelIds.map(coverageField),
          ...changedCoverageFields,
        ].filter(Boolean).filter((value, indexNumber, values) => values.indexOf(value) === indexNumber).map((field) => ({
          field,
          coverToStore: plan.coverage_scope === 'all_stores' ? 1 : 2,
        })),
      };
      const preview = {
        spu_id: spuId,
        tenant_id: String(beforeDetail.tenantId || ''),
        plan_sha256: crypto.createHash('sha256').update(planRaw).digest('hex'),
        dry_run: dryRun,
        requested_changes: requested,
        coverage_request: coverageRequest,
        before: beforeSummary,
        browser_transport: 'chrome_extension_current_tab',
      };
      if (!requested.length) {
        statuses.set(spuId, { spu_id: spuId, title: row.title || '', status: 'no_change', duration_ms: Date.now() - startedAt });
      } else if (dryRun) {
        const previewPath = path.join(runDir, `${batchName}-${spuId}-preview.json`);
        await writeJsonAtomic(previewPath, preview);
        statuses.set(spuId, { spu_id: spuId, title: row.title || '', status: 'previewed', preview_path: previewPath, requested_change_count: requested.length, duration_ms: Date.now() - startedAt });
      } else {
        const updateUrl = plan.update_profile === 'tenant_edit_v424' ? UPDATE_V2_URL : UPDATE_URL;
        const saveResponse = await signedRequest(cdp, {
          url: withVersion(updateUrl, identity.csecversion),
          body: { tenantSpu: patched, coverageRequest },
          qnhReferrer: '/unifiedGoods/tenant/edit',
          fetchReferrer: targetUrl,
        }, 60000);
        assertBusiness(saveResponse, `保存 SPU ${spuId}`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const readbackResponse = await signedRequest(cdp, {
          url: withVersion(DETAIL_URL, identity.csecversion),
          body: detailReadBody(spuId),
          qnhReferrer: '/unifiedGoods/tenant/edit',
          fetchReferrer: targetUrl,
        });
        assertBusiness(readbackResponse, `回读 SPU ${spuId}`);
        const afterDetail = detailSpu(readbackResponse.data);
        if (String(afterDetail.spuId || '') !== spuId || String(afterDetail.tenantId || '') !== String(identity.tenant_id)) {
          throw new Error(`保存后回读身份不一致：${spuId}`);
        }
        const verification = verifyChanges(afterDetail, requested);
        const result = {
          ...preview,
          dry_run: false,
          update_http_status: saveResponse.http_status,
          update_business: businessEnvelope(saveResponse.data),
          update_endpoint: updateUrl.replace(/[?].*$/, ''),
          after: summarizeDetail(afterDetail),
          changed_fields: diffSummaries(beforeSummary, summarizeDetail(afterDetail)),
          verification,
          verified: verification.every((item) => item.verified),
          verified_at: nowIso(),
        };
        const resultPath = path.join(runDir, `${batchName}-${spuId}-result.json`);
        await writeJsonAtomic(resultPath, result);
        if (!result.verified) throw new Error(`保存后字段回读不一致：${spuId}`);
        statuses.set(spuId, { spu_id: spuId, title: row.title || '', status: 'verified', result_path: resultPath, requested_change_count: requested.length, duration_ms: Date.now() - startedAt });
      }
    } catch (error) {
      statuses.set(spuId, { spu_id: spuId, title: row.title || '', status: 'failed', error: String(error?.message || error).slice(0, 1000), duration_ms: Date.now() - startedAt });
    }
    await closeInternalEditTabs(cdp, spuId).catch(() => 0);
    await writeJsonAtomic(checkpointPath, {
      updated_at: nowIso(),
      index_path: path.resolve(indexPath),
      offset,
      limit,
      dry_run: dryRun,
      selected_total: rows.length,
      browser_transport: 'chrome_extension_current_tab',
      rows: [...statuses.values()],
    });
  }
  await tab.goto(LIST_PAGE_URL);
  return {
    checkpoint_path: checkpointPath,
    selected: rows.length,
    previewed: [...statuses.values()].filter((item) => item.status === 'previewed').length,
    verified: [...statuses.values()].filter((item) => item.status === 'verified').length,
    no_change: [...statuses.values()].filter((item) => item.status === 'no_change').length,
    failed: [...statuses.values()].filter((item) => item.status === 'failed').length,
  };
}
