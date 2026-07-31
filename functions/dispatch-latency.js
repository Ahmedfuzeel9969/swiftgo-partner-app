/**
 * Server-side dispatch pipeline timing (structured logs for latency audit).
 */

"use strict";

function createDispatchTimer(label, rideId = "") {
  const t0 = Date.now();
  const marks = [];
  return {
    mark(name, extra = {}) {
      const ms = Date.now() - t0;
      marks.push({ name, ms });
      console.log(
        JSON.stringify({
          type: "dispatch_latency",
          side: "server",
          label,
          rideId: rideId || undefined,
          mark: name,
          ms,
          ...extra,
        })
      );
      return ms;
    },
    finish(extra = {}) {
      const totalMs = Date.now() - t0;
      const payload = {
        type: "dispatch_latency",
        side: "server",
        label,
        rideId: rideId || undefined,
        totalMs,
        marks,
        ...extra,
      };
      console.log(JSON.stringify(payload));
      return payload;
    },
  };
}

class DispatchTimeoutError extends Error {
  constructor(ms, label) {
    super(`${label || "dispatch"}_timeout_${ms}ms`);
    this.name = "DispatchTimeoutError";
    this.code = "dispatch-timeout";
    this.timeoutMs = ms;
  }
}

/**
 * Fail fast before Cloud Run / gateway 504 when matching or reconcile hangs.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms=15000]
 * @param {string} [label="dispatch"]
 * @returns {Promise<T>}
 */
function withDispatchTimeout(promise, ms = 15000, label = "dispatch") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DispatchTimeoutError(ms, label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = { createDispatchTimer, withDispatchTimeout, DispatchTimeoutError };
