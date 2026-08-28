import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function playwrightCoreCandidates() {
  return [
    process.env.QNH_PLAYWRIGHT_CORE_PATH || '',
    path.resolve(path.dirname(process.execPath), '..', 'node_modules/playwright-core/index.mjs'),
    path.resolve(process.cwd(), 'node_modules/playwright-core/index.mjs'),
    '/home/ubuntu/e2e-browser-lab/node_modules/playwright-core/index.mjs',
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

export async function loadChromium() {
  const attempted = [];
  for (const candidate of playwrightCoreCandidates()) {
    attempted.push(candidate);
    try {
      await fs.access(candidate);
      const module = await import(pathToFileURL(candidate).href);
      if (module.chromium && typeof module.chromium.connectOverCDP === 'function') {
        return module.chromium;
      }
    } catch {
      // Try the next frozen local runtime candidate without network installation.
    }
  }
  throw new Error(`playwright_core_not_found:${attempted.join(',')}`);
}
