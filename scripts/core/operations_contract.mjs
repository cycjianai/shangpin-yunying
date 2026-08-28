/** Canonical JavaScript helpers for the shared seven-sheet workbook. */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const SCHEMA = JSON.parse(
  await fs.readFile(new URL('../operations_workbook_schema.json', import.meta.url), 'utf8'),
);
const CONTENT = SCHEMA.content_contract;
const FIELD_PREFIXES = new Set(CONTENT.field_id_prefixes.map((value) => value.replace(/\.$/, '')));
const RESULT_VALUES = new Set(CONTENT.result_values);
const SOURCE_VALUES = new Set(CONTENT.source_strategy_values);
const CHANNEL_VALUES = new Set(CONTENT.channel_values);
const FORBIDDEN_LEGACY_CELL_VALUES = new Set(CONTENT.forbidden_legacy_cell_values);
const PRICE_VALUE_PATTERN = new RegExp(CONTENT.price_value_pattern);

export const EMPTY_VALUE = CONTENT.empty_value;
export const NOT_APPLICABLE = CONTENT.not_applicable_value;

const SOURCE_ALIASES = new Map(Object.entries({
  platform_match: 'platform_recommendation_validated',
  official_recommendation: 'platform_recommendation_validated',
  qnh_channel_brand_query: 'platform_recommendation_validated',
  exact_obsolete_category_repair: 'platform_recommendation_validated',
  cross_channel_equivalent: 'cross_channel_equivalent_fact',
  same_spu_cross_channel: 'cross_channel_equivalent_fact',
  same_product_composite: 'same_product_master_fact',
  repair_partial_composite: 'same_product_master_fact',
  title_or_spec_fact: 'same_product_master_fact',
  safe_packaging_reference: 'same_product_master_fact',
  existing_channel_value: 'platform_current_fact',
  same_tenant_channel_snapshot: 'platform_current_fact',
  same_product_media_evidence: 'same_product_media_evidence',
  page_readback_diff: 'runtime_readback',
  safe_non_regulated_default: 'deterministic_safe_default',
  zero_cost_default_matrix: 'deterministic_safe_default',
  zero_cost_empty_option_terminal_fallback: 'deterministic_safe_default',
  qnh_type5_country_tree_contract: 'deterministic_safe_default',
  qnh_no_brand_fallback: 'deterministic_safe_default',
  qnh_type4_brand_without_candidates: 'deterministic_safe_default',
  same_tenant_no_brand_fallback: 'deterministic_safe_default',
}));

export function canonicalSegment(value, fallbackLabel = 'field') {
  const raw = String(value ?? '').trim().normalize('NFKC');
  const slug = raw.toLowerCase()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/[_-]{2,}/g, '_');
  if (slug) return slug;
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  return `${fallbackLabel}_${digest}`;
}

export function canonicalFieldId(prefix, ...segments) {
  const namespace = String(prefix ?? '').trim().replace(/\.$/, '');
  if (!FIELD_PREFIXES.has(namespace)) throw new Error(`field_id_namespace_invalid:${namespace}`);
  if (!segments.length) throw new Error(`field_id_segments_empty:${namespace}`);
  const value = [namespace, ...segments.map((segment) => canonicalSegment(segment))].join('.');
  if (!/^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(value)) {
    throw new Error(`field_id_format_invalid:${value}`);
  }
  return value;
}

export function valueText(value, role = 'planned') {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return role === 'before' ? EMPTY_VALUE : NOT_APPLICABLE;
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text || (role === 'before' ? EMPTY_VALUE : NOT_APPLICABLE);
}

export function canonicalResult(value) {
  const aliases = {
    verified: 'verified_complete',
    success: 'verified_complete',
    no_change: 'verified_no_change',
    materialized_waiting_review: 'waiting_platform_review',
    blocked_without_evidence: 'manual_evidence_required',
  };
  const text = aliases[String(value ?? '').trim()] || String(value ?? '').trim();
  if (!RESULT_VALUES.has(text)) throw new Error(`result_value_invalid:${text}`);
  return text;
}

