/**
 * Phase 1 — billing / Firebase diagnostic helpers (observe only).
 * Does not change write gates, thresholds, P2P, or listeners.
 *
 * CFG_* aliases re-export production runtime constants — never duplicate literals.
 */

import {
  RESPONSIVE_INTERVAL_MS,
  IDLE_LOCATION_INTERVAL_MS,
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  MIN_LOCATION_MOVE_M,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  P2P_SPARSE_EXIT_HYSTERESIS_MS,
} from "../../driver-app/js/location-checkpoint-policy.mjs";
import {
  P2P_FALLBACK_AFTER_MS,
  P2P_DEGRADED_AFTER_MS,
  P2P_SEND_INTERVAL_MS,
  P2P_HEARTBEAT_INTERVAL_MS,
  FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "../../driver-app/js/p2p-protocol.mjs";
import {
  FRESHNESS_FRESH_MS,
  FRESHNESS_DELAYED_MS,
} from "../../customer-app/js/live-location-render.mjs";
import { MAX_ACCEPT_ACCURACY_M } from "../../driver-app/js/location-envelope.mjs";

/** @deprecated Prefer importing runtime symbols; CFG_* kept for diagnostic report callers. */
export const CFG_MAX_ACCEPT_ACCURACY_M = MAX_ACCEPT_ACCURACY_M;
export const CFG_RESPONSIVE_INTERVAL_MS = RESPONSIVE_INTERVAL_MS;
export const CFG_IDLE_LOCATION_INTERVAL_MS = IDLE_LOCATION_INTERVAL_MS;
export const CFG_BACKGROUND_APPROACH_INTERVAL_MS = BACKGROUND_APPROACH_INTERVAL_MS;
export const CFG_BACKGROUND_TRIP_INTERVAL_MS = BACKGROUND_TRIP_INTERVAL_MS;
export const CFG_MIN_LOCATION_MOVE_M = MIN_LOCATION_MOVE_M;
export const CFG_P2P_SPARSE_ENTER_MS = P2P_SPARSE_ENTER_HYSTERESIS_MS;
export const CFG_P2P_SPARSE_EXIT_MS = P2P_SPARSE_EXIT_HYSTERESIS_MS;
export const CFG_P2P_FALLBACK_AFTER_MS = P2P_FALLBACK_AFTER_MS;
export const CFG_P2P_DEGRADED_AFTER_MS = P2P_DEGRADED_AFTER_MS;
export const CFG_P2P_SEND_INTERVAL_MS = P2P_SEND_INTERVAL_MS;
export const CFG_P2P_HEARTBEAT_INTERVAL_MS = P2P_HEARTBEAT_INTERVAL_MS;
export const CFG_FIREBASE_BACKUP_READ_INTERVAL_MS = FIREBASE_BACKUP_READ_INTERVAL_MS;
export const CFG_FRESHNESS_FRESH_MS = FRESHNESS_FRESH_MS;
export const CFG_FRESHNESS_DELAYED_MS = FRESHNESS_DELAYED_MS;

export const PHASE1_DRIVER_CONFIG = Object.freeze({
  responsiveWriteIntervalMs: CFG_RESPONSIVE_INTERVAL_MS,
  idleWriteIntervalMs: CFG_IDLE_LOCATION_INTERVAL_MS,
  backgroundApproachIntervalMs: CFG_BACKGROUND_APPROACH_INTERVAL_MS,
  backgroundTripIntervalMs: CFG_BACKGROUND_TRIP_INTERVAL_MS,
  minimumMovementMeters: CFG_MIN_LOCATION_MOVE_M,
  minimumSpeedMps: null,
  maxAcceptAccuracyMeters: CFG_MAX_ACCEPT_ACCURACY_M,
  p2pSparseEnterHysteresisMs: CFG_P2P_SPARSE_ENTER_MS,
  p2pSparseExitHysteresisMs: CFG_P2P_SPARSE_EXIT_MS,
  conditionsBeforeFirebaseWrite:
    `Envelope must normalize (accuracy ≤${CFG_MAX_ACCEPT_ACCURACY_M}m) + pass evaluateFixAgainstPrevious; then checkpoint write gate (force OR status change OR hard-interval elapsed OR moved≥${CFG_MIN_LOCATION_MOVE_M}m OR interval elapsed OR zone/cell change).`,
  conditionsBeforeP2pSend:
    "After envelope accept (normalize + evaluateFixAgainstPrevious). Independent of Firebase write gate. Requires activeExecutionRide. Counted when GPS is enqueued to the P2P session.",
});

export const PHASE1_CUSTOMER_CONFIG = Object.freeze({
  firebaseListenerType: "Firestore onSnapshot (continuous realtime listener)",
  polling: false,
  pollingIntervalMs: null,
  snapshotProcessing:
    "watchRideRequest → handleRideSnapshot → ingestFirebaseLocation → arbiter → display pipeline",
  duplicateSuppression:
    "Arbiter rejects older observedAt; equal observedAt while P2P preferred is ignored as Firebase echo. Phase 1 also classifies same coords/timestamp/sequence for billing reports.",
  freshnessFreshMs: CFG_FRESHNESS_FRESH_MS,
  freshnessDelayedMs: CFG_FRESHNESS_DELAYED_MS,
  firebaseBackupReadIntervalMs: CFG_FIREBASE_BACKUP_READ_INTERVAL_MS,
});

export const PHASE1_P2P_CONFIG = Object.freeze({
  fallbackAfterMs: CFG_P2P_FALLBACK_AFTER_MS,
  degradedAfterMs: CFG_P2P_DEGRADED_AFTER_MS,
  sendIntervalMs: CFG_P2P_SEND_INTERVAL_MS,
  heartbeatIntervalMs: CFG_P2P_HEARTBEAT_INTERVAL_MS,
  retryInterval: "Signaling / session restart on ride sync and unhealthy paths (no fixed poll interval)",
  failureTimeoutMs: CFG_P2P_FALLBACK_AFTER_MS,
  firebaseFallbackTrigger:
    `Silent P2P >${CFG_P2P_FALLBACK_AFTER_MS / 1000}s, session closed, or explicit unhealthy → prefer Firebase`,
  reconnectBehavior: "Customer/driver controllers re-sync signaling when ride view is active/visible",
});

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function sec(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 1000) * 10) / 10;
}

