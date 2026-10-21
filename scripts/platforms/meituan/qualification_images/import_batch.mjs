import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildAuditUrl,
  prepareAuditWorker,
  readAuditDetail,
  saveQualificationPlan,
} from '../unavailable_one_pass/engine.mjs';

const UPLOAD_MODULE = 36515;
const LEGACY_UPLOAD_MODULE = 27177;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function groupReadyItems(manifest, readyOnly) {
  if (manifest?.schema !== 'meituan-qualification-import-manifest-v1') throw new Error('qualification_manifest_schema_invalid');
  if (manifest?.platform_adapter !== 'meituan' || manifest?.task_mode !== 'unavailable_one_pass') throw new Error('qualification_manifest_mode_invalid');
  const blocked = (manifest.items || []).filter((item) => item.status !== 'ready');
  if (blocked.length && !readyOnly) throw new Error(`qualification_manifest_has_blocked_items:${blocked.length}`);
  const groups = new Map();
  for (const item of manifest.items || []) {
    if (item.status !== 'ready') continue;
    const spuId = String(item.spu_id || '');
    if (!/^\d{5,20}$/.test(spuId)) throw new Error('qualification_spu_id_invalid');
    if (!groups.has(spuId)) groups.set(spuId, []);
    groups.get(spuId).push(item);
  }
  for (const items of groups.values()) items.sort((a, b) => Number(a.picture_type) - Number(b.picture_type) || Number(a.sequence) - Number(b.sequence));
  return { groups, blockedCount: blocked.length };
}

function mimeFor(file) {
  const suffix = path.extname(file).toLowerCase();
  if (suffix === '.png') return 'image/png';
  if (suffix === '.jpg' || suffix === '.jpeg') return 'image/jpeg';
  throw new Error('qualification_image_extension_invalid');
}

async function uploadReceipt({ cdp, runDir, item, wmPoiId }) {
  const filePath = path.resolve(String(item.file_path || ''));
  const bytes = await fs.readFile(filePath);
  const actualSha = sha256(bytes);
  if (actualSha !== String(item.sha256 || '')) throw new Error(`qualification_file_sha256_changed:${item.file_name}`);
  if (bytes.length > 5 * 1024 * 1024) throw new Error(`qualification_image_exceeds_5mb:${item.file_name}`);
  const businessKey = sha256(`${wmPoiId}\n${item.spu_id}\n${item.picture_type}\n${item.sequence}\n${actualSha}`);
  const receiptPath = path.join(runDir, 'uploads', `${businessKey}.json`);
  try {
    const existing = await readJson(receiptPath);
    if (existing?.source_sha256 === actualSha && existing?.image_url) return existing;
  } catch {}
  const dataUrl = `data:${mimeFor(filePath)};base64,${bytes.toString('base64')}`;
  const expression = `(async(arg)=>{const o=window.originProductDetail||{};const id=String(o.res?.id||o.res?.productSpu?.id||'');const wm=String(o.res?.wmPoiId||o.res?.productSpu?.wmPoiId||o.params?.poiId||'');if(id!==String(arg.spu_id)||wm!==String(arg.wm_poi_id))throw new Error('upload_identity_mismatch');let r;window.webpackChunkpackage_detail.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);let result;if(r?.m?.[${UPLOAD_MODULE}]&&typeof r(${UPLOAD_MODULE})?.jt==='function'){result=await r(${UPLOAD_MODULE}).jt(arg.data_url,arg.file_name,String(arg.wm_poi_id),false)}else if(r?.m?.[${LEGACY_UPLOAD_MODULE}]&&typeof r(${LEGACY_UPLOAD_MODULE})?.lU==='function'){result=await r(${LEGACY_UPLOAD_MODULE}).lU(arg.data_url,arg.file_name,[arg.wm_poi_id],false)}else{throw new Error('native_upload_module_missing')}const url=String(result?.url||'');if(!url)throw new Error('native_upload_url_missing');return{ok:true,url,poor_quality:Number(result?.poorQuality||0),low_white_rate:Number(result?.lowWhiteRate||0)}})(${JSON.stringify({ spu_id: item.spu_id, wm_poi_id: wmPoiId, file_name: item.file_name, data_url: dataUrl })})`;
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 120000 });
  if (response?.exceptionDetails) throw new Error(`qualification_upload_exception:${response.exceptionDetails.text || 'unknown'}`);
  const value = response?.result?.value;
  if (!value?.ok || !value?.url) throw new Error('qualification_upload_failed');
  const receipt = {
    schema: 'meituan-qualification-upload-receipt-v1',
    created_at: new Date().toISOString(),
    wm_poi_id: String(wmPoiId),
    spu_id: String(item.spu_id),
    picture_type: Number(item.picture_type),
    sequence: Number(item.sequence),
    source_path: filePath,
    source_sha256: actualSha,
    image_url: value.url,
    native_quality: { poor_quality: value.poor_quality, low_white_rate: value.low_white_rate },
  };
  await writeJson(receiptPath, receipt);
  return receipt;
}

