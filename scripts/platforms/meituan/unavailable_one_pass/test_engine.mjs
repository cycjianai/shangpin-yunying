import assert from 'node:assert/strict';
import { selectBrowserTransport, parseMeituanPageIdentity, stableCohortFromRounds } from './browser_transport.mjs';
import { buildAuditUrl, buildQualificationSaveExpression, buildSaveExpression, freezeAuditDetails, issueItems, validateSafePlan, compareProtectedMedia } from './engine.mjs';

assert.equal(selectBrowserTransport({ extensionAvailable: true }).browser_transport, 'chrome_extension_current_tab');
assert.equal(selectBrowserTransport({ managedCdp: { idle: true, identity_verified: true, url: 'http://127.0.0.1:9333' } }).browser_transport, 'managed_cdp');
assert.throws(() => selectBrowserTransport({ requested: 'cdp', managedCdp: { idle: false, identity_verified: true, url: 'http://127.0.0.1:9333' } }), /managed_cdp_unavailable/);
assert.equal(parseMeituanPageIdentity({ topUrl: 'https://shangoue.meituan.com/#/x', frameUrl: 'https://shangoue.meituan.com/reuse/sc/product/views/product/manager/optimizeList?wmPoiId=123456' }).wm_poi_id, '123456');

const rows = [{ id: '1' }, { id: '2' }, { id: '1' }];
const stable = stableCohortFromRounds([{ total: 3, rows }, { total: 3, rows: [...rows].reverse() }]);
assert.equal(stable.unique_spu_count, 2);
assert.equal(stable.duplicate_record_count, 1);
assert.throws(() => stableCohortFromRounds([{ total: 2, rows: [{ id: '1' }] }, { total: 2, rows: [{ id: '2' }] }]), /not_stable/);

const issues = issueItems({ optimizedInfoList: [{ optimizedFieldList: [{ fieldName: '商品图片', comment: '缺少包装标签图', lackQuaInfo: [{ quaPicType: 3, quaPicTitle: '包装标签图' }] }] }] });
assert.equal(issues.filter((x) => x.type === 'qualification_image').length, 1);
assert.match(buildAuditUrl('https://shangoue.meituan.com/reuse/sc/product/page/detail/audit?spuId=1&wmPoiId=2', '12345', '67890'), /spuId=12345/);
assert.throws(() => validateSafePlan({ spu_id: '1', clear_invalid_barcode: true }, issues), /not_authorized/);
assert.throws(() => validateSafePlan({ spu_id: '1', cpv_updates: [{ picture_type: 4, title: '3C证书', urls: ['https://x'] }] }, issues), /authoritative/);
assert.throws(() => validateSafePlan({ spu_id: '1', cpv_updates: [{ picture_type: 5, title: '配料图', urls: ['https://x'], placement: 'replace' }] }, issues), /placement/);
assert.equal(compareProtectedMedia({ main: ['a'], detail: ['b'], cpv: [], qualification: [] }, { main: ['a'], detail: ['b', 'c'], cpv: [], qualification: [] }).ok, true);
const saveExpression = buildSaveExpression({ spu_id: '1', clear_invalid_barcode: true });
assert.match(saveExpression, /product\.cpvGuidePicList=JSON\.stringify/);
assert.doesNotMatch(saveExpression, /if\(\(arg\.cpv_updates\|\|\[\]\)\.length\).*cpvGuidePicList/);
assert.match(saveExpression, /spuId:String\(arg\.spu_id\)/);
assert.match(buildSaveExpression({ spu_id: '1', cpv_updates: [{ picture_type: 5, urls: ['https://x'] }] }), /new Set\(\[\.\.\.\(product\.cpvGuidePicMap/);
assert.match(buildQualificationSaveExpression({ spu_id: '1', cpv_updates: [{ picture_type: 5, urls: ['https://x'], placement: 'prepend' }] }), /placement\|\|'append'.*prepend/);
assert.match(buildSaveExpression({ spu_id: '1', copy_main_to_detail_if_empty: true }), /pictureContentList=main\.map\(detailUrl\)\.filter\(Boolean\)/);
assert.match(buildSaveExpression({ spu_id: '1', copy_main_to_detail_if_empty: true }), /w=1080&h=1080/);
assert.match(buildSaveExpression({ spu_id: '1', weight: { value: 2.5, unit: 'L' } }), /L:'升\(L\)'/);
assert.equal(typeof freezeAuditDetails, 'function');
console.log(JSON.stringify({ ok: true, tests: 22 }));
