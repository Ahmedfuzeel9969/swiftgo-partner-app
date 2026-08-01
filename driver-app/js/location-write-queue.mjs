/**
 * Single in-flight vehicle location write with newest-pending coalesce.
 * No unbounded queue: at most one active write + one pending fix.
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
 * }} deps
 */
export function createLocationWriteSerializer(deps) {
  const writeFn = deps.writeFn;
  const isCancelled =
    typeof deps.isCancelled === "function" ? deps.isCancelled : () => false;

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
   * @param {LocationWriteJob} job
   * @returns {Promise<void>}
   */
  function enqueue(job) {
    if (!job || typeof writeFn !== "function") return Promise.resolve();
    if (isCancelled(job.generation)) return Promise.resolve();

    // Coalesce: always keep the newest pending when busy.
    if (inFlight) {
      pending = job;
      return inFlight;
    }

    const runLoop = async () => {
      let current = job;
      while (current) {
        if (isCancelled(current.generation)) {
          current = pending;
          pending = null;
          continue;
        }
        writesStarted += 1;
        try {
          // Only the first successful session-start write stamps the server start.
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
        current = pending;
        pending = null;
      }
    };

    inFlight = runLoop().finally(() => {
      inFlight = null;
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
