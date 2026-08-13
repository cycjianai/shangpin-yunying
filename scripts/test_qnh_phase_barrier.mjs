#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createPreparedSaveBarrier } from './qnh_phase_barrier.mjs';

const events = [];
const preparedReceipts = [];
const barrier = createPreparedSaveBarrier(3, {
  async onAllPrepared(receipts) {
    preparedReceipts.push(...receipts);
    events.push('all_prepared');
  },
  async onAllSavesSettled(receipts) {
    events.push(`all_saves_settled:${receipts.length}`);
  },
});

const worker = async (id, prepareDelay, saveDelay) => {
  await new Promise((resolve) => setTimeout(resolve, prepareDelay));
  events.push(`prepared:${id}`);
  await barrier.arrivePrepared({ id });
  events.push(`save_started:${id}`);
  await new Promise((resolve) => setTimeout(resolve, saveDelay));
  events.push(`save_finished:${id}`);
  await barrier.arriveSaveSettled({ id, ok: true });
  events.push(`verify_started:${id}`);
};

await Promise.all([
  worker('a', 15, 8),
  worker('b', 5, 12),
  worker('c', 10, 4),
]);

const allPreparedIndex = events.indexOf('all_prepared');
const firstSaveIndex = events.findIndex((event) => event.startsWith('save_started:'));
const allSavesSettledIndex = events.findIndex((event) => event.startsWith('all_saves_settled:'));
const firstVerifyIndex = events.findIndex((event) => event.startsWith('verify_started:'));

assert.equal(preparedReceipts.length, 3);
assert.ok(allPreparedIndex >= 0);
assert.ok(firstSaveIndex > allPreparedIndex);
assert.ok(allSavesSettledIndex >= 0);
assert.ok(firstVerifyIndex > allSavesSettledIndex);
assert.equal(barrier.metrics().prepared_count, 3);
assert.equal(barrier.metrics().save_settled_count, 3);
assert.ok(barrier.metrics().save_burst_ms >= 0);

const aborted = createPreparedSaveBarrier(2);
const waiting = aborted.arrivePrepared({ id: 'waiting' });
aborted.abort(new Error('prepare failed'));
await assert.rejects(waiting, /prepare failed/);

console.log(JSON.stringify({ ok: true, events, metrics: barrier.metrics() }));
