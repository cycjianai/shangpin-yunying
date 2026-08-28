/**
 * Decide how a direct-batch row should be handled when a checkpoint already
 * contains a terminal-looking row for the same SPU.
 *
 * Keep this policy pure so dry-run and mutation resume semantics cannot drift
 * inside the browser orchestration loop.
 */
export function checkpointResumeDisposition({ priorStatus = '', dryRun = false } = {}) {
  const status = String(priorStatus || '');
  if (dryRun && status === 'previewed') return 'reuse_terminal';
  if (dryRun && status === 'failed') return 'process';
  if (status === 'no_change') return 'reuse_terminal';
  if (status === 'failed') return 'defer_to_readback';
  return 'process';
}
