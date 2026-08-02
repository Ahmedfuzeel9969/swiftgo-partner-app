/**
 * Phase 6 — breadcrumb uploader (one in flight, bounded backoff).
 * Firebase CDN imports stay inside defaultCall so Node unit tests can inject callSubmit.
 */

import {
  BREADCRUMB_DIAG,
  BREADCRUMB_FINAL_FLUSH_TIMEOUT_MS,
  BREADCRUMB_RETRY_BASE_MS,
  BREADCRUMB_RETRY_MAX_MS,
  BREADCRUMB_TARGET_BATCH_POINTS,
  BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS,
} from "./breadcrumb-schema.mjs";

/**
 * @param {{
 *   queue: ReturnType<typeof import('./breadcrumb-queue.mjs').createBreadcrumbQueue>,
 *   getBinding: () => object|null,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   onDiag?: (code: string) => void,
 *   callSubmit?: (batch: object) => Promise<object>,
 * }} opts
 */
export function createBreadcrumbUploader(opts) {
  const queue = opts.queue;
  const getBinding = opts.getBinding;
  const nowMs = opts.nowMs || (() => Date.now());
  const setT = opts.setTimeoutFn || setTimeout;
  const clearT = opts.clearTimeoutFn || clearTimeout;
  const diag = opts.onDiag || (() => {});

  let inFlight = false;
  let timer = 0;
  let failStreak = 0;
  let lastUploadAt = 0;
  let closed = false;

  const counters = {
    uploadsStarted: 0,
    uploadsAcked: 0,
    uploadsFailed: 0,
    retriesScheduled: 0,
  };

  async function defaultCall(batch) {
    const { httpsCallable } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js"
    );
    const { getFirebase } = await import("./firebase.js");
    const { ready, functions } = getFirebase();
    if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
    const res = await httpsCallable(functions, "submitRideBreadcrumbBatch")({ batch });
    return res?.data || res;
  }

  const callSubmit = opts.callSubmit || defaultCall;

  function schedule(ms) {
    if (closed) return;
    if (timer) clearT(timer);
    const delay = Math.max(0, Number(ms) || BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS);
    timer = setT(() => {
      timer = 0;
      void tick({ reason: "timer" });
    }, delay);
  }

  function backoffMs() {
    const exp = Math.min(
      BREADCRUMB_RETRY_MAX_MS,
      BREADCRUMB_RETRY_BASE_MS * 2 ** Math.max(0, failStreak - 1)
    );
    const jitter = Math.floor(Math.random() * 400);
    return exp + jitter;
  }

  async function uploadOldest(binding, { force = false } = {}) {
    if (closed || inFlight || !binding) return { ok: false, reason: "busy_or_closed" };
    // Claim the flight slot before any await to prevent concurrent uploads.
    inFlight = true;
    try {
      let batch = await queue.peekOldestBatch(binding);
      if (!batch) {
        const batchResult = await queue.takeBatch(binding, {
          force,
          maxPoints: BREADCRUMB_TARGET_BATCH_POINTS,
        });
        if (!batchResult.ok) return batchResult;
        batch = batchResult.batch;
      }
      counters.uploadsStarted += 1;
      diag(BREADCRUMB_DIAG.BATCH_UPLOAD_STARTED);
      try {
        const ack = await callSubmit(batch);
        if (ack?.acknowledged || ack?.ok) {
          await queue.acknowledgeBatch(binding, batch.batchSequence);
          counters.uploadsAcked += 1;
          failStreak = 0;
          lastUploadAt = nowMs();
          diag(BREADCRUMB_DIAG.BATCH_ACKNOWLEDGED);
          return { ok: true, ack };
        }
        throw new Error("NO_ACK");
      } catch (err) {
        counters.uploadsFailed += 1;
        failStreak += 1;
        counters.retriesScheduled += 1;
        diag(BREADCRUMB_DIAG.BATCH_RETRY_SCHEDULED);
        schedule(backoffMs());
        return { ok: false, error: err };
      }
    } finally {
      inFlight = false;
    }
  }

  async function tick({ reason = "", force = false } = {}) {
    void reason;
    if (closed) return;
    const binding = getBinding();
    if (!binding) {
      schedule(BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS);
      return;
    }
    const count = await queue.pointCount(binding);
    const intervalDue = nowMs() - lastUploadAt >= BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS;
    const sizeDue = count >= BREADCRUMB_TARGET_BATCH_POINTS;
    const pending = await queue.peekOldestBatch(binding);
    const due = force || sizeDue || intervalDue || Boolean(pending);
    if (due) {
      await uploadOldest(binding, { force: force || sizeDue || intervalDue });
      // Drain pending sequentially if more ready (one in flight per call).
      while (!closed && (await queue.peekOldestBatch(binding))) {
        const r = await uploadOldest(binding, { force: true });
        if (!r.ok) break;
      }
    }
    schedule(BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS);
  }

  function start() {
    closed = false;
    lastUploadAt = nowMs();
    schedule(BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS);
  }

  function stop() {
    closed = true;
    if (timer) clearT(timer);
    timer = 0;
  }

  async function flushBounded(timeoutMs = BREADCRUMB_FINAL_FLUSH_TIMEOUT_MS) {
    const binding = getBinding();
    if (!binding) return { ok: false, reason: "no_binding" };
    const started = nowMs();
    // Force form a batch from remaining points
    await queue.takeBatch(binding, { force: true, maxPoints: BREADCRUMB_TARGET_BATCH_POINTS });
    while (nowMs() - started < timeoutMs) {
      const pending = await queue.peekOldestBatch(binding);
      const count = await queue.pointCount(binding);
      if (!pending && count === 0) return { ok: true };
      if (pending) {
        const r = await uploadOldest(binding, { force: true });
        if (!r.ok) {
          diag(BREADCRUMB_DIAG.FINAL_FLUSH_TIMEOUT);
          return { ok: false, reason: "upload_failed" };
        }
      } else if (count > 0) {
        await queue.takeBatch(binding, { force: true, maxPoints: BREADCRUMB_TARGET_BATCH_POINTS });
      } else {
        break;
      }
    }
    const left = (await queue.pointCount(binding)) + ((await queue.peekOldestBatch(binding)) ? 1 : 0);
    if (left > 0) diag(BREADCRUMB_DIAG.FINAL_FLUSH_TIMEOUT);
    return { ok: left === 0, remaining: left };
  }

  return {
    start,
    stop,
    tick,
    flushBounded,
    isInFlight: () => inFlight,
    getCounters: () => ({ ...counters }),
  };
}
