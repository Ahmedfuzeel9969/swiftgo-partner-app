/**
 * Phase 3 — single customer location-source arbiter (P2P vs Firebase).
 * One marker pipeline only; never move marker backward in observedAt.
 *
 * While P2P is healthy: do not render Firebase location.
 * After P2P silence ≥ fallbackAfterMs (or explicit unhealthy): Firebase backup
 * renders at most once per FIREBASE_BACKUP_READ_INTERVAL_MS.
 */

import {
  P2P_DIAG,
  P2P_FALLBACK_AFTER_MS,
  FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "./p2p-protocol.mjs";

/**
 * @typedef {{
 *   lat: number,
 *   lng: number,
 *   observedAt: number,
 *   sequence?: number,
 *   trackingSessionId?: string,
 *   assignmentVersion?: number,
 *   source: "p2p"|"firebase",
 * }} ArbiterFix
 */

/**
 * @param {{
 *   nowMs?: () => number,
 *   fallbackAfterMs?: number,
 *   firebaseBackupReadIntervalMs?: number,
 *   onDiag?: (code: string) => void,
 *   onRender?: (fix: ArbiterFix, meta: object) => void,
 * }} [opts]
 */
export function createLiveLocationSourceArbiter(opts = {}) {
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  const fallbackAfterMs = opts.fallbackAfterMs ?? P2P_FALLBACK_AFTER_MS;
  const backupReadIntervalMs =
    opts.firebaseBackupReadIntervalMs ?? FIREBASE_BACKUP_READ_INTERVAL_MS;
  const diag = opts.onDiag || (() => {});
  const onRender = opts.onRender || (() => {});

  let generation = 0;
  let closed = false;
  let lastRendered = null;
  let lastP2pAt = 0;
  let lastFirebase = null;
  let lastFirebaseRenderAt = 0;
  let preferred = "firebase";
  let p2pHealthy = false;

  const counters = {
    p2pAccepted: 0,
    p2pRendered: 0,
    firebaseAccepted: 0,
    firebaseRendered: 0,
    firebaseThrottled: 0,
    firebaseIgnoredWhileP2p: 0,
    staleRejected: 0,
    sourceSwitches: 0,
    sourceSwitchP2pToFirebase: 0,
    sourceSwitchFirebaseToP2p: 0,
  };

  function bumpGeneration() {
    generation += 1;
    return generation;
  }

  function isCurrent(gen) {
    return !closed && Number(gen) === generation;
  }

  function shouldReplace(prev, next) {
    if (!prev) return true;
    if (String(next.trackingSessionId || "") && String(prev.trackingSessionId || "")) {
      if (next.trackingSessionId !== prev.trackingSessionId) {
        // Newer session wins only if observedAt is not older.
        return next.observedAt >= prev.observedAt - 2_000;
      }
    }
    if (next.observedAt < prev.observedAt) return false;
    if (next.observedAt === prev.observedAt) {
      const ns = Number(next.sequence) || 0;
      const ps = Number(prev.sequence) || 0;
      if (ns && ps && ns <= ps && next.source === prev.source) return false;
    }
    return true;
  }

  function render(fix, reason) {
    if (!shouldReplace(lastRendered, fix)) {
      counters.staleRejected += 1;
      return false;
    }
    const prevSource = lastRendered?.source;
    lastRendered = fix;
    if (prevSource && prevSource !== fix.source) {
      counters.sourceSwitches += 1;
      if (prevSource === "p2p" && fix.source === "firebase") {
        counters.sourceSwitchP2pToFirebase += 1;
      } else if (prevSource === "firebase" && fix.source === "p2p") {
        counters.sourceSwitchFirebaseToP2p += 1;
      }
      diag(fix.source === "p2p" ? P2P_DIAG.SOURCE_P2P : P2P_DIAG.SOURCE_FIREBASE);
    }
    onRender(fix, { reason, preferred, p2pHealthy, generation });
    if (fix.source === "p2p") counters.p2pRendered += 1;
    else if (fix.source === "firebase") counters.firebaseRendered += 1;
    return true;
  }

  function activateFirebaseFallback() {
    const wasP2pPrimary = p2pHealthy && preferred === "p2p";
    p2pHealthy = false;
    preferred = "firebase";
    if (wasP2pPrimary) {
      // Responsive fallback: first Firebase render after P2P loss must not wait out the prior throttle window.
      lastFirebaseRenderAt = 0;
    }
    diag(P2P_DIAG.FIREBASE_FALLBACK);
  }

  function ensureP2pHealth() {
    if (!p2pHealthy) return;
    if (!lastP2pAt || nowMs() - lastP2pAt > fallbackAfterMs) {
      activateFirebaseFallback();
    }
  }

  function ingestP2p(fix, gen) {
    if (!isCurrent(gen) || closed || !fix) {
      diag(P2P_DIAG.STALE_GENERATION);
      return false;
    }
    lastP2pAt = nowMs();
    p2pHealthy = true;
    preferred = "p2p";
    const rendered = render({ ...fix, source: "p2p" }, "p2p");
    if (rendered) counters.p2pAccepted += 1;
    return rendered;
  }

  function ingestFirebase(fix, gen) {
    if (!isCurrent(gen) || closed || !fix) {
      diag(P2P_DIAG.STALE_GENERATION);
      return false;
    }
    ensureP2pHealth();
    lastFirebase = { ...fix, source: "firebase" };

    const ageP2p = lastP2pAt ? nowMs() - lastP2pAt : Infinity;
    if (p2pHealthy && preferred === "p2p" && ageP2p <= fallbackAfterMs) {
      // P2P primary — do not use Firebase location while healthy.
      counters.firebaseIgnoredWhileP2p += 1;
      return false;
    }

    preferred = "firebase";
    p2pHealthy = false;

    const now = nowMs();
    if (lastFirebaseRenderAt && now - lastFirebaseRenderAt < backupReadIntervalMs) {
      counters.firebaseThrottled += 1;
      return false;
    }

    lastFirebaseRenderAt = now;
    const rendered = render(lastFirebase, "firebase");
    if (rendered) counters.firebaseAccepted += 1;
    return rendered;
  }

  function noteP2pUnhealthy() {
    activateFirebaseFallback();
    // Accept newest Firebase without moving marker backward in time.
    if (lastFirebase && shouldReplace(lastRendered, lastFirebase)) {
      const now = nowMs();
      if (!lastFirebaseRenderAt || now - lastFirebaseRenderAt >= backupReadIntervalMs) {
        lastFirebaseRenderAt = now;
        render(lastFirebase, "fallback");
      }
    }
  }

  function getState() {
    return {
      generation,
      closed,
      preferred,
      p2pHealthy,
      lastRendered,
      lastP2pAt,
      lastFirebaseRenderAt,
      counters: { ...counters },
    };
  }

  function reset({ clearCounters = false } = {}) {
    bumpGeneration();
    lastRendered = null;
    lastP2pAt = 0;
    lastFirebase = null;
    lastFirebaseRenderAt = 0;
    preferred = "firebase";
    p2pHealthy = false;
    if (clearCounters) {
      for (const key of Object.keys(counters)) counters[key] = 0;
    }
  }

  function destroy() {
    closed = true;
    bumpGeneration();
  }

  return {
    bumpGeneration,
    getGeneration: () => generation,
    isCurrent,
    ingestP2p,
    ingestFirebase,
    noteP2pUnhealthy,
    ensureP2pHealth,
    getState,
    reset,
    destroy,
    getCounters: () => ({ ...counters }),
  };
}
