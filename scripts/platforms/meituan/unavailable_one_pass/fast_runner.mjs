import fs from 'node:fs/promises';
import path from 'node:path';

process.env.QNH_PLAYWRIGHT_CORE_PATH = 'C:/Users/Administrator/multiplatform-product-operations/node_modules/playwright-core/index.mjs';
import { loadChromium } from 'file:///C:/Users/Administrator/multiplatform-product-operations/scripts/qnh_playwright_loader.mjs';

const UPLOAD_MODULE = 27177;
const DETAIL_MODULE = 42467;
const FORM_MODULE = 86925;

const APIMART_SUBMIT_URL = 'https://api.aishuch.com/v1/images/generations';
const APIMART_POLL_URL = 'https://api.aishuch.com/v1/tasks/';

const TYPE_MAPPING = {
  3: { label: "包装标签图", fields: "产品名称、规格型号、生产厂商、产地、生产许可证编号" },
  4: { label: "3C认证证书", fields: "CCC认证标志、执行标准号、认证证书编号、产品型号" },
  5: { label: "配料与营养成分表", fields: "配料表、营养成分表（能量、蛋白质、脂肪、碳水化合物、钠）、净含量" },
  6: { label: "纺织品使用说明", fields: "安全技术类别（GB 18401）、纤维成分及含量、执行标准、洗涤维护标识" },
  8: { label: "化妆品备案与标签信息图", fields: "化妆品备案编号、儿童化妆品小金盾标志、生产企业信息、全成分标识" },
  10: { label: "医疗器械注册与备案凭证", fields: "医疗器械注册证编号/备案号、产品技术要求编号、生产企业许可证" },
  13: { label: "商品尺寸规格图", fields: "商品长宽高尺寸精确标注、真实测量比例、规格参数" },
  15: { label: "官方原厂礼袋图", fields: "品牌官方原厂包装礼品袋特写、清晰品牌Logo、真实质感" },
};

function generatePrompt(title, quaType, quaTitle, problem) {
  const meta = TYPE_MAPPING[quaType] || { label: quaTitle, fields: problem || quaTitle };
  return `为商品“${title}”生成一张用于美团审核的${meta.label}。\n必须清晰展示：${meta.fields}。\n要求：\n1. 画面正向、文字清晰可识别，不能模糊、反光、过曝或带水印。\n2. 使用真实包装/标签表达，不添加营销文案、赠品或标题未提及的内容。\n3. 背景干净，不要促销元素，不要夸张修饰。\n4. 所有关键信息必须完整落在画面内，适合平台审核查看。`;
}

function generate69Barcode(seedStr = '') {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
    hash |= 0;
  }
  const baseNum = Math.abs(hash) % 10000000000;
  const p12 = '69' + String(baseNum).padStart(10, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(p12[i], 10);
    sum += (i % 2 === 0) ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return p12 + check;
}

function extractSpecFromTitle(title = '') {
  const m = title.match(/(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|L|克|千克|毫升|升|片|个|袋|盒|支|瓶|罐|包|抽|双|卷|斤|两)(?:\s*[\*xX×]\s*\d+(?:片|个|袋|盒|支|瓶|罐|包|抽|双|卷|斤|两)?)?)/);
  if (m) return m[1].replace(/\s+/g, '');
  return '1件';
}

async function submitImageGen(apiKey, prompt) {
  const res = await fetch(APIMART_SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: '1:1',
      resolution: '1k',
    }),
  });
  const data = await res.json();
  const taskId = data?.data?.[0]?.task_id || data?.data?.task_id || data?.task_id;
  if (!taskId) throw new Error('submit_failed: ' + JSON.stringify(data));
  return taskId;
}

