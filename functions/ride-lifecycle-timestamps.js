/**
 * Server-authoritative lifecycle timestamps for rideLocationReports.
 * Stamps driverArrivedAt / tripStartedAt when assigned driver advances status via client rules.
 * Diagnostic only — does not alter fare, settlement, dispatch, or status transitions.
 */
"use strict";

const { FieldValue } = require("firebase-admin/firestore");

function hasTimestamp(value) {
  if (value == null) return false;
  if (typeof value.toMillis === "function") return true;
  if (value instanceof Date && Number.isFinite(value.getTime())) return true;
  if (typeof value === "object" && Number.isInteger(value.seconds)) return true;
  if (typeof value === "object" && Number.isInteger(value._seconds)) return true;
  return false;
}

/**
 * Pure plan for which lifecycle timestamps should be stamped.
 * @param {Record<string, unknown>} [before]
 * @param {Record<string, unknown>} [after]
 */
function planLifecycleTimestampStamp(before = {}, after = {}) {
  const beforeStatus = String(before.status || "");
  const afterStatus = String(after.status || "");
  if (beforeStatus === afterStatus) {
    return { driverArrivedAt: false, tripStartedAt: false };
  }

  return {
    driverArrivedAt: afterStatus === "arrived" && !hasTimestamp(after.driverArrivedAt),
    tripStartedAt: afterStatus === "in_progress" && !hasTimestamp(after.tripStartedAt),
  };
}

/**
 * Build Admin SDK patch for lifecycle timestamp stamp (null when nothing to write).
 * @param {Record<string, unknown>} [before]
 * @param {Record<string, unknown>} [after]
 */
function buildLifecycleTimestampPatch(before = {}, after = {}) {
  const plan = planLifecycleTimestampStamp(before, after);
  const patch = {};
  if (plan.driverArrivedAt) patch.driverArrivedAt = FieldValue.serverTimestamp();
  if (plan.tripStartedAt) patch.tripStartedAt = FieldValue.serverTimestamp();
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Apply lifecycle timestamp stamp idempotently (absent-field guard).
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} rideId
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 */
async function applyRideLifecycleTimestampStamp(db, rideId, before = {}, after = {}) {
  const patch = buildLifecycleTimestampPatch(before, after);
  if (!patch) return { stamped: false, fields: [] };
  await db.collection("rides").doc(rideId).update(patch);
  return { stamped: true, fields: Object.keys(patch) };
}

module.exports = {
  planLifecycleTimestampStamp,
  buildLifecycleTimestampPatch,
  applyRideLifecycleTimestampStamp,
  hasTimestamp,
};
