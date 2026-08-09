import process from 'node:process';

export const QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY = 2;
export const QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY = 10;
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

export function resolveRuntimeConcurrencyCeiling(
  configuredConcurrency,
  metrics = {},
  previousCeiling = configuredConcurrency,
) {
  const configured = Math.max(1, Math.min(
    QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY,
    positiveInteger(configuredConcurrency, QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY),
  ));
  const rssBytes = Number(metrics?.rss_bytes || 0);
  const memAvailableKib = Number(metrics?.mem_available_kib || 0);
  let ceiling = configured;
  if (rssBytes >= 1600 * MIB || (memAvailableKib > 0 && memAvailableKib < 7 * GIB / 1024)) {
    ceiling = 1;
  } else if (
    rssBytes >= 700 * MIB
    || (memAvailableKib > 0 && memAvailableKib < 8 * GIB / 1024)
  ) {
    ceiling = Math.min(ceiling, 2);
  } else if (memAvailableKib > 0 && memAvailableKib < 9 * GIB / 1024) {
    ceiling = Math.min(ceiling, 4);
  }
  return Math.max(1, Math.min(
    configured,
    positiveInteger(previousCeiling, configured),
    ceiling,
  ));
}

export function shouldRecycleRuntimeProcess(metrics = {}) {
  const rssBytes = Number(metrics?.rss_bytes || 0);
  const memAvailableKib = Number(metrics?.mem_available_kib || 0);
  return (
    rssBytes >= 1600 * MIB
    || (memAvailableKib > 0 && memAvailableKib < 7 * GIB / 1024)
  );
}

export function resolveProgressiveRuntimeConcurrency(configuredConcurrency, completedCount) {
  const configured = Math.max(1, Math.min(
    QNH_DIRECT_ADAPTIVE_MAX_CONCURRENCY,
    positiveInteger(configuredConcurrency, QNH_DIRECT_SAFE_DEFAULT_CONCURRENCY),
  ));
  const completed = Math.max(0, Number(completedCount) || 0);
  let stageCeiling = 2;
  if (completed >= 30) stageCeiling = 10;
  else if (completed >= 20) stageCeiling = 8;
  else if (completed >= 10) stageCeiling = 6;
  else if (completed >= 2) stageCeiling = 4;
  return Math.max(1, Math.min(configured, stageCeiling));
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
