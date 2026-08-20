/**
 * Background driver location upload — scoped HMAC credential + HTTPS ingest.
 * Writes only vehicles/{vehicleId}; ride.driverLocation stays mirror CF owned.
 * Privacy: never log coordinates, tokens, or exact ride/driver IDs.
 */

"use strict";

const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");
const {
  LOCATION_DIAG,
  evaluateFixAgainstPrevious,
  isValidLatLng,
  isValidTrackingSessionId,
  normalizeLocationFix,
  timestampToMs,
  toVehicleLocationField,
} = require("./live-location-envelope");
const { gridCellId, hotspotIdForLocation } = require("./geo-cells");

const ACTIVE_RIDE_STATUSES = Object.freeze(["accepted", "arrived", "in_progress"]);
const APPROACH_STATUSES = Object.freeze(["accepted", "arrived"]);
const TRIP_STATUSES = Object.freeze(["in_progress"]);

/** Visible customer while P2P unavailable (native swipe-close path). */
const RESPONSIVE_INTERVAL_MS = 4_000;
/** Customer not watching — approach. */
const BACKGROUND_APPROACH_INTERVAL_MS = 60_000;
/** Customer not watching — trip. */
const BACKGROUND_TRIP_INTERVAL_MS = 30_000;

const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60_000;
const MIN_CREDENTIAL_TTL_MS = 5 * 60_000;
const MAX_CREDENTIAL_TTL_MS = 30 * 60_000;
const LOCATION_GRID_DEG = 0.009;
const PRESENCE_COLLECTION = "rideViewerPresence";

function readUploadSecret() {
  const secret = String(
    process.env.BACKGROUND_LOCATION_UPLOAD_SECRET ||
      process.env.BG_LOCATION_UPLOAD_SECRET ||
      ""
  ).trim();
  return secret || null;
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecodeToString(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function signPayload(secret, payloadJson) {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * @param {{
 *   driverUid: string,
 *   rideId: string,
 *   vehicleId: string,
 *   trackingSessionId: string,
 *   assignmentSessionToken: string,
 *   ttlMs?: number,
 *   nowMs?: number,
 *   secret?: string|null,
 * }} input
 */
function mintBackgroundLocationCredential(input = {}) {
  const secret = input.secret != null ? input.secret : readUploadSecret();
  if (!secret) {
    return { ok: false, reason: "SECRET_NOT_CONFIGURED" };
  }
  const driverUid = String(input.driverUid || "").trim();
  const rideId = String(input.rideId || "").trim();
  const vehicleId = String(input.vehicleId || "").trim();
  const trackingSessionId = String(input.trackingSessionId || "").trim();
  const assignmentSessionToken = String(input.assignmentSessionToken || "").trim();
  if (!driverUid || !rideId || !vehicleId || !assignmentSessionToken) {
    return { ok: false, reason: "INVALID_BINDING" };
  }
  if (!isValidTrackingSessionId(trackingSessionId)) {
    return { ok: false, reason: "INVALID_SESSION" };
  }
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  let ttlMs = Number(input.ttlMs);
  if (!Number.isFinite(ttlMs)) ttlMs = DEFAULT_CREDENTIAL_TTL_MS;
  ttlMs = Math.min(MAX_CREDENTIAL_TTL_MS, Math.max(MIN_CREDENTIAL_TTL_MS, Math.floor(ttlMs)));
  const exp = nowMs + ttlMs;
  const payload = {
    v: 1,
    uid: driverUid,
    rid: rideId,
    vid: vehicleId,
    sid: trackingSessionId,
    ast: assignmentSessionToken,
    iat: nowMs,
    exp,
  };
  const payloadJson = JSON.stringify(payload);
  const token = `${b64urlEncode(payloadJson)}.${signPayload(secret, payloadJson)}`;
  return {
    ok: true,
    token,
    expiresAtMs: exp,
    ttlMs,
    uploadPath: "/ingestBackgroundDriverLocation",
  };
}

/**
 * @param {string} token
 * @param {{ secret?: string|null, nowMs?: number }} [opts]
 */
function verifyBackgroundLocationCredential(token, opts = {}) {
  const secret = opts.secret != null ? opts.secret : readUploadSecret();
  if (!secret) return { ok: false, reason: "SECRET_NOT_CONFIGURED" };
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "INVALID_TOKEN" };
  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(parts[0]));
  } catch {
    return { ok: false, reason: "INVALID_TOKEN" };
  }
  const expected = signPayload(secret, JSON.stringify(payload));
  if (!timingSafeEqualStr(expected, parts[1])) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (!Number.isFinite(payload.exp) || nowMs >= Number(payload.exp)) {
    return { ok: false, reason: "TOKEN_EXPIRED" };
  }
  if (Number(payload.v) !== 1) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  const driverUid = String(payload.uid || "").trim();
  const rideId = String(payload.rid || "").trim();
  const vehicleId = String(payload.vid || "").trim();
  const trackingSessionId = String(payload.sid || "").trim();
  const assignmentSessionToken = String(payload.ast || "").trim();
  if (!driverUid || !rideId || !vehicleId || !assignmentSessionToken) {
    return { ok: false, reason: "INVALID_BINDING" };
  }
  if (!isValidTrackingSessionId(trackingSessionId)) {
    return { ok: false, reason: "INVALID_SESSION" };
  }
  return {
    ok: true,
    claims: {
      driverUid,
      rideId,
      vehicleId,
      trackingSessionId,
      assignmentSessionToken,
      issuedAtMs: Number(payload.iat) || 0,
      expiresAtMs: Number(payload.exp) || 0,
    },
  };
}

