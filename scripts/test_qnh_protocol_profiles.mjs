/** 业务红线：4.2.0/4.2.4/4.3.0 必须增量兼容；未知版本、错页面、错 SPU、错 endpoint 与错签名版本必须零发送。 */
import assert from 'node:assert/strict';
import {
  validateDirectSignature,
  validateNativeEditorEvidence,
  validateNativeListEvidence,
  withCsecVersion,
} from './qnh_protocol_profile.mjs';
import {
  assertNoBannedPlaceholderImages,
  resolveSafeCoverToStore,
} from './qnh_direct.mjs';

const listPage = 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list';
const listUrl = (version) => `https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query?csecversion=${version}`;
for (const version of ['4.2.0', '4.2.4', '4.3.0']) {
  assert.equal(validateNativeListEvidence({ page_url: listPage, request_url: listUrl(version), method: 'POST', http_status: 200 }).csecversion, version);
}
assert.throws(() => validateNativeListEvidence({ page_url: listPage, request_url: listUrl('9.9.9'), method: 'POST', http_status: 200 }), /version_unknown/);
assert.throws(() => validateNativeListEvidence({ page_url: listPage, request_url: listUrl('4.3.0'), method: 'GET', http_status: 200 }), /method_mismatch/);
assert.throws(() => validateNativeListEvidence({ page_url: listPage, request_url: 'https://qnh.meituan.com/x?csecversion=4.3.0', method: 'POST', http_status: 200 }), /endpoint_mismatch/);

const spu = '2084593120909479977';
const editPage = `https://qnh.meituan.com/home.html#/unifiedGoods/tenant/edit?spu=${spu}`;
const editUrl = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/detail?csecversion=4.3.0';
assert.equal(validateNativeEditorEvidence({ page_url: editPage, request_url: editUrl, method: 'POST', http_status: 200, body: { spuId: spu } }, spu).target_spu, spu);
assert.throws(() => validateNativeEditorEvidence({ page_url: editPage, request_url: editUrl, method: 'POST', http_status: 200, body: { spuId: '1' } }, spu), /target_spu_mismatch/);
assert.equal(validateDirectSignature({ mtgsig: '{"a9":"4.3.0-bound"}', requestUrl: editUrl }).requested_version, '4.3.0');
assert.throws(() => validateDirectSignature({ mtgsig: '{"a9":"4.2.4-bound"}', requestUrl: editUrl }), /profile_contract_mismatch/);
assert.equal(validateDirectSignature({ mtgsig: '{"a9":"opaque-bound"}', requestUrl: editUrl }).opaque_a9, true);
assert.match(withCsecVersion(editUrl, '4.2.4'), /csecversion=4.2.4/);
assert.equal(resolveSafeCoverToStore('mt_channel_category_property', { coverage_scope: 'all_stores' }), 1);
assert.equal(resolveSafeCoverToStore('elm_channel_category_property', { coverage_scope: 'all_stores' }), 1);
assert.equal(resolveSafeCoverToStore('picture', { coverage_scope: 'all_stores' }), 2);
assert.equal(resolveSafeCoverToStore('pic_url_list', { coverage_scope: 'all_stores' }), 2);
assert.equal(resolveSafeCoverToStore('product_name', { coverage_scope: 'all_stores' }), 2);
assert.equal(resolveSafeCoverToStore('spu_name', { coverage_scope: 'all_stores' }), 2);
assert.throws(
  () => assertNoBannedPlaceholderImages(['https://img.meituan.net/sgfn/6f244c5f3cb8b26399bbf31116c40de81422507.png']),
  /严禁向.*写入已拉黑的通用说明占位图/,
);
assert.throws(
  () => assertNoBannedPlaceholderImages(['https://img.meituan.net/sgfn/064b297f2dffbf5ad8d0e51e6f35cd5b1391479.png']),
  /严禁向.*写入已拉黑的通用说明占位图/,
);
process.stdout.write('qnh protocol profile tests: ok\n');