function exactPrefix(actual, expected) {
  return expected.every((url, index) => actual[index] === url);
}

function verifyReadback(detail, updates) {
  const checks = updates.map((update) => {
    const actual = detail?.cpv_map?.[String(update.picture_type)]?.urls || [];
    return {
      picture_type: Number(update.picture_type),
      expected_urls: update.urls,
      actual_urls: actual,
      ordered_prefix: exactPrefix(actual, update.urls),
    };
  });
  return { ok: checks.every((check) => check.ordered_prefix), checks };
}

export async function runQualificationImport({
  tab,
  cdp,
  manifestPath,
  runDir,
  readyOnly = false,
  canaryOnly = false,
} = {}) {
  const absoluteManifest = path.resolve(String(manifestPath || ''));
  const absoluteRunDir = path.resolve(String(runDir || ''));
  const manifest = await readJson(absoluteManifest);
  const wmPoiId = String(manifest.wm_poi_id || '');
  if (!/^\d{5,20}$/.test(wmPoiId)) throw new Error('qualification_manifest_wm_poi_id_invalid');
  const { groups, blockedCount } = groupReadyItems(manifest, readyOnly);
  const manifestSha = sha256(await fs.readFile(absoluteManifest));
  const checkpointPath = path.join(absoluteRunDir, 'qualification-import-checkpoint.json');
  let checkpoint = { schema: 'meituan-qualification-import-checkpoint-v1', manifest_sha256: manifestSha, items: {} };
  try {
    checkpoint = await readJson(checkpointPath);
    if (checkpoint.manifest_sha256 !== manifestSha) throw new Error('qualification_checkpoint_manifest_changed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(absoluteRunDir, { recursive: true });
  let processed = 0;
  for (const [spuId, items] of groups) {
    if (checkpoint.items?.[spuId]?.status === 'readback_verified') continue;
    if (canaryOnly && processed >= 1) break;
    const auditUrl = buildAuditUrl('https://shangoue.meituan.com/reuse/sc/product/page/detail/audit', spuId, wmPoiId);
    await prepareAuditWorker({ tab, cdp, auditUrl, expectedSpuId: spuId, expectedWmPoiId: wmPoiId });
    const before = await readAuditDetail({ cdp });
    if (String(before?.spu_id || '') !== spuId) throw new Error('qualification_read_identity_mismatch');
    const configured = new Set(Object.values(before?.cpv_map || {}).map((entry) => Number(entry.img_type)));
    const requestedTypes = new Set(items.map((item) => Number(item.picture_type)));
    for (const pictureType of requestedTypes) {
      if (!configured.has(pictureType) && ![3, 4, 5, 6, 7, 8, 10, 11, 13, 14].includes(pictureType)) throw new Error(`qualification_picture_type_not_supported:${pictureType}`);
    }
    const receipts = [];
    for (const item of items) receipts.push({ item, receipt: await uploadReceipt({ cdp, runDir: absoluteRunDir, item, wmPoiId }) });
    const byType = new Map();
    for (const { item, receipt } of receipts) {
      const key = Number(item.picture_type);
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push({ item, receipt });
    }
    const updates = [...byType.entries()].map(([pictureType, rows]) => ({
      picture_type: pictureType,
      title: rows[0].item.title,
      reason: `批量导入${rows[0].item.title}`,
      placement: 'prepend',
      urls: rows.map((row) => row.receipt.image_url),
      authoritative_evidence: rows.map((row) => row.item.authoritative_evidence),
    }));
    const existingIntent = path.join(absoluteRunDir, `qualification-${spuId}-${manifestSha.slice(0, 12)}-intent.json`);
    try {
      await fs.access(existingIntent);
      const current = await readAuditDetail({ cdp });
      const verification = verifyReadback(current, updates);
      checkpoint.items[spuId] = { status: verification.ok ? 'readback_verified' : 'unknown_previous_write_requires_review', verification };
      await writeJson(checkpointPath, checkpoint);
      if (!verification.ok) throw new Error(`qualification_previous_write_unknown:${spuId}`);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const plan = { spu_id: spuId, cpv_updates: updates };
    const issues = updates.map((update) => ({
      type: 'qualification_image',
      field_name: '商品图片',
      qua_pic_type: update.picture_type,
      qua_pic_title: update.title,
      comment: update.reason,
    }));
    const save = await saveQualificationPlan({ cdp, plan, issues, writeIntentPath: existingIntent });
    const after = await readAuditDetail({ cdp });
    const verification = verifyReadback(after, updates);
    const protectedMedia = {
      main_unchanged: JSON.stringify(before.media?.main || []) === JSON.stringify(after.media?.main || []),
      detail_preserved: (before.media?.detail || []).every((url) => (after.media?.detail || []).includes(url)),
      old_cpv_preserved: (before.media?.cpv || []).every((url) => (after.media?.cpv || []).includes(url)),
    };
    const ok = Boolean(save?.ok) && verification.ok && Object.values(protectedMedia).every(Boolean);
    checkpoint.items[spuId] = {
      status: ok ? 'readback_verified' : 'readback_mismatch',
      save_status: save?.status || 'unknown',
      verification,
      protected_media: protectedMedia,
      uploaded_count: receipts.length,
      updated_at: new Date().toISOString(),
    };
    await writeJson(checkpointPath, checkpoint);
    processed += 1;
    if (!ok) throw new Error(`qualification_readback_failed:${spuId}`);
  }
  const values = Object.values(checkpoint.items || {});
  const summary = {
    schema: checkpoint.schema,
    manifest_sha256: manifestSha,
    ready_files: Number(manifest.ready_count || 0),
    blocked_files_skipped: blockedCount,
    target_spu: groups.size,
    readback_verified_spu: values.filter((item) => item.status === 'readback_verified').length,
    canary_only: Boolean(canaryOnly),
    checkpoint: checkpointPath,
  };
  await writeJson(path.join(absoluteRunDir, 'qualification-import-summary.json'), summary);
  return summary;
}

async function loadPlaywright() {
  const candidates = [process.env.QNH_PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate);
    } catch {}
  }
  throw new Error('playwright_core_unavailable:set_QNH_PLAYWRIGHT_CORE_PATH');
}

function argsOf(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (['ready-only', 'canary-only'].includes(key)) out[key] = true;
    else out[key] = argv[++index];
  }
  return out;
}

