export const MAX_QNH_MUTATION_WINDOW = 50;

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function buildMutationWindows(total, maximum = MAX_QNH_MUTATION_WINDOW) {
  const normalizedTotal = nonNegativeInteger(total);
  const normalizedMaximum = nonNegativeInteger(maximum);
  if (normalizedMaximum < 1 || normalizedMaximum > MAX_QNH_MUTATION_WINDOW) {
    throw new Error(`qnh_batch_window_limit_exceeded:${normalizedMaximum}`);
  }
  const windows = [];
  for (let offset = 0; offset < normalizedTotal; offset += normalizedMaximum) {
    windows.push({
      offset,
      limit: Math.min(normalizedMaximum, normalizedTotal - offset),
      index: windows.length + 1,
    });
  }
  return windows;
}

export function selectReadyMutationWindow(rows, offset = 0, limit = MAX_QNH_MUTATION_WINDOW) {
  const normalizedOffset = nonNegativeInteger(offset);
  const normalizedLimit = Number(limit) > 0
    ? nonNegativeInteger(limit)
    : MAX_QNH_MUTATION_WINDOW;
  if (normalizedLimit < 1 || normalizedLimit > MAX_QNH_MUTATION_WINDOW) {
    throw new Error(`qnh_batch_window_limit_exceeded:${normalizedLimit}`);
  }
  const readyRows = (Array.isArray(rows) ? rows : []).filter(
    (row) => row?.status === 'ready' && row?.plan_path,
  );
  return readyRows.slice(normalizedOffset, normalizedOffset + normalizedLimit);
}
