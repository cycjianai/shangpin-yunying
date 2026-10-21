import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stableCohortFromRounds } from './browser_transport.mjs';

const MANAGER_MODULE = 69282;
const DETAIL_MODULE = 42467;
const FORM_MODULE = 86925;
const HARD_EVIDENCE = /3C|认证证书|能效|水效|检测报告|医疗器械|备案|小金盾|许可证|注册证|公章|证书编号|生产者|制造商/i;

function sha(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function issueItems(row) {
  const out = [];
  for (const info of row?.optimizedInfoList || []) {
    for (const field of info?.optimizedFieldList || []) {
      const fieldName = String(field?.fieldName || '').trim();
      const comment = String(field?.comment || '').trim();
      if (fieldName || comment) out.push({ type: 'field', field_name: fieldName, comment });
      for (const item of field?.lackQuaInfo || []) {
        out.push({
          type: 'qualification_image',
          field_name: fieldName || '商品图片',
          comment: String(item?.problemDesc || comment || '').trim(),
          qua_pic_type: Number(item?.quaPicType || 0),
          qua_pic_title: String(item?.quaPicTitle || '').trim(),
          qua_pic_desc: String(item?.quaPicDesc || '').trim(),
          current_url: String(item?.quaPicUrl || '').trim(),
        });
      }
    }
  }
  return out;
}

export function buildAuditUrl(templateUrl, spuId, wmPoiId) {
  const url = new URL(templateUrl);
  if (url.hostname !== 'shangoue.meituan.com' || !/\/reuse\/sc\/product\/page\/detail\/audit$/.test(url.pathname)) {
    throw new Error('audit_template_url_invalid');
  }
  const id = String(spuId || '').trim();
  const store = String(wmPoiId || '').trim();
  if (!/^\d{5,20}$/.test(id) || !/^\d{5,20}$/.test(store)) throw new Error('audit_identity_invalid');
  url.searchParams.set('spuId', id);
  url.searchParams.set('wmPoiId', store);
  if (!url.searchParams.has('oldVersion')) url.searchParams.set('oldVersion', 'true');
  return url.toString();
}

export function validateSafePlan(plan, issues = []) {
  if (!plan || typeof plan !== 'object') throw new Error('plan_missing');
  const allowed = new Set(['clear_invalid_barcode', 'copy_main_to_detail_if_empty', 'default_detail_images_if_empty', 'barcode', 'auto_fill_general_attributes', 'attributes', 'name', 'spec', 'weight', 'cpv_updates']);
  for (const key of Object.keys(plan)) if (!allowed.has(key) && !['spu_id', 'evidence', 'reason'].includes(key)) throw new Error(`plan_key_not_allowed:${key}`);
  if (plan.clear_invalid_barcode && !issues.some((item) => /条形码.*(?:不合法|错误|无效|不符)/.test(`${item.field_name} ${item.comment}`))) {
    throw new Error('barcode_clear_not_authorized_by_issue');
  }
  for (const update of plan.cpv_updates || []) {
    if (!Number.isInteger(Number(update.picture_type)) || !(update.urls || []).length) throw new Error('cpv_update_invalid');
    if (!['append', 'prepend'].includes(String(update.placement || 'append'))) throw new Error('cpv_placement_invalid');
    if (HARD_EVIDENCE.test(`${update.title || ''} ${update.reason || ''}`) && !update.authoritative_evidence) {
      throw new Error('regulated_image_requires_authoritative_evidence');
    }
  }
  for (const attr of plan.attributes || []) {
    if (!String(attr.attr_name || '').trim()) throw new Error('attribute_name_missing');
    if (HARD_EVIDENCE.test(String(attr.attr_name)) && !attr.authoritative_evidence) throw new Error('regulated_attribute_requires_authoritative_evidence');
  }
  return true;
}

export function compareProtectedMedia(before, after) {
  const groups = ['main', 'detail', 'cpv', 'qualification'];
  const result = {};
  let ok = true;
  for (const group of groups) {
    const left = before?.[group] || [];
    const right = after?.[group] || [];
    const preserved = left.every((value, index) => right[index] === value) || (group !== 'main' && left.every((value) => right.includes(value)));
    result[group] = { before: left.length, after: right.length, preserved };
    if (!preserved) ok = false;
  }
  return { ok, groups: result };
}

function managerScanExpression(rounds = 2, pageSize = 20, concurrency = 5, effectTypes = [5]) {
  const typesJson = JSON.stringify(Array.isArray(effectTypes) && effectTypes.length ? effectTypes.map(Number) : [5]);
  return `(async()=>{const w=document.getElementById('hashframe').contentWindow;const u=new URL(w.location.href);const wmPoiId=String(u.searchParams.get('wmPoiId')||'');if(!/^\\d{5,20}$/.test(wmPoiId))throw new Error('manager_identity_missing');let r;w.webpackChunkmrn_product_pc.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);const api=r(${MANAGER_MODULE});if(typeof api?.fetchList!=='function')throw new Error('manager_reader_unavailable');const rounds=[];for(let round=0;round<${Number(rounds)};round++){let total=0;const all=[];for(const effectType of ${typesJson}){const base={effectType,needAudit:true,pageNum:1,pageSize:${Number(pageSize)},searchWord:''};const first=await api.fetchList(base);const t=Number(first?.totalCount||0);total+=t;const pages=Math.max(1,Math.ceil(t/${Number(pageSize)}));all.push(...(first?.spus||[]));for(let start=2;start<=pages;start+=${Number(concurrency)}){const nums=[];for(let p=start;p<Math.min(start+${Number(concurrency)},pages+1);p++)nums.push(p);const got=await Promise.all(nums.map(pageNum=>api.fetchList({...base,pageNum})));for(const x of got)all.push(...(x?.spus||[]))}}const map=new Map();for(const row of all){const id=String(row?.id||row?.spuId||'');if(id&&!map.has(id))map.set(id,row)}rounds.push({total,rows:[...map.values()]});if(round+1<${Number(rounds)})await new Promise(x=>setTimeout(x,500))}return{ok:true,wmPoiId,createdAt:new Date().toISOString(),rounds}})()`;
}

export async function freezeCohort({ cdp, runDir, rounds = 2, pageSize = 20, concurrency = 5 }) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: managerScanExpression(rounds, pageSize, concurrency),
    returnByValue: true,
    awaitPromise: true,
  }, { timeoutMs: 180000 });
  if (response?.exceptionDetails) throw new Error(`manager_scan_exception:${response.exceptionDetails.text || 'unknown'}`);
  const raw = response?.result?.value;
  if (!raw?.ok) throw new Error('manager_scan_failed');
  const cohort = stableCohortFromRounds(raw.rounds);
  const products = cohort.rows.map((row) => ({
    spu_id: String(row?.id || row?.spuId || ''),
    name: String(row?.name || row?.spuName || '').trim(),
    issues: issueItems(row),
    scopes: ['audit_failed'],
  }));
  const manifest = {
    schema: 'meituan-unavailable-manifest-v1',
    platform_adapter: 'meituan',
    task_mode: 'unavailable_one_pass',
    wm_poi_id: raw.wmPoiId,
    platform_record_count: cohort.platform_record_count,
    unique_spu_count: cohort.unique_spu_count,
    duplicate_record_count: cohort.duplicate_record_count,
    spu_set_sha256: cohort.spu_set_sha256,
    created_at: raw.createdAt,
    products,
  };
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function prepareAuditWorker({ tab, cdp, auditUrl, expectedSpuId, expectedWmPoiId, quietMs = 3500 }) {
  await tab.goto(auditUrl);
  await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 60000 });
  await new Promise((resolve) => setTimeout(resolve, quietMs));
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{try{const o=window.originProductDetail||{};if(!o.res)return{ok:false,reason:'native_detail_missing'};const id=String(o.res.id||o.res.productSpu?.id||'');const wm=String(o.res.wmPoiId||o.res.productSpu?.wmPoiId||o.params?.poiId||'');if(id!==${JSON.stringify(String(expectedSpuId))}||wm!==${JSON.stringify(String(expectedWmPoiId))})return{ok:false,reason:'native_identity_mismatch',id,wm};if(!window.webpackChunkpackage_detail)return{ok:false,reason:'detail_chunk_missing'};let r;window.webpackChunkpackage_detail.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);if(!r?.m?.[${DETAIL_MODULE}]||!r?.m?.[${FORM_MODULE}])return{ok:false,reason:'detail_modules_not_registered'};const api=r(${DETAIL_MODULE});return{ok:typeof api?.vP==='function'&&typeof api?.$W==='function',id,wm,apiKeys:Object.keys(api||{}).sort()}}catch(e){return{ok:false,reason:'detail_module_init_exception',message:String(e?.message||e)}}})()`,
    returnByValue: true,
  }, { timeoutMs: 30000 });
  const value = response?.result?.value;
  if (!value?.ok) throw new Error(`audit_worker_not_ready:${value?.reason || 'unknown'}`);
  return value;
}

export async function readAuditDetail({ cdp }) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(async()=>{let r;window.webpackChunkpackage_detail.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);const o=window.originProductDetail||{};if(!o.res||!o.params)throw new Error('native_detail_missing');const p=await r(${DETAIL_MODULE}).vP({spuId:o.params.spuId,poiId:o.params.poiId},o.params.options||{});const product=p.productInfo||{};function label(x){return String(x?.name??x?.label??x?.value??x?.attrValue??'').trim()}const attrs=[];const seen=new Set();function add(a){if(!a||typeof a!=='object')return;const name=String(a.attrName||a.name||a.propertyName||a.label||'').trim();const id=String(a.attrId??a.id??a.code??'');const key=id+':'+name;if(!name||seen.has(key))return;seen.add(key);attrs.push({attr_id:id,attr_name:name,required:Boolean(a.required||a.isRequired||a.mustFill||a.requiredFlag),value_type:Number(a.valueType??a.attrValueType??0),selected:(a.options||[]).filter(x=>x?.selected).map(label).filter(Boolean),options:(a.options||[]).map(label).filter(Boolean),value_format:a.valueFormat||[],render:a.render||null})}Object.values(product.normalAttributesValueMap||{}).forEach(add);Object.values(product.categoryAttrValueMap||{}).forEach(add);(product.categoryAttrList||[]).forEach(add);const urls=(v)=>Array.isArray(v)?v.map(x=>String(x?.url||x?.src||x)).filter(Boolean):String(v||'').split(',').filter(Boolean);const cpvMap=Object.fromEntries(Object.entries(product.cpvGuidePicMap||{}).map(([key,value])=>[String(value?.imgType??key),{img_type:Number(value?.imgType??key),urls:urls(value?.urlList)}]));const media={main:urls(product.pictureList),detail:urls(product.pictureContentList),cpv:Object.values(cpvMap).flatMap(x=>x.urls),qualification:urls(product.approvalNumberPics)};return{ok:true,spu_id:String(product.id||''),name:String(product.name||''),issue:{audit_reject_info:p.auditRejectInfo||null,lack_qua_info:p.lackQuaInfo||null,odin_audit_message:p.odinAuditMessage||'',audit_tips_title:p.auditTipsTitle||'',audit_tips_msg:p.auditTipsMsg||'',state:p.state,data_source:p.dataSource,audit_type:p.auditType},attrs,sku_list:(product.skuList||[]).map(s=>({spec_name:String(s?.specName||s?.spec||''),weight:s?.weight||null,upc:String(s?.upcCode?.value??s?.upcCode??'')})),cpv_map:cpvMap,media}})()`,
    returnByValue: true,
    awaitPromise: true,
  }, { timeoutMs: 30000 });
  if (response?.exceptionDetails) throw new Error(`audit_detail_exception:${response.exceptionDetails.text || 'unknown'}`);
  const value = response?.result?.value;
  if (value?.media) value.media_sha256 = sha(value.media);
  return value;
}

