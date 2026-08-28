import process from 'node:process';

export const QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY = 1;
export const QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY = 4;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function resolveDirectBatchConcurrency(requested, environment = process.env) {
  const adaptiveApproved = environment?.QNH_DIRECT_ADAPTIVE_APPROVED === '1';
  const absoluteMaximum = adaptiveApproved
    ? QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY
    : QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY;
  const configuredMaximum = Math.min(
    absoluteMaximum,
    positiveInteger(
      environment?.QNH_DIRECT_MAX_CONCURRENCY,
      QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY,
    ),
  );
  return Math.min(
    configuredMaximum,
    positiveInteger(requested, configuredMaximum),
  );
}

export function effectiveRuntimeRssBytes(metrics = {}) {
  return Math.max(0, Number(metrics?.rss_bytes || 0))
    + Math.max(0, Number(metrics?.browser_worker_rss_bytes || 0));
}

export function resolveRuntimeConcurrencyCeiling(
  configuredConcurrency,
  metrics = {},
  previousCeiling = configuredConcurrency,
) {
  const configured = Math.max(1, Math.min(
    QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY,
    positiveInteger(configuredConcurrency, QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY),
  ));
  const rssBytes = effectiveRuntimeRssBytes(metrics);
  const memAvailableKib = Number(metrics?.mem_available_kib || 0);
  let ceiling = configured;
  if (rssBytes >= 2400 * MIB || (memAvailableKib > 0 && memAvailableKib < 5 * GIB / 1024)) {
    ceiling = 1;
  } else if (rssBytes >= 2100 * MIB || (memAvailableKib > 0 && memAvailableKib < 5.5 * GIB / 1024)) {
    ceiling = Math.min(ceiling, 2);
  } else if (rssBytes >= 1600 * MIB || (memAvailableKib > 0 && memAvailableKib < 6 * GIB / 1024)) {
    ceiling = Math.min(ceiling, 4);
  }
  return Math.max(1, Math.min(
    configured,
    positiveInteger(previousCeiling, configured),
    ceiling,
  ));
}

export function shouldRecycleRuntimeProcess(metrics = {}) {
  const rssBytes = effectiveRuntimeRssBytes(metrics);
  const memAvailableKib = Number(metrics?.mem_available_kib || 0);
  return (
    rssBytes >= 2400 * MIB
    || (memAvailableKib > 0 && memAvailableKib < 5 * GIB / 1024)
  );
}

export function shouldRunSynchronousGc(metrics = {}) {
  const rssBytes = Math.max(0, Number(metrics?.rss_bytes || 0));
  if (rssBytes === 0 || rssBytes >= 1600 * MIB) return false;
  const adaptiveApproved = metrics?.adaptive_approved === true;
  const runtimeConcurrency = positiveInteger(metrics?.runtime_concurrency, 1);
  // Concurrent responses may still be materialising while another worker
  // returns. A synchronous full-heap GC is therefore safe in adaptive mode
  // only after the controller has converged to one active worker.
  return !adaptiveApproved || runtimeConcurrency === 1;
}

export function shouldCollectSingleWorkerRenderer(metrics = {}) {
  return (
    metrics?.adaptive_approved === true
    && positiveInteger(metrics?.runtime_concurrency, 1) === 1
    && metrics?.performed_platform_work === true
  );
}

export function resolveProgressiveRuntimeConcurrency(configuredConcurrency, completedCount) {
  const configured = Math.max(1, Math.min(
    QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY,
    positiveInteger(configuredConcurrency, QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY),
  ));
  const completed = Math.max(0, Number(completedCount) || 0);
  let stageCeiling = 1;
  if (completed >= 10) stageCeiling = 4;
  else if (completed >= 2) stageCeiling = 2;
  return Math.max(1, Math.min(configured, stageCeiling));
}

export function resolveInitialRuntimeConcurrency(
  configuredConcurrency,
  { modernEditorPool = false } = {},
) {
  const configured = Math.max(1, Math.min(
    QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY,
    positiveInteger(configuredConcurrency, QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY),
  ));
  return 1;
}

export function assertManagedDirectBatchRuntime(environment = process.env) {
  if (environment?.YDSG_AUTOMATION_MANAGED === '1') return;
  const error = new Error(
    'qnh_managed_runtime_required: 请通过 scripts/run_qnh_batch.sh 启动批处理',
  );
  error.code = 'qnh_managed_runtime_required';
  error.exitCode = 79;
  throw error;
}