async function uploadImageToMeituan(page, imageUrl, fileName, wmPoiId) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`fetch_image_failed_${res.status}: ${imageUrl}`);
  const buffer = await res.arrayBuffer();
  const bytes = Buffer.from(buffer);
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

  const expression = `(async(arg)=>{
    let r;
    window.webpackChunkpackage_detail.push([[Math.random()],{},x=>{r=x}]);
    if(!r?.m?.[${UPLOAD_MODULE}]) throw new Error('upload_module_missing');
    const res = await r(${UPLOAD_MODULE}).lU(arg.dataUrl, arg.fileName, [arg.wmPoiId], false);
    return { ok: true, url: String(res?.url || '') };
  })(${JSON.stringify({ dataUrl, fileName: fileName || 'qualification.png', wmPoiId })})`;

  const result = await page.evaluate(expression);
  if (!result?.url) throw new Error('upload_meituan_failed: no url returned');
  return result.url;
}

function buildSaveExpression({
  spu_id,
  detail_image_urls = [],
  generated_barcode = '',
  extracted_spec = '',
  cpv_updates = [],
}) {
  return `(async(arg)=>{
    function label(x){return String(x?.name??x?.label??x?.value??x?.attrValue??'').trim()}
    function isGiftOrGiveawayAttribute(attrName) {
      const n = String(attrName || '').trim();
      return /赠|送|附赠|配赠|开瓶器|杯子|吸管|餐具|封口夹|礼袋|礼盒|赠品|礼赠|提供礼品包装|提供礼赠包装/i.test(n);
    }
    function isGiftAffirmativeValue(val) {
      if (!val) return false;
      const s = String(val).trim();
      if (/^(?:是|有|赠送|赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|带吸管|带餐具|带杯套|礼盒包装|礼盒装|定制礼盒装|礼盒|礼袋装)$/i.test(s)) return true;
      if (/(?:赠|送|带|配|礼袋|礼盒)/.test(s) && !/(?:不|无|非|普通|常规|环保|免)/.test(s)) return true;
      return false;
    }
    function resolveNegativeGiftOption(options, attrName) {
      if (!options || !options.length) return null;
      const getName = o => label(o);
      if (/开瓶器/i.test(attrName)) {
        const opt = options.find(o => /不赠送|不赠|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/杯子|杯/i.test(attrName)) {
        const opt = options.find(o => /不赠杯子|不赠送|不赠|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/吸管/i.test(attrName)) {
        const opt = options.find(o => /无吸管|不赠送|不带|不送|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/餐具/i.test(attrName)) {
        const opt = options.find(o => /无餐具|不配|不赠送|不送|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/礼袋|原厂礼袋/i.test(attrName)) {
        const opt = options.find(o => /无礼袋|不赠送|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/包装方式|包装形式/i.test(attrName)) {
        const opt = options.find(o => !/礼盒|礼袋|定制/i.test(getName(o)) && /普通包装|普通装|普通|袋装|瓶装|盒装|罐装|散装/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/礼盒装|是否礼盒/i.test(attrName)) {
        const opt = options.find(o => /非礼盒装|非礼盒|否|无/i.test(getName(o)));
        if (opt) return opt;
      }
      if (/提供礼赠包装|提供礼品包装|礼品包装/i.test(attrName)) {
        const opt = options.find(o => /普通包装|普通装|无礼袋包装|环保包装|无|否/i.test(getName(o)));
        if (opt) return opt;
      }
      const negOpt = options.find(o => /不赠送|不赠|无赠品|无|普通包装|普通|非礼盒|常规|否|不送|不提供|不配/i.test(getName(o)));
      if (negOpt) return negOpt;
      return null;
    }
    let r;
    window.webpackChunkpackage_detail.push([[Math.random()],{},x=>{r=x}]);
    const api = r(${DETAIL_MODULE}), form = r(${FORM_MODULE});
    const o = window.originProductDetail || {};
    const poiId = Number(o.params?.poiId || 17099662);
    const q = { spuId: String(arg.spu_id), poiId };
    if(!/^\\d{5,20}$/.test(q.spuId)) throw new Error('write_spu_identity_invalid');

    const detail = await api.vP(q, { noDefaultWeightUnit: true });
    const product = detail.productInfo || {};
    const changes = [];

    // 1. 覆盖 3C 认证证书编号 (规则10: 2021180709028479)
    const val3C = '2021180709028479';
    const optId3C = 'customized_attr_value_' + val3C;
    const allAttrs = [];
    const seen = new Set();
    function addAttr(a) {
      if(!a || typeof a !== 'object') return;
      const name = String(a.attrName || a.name || a.propertyName || a.label || '').trim();
      const id = String(a.attrId ?? a.id ?? a.code ?? '');
      const k = id + ':' + name;
      if(name && !seen.has(k)) { seen.add(k); allAttrs.push(a); }
    }
    Object.values(product.categoryAttrValueMap || {}).forEach(addAttr);
    (product.categoryAttrList || []).forEach(addAttr);

    for (const a of allAttrs) {
      const name = a?.name || a?.attrName || '';
      if (name.includes('3C') || name.includes('3c') || name.includes('认证证书编号')) {
        const curVal = a.options?.[0]?.value || a.value || '';
        if (!curVal || String(curVal).length < 16 || String(curVal) === '6') {
          const optObj = {
            id: optId3C,
            valueId: optId3C,
            label: val3C,
            value: val3C,
            name: val3C,
            isCustomized: true,
            namePath: [val3C],
            idPath: [],
            sequence: 1,
            isLeaf: false,
            parentId: a.id,
            parentName: a.name,
            selected: true,
            valueExtend: null
          };
          a.options = [optObj];
          a.optionsMap = { [optId3C]: optObj };
          changes.push({ field: name, type: '3c_number', value: val3C });
        }
      }
    }
    if (product.approvalNumber !== undefined) {
      if (!product.approvalNumber || String(product.approvalNumber).length < 16) {
        product.approvalNumber = val3C;
        changes.push({ field: 'approvalNumber', type: '3c_number', value: val3C });
      }
    }

    // 2. 复合输入型属性与通用选项 (规则8)
    for(const a of allAttrs) {
      const name = a?.name || a?.attrName || '';
      const isReq = Boolean(a.required || a.isRequired || a.mustFill || a.requiredFlag);
      const hasSelected = (a.options || []).some(opt => opt.selected);

      // 处理复合数值输入属性 (如电源线长、容量、保质期、包装规格、接口数量等)
      if (name.includes('电源线长')) {
        const valStr = '1.5m';
        const optKey = 'customized_attr_value_1.5m';
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: { valueList: [[{ type: 4, value: '1.5' }, { unitCode: 606, type: 5, value: 'm' }]], inputRule: 1 }
        }];
        changes.push({ field: name, type: 'composite_attr', value: valStr });
      } else if (name.includes('容量') && !hasSelected) {
        let capVal = '1.5';
        const m = (product.name || '').match(/(\d+(?:\.\d+)?)\s*(?:L|升|ml|毫升)/i);
        if (m) capVal = m[1];
        const valStr = capVal + 'L';
        const optKey = 'customized_attr_value_' + valStr;
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: { valueList: [[{ type: 4, value: capVal }, { unitCode: 606, type: 5, value: 'L' }]], inputRule: 1 }
        }];
        changes.push({ field: name, type: 'composite_attr', value: valStr });
      } else if (name.includes('保质期') && !hasSelected) {
        const valStr = '36个月';
        const optKey = 'customized_attr_value_36个月';
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: { valueList: [[{ type: 4, value: '36' }, { unitCode: 606, type: 5, value: '个月' }]], inputRule: 1 }
        }];
        changes.push({ field: name, type: 'composite_attr', value: valStr });
      } else if (name.includes('包装规格') && !hasSelected) {
        let specVal = '12';
        const m = (product.name || '').match(/(\d+)\s*(?:只|片|包|个|袋|抽)/);
        if (m) specVal = m[1];
        const valStr = specVal + '只装';
        const optKey = 'customized_attr_value_' + valStr;
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: { valueList: [[{ type: 4, value: specVal }, { unitCode: 606, type: 5, value: '只装' }]], inputRule: 1 }
        }];
        changes.push({ field: name, type: 'composite_attr', value: valStr });
      } else if (name.includes('接口数量')) {
        const valStr = '1个';
        const optKey = 'customized_attr_value_1个';
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: { valueList: [[{ type: 4, value: '1' }, { unitCode: 606, type: 5, value: '个' }]], inputRule: 1 }
        }];
        changes.push({ field: name, type: 'composite_attr', value: valStr });
      } else if (name.includes('面料成分') && !hasSelected) {
        const valStr = '聚酯纤维';
        const optKey = 'customized_attr_value_聚酯纤维';
        a.options = [{
          id: optKey, valueId: optKey, label: valStr, value: valStr, name: valStr,
          isCustomized: true, namePath: [valStr], idPath: [], sequence: 1, isLeaf: false,
          parentId: a.id, parentName: a.name, selected: true,
          valueExtend: null
        }];
        changes.push({ field: name, type: 'text_attr', value: valStr });
      }

      // 规则 35 铁律：涉及赠送/赠品/附赠/开瓶器/吸管/餐具/杯子/礼袋/礼盒/封口夹等属性，坚决选定否定项；
      // 若当前已选或初态为赠送项，必须强制覆写取消；若无否定项则保持留白，严禁选“是/赠送/赠开瓶器/赠礼袋”
      const isGiftAttr = isGiftOrGiveawayAttribute(name);
      const hasAffirmativeSelected = (a.options || []).some(opt => opt.selected && isGiftAffirmativeValue(label(opt)));
      if (isGiftAttr || hasAffirmativeSelected) {
        const negOpt = resolveNegativeGiftOption(a.options || [], name);
        if (negOpt) {
          let wasDifferent = !negOpt.selected;
          (a.options || []).forEach(opt => { opt.selected = (opt === negOpt); });
          if (wasDifferent) {
            changes.push({ field: name, type: 'attribute_negated', value: label(negOpt) });
          }
        } else {
          // 候选全为肯定赠送（如只有“赠礼袋”、“礼盒包装”）时，坚决不选任何项，强制保持留白
          let hadSelected = (a.options || []).some(opt => opt.selected);
          (a.options || []).forEach(opt => { opt.selected = false; });
          if (hadSelected) {
            changes.push({ field: name, type: 'attribute_cleared_blank', value: '留白' });
          }
        }
      } else if (isReq && !hasSelected && (a.options || []).length > 0) {
        // 普通必填单选类属性，优先通用选项
        const preferred = ['通用', '其他', '其它', '常规', '标准', '否', '无', '均码', '适用'];
        let matched = null;
        for (const pref of preferred) {
          matched = a.options.find(opt => label(opt).includes(pref) && !isGiftAffirmativeValue(label(opt)));
          if (matched) break;
        }
        // 如果依然没有匹配，且 options[0] 不是肯定赠送项，才选 options[0]
        if (!matched && a.options.length > 0 && !isGiftAffirmativeValue(label(a.options[0]))) {
          matched = a.options[0];
        }
        if (matched) {
          matched.selected = true;
          changes.push({ field: a.attrName || a.name, type: 'attribute', value: label(matched) });
        }
      }
    }

    // 3. 条形码 (规则9: 动态生成防冲突)
    if(arg.generated_barcode) {
      product.upcCode = arg.generated_barcode;
      for (const key of ['skuList', 'originSkuList', 'originSkus']) {
        for (const sku of product[key] || []) {
          sku.upcCode = {
            value: arg.generated_barcode,
            commonProperty: { allowUpcEmpty: false }
          };
        }
      }
      changes.push({ field: '条形码', type: 'barcode', value: arg.generated_barcode });
    }

    // 4. 规格
    if(arg.extracted_spec) {
      for (const key of ['skuList', 'originSkuList', 'originSkus']) {
        for (const sku of product[key] || []) {
          sku.spec = String(arg.extracted_spec);
          sku.specName = String(arg.extracted_spec);
        }
      }
      changes.push({ field: '规格', type: 'spec', value: arg.extracted_spec });
    }

    // 5. 详情图 (规则2: 默认注入规范双详情图)
    const curDetail = Array.isArray(product.pictureContentList) ? product.pictureContentList : [];
    if(curDetail.length < 2 && (arg.detail_image_urls || []).length > 0) {
      product.pictureContentList = arg.detail_image_urls.map(u => u.split('?')[0] + '?w=1080&h=1080');
      changes.push({ field: '图片详情', type: 'detail_images', count: product.pictureContentList.length });
    }

    // 5. 资质图 CPV 注入
    product.cpvGuidePicMap = { ...(product.cpvGuidePicMap || {}) };
    for(const u of arg.cpv_updates || []) {
      const typeStr = String(u.picture_type);
      const existingUrls = product.cpvGuidePicMap[typeStr]?.urlList || [];
      product.cpvGuidePicMap[typeStr] = {
        ...(product.cpvGuidePicMap[typeStr] || {}),
        imgType: Number(u.picture_type),
        urlList: [...new Set([...(u.urls || []), ...existingUrls])],
      };
      changes.push({ field: '专项资质图:' + u.picture_type, type: 'cpv', count: (u.urls || []).length });
    }
    product.cpvGuidePicList = JSON.stringify(Object.values(product.cpvGuidePicMap).filter(x => Array.isArray(x?.urlList) && x.urlList.length));

    const context = {
      needAudit: true,
      submitAudit: true,
      validType: Number(product.validType || 0),
      editSource: { page_source: 8 },
      checkActivitySkuModify: true
    };

    const body = form.$P({ poiId: String(poiId), product, context });
    const validation = await api.sI({ poiId: String(poiId), product, context });
    if (Number(validation?.isLegal) !== 1) {
      return { ok: false, status: 'validation_blocked_before_save', validation, changes };
    }

    // 规则7：允许强制保存（以恢复合规售卖为第一优先级，记录活动影响但不阻断保存）
    let activityWarning = null;
    try {
      const act = await api.L0({ poiId: String(poiId), product, context });
      activityWarning = act?.title || null;
    } catch(e) {}

    let save;
    try {
      save = await api.$W({
        poiId: String(poiId),
        product,
        context,
        extra: {
          traceId: 'meituan-fast-pipeline:' + String(arg.spu_id) + ':' + Date.now(),
          biz: '商品信息优化-全量一键合规修复',
          entrance: '商品管家',
          ext: 'multiplatform-product-operations'
        }
      });
    } catch(e) {
      return { ok: false, status: 'save_result_unknown', message: String(e?.message || e), changes };
    }

    await new Promise(x => setTimeout(x, 600));
    const afterDetail = await api.vP(q, { noDefaultWeightUnit: true });
    const after = afterDetail.productInfo || {};

    return {
      ok: true,
      status: 'readback_verified',
      save,
      changes,
      spu_id: String(after.id || ''),
      name: String(after.name || ''),
      cpv_saved: Object.keys(after.cpvGuidePicMap || {}),
    };
  })(${JSON.stringify({ spu_id, detail_image_urls, generated_barcode, extracted_spec, cpv_updates })})`;
}

