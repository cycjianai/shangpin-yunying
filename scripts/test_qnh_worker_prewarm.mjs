#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  bootstrapQnhWorkerPool,
  prewarmQnhWorkerPage,
} from './qnh_worker_prewarm.mjs';

const calls = [];
const fakePage = {
  async route() { calls.push('route'); },
  async goto() { calls.push('goto'); },
  async waitForFunction() { calls.push('h5guard'); },
  locator() {
    calls.push('optional_shell_probe');
    return {
      async waitFor() {
        throw new Error('optional list shell never mounted');
      },
    };
  },
  async waitForTimeout() { calls.push('settle'); },
};

await prewarmQnhWorkerPage(fakePage, {
  listPageUrl: 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list',
  timeoutMs: 1,
});

assert.deepEqual(calls, ['route', 'goto', 'h5guard', 'settle']);

const bootstrapCalls = [];
const bootstrapPage = {
  async route() { bootstrapCalls.push('route'); },
  async goto() { bootstrapCalls.push('goto'); },
  async waitForFunction() { bootstrapCalls.push('h5guard'); },
  async waitForTimeout(milliseconds) { bootstrapCalls.push(`wait:${milliseconds}`); },
  async close() { bootstrapCalls.push('close'); },
};
const browserContext = {
  async newPage() {
    bootstrapCalls.push('new_page');
    return bootstrapPage;
  },
};
const bootstrap = await bootstrapQnhWorkerPool(browserContext, {
  listPageUrl: 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list',
  timeoutMs: 1,
  settleMs: 10000,
});
assert.equal(bootstrap.completed, true);
assert.deepEqual(bootstrapCalls, [
  'new_page',
  'route',
  'goto',
  'h5guard',
  'wait:300',
  'wait:10000',
  'close',
]);

console.log(JSON.stringify({ ok: true, calls, bootstrap_calls: bootstrapCalls }));