export async function freezeAuditDetails({ cdp, manifest, runDir, concurrency = 8 }) {
  const ids = (manifest?.products || []).map((product) => String(product?.spu_id || '')).filter(Boolean);
  if (!ids.length || !/^\d{5,20}$/.test(String(manifest?.wm_poi_id || ''))) throw new Error('detail_inventory_identity_missing');
  const expression = `(async(ids)=>{let r;window.webpackChunkpackage_detail.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);const o=window.originProductDetail||{};if(!o.params?.options)throw new Error('native_detail_options_missing');const api=r(${DETAIL_MODULE}),out=[];let next=0;function urls(v){return Array.isArray(v)?v.map(x=>String(x?.url||x?.src||x)).filter(Boolean):String(v||'').split(',').filter(Boolean)}function label(x){return String(x?.name??x?.label??x?.value??x?.attrValue??'').trim()}async function worker(){while(next<ids.length){const id=ids[next++];try{const p=await api.vP({spuId:id,poiId:o.params.poiId},o.params.options||{});const x=p.productInfo||{},attrs=[],seen=new Set();function add(a){if(!a||typeof a!=='object')return;const name=String(a.attrName||a.name||a.propertyName||a.label||'').trim(),aid=String(a.attrId??a.id??a.code??''),key=aid+':'+name;if(!name||seen.has(key))return;seen.add(key);attrs.push({attr_id:aid,attr_name:name,required:Boolean(a.required||a.isRequired||a.mustFill||a.requiredFlag),selected:(a.options||[]).filter(y=>y?.selected).map(label).filter(Boolean),options:(a.options||[]).map(label).filter(Boolean)})}Object.values(x.normalAttributesValueMap||{}).forEach(add);Object.values(x.categoryAttrValueMap||{}).forEach(add);(x.categoryAttrList||[]).forEach(add);out.push({spu_id:id,ok:true,name:String(x.name||''),category_id:String(x.categoryId||''),main:urls(x.pictureList),detail:urls(x.pictureContentList),cpv_map:Object.fromEntries(Object.entries(x.cpvGuidePicMap||{}).map(([k,v])=>[String(v?.imgType??k),{img_type:Number(v?.imgType??k),urls:urls(v?.urlList)}])),cpv_config:(x.cpvGuidePicConfigList||[]).map(v=>({img_type:Number(v.imgType||0),title:String(v.imgTitle||''),desc:String(v.imgDesc||''),required:Boolean(v.picRequired),limit:Number(v.picNumLimit||0)})),approval:urls(x.approvalNumberPics),attrs,sku_list:(x.skuList||[]).map(s=>({spec_name:String(s?.specName||s?.spec||''),weight:s?.weight||null,upc:String(s?.upcCode?.value??s?.upcCode??'')})),audit_reject_info:p.auditRejectInfo||null,audit_suggest_category:p.auditSuggestCategory||p.auditRejectInfo?.auditSuggestCategory||null,state:p.state,audit_type:p.auditType})}catch(e){out.push({spu_id:id,ok:false,error:String(e?.message||e)})}}}await Promise.all(Array.from({length:${Math.max(1, Math.min(Number(concurrency) || 1, 10))}},worker));return out})(${JSON.stringify(ids)})`;
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, { timeoutMs: 300000 });
  if (response?.exceptionDetails) throw new Error(`detail_inventory_exception:${response.exceptionDetails.text || 'unknown'}`);
  const rows = response?.result?.value;
  if (!Array.isArray(rows) || rows.length !== ids.length) throw new Error('detail_inventory_incomplete');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'detail-inventory.json'), `${JSON.stringify(rows, null, 2)}\n`);
  return { rows, ok_count: rows.filter((row) => row.ok).length, failed_count: rows.filter((row) => !row.ok).length };
}

