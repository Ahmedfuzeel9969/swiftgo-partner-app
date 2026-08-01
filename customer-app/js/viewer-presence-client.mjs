/**
 * Phase 1 — customer viewer presence lease client (heartbeat only; no driver throttle).
 * Firebase callable is injected or lazy-loaded so unit tests need no CDN imports.
 */

import { VIEWER_DIAG } from "./ride-view-lifecycle.mjs";

/** Heartbeat interval while visible (ms). */
export const PRESENCE_HEARTBEAT_MS = 45_000;
/** Server lease TTL after last successful refresh (ms). */
export const PRESENCE_LEASE_TTL_MS = 90_000;
/** ± jitter fraction of heartbeat interval (documented safe range). */
export const PRESENCE_HEARTBEAT_JITTER_FRAC = 0.12;
/** Max jitter absolute ms. */
export const PRESENCE_HEARTBEAT_JITTER_MAX_MS = 5_000;
/** Bounded retry backoff base. */
export const PRESENCE_RETRY_BASE_MS = 2_000;
export const PRESENCE_RETRY_MAX_MS = 30_000;
export const PRESENCE_RETRY_MAX_ATTEMPTS = 5;

/** Session id: 3–64 chars [A-Za-z0-9_-] — matches tracking session policy. */
export function isValidPresenceSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 3 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

export function createPresenceSessionId(now = Date.now()) {
  return `vp_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Jittered delay for next heartbeat.
 * @returns {number} ms in [HEARTBEAT*(1-j), HEARTBEAT*(1+j)] capped by MAX
 */
export function nextHeartbeatDelayMs(random = Math.random) {
  const base = PRESENCE_HEARTBEAT_MS;
  const span = Math.min(PRESENCE_HEARTBEAT_JITTER_MAX_MS, base * PRESENCE_HEARTBEAT_JITTER_FRAC);
  const delta = (random() * 2 - 1) * span;
  return Math.max(1_000, Math.round(base + delta));
}

export function nextRetryDelayMs(attempt, random = Math.random) {
  const exp = Math.min(
    PRESENCE_RETRY_MAX_MS,
    PRESENCE_RETRY_BASE_MS * 2 ** Math.max(0, attempt)
  );
  const jitter = Math.round(random() * 400);
  return Math.min(PRESENCE_RETRY_MAX_MS, exp + jitter);
}

export function presenceDocId(rideId, customerUid) {
  return `${String(rideId || "").trim()}_${String(customerUid || "").trim()}`;
}

async function defaultCallRefresh(payload) {
  const { httpsCallable } = await import(
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js"
  );
  const { getFirebase } = await import("./firebase.js");
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const res = await httpsCallable(functions, "refreshRideViewerPresence")(payload);
  return res?.data || res;
}

/**
 * @param {{
 *   callRefresh?: (payload: object) => Promise<object>,
 *   getAuthUid?: () => string,
 *   isVisible?: () => boolean,
 *   isCurrentGeneration?: (gen: number) => boolean,
 *   onDiag?: (code: string) => void,
 *   onAttempt?: () => void,
 *   onSuccess?: () => void,
 *   onFailure?: () => void,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   random?: () => number,
 * }} [opts]
 */
export function createViewerPresenceClient(opts = {}) {
  const setT = opts.setTimeoutFn || setTimeout;
  const clearT = opts.clearTimeoutFn || clearTimeout;
  const random = opts.random || Math.random;
  const diag = opts.onDiag || (() => {});

  let timer = 0;
  let rideId = "";
  let sessionId = "";
  let generation = 0;
  let leaseVersion = 0;
  let retryAttempt = 0;
  let stopped = true;
  let inFlight = false;

  const callRefresh = typeof opts.callRefresh === "function" ? opts.callRefresh : defaultCallRefresh;

  function clearTimer() {
    if (timer) {
      clearT(timer);
      timer = 0;
    }
  }

  function stop() {
    stopped = true;
    clearTimer();
    inFlight = false;
    rideId = "";
    generation = 0;
  }

  async function tick() {
    if (stopped || !rideId) return;
    if (typeof opts.isVisible === "function" && !opts.isVisible()) return;
    if (typeof opts.isCurrentGeneration === "function" && !opts.isCurrentGeneration(generation)) {
      return;
    }
    if (inFlight) return;
    inFlight = true;
    opts.onAttempt?.();
    try {
      leaseVersion += 1;
      await callRefresh({
        rideId,
        sessionId,
        leaseVersion,
      });
      retryAttempt = 0;
      opts.onSuccess?.();
      diag(VIEWER_DIAG.PRESENCE_REFRESHED);
    } catch {
      opts.onFailure?.();
      diag(VIEWER_DIAG.PRESENCE_FAILED);
      retryAttempt += 1;
      if (retryAttempt > PRESENCE_RETRY_MAX_ATTEMPTS) {
        diag(VIEWER_DIAG.PRESENCE_EXPIRED);
        inFlight = false;
        // Stop aggressive retries; wait for next normal heartbeat schedule.
        retryAttempt = PRESENCE_RETRY_MAX_ATTEMPTS;
        schedule(nextHeartbeatDelayMs(random));
        return;
      }
      inFlight = false;
      schedule(nextRetryDelayMs(retryAttempt, random));
      return;
    }
    inFlight = false;
    if (!stopped) schedule(nextHeartbeatDelayMs(random));
  }

  function schedule(delayMs) {
    clearTimer();
    if (stopped) return;
    timer = setT(() => {
      timer = 0;
      void tick();
    }, delayMs);
  }

  /**
   * Start exactly one heartbeat loop for a ride/generation.
   * Hidden callers must not start this.
   */
  function start({ rideId: rid, generation: gen, forceNewSession = false } = {}) {
    const id = String(rid || "").trim();
    if (!id) {
      stop();
      return;
    }
    if (
      !stopped &&
      id === rideId &&
      Number(gen) === generation &&
      !forceNewSession
    ) {
      return; // one loop only
    }
    clearTimer();
    stopped = false;
    rideId = id;
    generation = Number(gen) || 0;
    retryAttempt = 0;
    if (forceNewSession || !isValidPresenceSessionId(sessionId)) {
      sessionId = createPresenceSessionId();
    }
    // Immediate refresh, then jittered cadence.
    void tick();
  }

  function getSessionId() {
    return sessionId;
  }

  function isRunning() {
    return !stopped && Boolean(rideId) && (timer !== 0 || inFlight);
  }

  return {
    start,
    stop,
    tick,
    getSessionId,
    isRunning,
    nextHeartbeatDelayMs: () => nextHeartbeatDelayMs(random),
  };
}
