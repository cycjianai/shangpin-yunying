/**
 * 【业务说明书：牵牛花 Skill - 50 SPU 硬分片与偏移窗口校验脚本】
 * 建立时间：2026年
 * 核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
 * 1. 单个 mutation 子进程最多接收 50 个 ready SPU。
 * 2. offset 必须基于稳定 ready 序列，窗口之间不能重复或遗漏。
 * 3. 超过 50 的显式 limit 必须在连接平台前失败关闭。
 */
import assert from 'node:assert/strict';
import {
  MAX_QNH_MUTATION_WINDOW,
  buildMutationWindows,
  selectReadyMutationWindow,
} from './qnh_batch_window.mjs';

const rows = Array.from({ length: 1500 }, (_, index) => ({
  spu_id: String(index + 1),
  status: index < 1494 ? 'ready' : 'blocked',
  plan_path: index < 1494 ? `/plans/${index + 1}.json` : '',
}));

assert.equal(MAX_QNH_MUTATION_WINDOW, 50);
const windows = buildMutationWindows(1494);
assert.equal(windows.length, 30);
assert.deepEqual(windows[0], { offset: 0, limit: 50, index: 1 });
assert.deepEqual(windows.at(-1), { offset: 1450, limit: 44, index: 30 });

const selected = windows.flatMap(({ offset, limit }) => (
  selectReadyMutationWindow(rows, offset, limit).map((row) => row.spu_id)
));
assert.equal(selected.length, 1494);
assert.equal(new Set(selected).size, 1494);
assert.equal(selected[0], '1');
assert.equal(selected.at(-1), '1494');
assert.throws(
  () => selectReadyMutationWindow(rows, 0, 51),
  /qnh_batch_window_limit_exceeded/,
);
process.stdout.write('qnh batch window contract: ok\n');
