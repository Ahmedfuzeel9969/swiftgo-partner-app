// Generated from shared/js/ride-location-contract.mjs; checked by tests.
"use strict";
/** Canonical location contract. Server adapter is checked byte-for-byte in tests. */
const LOCATION_MAX_AGE_MS = 30_000;
const LOCATION_MAX_FUTURE_MS = 10_000;
const LOCATION_MAX_ACCURACY_M = 80;
const LOCATION_MAX_SPEED_MPS = 45;

function locationSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(value) ? value : "";
}

function locationDistanceM(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function rideLocationAssignmentVersion(ride) {
  // Matches the existing server signaling identity; never derive authority from a message.
  let h = 0;
  for (const c of `${ride?.driverId || ""}|${ride?.vehicleId || ""}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.max(1, h % 1_000_000_000);
}

/** No numeric coercion, timestamp invention, or session invention at this boundary. */
function validateRideLocationFix(raw, context = {}) {
  const reject = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== "object") return reject("invalid_fix");
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lng) ||
      Math.abs(raw.lat) > 90 || Math.abs(raw.lng) > 180) return reject("invalid_coords");
  const observedAt = raw.observedAt;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return reject("invalid_observedAt");
  const now = context.nowMs ?? Date.now();
  if (now - observedAt > (context.maxAgeMs ?? LOCATION_MAX_AGE_MS)) return reject("stale_observedAt");
  if (observedAt - now > LOCATION_MAX_FUTURE_MS) return reject("future_observedAt");
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) return reject("invalid_sequence");
  const trackingSessionId = locationSessionId(raw.trackingSessionId ?? raw.sessionId);
  if (!trackingSessionId) return reject("invalid_tracking_session");
  if (context.trackingSessionId && trackingSessionId !== context.trackingSessionId) return reject("wrong_tracking_session");
  if (context.rideId && raw.rideId !== context.rideId) return reject("wrong_ride");
  if (context.assignmentVersion && raw.assignmentVersion !== context.assignmentVersion) return reject("wrong_assignment");
  if (context.assignmentId && raw.assignmentId !== context.assignmentId) return reject("wrong_assignment");
  if (context.role && raw.role !== context.role) return reject("unexpected_role");
  for (const [key, max] of [["accuracyM", LOCATION_MAX_ACCURACY_M], ["speedMps", LOCATION_MAX_SPEED_MPS], ["headingDeg", 360]]) {
    if (raw[key] != null && (!Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > max)) return reject(`invalid_${key}`);
  }
  const fix = {
    lat: raw.lat, lng: raw.lng, observedAt, sequence: raw.sequence, trackingSessionId,
    accuracyM: raw.accuracyM ?? null, speedMps: raw.speedMps ?? null,
    headingDeg: raw.headingDeg === 360 ? 0 : raw.headingDeg ?? null,
    ...(raw.rideId ? { rideId: raw.rideId } : {}),
    ...(raw.assignmentVersion ? { assignmentVersion: raw.assignmentVersion } : {}),
    ...(raw.assignmentId ? { assignmentId: raw.assignmentId } : {}),
    ...(raw.role ? { role: raw.role } : {}),
  };
  const previous = context.previous;
  if (previous) {
    // Transport switching never makes the same GPS fix new again. P2P packet
    // sequence is separate from this original GPS sample sequence.
    if (observedAt === previous.observedAt) return reject("duplicate_fix");
    if (observedAt < previous.observedAt) return reject("out_of_order");
    const sameSession = trackingSessionId === (previous.trackingSessionId ?? previous.sessionId);
    if (sameSession && raw.sequence <= previous.sequence) return reject("out_of_order");
    const elapsedSeconds = (observedAt - previous.observedAt) / 1000;
    const uncertaintyM = (previous.accuracyM ?? 0) + (fix.accuracyM ?? 0) + 20;
    // Also check sub-second and session-change fixes; neither is a jump bypass.
    if (locationDistanceM(previous, fix) > uncertaintyM + LOCATION_MAX_SPEED_MPS * elapsedSeconds) {
      return reject("impossible_jump");
    }
  }
  return { ok: true, fix };
}
module.exports = { LOCATION_MAX_AGE_MS, LOCATION_MAX_FUTURE_MS, LOCATION_MAX_ACCURACY_M, LOCATION_MAX_SPEED_MPS, locationSessionId, locationDistanceM, rideLocationAssignmentVersion, validateRideLocationFix };