/**
 * Classify why a successful Firebase vehicle location write was allowed.
 */
export function classifyFirebaseWriteReason({
  force = false,
  statusChanged = false,
  movedEnough = false,
  zoneChanged = false,
  matchCellChanged = false,
  writeGateReason = "",
  ageMs = null,
  intervalMs = null,
} = {}) {
  if (force) {
    return {
      code: "forced_write",
      label: "Forced write",
      plain: "Firebase write happened because a forced/immediate checkpoint was requested.",
    };
  }
  if (statusChanged || writeGateReason === "status_changed") {
    return {
      code: "ride_state_changed",
      label: "Ride state changed",
      plain: "Firebase write happened because the vehicle ride/online status changed.",
    };
  }
  if (writeGateReason === "interval_elapsed") {
    return {
      code: "minimum_interval_reached",
      label: "Minimum interval reached",
      plain: "Firebase write happened because the minimum write interval had elapsed.",
    };
  }
  const intervalOk =
    Number.isFinite(ageMs) && Number.isFinite(intervalMs) && ageMs >= intervalMs;
  if (movedEnough && intervalOk) {
    return {
      code: "both_interval_and_movement",
      label: "Both interval and movement reached",
      plain:
        "Firebase write happened because both the minimum interval and the minimum movement were satisfied.",
    };
  }
  if (movedEnough) {
    return {
      code: "minimum_movement_reached",
      label: "Minimum movement reached",
      plain: "Firebase write happened because the driver moved at least the minimum distance.",
    };
  }
  if (zoneChanged || matchCellChanged) {
    return {
      code: "other_zone_or_cell",
      label: "Other (zone/geo cell change)",
      plain: "Firebase write happened because the location grid or match geo-cell changed.",
    };
  }
  return {
    code: "other",
    label: `Other (${writeGateReason || "responsive_gate"})`,
    plain: `Firebase write happened for gate reason: ${writeGateReason || "responsive_gate"}.`,
  };
}

/**
 * Human-readable explanation when a Firebase write is skipped.
 */
