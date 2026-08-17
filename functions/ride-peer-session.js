/**
 * Phase 3 — server-authoritative P2P signaling for assigned ride peers.
 * Collection: ridePeerSessions/{rideId}
 * Clients cannot forge timestamps; SDP size capped; list denied in rules.
 */

"use strict";

const crypto = require("crypto");

const P2P_PROTOCOL_VERSION = 1;
const P2P_SESSION_TTL_MS = 15 * 60_000;
const P2P_MAX_SDP_CHARS = 16_384;
const TRACKABLE = new Set(["accepted", "arrived", "in_progress"]);

function isValidPeerSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 8 && s.length <= 96 && /^[A-Za-z0-9_-]+$/.test(s);
}

function isValidTrackingSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 3 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

function createPeerSessionId() {
  return `ps_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("hex")}`;
}

function assertTrackableRide(ride, uid, role) {
  if (!ride) {
    const err = new Error("RIDE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const status = String(ride.status || "");
  if (!TRACKABLE.has(status)) {
    const err = new Error("RIDE_NOT_TRACKABLE");
    err.code = "failed-precondition";
    throw err;
  }
  if (role === "driver") {
    if (String(ride.driverId || "") !== uid) {
      const err = new Error("NOT_RIDE_DRIVER");
      err.code = "permission-denied";
      throw err;
    }
  } else if (role === "customer") {
    if (String(ride.userId || "") !== uid) {
      const err = new Error("NOT_RIDE_CUSTOMER");
      err.code = "permission-denied";
      throw err;
    }
  }
}

function assignmentVersionFromRide(ride) {
  // Bind to assignment identity — bump when driver/vehicle changes (not status).
  const raw = `${ride.driverId || ""}|${ride.vehicleId || ""}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return Math.max(1, h % 1_000_000_000);
}

/**
 * Driver publishes bundled offer (non-trickle).
 */
async function createRidePeerOffer(db, input) {
  const driverUid = String(input?.driverUid || "").trim();
  const rideId = String(input?.rideId || "").trim();
  const offerSdp = String(input?.offerSdp || "");
  const trackingSessionId = String(input?.trackingSessionId || "").trim();
  let peerSessionId = String(input?.peerSessionId || "").trim();

  if (!driverUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  if (!rideId || rideId.length > 128) {
    const err = new Error("INVALID_RIDE_ID");
    err.code = "invalid-argument";
    throw err;
  }
  if (!offerSdp || offerSdp.length > P2P_MAX_SDP_CHARS) {
    const err = new Error("INVALID_OR_OVERSIZED_SDP");
    err.code = "invalid-argument";
    throw err;
  }
  if (!isValidTrackingSessionId(trackingSessionId)) {
    const err = new Error("INVALID_TRACKING_SESSION");
    err.code = "invalid-argument";
    throw err;
  }
  if (peerSessionId && !isValidPeerSessionId(peerSessionId)) {
    const err = new Error("INVALID_PEER_SESSION");
    err.code = "invalid-argument";
    throw err;
  }
  if (!peerSessionId) peerSessionId = createPeerSessionId();

  const rideSnap = await db.collection("rides").doc(rideId).get();
  if (!rideSnap.exists) {
    const err = new Error("RIDE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const ride = rideSnap.data() || {};
  assertTrackableRide(ride, driverUid, "driver");
  if (input?.vehicleId && ride.vehicleId && String(input.vehicleId) !== String(ride.vehicleId)) {
    const err = new Error("VEHICLE_MISMATCH");
    err.code = "permission-denied";
    throw err;
  }

  const now = Date.now();
  const assignmentVersion = assignmentVersionFromRide(ride);
  const clientAv = Math.floor(Number(input?.assignmentVersion) || 0);
  if (clientAv && clientAv !== assignmentVersion) {
    const err = new Error("STALE_ASSIGNMENT");
    err.code = "failed-precondition";
    throw err;
  }

  const ref = db.collection("ridePeerSessions").doc(rideId);
  const payload = {
    rideId,
    driverId: driverUid,
    customerId: String(ride.userId || ""),
    vehicleId: String(ride.vehicleId || ""),
    sessionId: peerSessionId,
    trackingSessionId,
    assignmentVersion,
    state: "offer_ready",
    offer: offerSdp,
    answer: null,
    protocolVersion: P2P_PROTOCOL_VERSION,
    initiatorRole: "driver",
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt: new Date(now + P2P_SESSION_TTL_MS),
  };
  // Ignore any client-supplied createdAt/expiresAt/updatedAt.
  await ref.set(payload);

  return {
    ok: true,
    rideId,
    sessionId: peerSessionId,
    assignmentVersion,
    expiresAtMs: now + P2P_SESSION_TTL_MS,
    protocolVersion: P2P_PROTOCOL_VERSION,
  };
}

/**
 * Customer publishes bundled answer for the current offer session.
 */
async function publishRidePeerAnswer(db, input) {
  const customerUid = String(input?.customerUid || "").trim();
  const rideId = String(input?.rideId || "").trim();
  const answerSdp = String(input?.answerSdp || "");
  const peerSessionId = String(input?.peerSessionId || "").trim();

  if (!customerUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  if (!rideId) {
    const err = new Error("INVALID_RIDE_ID");
    err.code = "invalid-argument";
    throw err;
  }
  if (!answerSdp || answerSdp.length > P2P_MAX_SDP_CHARS) {
    const err = new Error("INVALID_OR_OVERSIZED_SDP");
    err.code = "invalid-argument";
    throw err;
  }
  if (!isValidPeerSessionId(peerSessionId)) {
    const err = new Error("INVALID_PEER_SESSION");
    err.code = "invalid-argument";
    throw err;
  }

  const rideSnap = await db.collection("rides").doc(rideId).get();
  if (!rideSnap.exists) {
    const err = new Error("RIDE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const ride = rideSnap.data() || {};
  assertTrackableRide(ride, customerUid, "customer");

  const ref = db.collection("ridePeerSessions").doc(rideId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("SESSION_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const sess = snap.data() || {};
  const now = Date.now();
  const exp = sess.expiresAt?.toMillis?.() || (sess.expiresAt instanceof Date ? sess.expiresAt.getTime() : Number(sess.expiresAt));
  if (Number.isFinite(exp) && now >= exp) {
    const err = new Error("SESSION_EXPIRED");
    err.code = "failed-precondition";
    throw err;
  }
  if (String(sess.sessionId || "") !== peerSessionId) {
    const err = new Error("ROTATED_SESSION");
    err.code = "failed-precondition";
    throw err;
  }
  if (String(sess.customerId || "") !== customerUid) {
    const err = new Error("NOT_SESSION_CUSTOMER");
    err.code = "permission-denied";
    throw err;
  }
  if (Number(sess.protocolVersion) !== P2P_PROTOCOL_VERSION) {
    const err = new Error("UNKNOWN_PROTOCOL");
    err.code = "invalid-argument";
    throw err;
  }
  const expectedAv = assignmentVersionFromRide(ride);
  if (Math.floor(Number(sess.assignmentVersion) || 0) !== expectedAv) {
    const err = new Error("STALE_ASSIGNMENT");
    err.code = "failed-precondition";
    throw err;
  }

  await ref.set(
    {
      answer: answerSdp,
      state: "answer_ready",
      updatedAt: new Date(now),
      // Refresh TTL only when peers actively signal (long-ride stability; no polling).
      expiresAt: new Date(now + P2P_SESSION_TTL_MS),
    },
    { merge: true }
  );

  return { ok: true, rideId, sessionId: peerSessionId };
}

async function closeRidePeerSession(db, input) {
  const uid = String(input?.uid || "").trim();
  const rideId = String(input?.rideId || "").trim();
  if (!uid || !rideId) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  const rideSnap = await db.collection("rides").doc(rideId).get();
  const ride = rideSnap.exists ? rideSnap.data() || {} : null;
  if (
    ride &&
    String(ride.driverId || "") !== uid &&
    String(ride.userId || "") !== uid
  ) {
    const err = new Error("NOT_PARTICIPANT");
    err.code = "permission-denied";
    throw err;
  }
  const ref = db.collection("ridePeerSessions").doc(rideId);
  const now = Date.now();
  await ref.set(
    {
      state: "closed",
      offer: null,
      answer: null,
      updatedAt: new Date(now),
      expiresAt: new Date(now),
    },
    { merge: true }
  );
  return { ok: true };
}

module.exports = {
  P2P_PROTOCOL_VERSION,
  P2P_SESSION_TTL_MS,
  P2P_MAX_SDP_CHARS,
  isValidPeerSessionId,
  createPeerSessionId,
  assignmentVersionFromRide,
  createRidePeerOffer,
  publishRidePeerAnswer,
  closeRidePeerSession,
};