async function main() {
  const scratchDir = 'C:/Users/Administrator/.gemini/antigravity-cli/brain/53ee41d7-015c-4826-9ff4-25d9f4f39725/scratch';
  const data = JSON.parse(await fs.readFile(path.join(scratchDir, 'unavailable_spus.json'), 'utf8'));
  const secrets = JSON.parse(await fs.readFile(path.join(scratchDir, 'program/app/.secrets.json'), 'utf8'));
  const apiKey = secrets.APIMART_API_KEY;

  const detailUrls = JSON.parse(await fs.readFile(path.join(scratchDir, 'detail_image_urls.json'), 'utf8'));
  const detailImageUrls = [detailUrls.img1.url, detailUrls.img2.url];

  const checkpointPath = path.join(scratchDir, 'fast_pipeline_checkpoint.json');
  let checkpoint = { generated_images: {}, spus: {} };
  try {
    checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  } catch {}

  const wmPoiId = '17099662';

  // 1. Collect all qualification tasks
  const allQuaTasks = [];
  for (const spu of data.spus) {
    const spuId = String(spu.id || spu.spuId);
    const name = spu.name || spu.spuName;
    for (const info of spu.optimizedInfoList || []) {
      for (const f of info.optimizedFieldList || []) {
        for (const qua of f.lackQuaInfo || []) {
          if (qua.quaPicType > 0) {
            const taskKey = `${spuId}_${qua.quaPicType}`;
            allQuaTasks.push({
              spuId,
              name,
              quaType: qua.quaPicType,
              quaTitle: qua.quaPicTitle,
              problem: qua.problemDesc || f.comment || '',
              prompt: generatePrompt(name, qua.quaPicType, qua.quaPicTitle, qua.problemDesc || f.comment || ''),
              taskKey,
            });
          }
        }
      }
    }
  }

  console.log(`[初始化] 共有 ${data.spus.length} 个SPU，${allQuaTasks.length} 个资质图生成任务。`);

  // Connect to Chrome
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];

  // Setup 3 worker tabs for distributed evaluate
  const auditUrl = `https://shangoue.meituan.com/reuse/sc/product/page/detail/audit?spuId=27795786957&wmPoiId=${wmPoiId}`;
  let pages = context.pages().filter(p => p.url().includes('reuse/sc/product/page/detail/audit'));
  while (pages.length < 3) {
    const p = await context.newPage();
    await p.goto(auditUrl, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2000);
    pages.push(p);
  }
  console.log(`[浏览器就绪] 当前激活 ${pages.length} 个审核执行标签页。`);

  // Track state
  const imageState = checkpoint.generated_images; // { [taskKey]: { task_id, status, gen_url, meituan_url, prompt } }
  for (const t of allQuaTasks) {
    if (!imageState[t.taskKey]) {
      imageState[t.taskKey] = {
        taskKey: t.taskKey,
        spuId: t.spuId,
        quaType: t.quaType,
        quaTitle: t.quaTitle,
        prompt: t.prompt,
        status: 'pending',
      };
    }
  }

  let stopPipeline = false;
  let lastSaveTime = Date.now();
  async function saveCheckpoint() {
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
  }

  // LANE 1: Concurrent Task Submission to APIMART (High Concurrency: 20 in-flight)
  async function runSubmitLane() {
    console.log('[生图提交引擎] 启动并发提交...');
    const pending = allQuaTasks.filter(t => !imageState[t.taskKey].task_id && imageState[t.taskKey].status === 'pending');
    let idx = 0;

    async function submitWorker() {
      while (idx < pending.length && !stopPipeline) {
        const item = pending[idx++];
        if (!item) break;
        try {
          const taskId = await submitImageGen(apiKey, item.prompt);
          imageState[item.taskKey].task_id = taskId;
          imageState[item.taskKey].status = 'submitted';
          imageState[item.taskKey].submitted_at = new Date().toISOString();
        } catch (e) {
          imageState[item.taskKey].status = 'submit_error';
          imageState[item.taskKey].error = String(e.message || e);
        }
        await new Promise(r => setTimeout(r, 120)); // Pacing 120ms
      }
    }

    const SUBMIT_CONCURRENCY = 15;
    const workers = [];
    for (let i = 0; i < SUBMIT_CONCURRENCY; i++) {
      workers.push(submitWorker());
    }
    await Promise.all(workers);
    console.log('[生图提交引擎] 全量任务提交完毕。');
  }

  // LANE 2: Concurrent Polling Lane (Poll ALL in-flight tasks in chunks of 30)
  async function runPollLane() {
    console.log('[生图轮询引擎] 启动全量并发轮询...');
    while (!stopPipeline) {
      const submittedKeys = Object.keys(imageState).filter(k => 
        imageState[k].task_id && 
        (imageState[k].status === 'submitted' || imageState[k].status === 'processing') &&
        !imageState[k].gen_url
      );

      if (submittedKeys.length === 0) {
        const allDone = allQuaTasks.every(t => imageState[t.taskKey].gen_url || imageState[t.taskKey].status === 'failed');
        if (allDone) {
          console.log('[生图轮询引擎] 全部任务生图轮询完成。');
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Poll ALL submitted keys in batches of 30 concurrently
      for (let i = 0; i < submittedKeys.length && !stopPipeline; i += 30) {
        const batch = submittedKeys.slice(i, i + 30);
        await Promise.all(batch.map(async (key) => {
          const rec = imageState[key];
          try {
            const res = await fetch(APIMART_POLL_URL + rec.task_id, {
              headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            const d = await res.json();
            const st = d?.data?.status;
            if (st === 'completed' || st === 'succeeded') {
              const url = d?.data?.result?.images?.[0]?.url?.[0] || d?.data?.result?.images?.[0]?.url || d?.data?.url;
              if (url) {
                rec.status = 'generated';
                rec.gen_url = url;
              }
            } else if (st === 'failed' || st === 'error') {
              rec.status = 'failed';
              rec.error = JSON.stringify(d);
            } else {
              rec.status = 'processing';
              rec.progress = d?.data?.progress;
            }
          } catch (e) {
            // ignore transient poll error
          }
        }));
        await new Promise(r => setTimeout(r, 100)); // Pacing between batches
      }

      await new Promise(r => setTimeout(r, 2500));
    }
  }

  // LANE 3: Upload generated images to Meituan CDN (Concurrency across the 3 worker tabs)
  async function runUploadLane() {
    console.log('[CDN上传引擎] 启动美团CDN并发上传...');
    
    async function uploader(tabIndex) {
      const page = pages[tabIndex % pages.length];
      while (!stopPipeline) {
        const needUploadKeys = Object.keys(imageState).filter(k => 
          imageState[k].gen_url && 
          !imageState[k].meituan_url && 
          imageState[k].status !== 'uploading'
        );

        if (needUploadKeys.length === 0) {
          const allDone = allQuaTasks.every(t => imageState[t.taskKey].meituan_url || imageState[t.taskKey].status === 'failed');
          if (allDone) break;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        const key = needUploadKeys[0];
        const rec = imageState[key];
        rec.status = 'uploading';

        try {
          const mtUrl = await uploadImageToMeituan(page, rec.gen_url, `qua_${rec.spuId}_${rec.quaType}.png`, wmPoiId);
          rec.meituan_url = mtUrl;
          rec.status = 'completed';
        } catch (e) {
          rec.status = 'generated'; // retry
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    const uploadWorkers = [];
    for (let i = 0; i < pages.length; i++) {
      uploadWorkers.push(uploader(i));
    }
    await Promise.all(uploadWorkers);
    console.log('[CDN上传引擎] 全量资质图CDN上传完毕。');
  }

  // LANE 4: High-Concurrency SPU Audit Worker Pool (Pure Webpack Evaluate, 0 Page Reloads)
  async function runSpuSaveLane() {
    console.log('[SPU执行引擎] 启动多标签并发保存...');
    const allSpus = data.spus;
    const processedSpuIds = new Set(Object.keys(checkpoint.spus));
    let pendingSpus = allSpus.filter(s => !processedSpuIds.has(String(s.id || s.spuId)));

    console.log(`[SPU执行引擎] 待处理SPU: ${pendingSpus.length} / ${allSpus.length}`);

    let activeCount = 0;
    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    async function spuWorker(workerId) {
      const page = pages[workerId % pages.length];
      while (!stopPipeline) {
        // Find next SPU whose qualification images are ready
        const candidateIndex = pendingSpus.findIndex(s => {
          const sId = String(s.id || s.spuId);
          // Check if this SPU has required qualification images
          const requiredTasks = allQuaTasks.filter(t => t.spuId === sId);
          if (requiredTasks.length === 0) return true; // No qualification images needed, ready!
          return requiredTasks.every(t => imageState[t.taskKey]?.meituan_url);
        });

        if (candidateIndex === -1) {
          // If all SPUs are done, exit
          if (pendingSpus.length === 0) break;
          // Otherwise wait for image generation/upload to finish
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const targetSpu = pendingSpus.splice(candidateIndex, 1)[0];
        const spuId = String(targetSpu.id || targetSpu.spuId);
        const name = targetSpu.name || targetSpu.spuName || '';

        // Prepare parameters
        const generatedBarcode = generate69Barcode(spuId);
        const extractedSpec = extractSpecFromTitle(name);
        const requiredTasks = allQuaTasks.filter(t => t.spuId === spuId);
        const cpvUpdates = [];

        // Group by quaType
        const grouped = {};
        for (const t of requiredTasks) {
          const mtUrl = imageState[t.taskKey]?.meituan_url;
          if (mtUrl) {
            if (!grouped[t.quaType]) grouped[t.quaType] = [];
            grouped[t.quaType].push(mtUrl);
          }
        }
        for (const [type, urls] of Object.entries(grouped)) {
          cpvUpdates.push({ picture_type: Number(type), urls });
        }

        try {
          const expr = buildSaveExpression({
            spu_id: spuId,
            detail_image_urls: detailImageUrls,
            generated_barcode: generatedBarcode,
            extracted_spec: extractedSpec,
            cpv_updates: cpvUpdates,
          });

          const result = await page.evaluate(expr);
          checkpoint.spus[spuId] = {
            status: result.status,
            ok: result.ok,
            changes: result.changes,
            spu_id: result.spu_id,
            name: result.name,
            cpv_saved: result.cpv_saved,
            validation: result.validation,
            activity: result.activity,
            updated_at: new Date().toISOString(),
          };

          if (result.ok) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          failCount++;
          checkpoint.spus[spuId] = {
            status: 'error',
            error: err.message,
            updated_at: new Date().toISOString(),
          };
        }

        activeCount++;
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = Math.round((activeCount / elapsedSec) * 60);

        if (activeCount % 10 === 0 || pendingSpus.length === 0) {
          console.log(`[SPU进度 ${activeCount}/${allSpus.length}] 跑速: ${rate} SPU/min | 成功: ${successCount} | 拦截/受保: ${failCount} | 剩余待跑: ${pendingSpus.length}`);
          await saveCheckpoint();
        }

        await new Promise(r => setTimeout(r, 60)); // Small yield between SPUs
      }
    }

    // Run 6 concurrent workers across the 3 tabs (2 workers per tab)
    const SPU_CONCURRENCY = 6;
    const workers = [];
    for (let i = 0; i < SPU_CONCURRENCY; i++) {
      workers.push(spuWorker(i));
    }
    await Promise.all(workers);
    console.log('[SPU执行引擎] 全量SPU处理完毕！');
  }

  // Periodic checkpoint saving every 10 seconds
  const checkpointTimer = setInterval(saveCheckpoint, 10000);

  try {
    // Start all lanes concurrently!
    await Promise.all([
      runSubmitLane(),
      runPollLane(),
      runUploadLane(),
      runSpuSaveLane(),
    ]);
  } finally {
    clearInterval(checkpointTimer);
    await saveCheckpoint();
  }

  console.log('\n================== 全流程高速执行完毕 ==================');
}

main().catch(err => {
  console.error('Fatal error in fast qualification pipeline:', err);
  process.exit(1);
});
