#!/usr/bin/env node

import assert from 'node:assert/strict';
import { checkpointResumeDisposition } from './qnh_batch_resume.mjs';

assert.equal(
  checkpointResumeDisposition({ priorStatus: 'previewed', dryRun: true }),
  'reuse_terminal',
  'dry-run 已通过项必须复用，不能再次打开页面',
);
assert.equal(
  checkpointResumeDisposition({ priorStatus: 'failed', dryRun: true }),
  'process',
  'dry-run 无平台副作用，失败项必须允许补检',
);
assert.equal(
  checkpointResumeDisposition({ priorStatus: 'failed', dryRun: false }),
  'defer_to_readback',
  'mutation 失败项必须等待独立回读，不能盲目重发',
);
assert.equal(
  checkpointResumeDisposition({ priorStatus: 'no_change', dryRun: false }),
  'reuse_terminal',
);

console.log(JSON.stringify({ ok: true, checks: 4 }));