export function canonicalSourceStrategy(value, fallback = 'runtime_readback') {
  const text = String(value ?? '').trim();
  if (SOURCE_VALUES.has(text)) return text;
  const lowered = text.toLowerCase();
  if (SOURCE_ALIASES.has(lowered)) return SOURCE_ALIASES.get(lowered);
  const rules = [
    [['真实资料', '人工资料', 'manual', 'real_evidence'], 'manual_evidence_required'],
    [['平台审核', '审核原文', 'review_reason'], 'platform_review_reason'],
    [['官方注册', 'official_registry', 'registry'], 'official_registry'],
    [['用户提供', 'user_provided'], 'user_provided_verified'],
    [['插件', 'plugin'], 'plugin_native_result'],
    [['源店', 'source_store', 'archive'], 'source_store_verified_archive'],
    [['经营策略', 'business_strategy'], 'business_strategy_result'],
    [['provider', 'generated'], 'provider_generated_non_regulated'],
    [['deepseek', 'llm', 'model', 'semantic'], 'semantic_model_candidate_validated'],
    [['默认', 'fallback', 'no_brand', 'country_tree', 'no_upc', 'safe_non'], 'deterministic_safe_default'],
    [['ocr', '媒体', '原图', '主图', 'media'], 'same_product_media_evidence'],
    [['跨渠道', 'cross_channel', 'same_spu_cross'], 'cross_channel_equivalent_fact'],
    [['平台候选', '平台匹配', 'official_recommendation', 'platform_match'], 'platform_recommendation_validated'],
    [['标题', '规格', '包装', 'same_product', 'master_fact'], 'same_product_master_fact'],
    [['现有渠道', '当前事实', 'existing_channel', 'platform_current'], 'platform_current_fact'],
    [['回读', 'readback', 'page_readback'], 'runtime_readback'],
  ];
  for (const [needles, result] of rules) {
    if (needles.some((needle) => lowered.includes(needle))) return result;
  }
  if (!SOURCE_VALUES.has(fallback)) throw new Error(`source_strategy_invalid:${fallback}`);
  return fallback;
}

export function isReadbackPassed(result) {
  return ['verified_complete', 'verified_no_change', 'waiting_platform_review'].includes(
    canonicalResult(result),
  );
}

export function validateAuditRow(row) {
  const errors = [];
  if (!Array.isArray(row) || row.length !== 10) return ['audit_row_width_invalid'];
  const [spuId, productName, channel, fieldId, fieldName, before, planned, readback, result, source] = row;
  for (const [label, value] of [
    ['spu_id', spuId], ['product_name', productName], ['channel', channel],
    ['field_id', fieldId], ['field_name', fieldName], ['before', before],
    ['planned', planned], ['readback', readback],
  ]) {
    if (!String(value ?? '').trim()) errors.push(`${label}_empty`);
  }
  if (!CHANNEL_VALUES.has(String(channel ?? '').trim())) errors.push('channel_value_invalid');
  const fieldText = String(fieldId ?? '').trim();
  const namespace = fieldText.split('.', 1)[0];
  if (!FIELD_PREFIXES.has(namespace) || !/^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(fieldText)) {
    errors.push('field_id_invalid');
  }
  if (!RESULT_VALUES.has(String(result ?? '').trim())) errors.push('result_value_invalid');
  if (!SOURCE_VALUES.has(String(source ?? '').trim())) errors.push('source_strategy_invalid');
  for (const [role, value] of [['before', before], ['planned', planned], ['readback', readback]]) {
    const text = String(value ?? '').trim();
    if (FORBIDDEN_LEGACY_CELL_VALUES.has(text)) errors.push(`legacy_cell_value_forbidden:${role}`);
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || JSON.stringify(parsed) !== text) errors.push(`multivalue_not_compact:${role}`);
      } catch {
        errors.push(`multivalue_json_invalid:${role}`);
      }
    }
    if (fieldText.startsWith('price.')
      && ![EMPTY_VALUE, NOT_APPLICABLE, CONTENT.unknown_value].includes(text)
      && !PRICE_VALUE_PATTERN.test(text)) {
      errors.push(`price_value_invalid:${role}`);
    }
  }
  return errors;
}