export function explainFirebaseWriteSkipped({
  reason = "",
  nowMs = Date.now(),
  lastWriteMs = null,
  intervalMs = null,
  distanceMovedM = null,
  minimumDistanceM = CFG_MIN_LOCATION_MOVE_M,
} = {}) {
  const age = Number.isFinite(lastWriteMs) ? nowMs - lastWriteMs : null;
  const remainingMs =
    Number.isFinite(age) && Number.isFinite(intervalMs) ? Math.max(0, intervalMs - age) : null;
  const nextAt = Number.isFinite(remainingMs) ? nowMs + remainingMs : null;

  let headline = "Firebase write skipped.";
  let reasonPlain = `Technical reason: ${reason || "unknown"}.`;

  if (reason === "interval" || reason === "interval_and_move") {
    reasonPlain =
      reason === "interval"
        ? "Minimum interval not reached."
        : "Minimum interval not reached (and movement was also below the minimum, so this write was not required yet).";
  } else if (reason === "not_ready") {
    reasonPlain = "Driver is not ready to publish (offline, no vehicle, or not signed in).";
  } else if (String(reason).includes("accuracy") || reason === "location_fix_poor_accuracy") {
    reasonPlain = "GPS accuracy was too poor to accept this fix for publishing.";
  } else if (String(reason).includes("out_of_order") || reason === "location_fix_out_of_order") {
    reasonPlain = "This GPS fix was rejected because its time/sequence was out of order.";
  } else if (String(reason).includes("duplicate") || reason === "location_fix_duplicate") {
    reasonPlain = "This GPS fix was an exact duplicate of the last accepted fix.";
  }

  const lines = [
    "Firebase write skipped",
    "",
    "Reason:",
    reasonPlain,
    "",
  ];
  if (remainingMs != null) {
    lines.push(`Remaining wait:\n${sec(remainingMs)} seconds`);
    lines.push("");
  }
  if (nextAt != null) {
    lines.push(`Next expected write:\n${fmtClock(nextAt)}`);
    lines.push("");
  }
  if (distanceMovedM != null && Number.isFinite(distanceMovedM)) {
    lines.push(`Distance moved:\n${Math.round(distanceMovedM * 10) / 10} meters`);
    lines.push("");
  }
  if (minimumDistanceM != null) {
    lines.push(`Minimum required distance:\n${minimumDistanceM} meters`);
    lines.push("");
  }
  lines.push(
    "If this write had been performed,",
    "it would have produced an unnecessary Firebase write."
  );
  lines.push("");
  lines.push(`Headline: ${headline}`);

  return {
    headline,
    reasonPlain,
    remainingWaitSec: sec(remainingMs),
    nextExpectedWriteClock: nextAt != null ? fmtClock(nextAt) : null,
    nextExpectedWriteMs: nextAt,
    distanceMovedM: Number.isFinite(distanceMovedM) ? Math.round(distanceMovedM * 10) / 10 : null,
    minimumDistanceM,
    plainText: lines.join("\n"),
  };
}

/**
 * Classify a customer Firebase location receive vs previous.
 */
export function classifyFirebaseReceive(prev, next) {
  if (!next) {
    return {
      kind: "empty",
      plain: "Firebase snapshot received without a driver location.",
    };
  }
  if (!prev) {
    return {
      kind: "new_location",
      plain: "New driver location received from Firebase.",
    };
  }
  const sameLat =
    Number.isFinite(prev.lat) &&
    Number.isFinite(next.lat) &&
    Math.abs(prev.lat - next.lat) < 1e-7;
  const sameLng =
    Number.isFinite(prev.lng) &&
    Number.isFinite(next.lng) &&
    Math.abs(prev.lng - next.lng) < 1e-7;
  const sameCoords = sameLat && sameLng;
  const sameObs =
    Number(prev.observedAt) > 0 &&
    Number(next.observedAt) > 0 &&
    Number(prev.observedAt) === Number(next.observedAt);
  const sameSeq =
    Number(prev.sequence) > 0 &&
    Number(next.sequence) > 0 &&
    Number(prev.sequence) === Number(next.sequence);

  if (sameCoords && sameObs && sameSeq) {
    return {
      kind: "duplicate_document",
      sameCoordinates: true,
      sameGpsTimestamp: true,
      sameSequence: true,
      plain:
        "Duplicate Firebase data received.\n\nNo new driver location.\n\nUI not updated because location has not changed.",
    };
  }
  if (sameCoords && sameObs) {
    return {
      kind: "duplicate_location",
      sameCoordinates: true,
      sameGpsTimestamp: true,
      sameSequence: sameSeq,
      plain:
        "Duplicate Firebase data received.\n\nSame coordinates and same GPS timestamp.\n\nNo new driver location.",
    };
  }
  if (sameCoords) {
    return {
      kind: "same_coordinates",
      sameCoordinates: true,
      sameGpsTimestamp: sameObs,
      sameSequence: sameSeq,
      plain:
        "Firebase snapshot received with the same coordinates as before.\n\nDriver marker position does not need to move.",
    };
  }
  return {
    kind: "new_location",
    sameCoordinates: false,
    sameGpsTimestamp: sameObs,
    sameSequence: sameSeq,
    plain: "New driver location received from Firebase.",
  };
}

/**
 * Record an automatic billing summary when a ride completes (observe-only).
 * Full billing text requires report modules (loaded via ensureFieldDiagnosticReports).
 * @param {object} diag field-diagnostics instance
 * @param {{ rideId?: string }} [opts]
 */
export function recordPhase1RideComplete(diag, opts = {}) {
  if (!diag) return;
  const endedAt = Date.now();
  try {
    diag.setMeta?.({
      rideStatus: "completed",
      rideEndedAt: endedAt,
      rideId: opts.rideId != null ? String(opts.rideId) : undefined,
    });
    diag.record?.("ride_meta", {
      rideId: String(opts.rideId || ""),
      status: "completed",
    });
    let plainText =
      "Billing summary marker recorded (detailed report deferred until diagnostics reports load).";
    if (typeof diag.buildBillingAnalysisReport === "function") {
      plainText = String(diag.buildBillingAnalysisReport({ rideEndedAt: endedAt }) || "").slice(
        0,
        12000
      );
    }
    diag.record?.("billing_summary_auto", {
      headline: "Automatic billing summary after ride completed.",
      plainText,
    });
  } catch {
    /* ignore */
  }
}
