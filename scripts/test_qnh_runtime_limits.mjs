/**
 * 【业务说明书：牵牛花 Skill - Node 与 Chrome renderer 联合资源门校验脚本】
 * 建立时间：2026年
 * 核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
 * 1. 浏览器既有基线不得被误算成本批 worker 增量。
 * 2. Node 很小但 worker renderer 过大时必须降并发或回收。
 * 3. 无论是否授权，自适应并发只能按 1→2→4 阶梯推进，硬上限为 4。
 */
import assert from 'node:assert/strict';
import {
  effectiveRuntimeRssBytes,
  resolveDirectBatchConcurrency,
  resolveInitialRuntimeConcurrency,
  resolveProgressiveRuntimeConcurrency,
  resolveRuntimeConcurrencyCeiling,
  shouldRecycleRuntimeProcess,
  shouldCollectSingleWorkerRenderer,
  shouldRunSynchronousGc,
} from './qnh_runtime_limits.mjs';

const mib = 1024 * 1024;
const roomyHost = 10 * 1024 * 1024;
assert.equal(
  effectiveRuntimeRssBytes({ rss_bytes: 300 * mib, browser_worker_rss_bytes: 0 }),
  300 * mib,
);
assert.equal(
  effectiveRuntimeRssBytes({ rss_bytes: 300 * mib, browser_worker_rss_bytes: 2200 * mib }),
  2500 * mib,
);
assert.equal(resolveRuntimeConcurrencyCeiling(4, {
  rss_bytes: 300 * mib,
  browser_worker_rss_bytes: 2200 * mib,
  mem_available_kib: roomyHost,
}), 1);
assert.equal(shouldRecycleRuntimeProcess({
  rss_bytes: 300 * mib,
  browser_worker_rss_bytes: 2200 * mib,
  mem_available_kib: roomyHost,
}), true);
assert.equal(resolveRuntimeConcurrencyCeiling(4, {
  rss_bytes: 326 * mib,
  browser_worker_rss_bytes: 1590 * mib,
  mem_available_kib: 6 * 1024 * 1024,
}), 4);
assert.equal(shouldRecycleRuntimeProcess({
  rss_bytes: 326 * mib,
  browser_worker_rss_bytes: 1590 * mib,
  mem_available_kib: 6 * 1024 * 1024,
}), false);
assert.equal(resolveDirectBatchConcurrency(10, {}), 1);
assert.equal(resolveDirectBatchConcurrency(10, {
  QNH_DIRECT_ADAPTIVE_APPROVED: '1',
  QNH_DIRECT_MAX_CONCURRENCY: '10',
}), 4);
assert.equal(resolveInitialRuntimeConcurrency(4, { modernEditorPool: true }), 1);
assert.equal(resolveInitialRuntimeConcurrency(4, { modernEditorPool: false }), 1);
assert.equal(resolveInitialRuntimeConcurrency(1, { modernEditorPool: true }), 1);
assert.equal(resolveProgressiveRuntimeConcurrency(4, 0), 1);
assert.equal(resolveProgressiveRuntimeConcurrency(4, 2), 2);
assert.equal(resolveProgressiveRuntimeConcurrency(4, 10), 4);
assert.equal(shouldRunSynchronousGc({
  rss_bytes: 900 * mib,
  adaptive_approved: true,
  runtime_concurrency: 1,
}), true);
assert.equal(shouldRunSynchronousGc({
  rss_bytes: 900 * mib,
  adaptive_approved: true,
  runtime_concurrency: 2,
}), false);
assert.equal(shouldRunSynchronousGc({
  rss_bytes: 1700 * mib,
  adaptive_approved: true,
  runtime_concurrency: 1,
}), false);
assert.equal(shouldCollectSingleWorkerRenderer({
  adaptive_approved: true,
  runtime_concurrency: 1,
  performed_platform_work: true,
}), true);
assert.equal(shouldCollectSingleWorkerRenderer({
  adaptive_approved: true,
  runtime_concurrency: 2,
  performed_platform_work: true,
}), false);
assert.equal(shouldCollectSingleWorkerRenderer({
  adaptive_approved: true,
  runtime_concurrency: 1,
  performed_platform_work: false,
}), false);
process.stdout.write('qnh runtime resource contract: ok\n');
