import assert from 'node:assert/strict';

import {
  EMPTY_VALUE,
  NOT_APPLICABLE,
  canonicalFieldId,
  canonicalSourceStrategy,
  isReadbackPassed,
  validateAuditRow,
  valueText,
} from './operations_contract.mjs';
import {
  aoxiangAuditRow,
  meituanUnavailableAuditRows,
} from './platform_event_mappers.mjs';

assert.equal(
  canonicalFieldId('channel_attribute', '美团', '材质'),
  canonicalFieldId('channel_attribute', '美团', '材质'),
);
assert.notEqual(
  canonicalFieldId('product', '商品名称'),
  canonicalFieldId('product', '商品卖点'),
);
assert.equal(canonicalSourceStrategy('同商品原图OCR实证'), 'same_product_media_evidence');
assert.equal(canonicalSourceStrategy('DeepSeek高置信候选'), 'semantic_model_candidate_validated');
assert.equal(valueText('', 'before'), EMPTY_VALUE);
assert.equal(valueText('', 'planned'), NOT_APPLICABLE);
assert.equal(isReadbackPassed('waiting_platform_review'), true);
assert.equal(isReadbackPassed('blocked'), false);

const aoxiang = aoxiangAuditRow({
  sku: '000012345678901234',
  item: { skuName: '翱象样例' },
  change: {
    channel: 'MT',
    fieldId: 'packing',
    field: '包装方式',
    before: [],
    planned: [{ propertyValueName: '独立装' }],
    source: 'platform_match',
  },
});
assert.deepEqual(aoxiang.slice(2, 5), ['美团', 'channel_attribute.meituan.packing', '包装方式']);
assert.deepEqual(aoxiang.slice(5), [
  EMPTY_VALUE,
  '独立装',
  '独立装',
  'verified_complete',
  'platform_recommendation_validated',
]);
assert.deepEqual(validateAuditRow(aoxiang), []);

const meituan = meituanUnavailableAuditRows({
  spu_id: '1001',
  name: '美团样例',
  still_in_target_set: true,
  changes: [{ field: '图片详情', before: '', after: ['url-1'] }],
  blockers: ['缺少真实注册证原图'],
});
assert.equal(meituan[0][3], 'media.detail.set');
assert.equal(meituan[0][8], 'waiting_platform_review');
assert.equal(meituan[0][9], 'same_product_media_evidence');
assert.equal(meituan[1][8], 'manual_evidence_required');
assert.equal(meituan[1][9], 'manual_evidence_required');
assert.deepEqual(validateAuditRow(meituan[0]), []);
assert.deepEqual(validateAuditRow(meituan[1]), []);
const legacy = [...meituan[0]];
legacy[8] = '保存后独立回读通过';
assert.ok(validateAuditRow(legacy).includes('result_value_invalid'));

process.stdout.write('operations content contract (js): ok\n');
