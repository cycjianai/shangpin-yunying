import assert from 'node:assert/strict';
import { selectBrowserTransport, parseMeituanPageIdentity, stableCohortFromRounds } from './browser_transport.mjs';
import {
  MANAGER_EFFECT_TYPES,
  UNAVAILABLE_CARD_EFFECT_TYPES,
  buildAppealPayload,
  buildAuditUrl,
  buildQualificationSaveExpression,
  buildSaveExpression,
  classifyPostSubmitState,
  freezeAuditDetails,
  issueItems,
  validateSafePlan,
  compareProtectedMedia,
} from './engine.mjs';

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
assert.match(buildAuditUrl('https://shangoue.meituan.com/reuse/sc/product/page/detail/audit?spuId=1&wmPoiId=2', '12345', '67890'), /oldVersion=true/);
assert.throws(() => validateSafePlan({ spu_id: '1', clear_invalid_barcode: true }, issues), /not_authorized/);
assert.throws(() => validateSafePlan({ spu_id: '1', cpv_updates: [{ picture_type: 4, title: '3C证书', urls: ['https://x'] }] }, issues), /authoritative/);
assert.throws(() => validateSafePlan({ spu_id: '1', cpv_updates: [{ picture_type: 5, title: '配料图', urls: ['https://x'], placement: 'replace' }] }, issues), /placement/);
assert.equal(compareProtectedMedia({ main: ['a'], detail: ['b'], cpv: [], qualification: [] }, { main: ['a'], detail: ['b', 'c'], cpv: [], qualification: [] }).ok, true);
const saveExpression = buildSaveExpression({ spu_id: '1', clear_invalid_barcode: true });
assert.match(saveExpression, /product\.cpvGuidePicList=JSON\.stringify/);
assert.match(saveExpression, /normalAttributesValueMap/);
assert.doesNotMatch(saveExpression, /if\(\(arg\.cpv_updates\|\|\[\]\)\.length\).*cpvGuidePicList/);
assert.match(saveExpression, /spuId:String\(arg\.spu_id\)/);
assert.match(buildSaveExpression({ spu_id: '1', cpv_updates: [{ picture_type: 5, urls: ['https://x'] }] }), /new Set\(\[\.\.\.\(product\.cpvGuidePicMap/);
assert.match(buildQualificationSaveExpression({ spu_id: '1', cpv_updates: [{ picture_type: 5, urls: ['https://x'], placement: 'prepend' }] }), /placement\|\|'append'.*prepend/);
assert.match(buildSaveExpression({ spu_id: '1', copy_main_to_detail_if_empty: true }), /pictureContentList=main\.map\(detailUrl\)\.filter\(Boolean\)/);
assert.match(buildSaveExpression({ spu_id: '1', copy_main_to_detail_if_empty: true }), /w=1080&h=1080/);
assert.match(buildSaveExpression({ spu_id: '1', weight: { value: 2.5, unit: 'L' } }), /L:'升\(L\)'/);
assert.equal(typeof freezeAuditDetails, 'function');
assert.deepEqual(UNAVAILABLE_CARD_EFFECT_TYPES, [1, 5, 6]);
assert.equal(MANAGER_EFFECT_TYPES.UNDER_REVIEW, 7);

const walleIssues = issueItems({
  walleProblemItemDetail: {
    problemItemDetails: [
      { code: 2, name: '商品图片质量差', qualityScorePromptList: [{ problemMsg: '缺少3C证书', tipMsg: '需在有效期内' }] },
      { code: 18, name: '类目属性不符合平台填写规范', qualityScorePromptList: [{ problemMsg: '3C认证证书编号属性', tipMsg: '不一致' }] },
    ],
  },
});
assert.equal(walleIssues.length, 2);
assert.equal(walleIssues[0].type, 'qualification_image');
assert.equal(walleIssues[0].qua_pic_type, 4);
assert.equal(walleIssues[1].type, 'field');

assert.deepEqual(
  classifyPostSubmitState({ id: '10001', auditInfo: { bizAuditStatus: 6, odinAuditStatus: 2 } }),
  { status: 'materialized_waiting_review', forbid_auto_fix: true, forbid_resubmit: true },
);

const appealPayload = buildAppealPayload({
  appealInfo: {
    odinAuditAppealItem: {
      auditAppealReasonBlock: [{ auditAppealReasonList: [{ code: 352, isSelected: 0 }] }],
    },
  },
  reasonCodes: [352],
  detailText: '节日庆典手持礼花彩带筒道具，非违禁器具',
  acctId: 1001,
  wmPoiId: '1000001',
});
assert.equal(JSON.parse(appealPayload.auditAppealInfo).odinAuditAppealItem.auditAppealReasonBlock[0].auditAppealReasonList[0].isSelected, 1);
assert.throws(() => buildAppealPayload({ appealInfo: {}, reasonCodes: [352], detailText: 'x', wmPoiId: '1000001', btnStatus: 2 }), /appeal_already_submitted/);

console.log(JSON.stringify({ ok: true, tests: 30 }));
