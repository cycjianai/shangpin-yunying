import fs from 'node:fs/promises';

function parseRssKib(status) {
  const match = String(status || '').match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) : 0;
}

export function rendererWorkerRssDeltaBytes(baselineBytes, currentBytes) {
  return Math.max(0, Number(currentBytes || 0) - Number(baselineBytes || 0));
}

async function processRssBytes(pid) {
  try {
    const status = await fs.readFile(`/proc/${Number(pid)}/status`, 'utf8');
    return parseRssKib(status) * 1024;
  } catch {
    return 0;
  }
}

export async function createBrowserResourceMonitor(browser) {
  if (!browser || typeof browser.newBrowserCDPSession !== 'function') {
    return {
      available: false,
      baseline: { renderer_rss_bytes: 0, browser_total_rss_bytes: 0 },
      sample: async () => ({
        available: false,
        renderer_rss_bytes: 0,
        browser_total_rss_bytes: 0,
        worker_renderer_rss_bytes: 0,
        renderer_processes: 0,
      }),
      close: async () => {},
    };
  }
  let session;
  try {
    session = await browser.newBrowserCDPSession();
    const rawSample = async () => {
      const processInfo = await session.send('SystemInfo.getProcessInfo');
      const rows = Array.isArray(processInfo?.processInfo) ? processInfo.processInfo : [];
      const rssRows = await Promise.all(rows.map(async (row) => ({
        type: String(row?.type || ''),
        rss_bytes: await processRssBytes(row?.id),
      })));
      return {
        available: true,
        renderer_rss_bytes: rssRows
          .filter((row) => row.type === 'renderer')
          .reduce((sum, row) => sum + row.rss_bytes, 0),
        browser_total_rss_bytes: rssRows.reduce((sum, row) => sum + row.rss_bytes, 0),
        renderer_processes: rssRows.filter((row) => row.type === 'renderer').length,
      };
    };
    const baseline = await rawSample();
    return {
      available: true,
      baseline,
      sample: async () => {
        try {
          const current = await rawSample();
          return {
            ...current,
            worker_renderer_rss_bytes: rendererWorkerRssDeltaBytes(
              baseline.renderer_rss_bytes,
              current.renderer_rss_bytes,
            ),
          };
        } catch {
          return {
            available: false,
            renderer_rss_bytes: 0,
            browser_total_rss_bytes: 0,
            worker_renderer_rss_bytes: 0,
            renderer_processes: 0,
          };
        }
      },
      close: async () => {
        try { await session.detach(); } catch { /* Browser may already be disconnected. */ }
      },
    };
  } catch {
    try { await session?.detach(); } catch { /* Best-effort cleanup. */ }
    return {
      available: false,
      baseline: { renderer_rss_bytes: 0, browser_total_rss_bytes: 0 },
      sample: async () => ({
        available: false,
        renderer_rss_bytes: 0,
        browser_total_rss_bytes: 0,
        worker_renderer_rss_bytes: 0,
        renderer_processes: 0,
      }),
      close: async () => {},
    };
  }
}
