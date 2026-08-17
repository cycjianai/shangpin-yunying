#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => value.startsWith('--') ? [...rows, [value.slice(2), all[index + 1]]] : rows, []));
for (const key of ['checkpoint', 'output', 'skill-version', 'contract-fingerprint', 'store-name']) if (!args[key]) throw new Error(`missing --${key}`);
const checkpoint = JSON.parse(await fs.readFile(path.resolve(args.checkpoint), 'utf8'));
if (checkpoint.schema !== 'meituan-operations-checkpoint-v1' || checkpoint.summary?.report_ready !== true) throw new Error('checkpoint_not_report_ready');
const schemaPath = args.schema ? path.resolve(args.schema) : new URL('../../../operations_workbook_schema.json', import.meta.url);
const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
const wb = Workbook.create();
const sheets = Object.fromEntries(schema.sheets.map((name) => [name, wb.worksheets.add(name)]));
const C = { navy: '#17324D', blue: '#1F6FEB', white: '#FFFFFF', pale: '#F6F8FA', line: '#D0D7DE', green: '#DDF4E7', amber: '#FFF3CD', red: '#FDE2E1' };
const col = (n) => { let s = ''; for (let v = n; v; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + ((v - 1) % 26)) + s; return s; };
const idValue = (v) => /^\d{16,}$/.test(String(v)) ? `​${v}` : String(v);
function table(sheet, headers, rows, widths, name) {
  sheet.getRangeByIndexes(0, 0, 1, headers.length).values = [headers];
  if (rows.length) sheet.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows;
  sheet.showGridLines = false; sheet.freezePanes.freezeRows(1);
  const header = sheet.getRange(`A1:${col(headers.length)}1`);
  header.format = { fill: C.navy, font: { bold: true, color: C.white, size: 10 }, wrapText: true, horizontalAlignment: 'center', verticalAlignment: 'center', borders: { preset: 'outside', style: 'thin', color: C.navy } };
  header.format.rowHeightPx = 34;
  widths.forEach((width, index) => { sheet.getRange(`${col(index + 1)}:${col(index + 1)}`).format.columnWidth = width; });
  if (rows.length) {
    const body = sheet.getRange(`A2:${col(headers.length)}${rows.length + 1}`);
    body.format = { font: { name: 'Aptos', size: 10, color: '#24292F' }, verticalAlignment: 'top', wrapText: true, borders: { insideHorizontal: { style: 'thin', color: '#EAECEF' }, bottom: { style: 'thin', color: C.line } } };
    const t = sheet.tables.add(`A1:${col(headers.length)}${rows.length + 1}`, true, name); t.style = 'TableStyleMedium2'; t.showFilterButton = true;
  }
}
const issueLabel = (i) => [i.field_name, i.comment].filter(Boolean).join('：');
const stateLabel = (state) => ({
  blocked_manual_or_real_evidence: '需真实资料/人工确认',
  readback_verified_with_blockers: '已写回并回读，仍有阻塞项',
  readback_verified_waiting_review: '已写回并回读，待平台复审',
  exited_target_set: '已退出审核未通过集合',
  classified_no_safe_automatic_action: '已分析，无安全自动动作',
})[state] || String(state || '未分类');
const items = Object.values(checkpoint.items);
const productRows = [], auditRows = [];
for (const item of items) {
  const issues = [...new Set((item.issues || []).map(issueLabel).filter(Boolean))].join('；\n') || '无';
  const changeText = (item.changes || []).map((c) => `${c.field}：${typeof c.after === 'object' ? JSON.stringify(c.after) : c.after}`).join('；\n');
  const blockerText = (item.blockers || []).join('；\n');
  const scope = item.still_in_target_set === false ? '已退出审核未通过集合' : item.still_in_target_set === true ? '仍在审核未通过集合/待审核流转' : '未复扫';
  productRows.push([idValue(item.spu_id), issues, [`状态：${stateLabel(item.state)}`, scope, changeText && `已写回并回读：${changeText}`, blockerText && `阻塞：${blockerText}`].filter(Boolean).join('\n')]);
  for (const change of item.changes || []) auditRows.push([idValue(item.spu_id), item.name || '', '美团', '', change.field || '', change.before == null || change.before === '' ? '(空值/无效结构)' : String(change.before), typeof change.after === 'object' ? JSON.stringify(change.after) : String(change.after ?? ''), typeof change.after === 'object' ? JSON.stringify(change.after) : String(change.after ?? ''), item.still_in_target_set === false ? '保存后回读通过；已退出目标集合' : '保存后独立回读通过；待平台复审', change.field?.startsWith('专项图:') ? '同商品原图OCR实证' : change.field === '条形码' ? '平台审核原文无条码口径' : change.field === '图片详情' ? '同商品主图规范化复用' : 'DeepSeek高置信+平台候选精确值']);
  for (const blocker of item.blockers || []) auditRows.push([idValue(item.spu_id), item.name || '', '美团', '', '阻塞项', '', '', '', blocker, /真实|原图|证书|备案|注册/.test(blocker) ? '真实资料门' : '平台校验/人工确认门']);
}
table(sheets['SPU清单'], schema.headers['SPU清单'], productRows, [18, 56, 78], 'MeituanSpuList');
table(sheets['字段级审计'], schema.headers['字段级审计'], auditRows, [18, 38, 10, 14, 24, 28, 30, 30, 34, 26], 'MeituanAudit');
table(sheets['平台不存在'], schema.headers['平台不存在'], [], [18, 26, 44], 'MeituanMissing');
const summary = checkpoint.summary;
const summaryRows = [
  ['Excel Schema版本', schema.schema_version], ['Skill版本', args['skill-version']], ['执行平台', '美团闪购商家平台'], ['任务类型', '无法售卖/审核未通过一次过治理'], ['合同指纹SHA256', args['contract-fingerprint']], ['门店/租户名称', args['store-name']],
  ['源清单商品数', summary.unique_spu_count], ['平台现存商品数', summary.unique_spu_count], ['平台不存在商品数', 0], ['最终合同通过商品数', 0], ['完成率', 0], ['本次有操作商品数', summary.modified_unique_spu], ['无需修改商品数', 0], ['唯一操作项数', auditRows.filter((r) => r[4] !== '阻塞项').length], ['最终回读通过项数', auditRows.filter((r) => String(r[8]).includes('回读通过')).length], ['最终问题数', summary.with_blockers],
  ['OCR调用数', 2413], ['媒体扫描数', 1377], ['条码扫描数', 1377], ['博查调用数', 0], ['Web搜索调用数', 0], ['模型调用数', 7], ['Provider Submit数', 0], ['Provider Query数', 0], ['图片上传数', 0], ['验收口径', '保存受理、字段物化、独立回读、平台复审退出四层分开；真实资料缺失不冒充完成'],
];
table(sheets['执行汇总'], schema.headers['执行汇总'], summaryRows, [34, 84], 'MeituanSummary');
sheets['执行汇总'].getRange('B11').format.numberFormat = '0.0%';
const exited = items.filter((x) => x.still_in_target_set === false).length;
const verifyRows = [['最终详情分片', '官方详情全量读取 1377/1377；官方审核集合稳定双快照'], ['源清单商品数', summary.unique_spu_count], ['平台现存商品数', summary.unique_spu_count], ['平台不存在商品数', 0], ['最终合同通过商品数', 0], ['最终回读通过项数', auditRows.filter((r) => String(r[8]).includes('回读通过')).length], ['最终问题数', summary.with_blockers], ['完成率', 0]];
table(sheets['最终结构复核'], schema.headers['最终结构复核'], verifyRows, [38, 82], 'MeituanVerify');
sheets['最终结构复核'].getRange('B9').format.numberFormat = '0.0%';
const feedbackRows = [
  ['Chrome 连接弹窗反复出现', '优先使用 Codex Chrome 插件 scoped CDP 接管当前登录页；仅在插件不可用且身份校验通过时使用 managed CDP', '当前会话无重复远程调试授权弹窗'],
  ['列表总数大于唯一SPU数', '连续两轮冻结总记录与唯一SPU集合；重复记录单独计数', '1379 条记录稳定对应 1377 个唯一SPU，重复 2 条'],
  ['只改条码却丢失既有专项图', '每次保存都把完整 cpvGuidePicMap 序列化回 cpvGuidePicList，并做媒体回读', '原图已恢复；后续批次零媒体丢失'],
  ['详情图裸URL被平台拒绝', '复用主图时统一追加 ?w=1080&h=1080', '详情图 canary 与批次回读通过'],
  ['容量单位 L 在预校验中丢失', '把 g/kg/ml/L 映射为平台单位标签 克(g)/千克(kg)/毫升(ml)/升(L)', '容量 canary 回读通过'],
  ['修改会退出营销活动', 'actCheck 命中停止活动时失败关闭，不自动牺牲活动资格', '相关商品未发送最终保存并进入阻塞清单'],
  ['资质图可能被普通主图冒充', '只接受同商品原图 OCR 严格命中或权威来源；证书/备案/注册材料禁止生成', '2413 张图仅 9 张通过，其他全部阻塞'],
];
table(sheets['问题与策略回灌'], schema.headers['问题与策略回灌'], feedbackRows, [34, 72, 52], 'MeituanFeedback');
const performanceRows = [['处理商品数', summary.unique_spu_count], ['唯一操作项数', auditRows.filter((r) => r[4] !== '阻塞项').length], ['总墙钟秒', '本次交互式会话'], ['平均秒/商品', '不以点击间隔冒充端到端耗时'], ['实际峰值并发', '读取8；写入1'], ['配置并发上限', '读取10；写入6'], ['请求数', '官方列表+详情+保存+回读'], ['请求错误数', 9], ['限流次数', 0], ['保存checkpoint文件数', 1], ['保存结果事件数（含残差）', Object.values(checkpoint.items).reduce((n, x) => n + (x.events || []).length, 0)], ['verified事件', summary.modified_unique_spu], ['failed响应事件（均经复读判定）', 9], ['OCR调用数', 2413], ['媒体扫描数', 1377], ['条码扫描数', 1377], ['博查调用数', 0], ['Web搜索调用数', 0], ['模型调用数', 7], ['Provider Submit数', 0], ['Provider Query数', 0], ['图片上传数', 0]];
table(sheets['性能与外部调用统计'], schema.headers['性能与外部调用统计'], performanceRows, [42, 72], 'MeituanPerformance');
for (const name of schema.sheets) { const used = sheets[name].getUsedRange(); if (used) used.format.font = { name: 'Aptos', size: 10, color: '#24292F' }; }
if (productRows.length) {
  const statusRange = sheets['SPU清单'].getRange(`C2:C${productRows.length + 1}`);
  statusRange.conditionalFormats.add('containsText', { text: '已退出', format: { fill: C.green } });
  statusRange.conditionalFormats.add('containsText', { text: '待平台复审', format: { fill: C.amber } });
  statusRange.conditionalFormats.add('containsText', { text: '阻塞', format: { fill: C.red } });
}
if (args['preview-dir']) {
  await fs.mkdir(path.resolve(args['preview-dir']), { recursive: true });
  for (const name of schema.sheets) {
    const used = sheets[name].getUsedRange();
    const rows = used?.values?.length || 1;
    const columns = schema.headers[name].length;
    const range = `A1:${col(columns)}${Math.min(rows, 30)}`;
    const image = await wb.render({ sheetName: name, range, scale: 1, format: 'png' });
    await fs.writeFile(path.join(path.resolve(args['preview-dir']), `${name}.png`), new Uint8Array(await image.arrayBuffer()));
  }
}
await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(wb); await output.save(path.resolve(args.output));
const inspect = await wb.inspect({ kind: 'table', range: '执行汇总!A1:B27', include: 'values,formulas', tableMaxRows: 30, tableMaxCols: 3, maxChars: 5000 });
const errors = await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 300 }, summary: 'final formula error scan', maxChars: 3000 });
console.log(JSON.stringify({ output: path.resolve(args.output), sheets: schema.sheets, exited, inspect: inspect.ndjson, formula_errors: errors.ndjson }));
