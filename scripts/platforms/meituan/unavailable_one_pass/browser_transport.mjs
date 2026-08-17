import crypto from 'node:crypto';

export const TRANSPORTS = Object.freeze({
  extension: 'chrome_extension_current_tab',
  cdp: 'managed_cdp',
});

export function selectBrowserTransport({ extensionAvailable = false, managedCdp = null, requested = 'auto' } = {}) {
  if (!['auto', 'extension', 'cdp'].includes(requested)) throw new Error('unsupported_browser_transport_request');
  if ((requested === 'auto' || requested === 'extension') && extensionAvailable) {
    return { browser_transport: TRANSPORTS.extension, cdp_url: 'chrome-extension-current-tab://scoped' };
  }
  if ((requested === 'auto' || requested === 'cdp') && managedCdp?.idle === true && managedCdp?.identity_verified === true) {
    const url = String(managedCdp.url || '');
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error('managed_cdp_must_be_loopback');
    return { browser_transport: TRANSPORTS.cdp, cdp_url: url };
  }
  throw new Error(requested === 'cdp' ? 'managed_cdp_unavailable' : 'chrome_extension_current_tab_unavailable');
}
export function parseMeituanPageIdentity({ topUrl = '', frameUrl = '', visibleStoreName = '' } = {}) {
  const accepted = [topUrl, frameUrl].filter(Boolean).every((value) => {
    try { return new URL(value).hostname === 'shangoue.meituan.com'; } catch { return false; }
  });
  if (!accepted || !frameUrl) throw new Error('meituan_page_identity_invalid');
  const frame = new URL(frameUrl);
  const wmPoiId = String(frame.searchParams.get('wmPoiId') || '').trim();
  if (!/^\d{5,20}$/.test(wmPoiId)) throw new Error('meituan_wm_poi_id_missing');
  const route = frame.pathname;
  if (!/\/product\/(?:manager|page\/detail|views\/product)/.test(route)) throw new Error('meituan_route_not_supported');
  return {
    platform_adapter: 'meituan',
    wm_poi_id: wmPoiId,
    visible_store_name: String(visibleStoreName || '').trim().slice(0, 160),
    top_url: topUrl,
    frame_url: frameUrl,
    route,
  };
}

export function stableCohortFromRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length < 2) throw new Error('cohort_requires_two_rounds');
  const normalized = rounds.map((round) => {
    const rows = Array.isArray(round?.rows) ? round.rows : [];
    const byId = new Map();
    for (const row of rows) {
      const id = String(row?.spuId || row?.id || '').trim();
      if (id && !byId.has(id)) byId.set(id, row);
    }
    return { total: Number(round?.total || 0), byId };
  });
  const firstIds = [...normalized[0].byId.keys()].sort();
  for (const round of normalized.slice(1)) {
    const ids = [...round.byId.keys()].sort();
    if (ids.length !== firstIds.length || ids.some((value, index) => value !== firstIds[index])) {
      throw new Error('cohort_spu_set_not_stable');
    }
  }
  const totals = [...new Set(normalized.map((round) => round.total))];
  if (totals.length !== 1) throw new Error('cohort_total_not_stable');
  return {
    platform_record_count: totals[0],
    unique_spu_count: firstIds.length,
    duplicate_record_count: Math.max(0, totals[0] - firstIds.length),
    rows: firstIds.map((id) => normalized[0].byId.get(id)),
    spu_ids: firstIds,
    spu_set_sha256: crypto.createHash('sha256').update(firstIds.join('\n')).digest('hex'),
  };
}
