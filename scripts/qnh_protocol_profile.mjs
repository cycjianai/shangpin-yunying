/**
 * 牵牛花 Skill 多协议画像：只接受当前文档原生成功证据和精确 H5guard 绑定，
 * 禁止版本轮盘、403 后换版本、错页面/SPU 写入及敏感签名持久化。
 */

export const KNOWN_QNH_VERSIONS = new Set(['4.2.0', '4.2.4', '4.3.0']);
export const LIST_ROUTE = '/unifiedGoods/tenant/spu-list';
export const EDIT_ROUTE = '/unifiedGoods/tenant/edit';
export const LIST_ENDPOINT = '/qnh-gw3/api/product/tenant/page-query';
export const DETAIL_ENDPOINT = '/qnh-gw3/api/product/tenant/detail';

const text = (value) => String(value ?? '').trim();

export function urlVersion(value) {
  try { return new URL(text(value)).searchParams.get('csecversion') || ''; } catch { return ''; }
}

export function urlPath(value) {
  try { return new URL(text(value)).pathname; } catch { return ''; }
}

export function withCsecVersion(value, version) {
  const parsed = new URL(text(value));
  if (!KNOWN_QNH_VERSIONS.has(text(version))) throw new Error('qnh_signature_version_unknown');
  parsed.searchParams.set('csecversion', text(version));
  return parsed.href;
}

export function pageRoute(value) {
  try {
    return decodeURIComponent(new URL(text(value)).hash || '')
      .replace(/^#/, '').split('?', 1)[0];
  } catch { return ''; }
}

export function pageSpu(value) {
  try {
    const hash = decodeURIComponent(new URL(text(value)).hash || '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    return new URLSearchParams(query).get('spu') || '';
  } catch { return ''; }
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function extractA9(value, depth = 0) {
  if (depth > 7 || value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.a9 !== undefined) return text(value.a9);
    for (const child of Object.values(value)) {
      const found = extractA9(child, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'string') return '';
  const parsed = parseJson(value);
  if (parsed !== null) {
    const found = extractA9(parsed, depth + 1);
    if (found) return found;
  }
  return value.match(/(?:^|[,{\s])['"]?a9['"]?\s*[:=]\s*['"]?([^'",}\s]+)/i)?.[1] || '';
}

export function validateDirectSignature({ mtgsig, requestUrl, requestMethod = 'POST' } = {}) {
  const expectedVersion = urlVersion(requestUrl);
  const a9 = extractA9(mtgsig);
  const explicitVersion = a9.match(/\b4\.(?:2|3)\.\d+\b/)?.[0] || '';
  if (!text(mtgsig) || !a9) throw new Error('qnh_signature_evidence_unbound');
  if (!KNOWN_QNH_VERSIONS.has(expectedVersion)) throw new Error('qnh_signature_version_unknown');
  if (text(requestMethod).toUpperCase() !== 'POST') throw new Error('qnh_method_mismatch');
  if (explicitVersion && explicitVersion !== expectedVersion) {
    throw new Error('qnh_signature_profile_contract_mismatch');
  }
  return Object.freeze({
    ok: true,
    requested_version: expectedVersion,
    a9_version: explicitVersion,
    opaque_a9: !explicitVersion,
    binding_source: 'direct_h5guard_exact_request',
  });
}

export function validateNativeListEvidence(evidence = {}) {
  const version = urlVersion(evidence.request_url);
  if (text(evidence.method).toUpperCase() !== 'POST') throw new Error('qnh_method_mismatch');
  if (urlPath(evidence.request_url) !== LIST_ENDPOINT) throw new Error('qnh_endpoint_mismatch');
  if (pageRoute(evidence.page_url) !== LIST_ROUTE) throw new Error('qnh_signature_page_profile_mismatch');
  if (!KNOWN_QNH_VERSIONS.has(version)) throw new Error('qnh_signature_version_unknown');
  if (Number(evidence.http_status) < 200 || Number(evidence.http_status) >= 300) {
    throw new Error('qnh_native_profile_http_failed');
  }
  return Object.freeze({
    context_profile: `tenant_list_v${version.replaceAll('.', '')}`,
    csecversion: version,
    qnh_referrer: LIST_ROUTE,
    source: 'current_document_native_list_success',
  });
}

export function validateNativeEditorEvidence(evidence = {}, targetSpu = '') {
  const version = urlVersion(evidence.request_url);
  const bodySpu = text(evidence.body?.spuId);
  const expectedSpu = text(targetSpu);
  if (text(evidence.method).toUpperCase() !== 'POST') throw new Error('qnh_method_mismatch');
  if (urlPath(evidence.request_url) !== DETAIL_ENDPOINT) throw new Error('qnh_endpoint_mismatch');
  if (pageRoute(evidence.page_url) !== EDIT_ROUTE) throw new Error('qnh_signature_page_profile_mismatch');
  if (!['4.2.4', '4.3.0'].includes(version)) throw new Error('qnh_signature_version_unknown');
  if (!expectedSpu || pageSpu(evidence.page_url) !== expectedSpu || bodySpu !== expectedSpu) {
    throw new Error('qnh_request_target_spu_mismatch');
  }
  if (Number(evidence.http_status) < 200 || Number(evidence.http_status) >= 300) {
    throw new Error('qnh_native_profile_http_failed');
  }
  return Object.freeze({
    context_profile: `tenant_edit_v${version.replaceAll('.', '')}`,
    csecversion: version,
    qnh_referrer: EDIT_ROUTE,
    target_spu: expectedSpu,
    source: 'current_document_native_editor_detail_success',
  });
}