export async function saveSafePlan({ cdp, plan, issues, writeIntentPath }) {
  validateSafePlan(plan, issues);
  await fs.writeFile(writeIntentPath, `${JSON.stringify({ schema: 'meituan-write-intent-v1', created_at: new Date().toISOString(), spu_id: plan.spu_id, plan_sha256: sha(plan), status: 'prepared' }, null, 2)}\n`, { flag: 'wx' });
  const response = await cdp.send('Runtime.evaluate', {
    expression: buildSaveExpression(plan), returnByValue: true, awaitPromise: true,
  }, { timeoutMs: 120000 });
  const value = response?.result?.value || { ok: false, status: 'unknown_result' };
  await fs.writeFile(writeIntentPath, `${JSON.stringify({ schema: 'meituan-write-intent-v1', created_at: new Date().toISOString(), spu_id: plan.spu_id, plan_sha256: sha(plan), status: 'request_finished', result: value }, null, 2)}\n`);
  return value;
}

export function buildSaveExpression(plan) {
  return `(async(arg)=>{function urls(v){return Array.isArray(v)?v.map(x=>String(x?.url||x?.src||x)).filter(Boolean):String(v||'').split(',').filter(Boolean)}function detailUrl(v){const s=String(v||'').trim();return s?s.split('?')[0]+'?w=1080&h=1080':''}function media(p){return{main:urls(p.pictureList),detail:urls(p.pictureContentList),cpv:Object.values(p.cpvGuidePicMap||{}).flatMap(x=>x?.urlList||[]).map(String),qualification:urls(p.approvalNumberPics)}}function cmp(a,b){return a.every((v,i)=>b[i]===v)}function label(x){return String(x?.name??x?.label??x?.value??x?.attrValue??'').trim()}let r;window.webpackChunkpackage_detail.push([[Math.floor(Math.random()*1e9)],{},x=>{r=x}]);const api=r(${DETAIL_MODULE}),form=r(${FORM_MODULE});const o=window.originProductDetail||{};const q={spuId:String(arg.spu_id),poiId:o.params.poiId};if(!/^\\d{5,20}$/.test(q.spuId))throw new Error('write_spu_identity_invalid');const detail=await api.vP(q,o.params.options||{});const product=detail.productInfo||{};const beforeMedia=media(product);const beforeName=String(product.name||'');const changes=[];if(arg.clear_invalid_barcode){product.upcCode='';for(const key of ['skuList','originSkuList','originSkus'])for(const sku of product[key]||[]){if(sku.upcCode&&typeof sku.upcCode==='object'){sku.upcCode.value='';sku.upcCode.commonProperty=sku.upcCode.commonProperty||{};sku.upcCode.commonProperty.allowUpcEmpty=true}else sku.upcCode={value:'',commonProperty:{allowUpcEmpty:true}}}changes.push({field:'条形码',before:'invalid',after:'empty_allowed'})}if(arg.copy_main_to_detail_if_empty&&!urls(product.pictureContentList).length){const main=urls(product.pictureList);if(main.length){product.pictureContentList=main.map(detailUrl).filter(Boolean);changes.push({field:'图片详情',before:0,after:main.length})}}const attrs=[];const seen=new Set();function add(a){if(!a||typeof a!=='object')return;const name=String(a.attrName||a.name||a.propertyName||a.label||'').trim();const id=String(a.attrId??a.id??a.code??'');const k=id+':'+name;if(name&&!seen.has(k)){seen.add(k);attrs.push(a)}}Object.values(product.normalAttributesValueMap||{}).forEach(add);Object.values(product.categoryAttrValueMap||{}).forEach(add);(product.categoryAttrList||[]).forEach(add);for(const u of arg.attributes||[]){const a=attrs.find(x=>String(x.attrName||x.name||'').trim()===String(u.attr_name));if(!a)throw new Error('attribute_missing:'+u.attr_name);const wanted=(u.values||[u.value]).map(String);const matched=[];for(const opt of a.options||[]){const hit=wanted.includes(label(opt));opt.selected=hit;if(hit)matched.push(label(opt))}if(matched.length!==wanted.length)throw new Error('attribute_option_not_exact:'+u.attr_name);changes.push({field:u.attr_name,before:'',after:matched})}if(r?.m?.[13085]&&product.normalAttributesValueMap){const Z=r(13085);const C=Z._f(product.normalAttributes,product.sellAttributes,product.normalAttributesValueMap,product.sellAttributesValueMap);product.categoryAttrList=C.categoryAttrList;product.categoryAttrValueMap=C.categoryAttrValueMap;product.bindAttrMap=Z.eN({unconditionalReturn:{unconditionalReturn:product.unconditionalReturn,selectedId:product.unconditionalReturnId}})}if(arg.name){product.name=String(arg.name);changes.push({field:'商品名称',before:beforeName,after:product.name})}if(arg.spec){for(const key of ['skuList','originSkuList','originSkus'])for(const sku of product[key]||[]){sku.spec=String(arg.spec);if('specName'in sku)sku.specName=String(arg.spec)}changes.push({field:'规格名称',before:'',after:String(arg.spec)})}if(arg.weight){const unitMap={g:'克(g)',kg:'千克(kg)',ml:'毫升(ml)',L:'升(L)'};for(const key of ['skuList','originSkuList','originSkus'])for(const sku of product[key]||[])sku.weight={value:Number(arg.weight.value),unit:unitMap[String(arg.weight.unit)]||String(arg.weight.unit),ignoreMax:false};changes.push({field:'重量',before:'',after:arg.weight})}product.cpvGuidePicMap={...(product.cpvGuidePicMap||{})};for(const u of arg.cpv_updates||[]){product.cpvGuidePicMap[String(u.picture_type)]={...(product.cpvGuidePicMap[String(u.picture_type)]||{}),imgType:Number(u.picture_type),urlList:[...new Set([...(product.cpvGuidePicMap[String(u.picture_type)]?.urlList||[]),...(u.urls||[])])]};changes.push({field:'专项图:'+u.picture_type,before:'',after:(u.urls||[]).length})}product.cpvGuidePicList=JSON.stringify(Object.values(product.cpvGuidePicMap).filter(x=>Array.isArray(x?.urlList)&&x.urlList.length));let context={needAudit:true,submitAudit:true,validType:Number(product.validType||0),ignoreSuggestCategory:false,editSource:{page_source:8},checkActivitySkuModify:true};const body=form.$P({poiId:String(o.params.poiId),product,context});if(Number(body?.saveType)!==2||Number(body?.auditSource)!==1)return{ok:false,status:'review_semantics_missing',diagnostics:{saveType:body?.saveType,auditSource:body?.auditSource},changes};let validation=await api.sI({poiId:String(o.params.poiId),product,context});if(validation?.validationErrorDetails?.length>0){context={...context,ignoreSuggestCategory:true};validation=await api.sI({poiId:String(o.params.poiId),product,context})}if(Number(validation?.isLegal)!==1&&validation?.validationErrorDetails?.length>0)return{ok:false,status:'validation_blocked_before_save',validation,changes};const activity=await api.L0({poiId:String(o.params.poiId),product,context});const activityText=JSON.stringify(activity||{});if(!arg.allow_force_save_on_activity_warning&&/退选|停止|下线/.test(activityText)&&!/不影响|无需/.test(activityText))return{ok:false,status:'activity_protected_before_save',activity,changes};let save;try{save=await api.$W({poiId:String(o.params.poiId),product,context,extra:{traceId:'meituan-one-pass:'+String(arg.spu_id)+':'+Date.now(),biz:'商品信息优化-一次过',entrance:'商品管家',ext:'multiplatform-product-operations'}})}catch(e){return{ok:false,status:'save_result_unknown',message:String(e?.message||e),changes}}await new Promise(x=>setTimeout(x,1200));const afterDetail=await api.vP(q,o.params.options||{});const after=afterDetail.productInfo||{};const afterMedia=media(after);const mediaOk=cmp(beforeMedia.main,afterMedia.main)&&beforeMedia.detail.every(x=>afterMedia.detail.includes(x))&&beforeMedia.cpv.every(x=>afterMedia.cpv.includes(x))&&beforeMedia.qualification.every(x=>afterMedia.qualification.includes(x));return{ok:mediaOk,status:mediaOk?'readback_verified':'readback_mismatch',save,changes,before_media:beforeMedia,after_media:afterMedia,spu_id:String(after.id||''),review:{state:afterDetail.state,audit_type:afterDetail.auditType},name:String(after.name||'')}})(${JSON.stringify(plan)})`;
}

