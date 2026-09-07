/**
 * Compact accepted-mirror aggregate stored on rides/{rideId} (diagnostic only).
 * Avoids per-checkpoint rideLocationReports reads/writes.
 */
"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { createEmptyServerCounters } = require("./ride-location-report-schema.js");

function mirrorOutcomeCounter(reason, mirrored) {
  if (mirrored) return "mirrorAccepted";
  if (["firebase_disabled", "p2p_first_grace"].includes(reason)) return "mirrorSkippedPolicy";
  if (/session|assignment/.test(reason)) return "mirrorSkippedSessionMismatch";
  if (/duplicate/.test(reason)) return "mirrorSkippedDuplicate";
  if (/order|sequence|timestamp_not_monotonic/.test(reason)) return "mirrorSkippedOutOfOrder";
  if (/noop|unchanged/.test(reason)) return "mirrorSkippedNoop";
  if (/inactive|missing|no_active|vehicle_mismatch/.test(reason)) return "mirrorSkippedInactive";
  if (/failed|txn/.test(reason)) return "mirrorFailed";
  return "mirrorSkippedInvalid";
}

/** One completed mirror invocation; Firestore transaction retries do not add
 * attempts. A separately redelivered trigger IS another attempt, usually a
 * duplicate skip. Counters do not claim one attempt equals one vehicle write. */
function buildMirrorOutcomeAggregatePatch(ride = {}, reason, mirrored, nowMs = Date.now()) {
  const counters = { ...createEmptyServerCounters(), mirrorAttempts: Number(ride.serverMirrorAccepted) || 0,
    mirrorAccepted: Number(ride.serverMirrorAccepted) || 0, ...(ride.serverMirrorCounters || {}) };
  counters.mirrorAttempts++;
  counters[mirrorOutcomeCounter(reason, mirrored)]++;
  const patch = { serverMirrorCounters: counters };
  if (mirrored) Object.assign(patch, acceptedTimingPatch(ride, nowMs));
  return patch;
}

function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && Number.isInteger(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1_000_000);
  }
  return null;
}

/**
 * Build ride patch fields for one accepted mirror (same ride update as driverLocation).
 * @param {object} ride current ride snapshot
 * @param {number} nowMs
 */
function acceptedTimingPatch(ride = {}, nowMs = Date.now()) {
  const accepted = (Number(ride.serverMirrorAccepted) || 0) + 1;
  const lastAtMs = timestampToMs(ride.lastServerMirrorAt);
  const firstAtMs = timestampToMs(ride.firstServerMirrorAt) ?? nowMs;
  let maximumMirrorGapMs = Number(ride.maximumMirrorGapMs) || 0;
  if (lastAtMs != null && nowMs > lastAtMs) {
    maximumMirrorGapMs = Math.max(maximumMirrorGapMs, nowMs - lastAtMs);
  }
  return {
    serverMirrorAccepted: accepted,
    firstServerMirrorAt: firstAtMs,
    lastServerMirrorAt: nowMs,
    maximumMirrorGapMs,
  };
}

function buildAcceptedMirrorAggregatePatch(ride = {}, nowMs = Date.now()) {
  return buildMirrorOutcomeAggregatePatch(ride, "accepted", true, nowMs);
}

/**
 * Convert ride aggregate into report server section (submit-time merge only).
 * @param {object} ride
 * @returns {object|null}
 */
function serverSectionFromRideAggregate(ride = {}) {
  const accepted = Number(ride.serverMirrorAccepted) || 0;
  if (accepted <= 0 && !(ride.serverMirrorCounters?.mirrorAttempts > 0)) return null;

  const firstMirrorAtMs = timestampToMs(ride.firstServerMirrorAt);
  const lastMirrorAtMs = timestampToMs(ride.lastServerMirrorAt);
  const longestGapMs =
    ride.maximumMirrorGapMs == null ? null : Number(ride.maximumMirrorGapMs) || null;

  const counters = { ...createEmptyServerCounters(), mirrorAttempts: accepted, mirrorAccepted: accepted,
    ...(ride.serverMirrorCounters || {}) };

  return {
    counters,
    firstMirrorAtMs,
    lastMirrorAtMs,
    longestGapMs,
    lastEventAtMs: lastMirrorAtMs,
  };
}

function hasRideServerMirrorAggregate(ride = {}) {
  return (Number(ride.serverMirrorAccepted) || Number(ride.serverMirrorCounters?.mirrorAttempts) || 0) > 0;
}

/** Reset assignment-scoped mirror aggregate when assignmentSessionToken is minted/rotated. */
function assignmentServerMirrorAggregateResetPatch() {
  return {
    serverMirrorAccepted: 0,
    serverMirrorCounters: createEmptyServerCounters(),
    firstServerMirrorAt: null,
    lastServerMirrorAt: null,
    maximumMirrorGapMs: 0,
  };
}

/**
 * Reset assignment-scoped ride location ordering baseline atomically with a fresh token.
 * Clears prior-assignment driverLocation so seed/mirror never compares against stale state.
 */
function assignmentLocationBaselineResetPatch() {
  return {
    ...assignmentServerMirrorAggregateResetPatch(),
    driverLocation: FieldValue.delete(),
    driverLocationUpdatedAt: FieldValue.delete(),
    driverTrackingSessionId: FieldValue.delete(),
    driverTrackingSessionStartedAt: FieldValue.delete(),
  };
}

module.exports = {
  buildMirrorOutcomeAggregatePatch,
  mirrorOutcomeCounter,
  buildAcceptedMirrorAggregatePatch,
  serverSectionFromRideAggregate,
  hasRideServerMirrorAggregate,
  assignmentServerMirrorAggregateResetPatch,
  assignmentLocationBaselineResetPatch,
  timestampToMs,
};
