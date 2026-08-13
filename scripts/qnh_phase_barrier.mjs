#!/usr/bin/env node

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A preparation failure can abort the save gate before any worker reaches
  // it. Attach a passive handler so that deliberate fail-closed cancellation
  // never becomes an unhandled rejection; callers still observe rejection
  // when they await the original promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function createPreparedSaveBarrier(expectedCount, hooks = {}) {
  const expected = Number(expectedCount);
  if (!Number.isInteger(expected) || expected < 1 || expected > 10) {
    throw new Error('prepared_save_barrier_expected_count_must_be_between_1_and_10');
  }
  const preparedGate = deferred();
  const saveGate = deferred();
  const preparedReceipts = [];
  const saveReceipts = [];
  let aborted = false;
  let preparedReleaseAt = 0;
  let saveReleaseAt = 0;

  const releasePreparedIfComplete = async () => {
    if (preparedReceipts.length !== expected || aborted) return;
    try {
      await hooks.onAllPrepared?.([...preparedReceipts]);
      preparedReleaseAt = Date.now();
      preparedGate.resolve();
    } catch (error) {
      aborted = true;
      preparedGate.reject(error);
      saveGate.reject(error);
    }
  };

  const releaseSavesIfComplete = async () => {
    if (saveReceipts.length !== expected || aborted) return;
    try {
      saveReleaseAt = Date.now();
      await hooks.onAllSavesSettled?.([...saveReceipts]);
      saveGate.resolve();
    } catch (error) {
      aborted = true;
      saveGate.reject(error);
    }
  };

  return {
    async arrivePrepared(receipt) {
      if (aborted) return preparedGate.promise;
      preparedReceipts.push(receipt);
      if (preparedReceipts.length > expected) {
        this.abort(new Error('prepared_save_barrier_prepared_overflow'));
      } else {
        void releasePreparedIfComplete();
      }
      return preparedGate.promise;
    },
    async arriveSaveSettled(receipt) {
      if (aborted) return saveGate.promise;
      saveReceipts.push(receipt);
      if (saveReceipts.length > expected) {
        this.abort(new Error('prepared_save_barrier_save_overflow'));
      } else {
        void releaseSavesIfComplete();
      }
      return saveGate.promise;
    },
    abort(error) {
      if (aborted) return;
      aborted = true;
      const reason = error instanceof Error ? error : new Error(String(error));
      preparedGate.reject(reason);
      saveGate.reject(reason);
    },
    metrics() {
      return {
        expected_count: expected,
        prepared_count: preparedReceipts.length,
        save_settled_count: saveReceipts.length,
        prepared_release_at_ms: preparedReleaseAt || null,
        save_release_at_ms: saveReleaseAt || null,
        save_burst_ms: preparedReleaseAt && saveReleaseAt
          ? Math.max(0, saveReleaseAt - preparedReleaseAt)
          : null,
        aborted,
      };
    },
  };
}
