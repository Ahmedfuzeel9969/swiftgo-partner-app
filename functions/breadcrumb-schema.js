"use strict";

/** Auto-generated from shared/js/breadcrumb-schema.mjs — do not edit by hand. */
/**
 * Phase 6 — breadcrumb batch schema, limits, and pure distance helpers.
 * Display-snapped / animation coordinates must never enter this path.
 */

const BREADCRUMB_PROTOCOL_VERSION = 1;

/** Cost-aware default: sample ~1 telemetry point / 4s (not 1 Hz server upload). */
const BREADCRUMB_SAMPLE_INTERVAL_MS = 4_000;
const BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS = 60_000;
const BREADCRUMB_TARGET_BATCH_POINTS = 15;
const BREADCRUMB_MAX_BATCH_POINTS = 30;
const BREADCRUMB_MAX_BATCH_BYTES = 12_000;
const BREADCRUMB_MAX_QUEUE_POINTS = 180;
const BREADCRUMB_MAX_QUEUE_BYTES = 80_000;
const BREADCRUMB_QUEUE_RETENTION_MS = 2 * 60 * 60_000;
const BREADCRUMB_MAX_BATCH_SPAN_MS = 10 * 60_000;
const BREADCRUMB_MAX_POINT_AGE_MS = 30 * 60_000;
const BREADCRUMB_MAX_FUTURE_SKEW_MS = 30_000;
const BREADCRUMB_MAX_ACCURACY_M = 100;
const BREADCRUMB_MIN_SEGMENT_M = 3;
const BREADCRUMB_MAX_SPEED_MPS = 55;
const BREADCRUMB_RETRY_BASE_MS = 5_000;
const BREADCRUMB_RETRY_MAX_MS = 120_000;
const BREADCRUMB_FINAL_FLUSH_TIMEOUT_MS = 4_000;
/** Bound catch-up uploads per network/app wake to avoid request storms. */
const BREADCRUMB_MAX_UPLOADS_PER_WAKE = 3;
const BREADCRUMB_COORD_DECIMALS = 7;

const BREADCRUMB_DIAG = Object.freeze({
  COLLECTION_STARTED: "breadcrumb_collection_started",
  COLLECTION_STOPPED: "breadcrumb_collection_stopped",
  POINT_ACCEPTED: "breadcrumb_point_accepted",
  POINT_REJECTED: "breadcrumb_point_rejected",
  POINT_SAMPLED_OUT: "breadcrumb_point_sampled_out",
  BATCH_QUEUED: "breadcrumb_batch_queued",
  BATCH_UPLOAD_STARTED: "breadcrumb_batch_upload_started",
  BATCH_ACKNOWLEDGED: "breadcrumb_batch_acknowledged",
  BATCH_RETRY_SCHEDULED: "breadcrumb_batch_retry_scheduled",
  BATCH_DUPLICATE: "breadcrumb_batch_duplicate",
  BATCH_OUT_OF_ORDER: "breadcrumb_batch_out_of_order",
  GAP_RECORDED: "breadcrumb_gap_recorded",
  QUEUE_OVERFLOW: "breadcrumb_queue_overflow",
  STALE_QUEUE_PURGED: "breadcrumb_stale_queue_purged",
  SHADOW_UPDATED: "breadcrumb_shadow_updated",
  FINAL_FLUSH_TIMEOUT: "breadcrumb_final_flush_timeout",
  IDB_UNAVAILABLE: "breadcrumb_idb_unavailable",
  ALREADY_ACTIVE: "breadcrumb_already_active",
});

/** Server-minted assignment session token shape (Admin/CF only). */
function isValidAssignmentSessionToken(token) {
  const t = String(token || "");
  return t.length >= 8 && t.length <= 80 && /^[A-Za-z0-9_-]+$/.test(t);
}