async function cli() {
  const args = argsOf(process.argv.slice(2));
  if (!args.manifest || !args['run-dir'] || !args['cdp-url']) throw new Error('usage:--manifest FILE --run-dir DIR --cdp-url http://127.0.0.1:PORT');
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(args['cdp-url'])) throw new Error('cdp_url_must_be_loopback');
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(args['cdp-url']);
  const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => page.url().includes('shangoue.meituan.com'));
  const identities = new Set(pages.flatMap((page) => page.frames().map((frame) => {
    try { return new URL(frame.url()).searchParams.get('wmPoiId'); } catch { return ''; }
  })).filter(Boolean));
  const manifest = await readJson(path.resolve(args.manifest));
  if (identities.size !== 1 || !identities.has(String(manifest.wm_poi_id || ''))) throw new Error('logged_in_meituan_store_identity_ambiguous_or_mismatch');
  const context = pages[0].context();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const tab = {
    goto: (url) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }),
    playwright: { waitForLoadState: ({ state, timeoutMs }) => page.waitForLoadState(state, { timeout: timeoutMs }) },
  };
  const cdp = { send: (method, params) => session.send(method, params) };
  const result = await runQualificationImport({
    tab,
    cdp,
    manifestPath: args.manifest,
    runDir: args['run-dir'],
    readyOnly: Boolean(args['ready-only']),
    canaryOnly: Boolean(args['canary-only']),
  });
  console.log(JSON.stringify(result, null, 2));
  await page.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  cli()
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: `${error.name}:${error.message}` }));
      process.exitCode = 2;
    })
    .finally(() => {
      // connectOverCDP() 的底层 WebSocket 不会自动断开，事件循环永远不会自然清空；
      // 不显式退出，父进程（run_import_process 的 process.poll()）会永远等不到子进程结束。
      process.exit(process.exitCode ?? 0);
    });
}