function presenceDocId(rideId, customerUid) {
  return `${String(rideId).trim()}_${String(customerUid).trim()}`;
}

function resolveViewerLeaseFromPresence(presenceData, nowMs) {
  if (!presenceData) return "UNKNOWN";
  const exp = timestampToMs(presenceData.expiresAt);
  if (!Number.isFinite(exp)) return "UNKNOWN";
  if (nowMs >= exp) return "EXPIRED";
  return "VISIBLE";
}

/**
 * Server-authoritative cadence when native path is active (P2P assumed unavailable).
 * Active rides always use responsive ~4s — presence lease does not slow fallback.
 */
function resolveBackgroundUploadIntervalMs({ rideStatus, viewerLease }) {
  void viewerLease;
  const status = String(rideStatus || "");
  if (TRIP_STATUSES.includes(status) || APPROACH_STATUSES.includes(status)) {
    return {
      intervalMs: RESPONSIVE_INTERVAL_MS,
      policy: "RESPONSIVE_FIREBASE",
      hardInterval: false,
    };
  }
  return {
    intervalMs: RESPONSIVE_INTERVAL_MS,
    policy: "RESPONSIVE_FIREBASE",
    hardInterval: false,
  };
}

function locationGridCell(lat, lng) {
  if (!isValidLatLng(lat, lng)) return null;
  return `${Math.floor(lat / LOCATION_GRID_DEG)}_${Math.floor(lng / LOCATION_GRID_DEG)}`;
}

function shouldAllowCadenceWrite({
  force = false,
  nowMs,
  lastWriteMs,
  intervalMs,
  hardInterval = false,
  movedEnough = true,
}) {
  if (force) return { allow: true, reason: "force" };
  const elapsed = Math.max(0, Number(nowMs) - Number(lastWriteMs || 0));
  const interval = Math.max(0, Number(intervalMs) || 0);
  if (!lastWriteMs || lastWriteMs <= 0) return { allow: true, reason: "first_write" };
  if (hardInterval) {
    if (elapsed < interval) return { allow: false, reason: "interval" };
    return { allow: true, reason: "hard_interval" };
  }
  if (elapsed >= interval) return { allow: true, reason: "interval" };
  if (movedEnough) return { allow: true, reason: "moved" };
  return { allow: false, reason: "interval" };
}

/**
 * Issue a short-lived upload credential for the assigned driver.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   driverUid: string,
 *   rideId: string,
 *   vehicleId: string,
 *   trackingSessionId: string,
 *   assignmentSessionToken?: string,
 *   ttlMs?: number,
 *   secret?: string|null,
 *   nowMs?: number,
 * }} input
 */
