/** Platform-specific evidence mapped into the one canonical audit-row contract. */

import {
  EMPTY_VALUE,
  NOT_APPLICABLE,
  canonicalFieldId,
  canonicalSourceStrategy,
  valueText,
} from './operations_contract.mjs';

export function propertyValueText(values) {
  if (!Array.isArray(values)) return '';
  return values
    .map((value) => String(value?.propertyValueName ?? '').trim())
    .filter(Boolean)
    .join(' / ');
}

export function aoxiangChannelLabel(channel) {
  return ({ MT: '美团', ELE: '淘宝闪购/饿了么' })[channel] || String(channel || NOT_APPLICABLE);
}

function aoxiangChannelSlug(channel) {
  return ({ MT: 'meituan', ELE: 'eleme' })[channel] || channel || 'unknown';
}

export function aoxiangAuditRow({ sku, item = {}, row = {}, change = {} }) {
  const finalValue = propertyValueText(change.planned);
  return [
    String(sku),
    item.skuName || row.skuName || NOT_APPLICABLE,
    aoxiangChannelLabel(change.channel),
    canonicalFieldId(
      'channel_attribute',
      aoxiangChannelSlug(change.channel),
      change.fieldId || change.field,
    ),
    change.field || `渠道属性 ${change.fieldId}`,
    valueText(propertyValueText(change.before), 'before'),
    valueText(finalValue, 'planned'),
    valueText(finalValue, 'readback'),
    'verified_complete',
    canonicalSourceStrategy(change.source),
  ];
}

function meituanFieldId(field) {
  const text = String(field || '').trim();
  const specialPicture = text.match(/^专项图[:：](.+)$/);
  if (specialPicture) return canonicalFieldId('qualification', 'special_picture', specialPicture[1]);
  const exact = new Map([
    ['条形码', ['product', 'barcode']],
    ['图片详情', ['media', 'detail', 'set']],
    ['详情图', ['media', 'detail', 'set']],
    ['商品主图', ['media', 'main', 'set']],
    ['主图', ['media', 'main', 'set']],
    ['商品名称', ['product', 'title']],
    ['商品卖点', ['product', 'selling_point']],
    ['品牌', ['product', 'brand']],
    ['商品类目', ['category', 'platform']],
    ['类目', ['category', 'platform']],
    ['规格', ['sku', 'default', 'specification']],
    ['产地', ['product', 'origin_place']],
    ['容量', ['product', 'capacity']],
  ]);
  const mapped = exact.get(text);
  return mapped
    ? canonicalFieldId(mapped[0], ...mapped.slice(1))
    : canonicalFieldId('product', text || 'unknown');
}

function meituanSource(field) {
  const text = String(field || '');
  if (text.startsWith('专项图:') || text.startsWith('专项图：')) return 'same_product_media_evidence';
  if (text === '条形码') return 'platform_review_reason';
  if (text === '图片详情' || text === '详情图' || text.includes('主图')) return 'same_product_media_evidence';
  return 'semantic_model_candidate_validated';
}

export function meituanUnavailableAuditRows(item = {}) {
  const rows = [];
  for (const change of item.changes || []) {
    const after = valueText(change.after, 'planned');
    rows.push([
      String(item.spu_id ?? ''),
      item.name || NOT_APPLICABLE,
      '美团',
      meituanFieldId(change.field),
      change.field || '未知字段',
      valueText(change.before, 'before'),
      after,
      after,
      item.still_in_target_set === false ? 'verified_complete' : 'waiting_platform_review',
      canonicalSourceStrategy(meituanSource(change.field)),
    ]);
  }
  for (const blocker of item.blockers || []) {
    const manualEvidence = /真实|原图|证书|备案|注册/.test(blocker);
    rows.push([
      String(item.spu_id ?? ''),
      item.name || NOT_APPLICABLE,
      '美团',
      canonicalFieldId('review', 'blocker', blocker),
      '阻塞项',
      EMPTY_VALUE,
      NOT_APPLICABLE,
      NOT_APPLICABLE,
      manualEvidence ? 'manual_evidence_required' : 'blocked',
      manualEvidence ? 'manual_evidence_required' : 'platform_review_reason',
    ]);
  }
  return rows;
}
