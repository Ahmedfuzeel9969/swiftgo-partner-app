/**
 * Phase 2 — adaptive Firebase location checkpoint policy (driver).
 *
 * Presence lease only selects cadence; it is never authorization.
 * P2P placeholder stays disabled — visible customers keep responsive ~4s cadence.
 *
 * Settlement / distance accuracy note (mandatory Phase 2 documentation):
 * - Completed ride settlement uses fare fields, not GPS traveledDistanceKm.
 * - In-progress partial-cancel fares use chord-summed mirrored GPS segments
 *   (functions/partial-fare.js accumulateTraveledSegment). Sparse 30/60s
 *   checkpoints undercount curved paths vs dense 4s sampling; they are not
 *   road-matched. Phase 2 does not change settlement formulas or invent
 *   missing road distance. Breadcrumb batching is Phase 6+.
 *
 * Movement threshold (preserved): MIN_LOCATION_MOVE_M = 10 metres.
 * Responsive / idle: write if moved ≥10m OR interval elapsed (plus zone/status).
 * Background active-ride: hard interval rate-limit; after interval, write even
 * if stationary (recovery heartbeat). Never fully stop during execution.
 */

export const CHECKPOINT_POLICY = Object.freeze({
  RESPONSIVE_FIREBASE: "RESPONSIVE_FIREBASE",
  BACKGROUND_APPROACH_CHECKPOINT: "BACKGROUND_APPROACH_CHECKPOINT",
  BACKGROUND_TRIP_CHECKPOINT: "BACKGROUND_TRIP_CHECKPOINT",
  SAFE_UNKNOWN_APPROACH: "SAFE_UNKNOWN_APPROACH",
  SAFE_UNKNOWN_TRIP: "SAFE_UNKNOWN_TRIP",
  NO_ACTIVE_RIDE: "NO_ACTIVE_RIDE",
});

export const VIEWER_LEASE = Object.freeze({
  VISIBLE: "VISIBLE",
  EXPIRED: "EXPIRED",
  UNKNOWN: "UNKNOWN",
  NONE: "NONE",
});

export const CHECKPOINT_DIAG = Object.freeze({
  POLICY_RESPONSIVE: "checkpoint_policy_responsive",
  POLICY_BACKGROUND_APPROACH: "checkpoint_policy_background_approach",
  POLICY_BACKGROUND_TRIP: "checkpoint_policy_background_trip",
  POLICY_SAFE_UNKNOWN: "checkpoint_policy_safe_unknown",
  PRESENCE_ATTACHED: "checkpoint_presence_attached",
  PRESENCE_DETACHED: "checkpoint_presence_detached",
  PRESENCE_EXPIRED: "checkpoint_presence_expired",
  IMMEDIATE_REQUESTED: "checkpoint_immediate_requested",
  IMMEDIATE_COALESCED: "checkpoint_immediate_coalesced",
  WRITE_SKIPPED_INTERVAL: "checkpoint_write_skipped_interval",
  STALE_GENERATION: "checkpoint_stale_generation_ignored",
});

/** Visible customer / no-active-ride online: current responsive policy. */
export const RESPONSIVE_INTERVAL_MS = 4_000;
/** Hidden/unknown before trip (accepted | arrived). */
export const BACKGROUND_APPROACH_INTERVAL_MS = 60_000;
/** Hidden/unknown during trip (in_progress). */
export const BACKGROUND_TRIP_INTERVAL_MS = 30_000;
/** Existing movement gate (metres) — preserved. */
export const MIN_LOCATION_MOVE_M = 10;

export const APPROACH_STATUSES = Object.freeze(["accepted", "arrived"]);
export const TRIP_STATUSES = Object.freeze(["in_progress"]);
export const EXECUTION_STATUSES = Object.freeze(["accepted", "arrived", "in_progress"]);

/**
 * Parse Firestore Timestamp / Date / millis into ms. Malformed → NaN (fail-safe).
 * @param {unknown} value
 * @returns {number}
 */
