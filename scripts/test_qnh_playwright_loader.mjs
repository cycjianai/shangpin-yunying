import assert from 'node:assert/strict';
import { loadChromium, playwrightCoreCandidates } from './qnh_playwright_loader.mjs';

const candidates = playwrightCoreCandidates();
assert.ok(candidates.length >= 1);
assert.equal(new Set(candidates).size, candidates.length);

const chromium = await loadChromium();
assert.equal(typeof chromium.connectOverCDP, 'function');

process.stdout.write(`${JSON.stringify({ passed: true, candidate_count: candidates.length })}\n`);