function isValidLatLng(lat, lng) {
  if (typeof lat === "string" || typeof lng === "string") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

function roundCoord(n) {
  const f = 10 ** BREADCRUMB_COORD_DECIMALS;
  return Math.round(Number(n) * f) / f;
}

function haversineMeters(a, b) {
  if (!a || !b || !isValidLatLng(a.lat, a.lng) || !isValidLatLng(b.lat, b.lng)) return NaN;
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function assignmentVersionFromRide(ride) {
  const raw = `${ride?.driverId || ""}|${ride?.vehicleId || ""}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return Math.max(1, h % 1_000_000_000);
}

/** Stable numeric partition helper derived from server assignmentSessionToken. */
function assignmentVersionFromToken(token) {
  const raw = String(token || "");
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return Math.max(1, h % 1_000_000_000);
}

/**
 * Validate one raw breadcrumb point (authoritative GPS only).
 */
function validateBreadcrumbPoint(raw, { nowMs = Date.now(), previous = null } = {}) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "invalid_point" };
  }
  if (raw.source === "display_snap" || raw.displayMode === "snap" || raw.source === "animation") {
    return { ok: false, reason: "display_or_animation_rejected" };
  }
  if (!isValidLatLng(raw.lat, raw.lng)) {
    return { ok: false, reason: "invalid_coords" };
  }
  const sequence = Math.floor(Number(raw.sequence));
  if (!Number.isFinite(sequence) || sequence < 1) {
    return { ok: false, reason: "invalid_sequence" };
  }
  const observedAt = Number(raw.observedAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0) {
    return { ok: false, reason: "invalid_observedAt" };
  }
  if (observedAt < nowMs - BREADCRUMB_MAX_POINT_AGE_MS) {
    return { ok: false, reason: "stale_observedAt" };
  }
  if (observedAt > nowMs + BREADCRUMB_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "future_observedAt" };
  }
  const accuracyM =
    raw.accuracyM == null ? null : Number(raw.accuracyM);
  if (accuracyM != null && (!Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > BREADCRUMB_MAX_ACCURACY_M)) {
    return { ok: false, reason: "accuracy_out_of_range" };
  }
  if (previous) {
    if (sequence <= previous.sequence) return { ok: false, reason: "sequence_not_increasing" };
    if (observedAt < previous.observedAt) return { ok: false, reason: "timestamp_not_monotonic" };
  }
  const speedMps = raw.speedMps == null ? null : Number(raw.speedMps);
  const headingDeg = raw.headingDeg == null ? null : Number(raw.headingDeg);
  const point = {
    sequence,
    observedAt,
    lat: roundCoord(raw.lat),
    lng: roundCoord(raw.lng),
  };
  if (accuracyM != null) point.accuracyM = Math.round(accuracyM * 10) / 10;
  if (Number.isFinite(speedMps) && speedMps >= 0) {
    point.speedMps = Math.round(speedMps * 100) / 100;
  }
  if (Number.isFinite(headingDeg)) {
    point.headingDeg = ((headingDeg % 360) + 360) % 360;
  }
  return { ok: true, point };
}

/**
 * Validate a full batch envelope (client or server).
 */
function validateBreadcrumbBatch(batch, { nowMs = Date.now() } = {}) {
  if (!batch || typeof batch !== "object") {
    return { ok: false, reason: "invalid_batch" };
  }
  const protocolVersion = Math.floor(Number(batch.protocolVersion));
  if (protocolVersion !== BREADCRUMB_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported_protocol" };
  }
  const rideId = String(batch.rideBinding?.rideId || batch.rideId || "").trim();
  const vehicleId = String(batch.rideBinding?.vehicleId || batch.vehicleId || "").trim();
  const driverId = String(batch.rideBinding?.driverId || batch.driverId || "").trim();
  const trackingSessionId = String(batch.trackingSessionId || "").trim();
  const assignmentSessionToken = String(batch.assignmentSessionToken || "").trim();
  const assignmentVersion = Math.floor(Number(batch.assignmentVersion) || 0);
  const batchSequence = Math.floor(Number(batch.batchSequence) || 0);
  if (!rideId || rideId.length > 128) return { ok: false, reason: "invalid_ride" };
  if (!vehicleId || vehicleId.length > 128) return { ok: false, reason: "invalid_vehicle" };
  if (!driverId || driverId.length > 128) return { ok: false, reason: "invalid_driver" };
  if (!trackingSessionId || trackingSessionId.length < 3 || trackingSessionId.length > 64) {
    return { ok: false, reason: "invalid_tracking_session" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trackingSessionId)) {
    return { ok: false, reason: "invalid_tracking_session" };
  }
  if (!isValidAssignmentSessionToken(assignmentSessionToken)) {
    return { ok: false, reason: "invalid_assignment_session_token" };
  }
  if (assignmentVersion < 1) return { ok: false, reason: "invalid_assignment_version" };
  if (batchSequence < 1) return { ok: false, reason: "invalid_batch_sequence" };

  const pointsIn = Array.isArray(batch.points) ? batch.points : null;
  if (!pointsIn || !pointsIn.length) return { ok: false, reason: "empty_points" };
  if (pointsIn.length > BREADCRUMB_MAX_BATCH_POINTS) {
    return { ok: false, reason: "too_many_points" };
  }

  const points = [];
  let previous = null;
  for (const raw of pointsIn) {
    const v = validateBreadcrumbPoint(raw, { nowMs, previous });
    if (!v.ok) return { ok: false, reason: v.reason };
    points.push(v.point);
    previous = v.point;
  }

  const firstFixSequence = points[0].sequence;
  const lastFixSequence = points[points.length - 1].sequence;
  const span = points[points.length - 1].observedAt - points[0].observedAt;
  if (span > BREADCRUMB_MAX_BATCH_SPAN_MS) {
    return { ok: false, reason: "batch_span_too_large" };
  }
  if (
    Number(batch.firstFixSequence) &&
    Math.floor(Number(batch.firstFixSequence)) !== firstFixSequence
  ) {
    return { ok: false, reason: "first_fix_mismatch" };
  }
  if (
    Number(batch.lastFixSequence) &&
    Math.floor(Number(batch.lastFixSequence)) !== lastFixSequence
  ) {
    return { ok: false, reason: "last_fix_mismatch" };
  }

  const normalized = {
    protocolVersion,
    rideBinding: { rideId, vehicleId, driverId },
    assignmentSessionToken,
    assignmentVersion,
    trackingSessionId,
    batchSequence,
    firstFixSequence,
    lastFixSequence,
    createdAtClient: Number(batch.createdAtClient) || nowMs,
    points,
    gapBefore: Boolean(batch.gapBefore),
  };

  const serialized = JSON.stringify(normalized);
  if (serialized.length > BREADCRUMB_MAX_BATCH_BYTES) {
    return { ok: false, reason: "batch_too_large", byteLength: serialized.length };
  }

  return { ok: true, batch: normalized, byteLength: serialized.length };
}

/**
 * Dense chord distance from validated consecutive raw points.
 * Does not invent segments across gaps.
 */
function accumulateDenseChordMeters(points, {
  previousAnchor = null,
  gapBefore = false,
  minSegmentM = BREADCRUMB_MIN_SEGMENT_M,
  maxSpeedMps = BREADCRUMB_MAX_SPEED_MPS,
} = {}) {
  let distanceM = 0;
  let accepted = 0;
  let rejected = 0;
  let anchor = gapBefore ? null : previousAnchor;
  let lastAccepted = previousAnchor;

  for (const p of points) {
    if (!anchor) {
      anchor = p;
      lastAccepted = p;
      accepted += 1;
      continue;
    }
    const dist = haversineMeters(anchor, p);
    const dt = Math.max(0, (Number(p.observedAt) || 0) - (Number(anchor.observedAt) || 0)) / 1000;
    if (!Number.isFinite(dist)) {
      rejected += 1;
      continue;
    }
    if (dist < minSegmentM) {
      // Stationary jitter — keep time advancing via lastAccepted but no distance.
      lastAccepted = p;
      accepted += 1;
      continue;
    }
    const speed = dt > 0 ? dist / dt : Infinity;
    if (speed > maxSpeedMps) {
      rejected += 1;
      // Do not bridge — reset anchor after impossible jump.
      anchor = p;
      lastAccepted = p;
      continue;
    }
    distanceM += dist;
    anchor = p;
    lastAccepted = p;
    accepted += 1;
  }

  return {
    distanceMeters: Math.round(distanceM * 100) / 100,
    acceptedPointCount: accepted,
    rejectedPointCount: rejected,
    lastAccepted,
  };
}

/**
 * Build a batch object from collected points.
 */
function buildBreadcrumbBatch({
  rideBinding,
  assignmentVersion,
  assignmentSessionToken,
  trackingSessionId,
  batchSequence,
  points,
  gapBefore = false,
  createdAtClient = Date.now(),
}) {
  const list = Array.isArray(points) ? points : [];
  return {
    protocolVersion: BREADCRUMB_PROTOCOL_VERSION,
    rideBinding,
    assignmentVersion,
    assignmentSessionToken,
    trackingSessionId,
    batchSequence,
    firstFixSequence: list[0]?.sequence ?? 0,
    lastFixSequence: list[list.length - 1]?.sequence ?? 0,
    createdAtClient,
    points: list,
    gapBefore: Boolean(gapBefore),
  };
}

function estimatePointBytes(point) {
  return JSON.stringify(point || {}).length;
}

module.exports = {
  BREADCRUMB_PROTOCOL_VERSION,
  BREADCRUMB_SAMPLE_INTERVAL_MS,
  BREADCRUMB_TARGET_UPLOAD_INTERVAL_MS,
  BREADCRUMB_TARGET_BATCH_POINTS,
  BREADCRUMB_MAX_BATCH_POINTS,
  BREADCRUMB_MAX_BATCH_BYTES,
  BREADCRUMB_MAX_QUEUE_POINTS,
  BREADCRUMB_MAX_QUEUE_BYTES,
  BREADCRUMB_QUEUE_RETENTION_MS,
  BREADCRUMB_MAX_BATCH_SPAN_MS,
  BREADCRUMB_MAX_POINT_AGE_MS,
  BREADCRUMB_MAX_FUTURE_SKEW_MS,
  BREADCRUMB_MAX_ACCURACY_M,
  BREADCRUMB_MIN_SEGMENT_M,
  BREADCRUMB_MAX_SPEED_MPS,
  BREADCRUMB_RETRY_BASE_MS,
  BREADCRUMB_RETRY_MAX_MS,
  BREADCRUMB_FINAL_FLUSH_TIMEOUT_MS,
  BREADCRUMB_MAX_UPLOADS_PER_WAKE,
  BREADCRUMB_COORD_DECIMALS,
  BREADCRUMB_DIAG,
  isValidAssignmentSessionToken,
  isValidLatLng,
  roundCoord,
  haversineMeters,
  assignmentVersionFromRide,
  assignmentVersionFromToken,
  validateBreadcrumbPoint,
  validateBreadcrumbBatch,
  accumulateDenseChordMeters,
  buildBreadcrumbBatch,
  estimatePointBytes,
};
