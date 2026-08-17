/**
 * Phase 5 — sustained off-route detection + bounded reroute policy.
 */

import { SNAP_DIAG, SNAP_MAX_DISTANCE_M } from "./route-projection.mjs";

export const OFF_ROUTE_MIN_FIXES = 2;
export const OFF_ROUTE_DISTANCE_M = 55;
export const OFF_ROUTE_SUSTAIN_MS = 6_000;
export const OFF_ROUTE_MAX_ACCURACY_M = 45;
export const REROUTE_COOLDOWN_MS = 25_000;
export const REROUTE_MAX_ATTEMPTS_WINDOW = 4;
export const REROUTE_WINDOW_MS = 15 * 60_000;
export const REROUTE_BACKOFF_BASE_MS = 5_000;
export const REROUTE_BACKOFF_MAX_MS = 90_000;

/**
 * @param {{
 *   nowMs?: () => number,
 *   onDiag?: (code: string) => void,
 * }} [opts]
 */
export function createOffRouteDetector(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const diag = opts.onDiag || (() => {});

  let candidateSince = null;
  let candidateCount = 0;
  let confirmed = false;
  let lastRerouteAt = 0;
  let attempts = [];
  let inFlight = false;
  let backoffUntil = 0;
  let failStreak = 0;

  const counters = {
    offRouteCandidates: 0,
    offRouteConfirmed: 0,
    rerouteAttempts: 0,
    rerouteSuccess: 0,
    rerouteFailure: 0,
  };

  function noteProjection(result) {
    const now = nowMs();
    const dist = Number(result?.nearestDistanceM ?? result?.distanceToRouteM);
    const accuracy = Number(result?.raw?.accuracyM);
    const outside =
      result?.confidence === "OFF_ROUTE_CANDIDATE" ||
      (Number.isFinite(dist) && dist >= OFF_ROUTE_DISTANCE_M);
    const accurateEnough =
      !Number.isFinite(accuracy) || accuracy <= OFF_ROUTE_MAX_ACCURACY_M;

    if (!outside || !accurateEnough) {
      candidateSince = null;
      candidateCount = 0;
      return { confirmed: false, candidate: false };
    }

    counters.offRouteCandidates += 1;
    diag(SNAP_DIAG.OFF_CANDIDATE);
    candidateCount += 1;
    if (!candidateSince) candidateSince = now;
    const sustained = now - candidateSince >= OFF_ROUTE_SUSTAIN_MS;
    if (candidateCount >= OFF_ROUTE_MIN_FIXES && sustained) {
      if (!confirmed) {
        confirmed = true;
        counters.offRouteConfirmed += 1;
        diag(SNAP_DIAG.OFF_CONFIRMED);
      }
      return { confirmed: true, candidate: true };
    }
    return { confirmed: false, candidate: true };
  }

  function resetCandidate() {
    candidateSince = null;
    candidateCount = 0;
    confirmed = false;
  }

  function canReroute() {
    const now = nowMs();
    if (inFlight) return { ok: false, reason: "in_flight" };
    if (now < backoffUntil) return { ok: false, reason: "backoff" };
    if (now - lastRerouteAt < REROUTE_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
    attempts = attempts.filter((t) => now - t < REROUTE_WINDOW_MS);
    if (attempts.length >= REROUTE_MAX_ATTEMPTS_WINDOW) {
      return { ok: false, reason: "max_attempts" };
    }
    if (!confirmed) return { ok: false, reason: "not_confirmed" };
    return { ok: true };
  }

  function beginReroute() {
    const gate = canReroute();
    if (!gate.ok) return gate;
    inFlight = true;
    lastRerouteAt = nowMs();
    attempts.push(lastRerouteAt);
    counters.rerouteAttempts += 1;
    diag(SNAP_DIAG.REROUTE_REQUESTED);
    return { ok: true };
  }

  function completeReroute(success) {
    inFlight = false;
    if (success) {
      counters.rerouteSuccess += 1;
      failStreak = 0;
      backoffUntil = 0;
      resetCandidate();
      diag(SNAP_DIAG.REROUTE_READY);
    } else {
      counters.rerouteFailure += 1;
      failStreak += 1;
      const delay = Math.min(
        REROUTE_BACKOFF_MAX_MS,
        REROUTE_BACKOFF_BASE_MS * 2 ** Math.max(0, failStreak - 1)
      );
      backoffUntil = nowMs() + delay;
      diag(SNAP_DIAG.REROUTE_FAILED);
    }
  }

  return {
    noteProjection,
    resetCandidate,
    canReroute,
    beginReroute,
    completeReroute,
    isInFlight: () => inFlight,
    getCounters: () => ({ ...counters }),
    OFF_ROUTE_DISTANCE_M,
    REROUTE_COOLDOWN_MS,
  };
}

void SNAP_MAX_DISTANCE_M;
