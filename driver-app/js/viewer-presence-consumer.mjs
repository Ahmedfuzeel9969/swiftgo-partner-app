/**
 * Phase 2 — document-specific viewer presence consumer for the assigned active ride.
 * Never collection-wide. Local expiry timer flips lease without a final close write.
 */

import {
  CHECKPOINT_DIAG,
  VIEWER_LEASE,
  presenceDocId,
  resolveViewerLeaseState,
  timestampToMsSafe,
} from "./location-checkpoint-policy.mjs";

/**
 * @param {{
 *   subscribeDoc: (path: { collection: string, id: string }, onNext: Function, onError: Function) => () => void,
 *   onLeaseChange: (lease: string, meta?: object) => void,
 *   onDiag?: (code: string) => void,
 *   isCurrentGeneration?: (gen: number) => boolean,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} deps
 */
export function createViewerPresenceConsumer(deps) {
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
  const setT = typeof deps.setTimeoutFn === "function" ? deps.setTimeoutFn : setTimeout;
  const clearT = typeof deps.clearTimeoutFn === "function" ? deps.clearTimeoutFn : clearTimeout;
  const diag = typeof deps.onDiag === "function" ? deps.onDiag : () => {};

  let unsub = () => {};
  let expiryTimer = 0;
  let boundRideId = "";
  let boundCustomerUid = "";
  let generation = 0;
  let lastExpiresAtMs = NaN;

  function clearExpiryTimer() {
    if (expiryTimer) {
      clearT(expiryTimer);
      expiryTimer = 0;
    }
  }

  function scheduleExpiry(expiresAtMs, gen) {
    clearExpiryTimer();
    if (!Number.isFinite(expiresAtMs)) return;
    const delay = Math.max(0, expiresAtMs - nowMs());
    // Idempotent refresh: same expiry → reschedule same wall time.
    lastExpiresAtMs = expiresAtMs;
    expiryTimer = setT(() => {
      expiryTimer = 0;
      if (typeof deps.isCurrentGeneration === "function" && !deps.isCurrentGeneration(gen)) {
        diag(CHECKPOINT_DIAG.STALE_GENERATION);
        return;
      }
      deps.onLeaseChange(VIEWER_LEASE.EXPIRED, { reason: "local_timer" });
      diag(CHECKPOINT_DIAG.PRESENCE_EXPIRED);
    }, delay);
  }

  function applySnap(snapExists, data, gen) {
    if (typeof deps.isCurrentGeneration === "function" && !deps.isCurrentGeneration(gen)) {
      diag(CHECKPOINT_DIAG.STALE_GENERATION);
      return;
    }
    if (!snapExists) {
      lastExpiresAtMs = NaN;
      clearExpiryTimer();
      deps.onLeaseChange(VIEWER_LEASE.UNKNOWN, { reason: "missing_doc" });
      return;
    }
    const expiresAtMs = timestampToMsSafe(data?.expiresAt);
    // Ignore client-forged local overrides — only server fields from the snap.
    const lease = resolveViewerLeaseState({
      expiresAtMs,
      nowMs: nowMs(),
      presenceReadable: true,
      presenceDocExists: true,
    });
    deps.onLeaseChange(lease, { expiresAtMs });
    if (lease === VIEWER_LEASE.VISIBLE && Number.isFinite(expiresAtMs)) {
      scheduleExpiry(expiresAtMs, gen);
    } else {
      clearExpiryTimer();
    }
  }

  /**
   * Subscribe to exactly one presence doc for the active ride.
   */
  function bind({ rideId, customerUid, generation: gen } = {}) {
    const id = String(rideId || "").trim();
    const cust = String(customerUid || "").trim();
    const nextGen = Number(gen) || 0;
    if (!id || !cust) {
      unbind();
      deps.onLeaseChange(VIEWER_LEASE.UNKNOWN, { reason: "missing_ids" });
      return;
    }
    if (id === boundRideId && cust === boundCustomerUid && nextGen === generation) {
      return; // idempotent
    }
    unbind({ silent: true });
    boundRideId = id;
    boundCustomerUid = cust;
    generation = nextGen;
    const docId = presenceDocId(id, cust);
    unsub = deps.subscribeDoc(
      { collection: "rideViewerPresence", id: docId },
      (snap) => {
        applySnap(Boolean(snap?.exists), snap?.data || null, nextGen);
      },
      () => {
        if (typeof deps.isCurrentGeneration === "function" && !deps.isCurrentGeneration(nextGen)) {
          return;
        }
        clearExpiryTimer();
        deps.onLeaseChange(VIEWER_LEASE.UNKNOWN, { reason: "read_error" });
      }
    );
    diag(CHECKPOINT_DIAG.PRESENCE_ATTACHED);
  }

  function unbind({ silent = false } = {}) {
    unsub();
    unsub = () => {};
    clearExpiryTimer();
    const had = Boolean(boundRideId);
    boundRideId = "";
    boundCustomerUid = "";
    generation = 0;
    lastExpiresAtMs = NaN;
    if (had && !silent) {
      diag(CHECKPOINT_DIAG.PRESENCE_DETACHED);
      deps.onLeaseChange(VIEWER_LEASE.NONE, { reason: "unbind" });
    }
  }

  function getBound() {
    return { rideId: boundRideId, customerUid: boundCustomerUid, generation, lastExpiresAtMs };
  }

  return {
    bind,
    unbind,
    getBound,
    /** Test helper */
    _scheduleExpiryForTest: scheduleExpiry,
  };
}
