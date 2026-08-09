/**
 * Compact accepted-mirror aggregate stored on rides/{rideId} (diagnostic only).
 * Avoids per-checkpoint rideLocationReports reads/writes.
 */
"use strict";

const { createEmptyServerCounters } = require("./ride-location-report-schema.js");

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
function buildAcceptedMirrorAggregatePatch(ride = {}, nowMs = Date.now()) {
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

/**
 * Convert ride aggregate into report server section (submit-time merge only).
 * @param {object} ride
 * @returns {object|null}
 */
function serverSectionFromRideAggregate(ride = {}) {
  const accepted = Number(ride.serverMirrorAccepted) || 0;
  if (accepted <= 0) return null;

  const firstMirrorAtMs = timestampToMs(ride.firstServerMirrorAt);
  const lastMirrorAtMs = timestampToMs(ride.lastServerMirrorAt);
  const longestGapMs =
    ride.maximumMirrorGapMs == null ? null : Number(ride.maximumMirrorGapMs) || null;

  const counters = { ...createEmptyServerCounters(), mirrorAttempts: accepted, mirrorAccepted: accepted };

  return {
    counters,
    firstMirrorAtMs,
    lastMirrorAtMs,
    longestGapMs,
    lastEventAtMs: lastMirrorAtMs,
  };
}

function hasRideServerMirrorAggregate(ride = {}) {
  return (Number(ride.serverMirrorAccepted) || 0) > 0;
}

module.exports = {
  buildAcceptedMirrorAggregatePatch,
  serverSectionFromRideAggregate,
  hasRideServerMirrorAggregate,
  timestampToMs,
};