export function buildQualificationSaveExpression(plan) {
  const appendFragment = "urlList:[...new Set([...(product.cpvGuidePicMap[String(u.picture_type)]?.urlList||[]),...(u.urls||[])])]";
  const placementFragment = "urlList:[...new Set(String(u.placement||'append')==='prepend'?[...(u.urls||[]),...(product.cpvGuidePicMap[String(u.picture_type)]?.urlList||[])]:[...(product.cpvGuidePicMap[String(u.picture_type)]?.urlList||[]),...(u.urls||[])])]";
  const expression = buildSaveExpression(plan);
  if (!expression.includes(appendFragment)) throw new Error('qualification_save_fragment_missing');
  return expression.replace(appendFragment, placementFragment);
}

export const DEFAULT_DETAIL_IMAGE_URLS = Object.freeze([
  'http://p0.meituan.net/shangouproductapi/434561c2837f7e18a14283901f3950811225008.png',
  'http://p0.meituan.net/shangouproductapi/ae8c9e13b10f64a794024ef9da1e86421243244.png',
]);

export function generate69Barcode(spuId) {
  const s = String(spuId || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  const rawNum = String(hash).padStart(9, '0').slice(-9);
  const prefix12 = `697${rawNum}`;
  let oddSum = 0;
  let evenSum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(prefix12[i]);
    if (i % 2 === 0) oddSum += digit;
    else evenSum += digit;
  }
  const total = oddSum + evenSum * 3;
  const checkDigit = (10 - (total % 10)) % 10;
  return `${prefix12}${checkDigit}`;
}