async function issueBackgroundLocationCredential(db, input = {}) {
  const driverUid = String(input.driverUid || "").trim();
  if (!driverUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  const rideId = String(input.rideId || "").trim();
  const vehicleId = String(input.vehicleId || "").trim();
  const trackingSessionId = String(input.trackingSessionId || "").trim();
  if (!rideId || !vehicleId || !isValidTrackingSessionId(trackingSessionId)) {
    const err = new Error("INVALID_ARGUMENT");
    err.code = "invalid-argument";
    throw err;
  }

  const [rideSnap, vehicleSnap] = await Promise.all([
    db.collection("rides").doc(rideId).get(),
    db.collection("vehicles").doc(vehicleId).get(),
  ]);
  if (!rideSnap.exists) {
    const err = new Error("RIDE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  if (!vehicleSnap.exists) {
    const err = new Error("VEHICLE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const ride = rideSnap.data() || {};
  const vehicle = vehicleSnap.data() || {};
  if (String(ride.driverId || "") !== driverUid) {
    const err = new Error("NOT_ASSIGNED_DRIVER");
    err.code = "permission-denied";
    throw err;
  }
  if (!ACTIVE_RIDE_STATUSES.includes(String(ride.status || ""))) {
    const err = new Error("RIDE_NOT_ACTIVE");
    err.code = "failed-precondition";
    throw err;
  }
  if (String(ride.vehicleId || "") !== vehicleId) {
    const err = new Error("VEHICLE_MISMATCH");
    err.code = "permission-denied";
    throw err;
  }
  if (String(vehicle.currentDriverId || vehicle.driverId || "") === driverUid) {
    /* ok */
  } else if (String(vehicle.linkedDriverId || "") === driverUid) {
    /* ok alternate field */
  } else {
    // Soft check — assignment on ride is authoritative; vehicle link may lag.
  }
  const assignmentSessionToken = String(
    input.assignmentSessionToken || ride.assignmentSessionToken || ""
  ).trim();
  if (!assignmentSessionToken) {
    const err = new Error("MISSING_ASSIGNMENT_TOKEN");
    err.code = "failed-precondition";
    throw err;
  }
  if (
    ride.assignmentSessionToken &&
    String(ride.assignmentSessionToken) !== assignmentSessionToken
  ) {
    const err = new Error("ASSIGNMENT_TOKEN_MISMATCH");
    err.code = "permission-denied";
    throw err;
  }

  const minted = mintBackgroundLocationCredential({
    driverUid,
    rideId,
    vehicleId,
    trackingSessionId,
    assignmentSessionToken,
    ttlMs: input.ttlMs,
    nowMs: input.nowMs,
    secret: input.secret,
  });
  if (!minted.ok) {
    const err = new Error(minted.reason || "MINT_FAILED");
    err.code =
      minted.reason === "SECRET_NOT_CONFIGURED" ? "failed-precondition" : "invalid-argument";
    throw err;
  }
  return {
    ok: true,
    token: minted.token,
    expiresAtMs: minted.expiresAtMs,
    ttlMs: minted.ttlMs,
    rideStatus: String(ride.status || ""),
    uploadPath: minted.uploadPath,
  };
}

/**
 * Ingest one native background fix. Canonical write: vehicles/{vehicleId} only.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   token: string,
 *   fix: object,
 *   force?: boolean,
 *   secret?: string|null,
 *   nowMs?: number,
 * }} input
 */
async function ingestBackgroundDriverLocation(db, input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const verified = verifyBackgroundLocationCredential(input.token, {
    secret: input.secret,
    nowMs,
  });
  if (!verified.ok) {
    return { ok: false, accepted: false, reason: verified.reason };
  }
  const claims = verified.claims;
  const sequence = Math.max(1, Math.floor(Number(input.fix?.sequence) || 0));
  if (!sequence) {
    return { ok: false, accepted: false, reason: LOCATION_DIAG.INVALID };
  }

  const normalized = normalizeLocationFix(input.fix || {}, {
    sessionId: claims.trackingSessionId,
    sequence,
    nowMs,
  });
  if (!normalized.ok || !normalized.envelope) {
    return { ok: false, accepted: false, reason: normalized.reason || LOCATION_DIAG.INVALID };
  }

  const rideRef = db.collection("rides").doc(claims.rideId);
  const vehicleRef = db.collection("vehicles").doc(claims.vehicleId);

  const result = await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) {
      return { ok: false, accepted: false, reason: "RIDE_NOT_FOUND" };
    }
    const ride = rideSnap.data() || {};
    if (String(ride.driverId || "") !== claims.driverUid) {
      return { ok: false, accepted: false, reason: "NOT_ASSIGNED_DRIVER" };
    }
    if (!ACTIVE_RIDE_STATUSES.includes(String(ride.status || ""))) {
      return { ok: false, accepted: false, reason: "RIDE_NOT_ACTIVE" };
    }
    if (String(ride.vehicleId || "") !== claims.vehicleId) {
      return { ok: false, accepted: false, reason: "VEHICLE_MISMATCH" };
    }
    if (
      String(ride.assignmentSessionToken || "") &&
      String(ride.assignmentSessionToken) !== claims.assignmentSessionToken
    ) {
      return { ok: false, accepted: false, reason: "ASSIGNMENT_TOKEN_MISMATCH" };
    }

    // Native HTTPS ingest does not read rideViewerPresence. Authorization uses the
    // HMAC credential + ride/vehicle binding above; cadence uses responsive 4s policy
    // regardless of viewer lease (client checkpoint policy owns lease semantics).
    const viewerLease = "UNKNOWN";

    const vehicleSnap = await tx.get(vehicleRef);
    if (!vehicleSnap.exists) {
      return { ok: false, accepted: false, reason: "VEHICLE_NOT_FOUND" };
    }
    const vehicle = vehicleSnap.data() || {};
    const vehicleSessionId = claims.trackingSessionId;
    const prevLoc = vehicle.location || null;
    const previous =
      prevLoc &&
      isValidLatLng(prevLoc.lat, prevLoc.lng) &&
      String(prevLoc.sessionId || "") === vehicleSessionId
        ? {
            lat: prevLoc.lat,
            lng: prevLoc.lng,
            observedAt: Number(prevLoc.observedAt) || 0,
            sequence: Number(prevLoc.sequence) || 0,
            sessionId: String(prevLoc.sessionId || ""),
            accuracyM: prevLoc.accuracyM != null ? Number(prevLoc.accuracyM) : null,
            headingDeg: prevLoc.headingDeg != null ? Number(prevLoc.headingDeg) : null,
            speedMps: prevLoc.speedMps != null ? Number(prevLoc.speedMps) : null,
          }
        : null;

    const vehicleSessionStartedMs = timestampToMs(vehicle.trackingSessionStartedAt) || nowMs;
    const gate = evaluateFixAgainstPrevious(previous, normalized.envelope, {
      enforceSessionConsistency: true,
      vehicleSessionId,
      vehicleSessionStartedMs,
      previousSessionStartedMs: previous ? vehicleSessionStartedMs : 0,
    });
    if (!gate.accept) {
      return { ok: true, accepted: false, reason: gate.reason, viewerLease };
    }

    const cadence = resolveBackgroundUploadIntervalMs({
      rideStatus: ride.status,
      viewerLease,
    });
    const lastWriteMs = timestampToMs(vehicle.locationUpdatedAt) || 0;
    let movedEnough = true;
    if (previous && isValidLatLng(previous.lat, previous.lng)) {
      const dLat = ((normalized.envelope.lat - previous.lat) * Math.PI) / 180;
      const dLng = ((normalized.envelope.lng - previous.lng) * Math.PI) / 180;
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((previous.lat * Math.PI) / 180) *
          Math.cos((normalized.envelope.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const meters = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
      movedEnough = meters >= 25;
    }
    const writeGate = shouldAllowCadenceWrite({
      force: Boolean(input.force),
      nowMs,
      lastWriteMs,
      intervalMs: cadence.intervalMs,
      hardInterval: cadence.hardInterval,
      movedEnough,
    });
    if (!writeGate.allow) {
      return {
        ok: true,
        accepted: false,
        reason: "CADENCE_SKIP",
        viewerLease,
        policy: cadence.policy,
        intervalMs: cadence.intervalMs,
      };
    }

    const location = toVehicleLocationField(normalized.envelope);
    location.source = "native_background";
    const lat = normalized.envelope.lat;
    const lng = normalized.envelope.lng;
    const patch = {
      location,
      locationUpdatedAt: FieldValue.serverTimestamp(),
      trackingSessionId: claims.trackingSessionId,
      locationGridCell: locationGridCell(lat, lng),
      status: "in_ride",
      activeRideId: claims.rideId,
      backgroundLocationUploadAt: FieldValue.serverTimestamp(),
    };
    const geoCell = gridCellId(lat, lng);
    if (geoCell) patch.geoCell = geoCell;
    patch.hotspotId = hotspotIdForLocation(lat, lng) || null;
    if (!vehicle.trackingSessionStartedAt) {
      patch.trackingSessionStartedAt = FieldValue.serverTimestamp();
    }

    tx.update(vehicleRef, patch);
    return {
      ok: true,
      accepted: true,
      reason: LOCATION_DIAG.ACCEPTED,
      viewerLease,
      policy: cadence.policy,
      intervalMs: cadence.intervalMs,
      sequence: normalized.envelope.sequence,
    };
  });

  return result;
}

module.exports = {
  ACTIVE_RIDE_STATUSES,
  RESPONSIVE_INTERVAL_MS,
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  DEFAULT_CREDENTIAL_TTL_MS,
  mintBackgroundLocationCredential,
  verifyBackgroundLocationCredential,
  resolveBackgroundUploadIntervalMs,
  shouldAllowCadenceWrite,
  resolveViewerLeaseFromPresence,
  presenceDocId,
  issueBackgroundLocationCredential,
  ingestBackgroundDriverLocation,
  readUploadSecret,
};
