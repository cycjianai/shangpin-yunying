export async function prewarmQnhWorkerPage(
  workerPage,
  { listPageUrl, timeoutMs = 45000 } = {},
) {
  if (!listPageUrl) throw new Error('worker 预热缺少列表页 URL');
  await workerPage.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'media', 'font'].includes(resourceType)) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  await workerPage.goto(listPageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  await workerPage.waitForFunction(
    () => Boolean(window.H5guard && typeof window.H5guard.sign === 'function'),
    null,
    { timeout: timeoutMs },
  );
  // A newly-created tab can inherit the authenticated SPA runtime and expose
  // H5guard before the optional list-tab shell mounts.  Requiring
  // #multiple-nav-tabs here created false 45-second failures.  This does not
  // weaken mutation safety: every product immediately navigates to its exact
  // edit route and must capture a native detail response whose page route,
  // request body SPU and response profile all match before any save can run.
  await workerPage.waitForTimeout(300);
}

export async function bootstrapQnhWorkerPool(
  browserContext,
  { listPageUrl, timeoutMs = 45000, settleMs = 10000 } = {},
) {
  const bootstrapPage = await browserContext.newPage();
  const startedAt = Date.now();
  try {
    await prewarmQnhWorkerPage(bootstrapPage, { listPageUrl, timeoutMs });
    await bootstrapPage.waitForTimeout(settleMs);
    return {
      completed: true,
      elapsed_ms: Date.now() - startedAt,
      settle_ms: settleMs,
    };
  } finally {
    await bootstrapPage.close().catch(() => {});
  }
}