export function extractSpecFromTitle(title) {
  const t = String(title || '').trim();
  const match = t.match(/[\s(（【]([\d\.\*xX\+\/]+(?:g|kg|ml|l|L|克|千克|毫升|升|包|罐|瓶|袋|盒|提|卷|支|卡|个|件|套|片|抽|双|把|只|斤|两)(?:\*[0-9]+[包罐瓶袋盒提卷支卡个件套片抽双把只])?(?:\/[包罐瓶袋盒提卷支卡个件套片抽双把只件份])?)[)）】]?$/i)
    || t.match(/([\d\.\*xX\+\/]+(?:g|kg|ml|l|L|克|千克|毫升|升|包|罐|瓶|袋|盒|提|卷|支|卡|个|件|套|片|抽|双|把|只|斤|两)(?:\/[包罐瓶袋盒提卷支卡个件套片抽双把只件份])?)$/i);
  return match ? match[1].trim() : '';
}

export async function saveQualificationPlan({ cdp, plan, issues, writeIntentPath }) {
  validateSafePlan(plan, issues);
  await fs.writeFile(writeIntentPath, `${JSON.stringify({ schema: 'meituan-write-intent-v1', created_at: new Date().toISOString(), spu_id: plan.spu_id, plan_sha256: sha(plan), status: 'prepared' }, null, 2)}\n`, { flag: 'wx' });
  const response = await cdp.send('Runtime.evaluate', {
    expression: buildQualificationSaveExpression(plan), returnByValue: true, awaitPromise: true,
  }, { timeoutMs: 120000 });
  const value = response?.result?.value || { ok: false, status: 'unknown_result' };
  await fs.writeFile(writeIntentPath, `${JSON.stringify({ schema: 'meituan-write-intent-v1', created_at: new Date().toISOString(), spu_id: plan.spu_id, plan_sha256: sha(plan), status: 'request_finished', result: value }, null, 2)}\n`);
  return value;
}