export function timestampToMsSafe(value) {
  if (value == null) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value?.toMillis === "function") {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : NaN;
    } catch {
      return NaN;
    }
  }
  if (typeof value?.seconds === "number") {
    const ms = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/**
 * Authoritative lease state from server expiresAt (+ optional lastSeenAt).
 * Local clock cannot extend visibility beyond server expiresAt.
 * Client-supplied fake expiry must not be trusted — callers pass server fields only.
 *
 * @param {{
 *   expiresAtMs?: number,
 *   nowMs?: number,
 *   presenceReadable?: boolean|null,
 *   presenceDocExists?: boolean|null,
 * }} input
 */
export function resolveViewerLeaseState(input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  if (input.presenceReadable === false) return VIEWER_LEASE.UNKNOWN;
  if (input.presenceDocExists === false) return VIEWER_LEASE.UNKNOWN;
  if (input.presenceDocExists == null && input.expiresAtMs == null) {
    return VIEWER_LEASE.UNKNOWN;
  }
  const exp = Number(input.expiresAtMs);
  if (!Number.isFinite(exp)) return VIEWER_LEASE.UNKNOWN;
  if (nowMs >= exp) return VIEWER_LEASE.EXPIRED;
  return VIEWER_LEASE.VISIBLE;
}

/**
 * @param {{
 *   hasActiveRide: boolean,
 *   rideStatus?: string,
 *   viewerLease?: string,
 *   p2pActive?: boolean,
 * }} input
 * @returns {{ policy: string, intervalMs: number, hardInterval: boolean, diag: string }}
 */
export function resolveCheckpointPolicy(input = {}) {
  const p2pActive = Boolean(input.p2pActive); // Phase 2: must remain false / unused for cadence cut
  void p2pActive;

  if (!input.hasActiveRide) {
    return {
      policy: CHECKPOINT_POLICY.NO_ACTIVE_RIDE,
      intervalMs: RESPONSIVE_INTERVAL_MS,
      hardInterval: false,
      diag: CHECKPOINT_DIAG.POLICY_RESPONSIVE,
    };
  }

  const status = String(input.rideStatus || "");
  const lease = String(input.viewerLease || VIEWER_LEASE.UNKNOWN);
  const isTrip = TRIP_STATUSES.includes(status);
  const isApproach = APPROACH_STATUSES.includes(status);

  if (lease === VIEWER_LEASE.VISIBLE) {
    return {
      policy: CHECKPOINT_POLICY.RESPONSIVE_FIREBASE,
      intervalMs: RESPONSIVE_INTERVAL_MS,
      hardInterval: false,
      diag: CHECKPOINT_DIAG.POLICY_RESPONSIVE,
    };
  }

  if (isTrip) {
    const unknown = lease === VIEWER_LEASE.UNKNOWN;
    return {
      policy: unknown
        ? CHECKPOINT_POLICY.SAFE_UNKNOWN_TRIP
        : CHECKPOINT_POLICY.BACKGROUND_TRIP_CHECKPOINT,
      intervalMs: BACKGROUND_TRIP_INTERVAL_MS,
      hardInterval: true,
      diag: unknown
        ? CHECKPOINT_DIAG.POLICY_SAFE_UNKNOWN
        : CHECKPOINT_DIAG.POLICY_BACKGROUND_TRIP,
    };
  }

  if (isApproach || EXECUTION_STATUSES.includes(status)) {
    const unknown = lease === VIEWER_LEASE.UNKNOWN || !isApproach;
    return {
      policy: unknown
        ? CHECKPOINT_POLICY.SAFE_UNKNOWN_APPROACH
        : CHECKPOINT_POLICY.BACKGROUND_APPROACH_CHECKPOINT,
      intervalMs: BACKGROUND_APPROACH_INTERVAL_MS,
      hardInterval: true,
      diag: unknown
        ? CHECKPOINT_DIAG.POLICY_SAFE_UNKNOWN
        : CHECKPOINT_DIAG.POLICY_BACKGROUND_APPROACH,
    };
  }

  return {
    policy: CHECKPOINT_POLICY.SAFE_UNKNOWN_APPROACH,
    intervalMs: BACKGROUND_APPROACH_INTERVAL_MS,
    hardInterval: true,
    diag: CHECKPOINT_DIAG.POLICY_SAFE_UNKNOWN,
  };
}

/**
 * Decide whether a fix may become a vehicle checkpoint write.
 * Preserves zone / geoCell / status force paths for dispatch readiness when not hard-limited.
 *
 * @param {{
 *   force?: boolean,
 *   nowMs: number,
 *   lastWriteMs: number,
 *   intervalMs: number,
 *   hardInterval?: boolean,
 *   movedEnough?: boolean,
 *   zoneChanged?: boolean,
 *   matchCellChanged?: boolean,
 *   statusChanged?: boolean,
 * }} input
 */
export function shouldAllowCheckpointWrite(input = {}) {
  const nowMs = Number(input.nowMs) || 0;
  const lastWriteMs = Number(input.lastWriteMs) || 0;
  const intervalMs = Math.max(0, Number(input.intervalMs) || 0);
  const age = nowMs - lastWriteMs;

  if (input.force) {
    return { allow: true, reason: "force" };
  }
  if (input.statusChanged) {
    return { allow: true, reason: "status_changed" };
  }

  if (input.hardInterval) {
    if (age < intervalMs) {
      return { allow: false, reason: "interval" };
    }
    return { allow: true, reason: "interval_elapsed" };
  }

  // Responsive / idle: preserve pre-Phase-2 gate (move OR interval OR zone/cell).
  if (
    !input.zoneChanged &&
    !input.matchCellChanged &&
    !input.movedEnough &&
    age < intervalMs
  ) {
    return { allow: false, reason: "interval_and_move" };
  }
  return { allow: true, reason: "responsive_gate" };
}

/**
 * @param {{
 *   diag?: (code: string) => void,
 *   nowMs?: () => number,
 * }} [opts]
 */
export function createCheckpointPolicyController(opts = {}) {
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  const diag =
    typeof opts.diag === "function"
      ? opts.diag
      : (code) => {
          try {
            console.info(JSON.stringify({ type: "checkpoint_policy_diag", reason: String(code) }));
          } catch {
            /* ignore */
          }
        };

  let generation = 0;
  let hasActiveRide = false;
  let rideStatus = "";
  let rideId = "";
  let viewerLease = VIEWER_LEASE.UNKNOWN;
  let lastPolicy = CHECKPOINT_POLICY.NO_ACTIVE_RIDE;
  let immediatePending = false;

  const counters = {
    rawGpsFixes: 0,
    rejectedInterval: 0,
    rejectedMovementNoop: 0,
    writesAttempted: 0,
    writesCommitted: 0,
    presenceEvents: 0,
    immediateRequested: 0,
    immediateCoalesced: 0,
    policyTransitions: 0,
  };

  function bumpGeneration() {
    generation += 1;
    immediatePending = false;
    return generation;
  }

  function getGeneration() {
    return generation;
  }

  function isCurrentGeneration(gen) {
    return Number(gen) === generation;
  }

  function currentDecision() {
    return resolveCheckpointPolicy({
      hasActiveRide,
      rideStatus,
      viewerLease,
      p2pActive: false,
    });
  }

  function emitPolicyIfChanged() {
    const next = currentDecision();
    if (next.policy !== lastPolicy) {
      lastPolicy = next.policy;
      counters.policyTransitions += 1;
      diag(next.diag);
    }
    return next;
  }

  function setActiveRide({ rideId: id = "", status = "", active = false } = {}) {
    const nextId = String(id || "").trim();
    const wasActive = hasActiveRide;
    const prevStatus = rideStatus;
    if (!active || !nextId) {
      if (hasActiveRide || rideId) bumpGeneration();
      hasActiveRide = false;
      rideId = "";
      rideStatus = "";
      viewerLease = VIEWER_LEASE.NONE;
      emitPolicyIfChanged();
      return { generation, decision: currentDecision(), statusChanged: false };
    }
    if (nextId !== rideId) {
      bumpGeneration();
      rideId = nextId;
      hasActiveRide = true;
      rideStatus = String(status || "");
      viewerLease = VIEWER_LEASE.UNKNOWN;
      emitPolicyIfChanged();
      return {
        generation,
        decision: currentDecision(),
        statusChanged: true,
        rideChanged: true,
      };
    }
    const nextStatus = String(status || "");
    const statusChanged = nextStatus !== rideStatus;
    rideStatus = nextStatus;
    hasActiveRide = true;
    if (!wasActive) viewerLease = VIEWER_LEASE.UNKNOWN;
    emitPolicyIfChanged();
    if (statusChanged && nextStatus === "in_progress" && prevStatus !== "in_progress") {
      requestImmediate("status_in_progress");
    }
    return { generation, decision: currentDecision(), statusChanged, rideChanged: false };
  }

  function setViewerLease(lease, { fromPresenceEvent = false } = {}) {
    const next = String(lease || VIEWER_LEASE.UNKNOWN);
    const prev = viewerLease;
    if (fromPresenceEvent) counters.presenceEvents += 1;
    if (next === VIEWER_LEASE.EXPIRED && prev !== VIEWER_LEASE.EXPIRED) {
      diag(CHECKPOINT_DIAG.PRESENCE_EXPIRED);
    }
    viewerLease = next;
    emitPolicyIfChanged();
    if (next === VIEWER_LEASE.VISIBLE && prev !== VIEWER_LEASE.VISIBLE) {
      requestImmediate("presence_visible");
    }
    return currentDecision();
  }

  function requestImmediate(reason = "") {
    void reason;
    if (immediatePending) {
      counters.immediateCoalesced += 1;
      diag(CHECKPOINT_DIAG.IMMEDIATE_COALESCED);
      return { coalesced: true };
    }
    immediatePending = true;
    counters.immediateRequested += 1;
    diag(CHECKPOINT_DIAG.IMMEDIATE_REQUESTED);
    return { coalesced: false };
  }

  function consumeImmediate() {
    if (!immediatePending) return false;
    immediatePending = false;
    return true;
  }

  function hasImmediatePending() {
    return immediatePending;
  }

  function noteRawGps() {
    counters.rawGpsFixes += 1;
  }

  function noteRejectedInterval() {
    counters.rejectedInterval += 1;
    diag(CHECKPOINT_DIAG.WRITE_SKIPPED_INTERVAL);
  }

  function noteRejectedMovementNoop() {
    counters.rejectedMovementNoop += 1;
  }

  function noteWriteAttempted() {
    counters.writesAttempted += 1;
  }

  function noteWriteCommitted() {
    counters.writesCommitted += 1;
  }

  function evaluateWriteGate(gateInput = {}) {
    const decision = currentDecision();
    const force = Boolean(gateInput.force) || immediatePending;
    const result = shouldAllowCheckpointWrite({
      ...gateInput,
      force,
      intervalMs: decision.intervalMs,
      hardInterval: decision.hardInterval,
      nowMs: gateInput.nowMs ?? nowMs(),
    });
    if (!result.allow && result.reason === "interval") {
      noteRejectedInterval();
    }
    if (!result.allow && result.reason === "interval_and_move") {
      noteRejectedMovementNoop();
    }
    return { ...result, decision, forceUsed: force };
  }

  function getCounters() {
    return { ...counters };
  }

  function getState() {
    return {
      generation,
      hasActiveRide,
      rideId,
      rideStatus,
      viewerLease,
      lastPolicy,
      immediatePending,
      decision: currentDecision(),
    };
  }

  return {
    CHECKPOINT_POLICY,
    VIEWER_LEASE,
    bumpGeneration,
    getGeneration,
    isCurrentGeneration,
    setActiveRide,
    setViewerLease,
    requestImmediate,
    consumeImmediate,
    hasImmediatePending,
    noteRawGps,
    noteRejectedInterval,
    noteRejectedMovementNoop,
    noteWriteAttempted,
    noteWriteCommitted,
    evaluateWriteGate,
    currentDecision,
    getCounters,
    getState,
  };
}

export function presenceDocId(rideId, customerUid) {
  return `${String(rideId || "").trim()}_${String(customerUid || "").trim()}`;
}
