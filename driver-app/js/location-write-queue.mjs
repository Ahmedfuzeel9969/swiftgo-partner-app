/**
 * Single in-flight vehicle location write with newest-pending coalesce.
 * No unbounded queue: at most one active write + one newest pending fix.
 */

/**
 * @typedef {{
 *   generation: number,
 *   sessionId: string,
 *   stampSessionStart: boolean,
 *   envelope: object,
 *   payload: object,
 * }} LocationWriteJob
 */

/**
 * @param {{
 *   writeFn: (job: LocationWriteJob) => Promise<void>,
 *   isCancelled?: (generation: number) => boolean,
 *   onAfterDrainBeforeClear?: () => void,
 * }} deps
 */
export function createLocationWriteSerializer(deps) {
  const writeFn = deps.writeFn;
  const isCancelled =
    typeof deps.isCancelled === "function" ? deps.isCancelled : () => false;
  const onAfterDrainBeforeClear =
    typeof deps.onAfterDrainBeforeClear === "function"
      ? deps.onAfterDrainBeforeClear
      : null;

  /** @type {Promise<void>|null} */
  let inFlight = null;
  /** @type {LocationWriteJob|null} */
  let pending = null;
  let sessionStartStamped = false;
  let writesStarted = 0;
  let writesCompleted = 0;

  function clearPending() {
    pending = null;
  }

  function cancelAll() {
    pending = null;
    // inFlight may still resolve; writeFn must check generation/cancel.
  }

  function markSessionStartComplete() {
    sessionStartStamped = true;
  }

  function resetSessionStartGate() {
    sessionStartStamped = false;
  }

  function getStats() {
    return {
      inFlight: Boolean(inFlight),
      hasPending: Boolean(pending),
      sessionStartStamped,
      writesStarted,
      writesCompleted,
    };
  }

  /**
   * Enqueue a location write. If one is in flight, keep only the newest pending job.
   * Always parks the job in `pending` first so a completion-boundary enqueue
   * (after the drain loop sees null pending but before inFlight is cleared)
   * cannot strand the newest fix.
   * @param {LocationWriteJob} job
   * @returns {Promise<void>}
   */
  function enqueue(job) {
    if (!job || typeof writeFn !== "function") return Promise.resolve();
    if (isCancelled(job.generation)) return Promise.resolve();

    // Newest-wins pending slot (overwrites any older pending).
    pending = job;

    if (inFlight) return inFlight;

    inFlight = (async () => {
      for (;;) {
        const current = pending;
        pending = null;
        if (!current) break;
        if (isCancelled(current.generation)) continue;

        writesStarted += 1;
        try {
          const toWrite = {
            ...current,
            stampSessionStart: Boolean(current.stampSessionStart) && !sessionStartStamped,
          };
          await writeFn(toWrite);
          writesCompleted += 1;
          if (toWrite.stampSessionStart) {
            sessionStartStamped = true;
          }
        } catch (err) {
          // Propagate only if nothing pending; otherwise try newest pending.
          if (!pending) throw err;
        }
      }
      // Test/production hook: runs after drain sees null pending while inFlight
      // is still set — the exact completion-boundary window.
      if (onAfterDrainBeforeClear) {
        try {
          onAfterDrainBeforeClear();
        } catch {
          /* ignore hook errors */
        }
      }
    })().finally(() => {
      inFlight = null;
      // Completion boundary: a job may have landed in pending after the loop
      // observed null but before inFlight was cleared.
      if (!pending) return;
      if (isCancelled(pending.generation)) {
        pending = null;
        return;
      }
      enqueue(pending);
    });

    return inFlight;
  }

  return {
    enqueue,
    clearPending,
    cancelAll,
    markSessionStartComplete,
    resetSessionStartGate,
    getStats,
  };
}
