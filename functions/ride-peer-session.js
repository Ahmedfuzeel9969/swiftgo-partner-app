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
  return `ps_${Date.now().toString(36)}_${crypto.randomBytes(16).toString("hex")}`;
}

/** Stable non-secret offer identity used only for stale signaling rejection. */
function offerFingerprint(sdp) {
  return `sha256_${crypto.createHash("sha256").update(String(sdp || "")).digest("hex")}`;
}

/**
 * Firestore transactions are mandatory in production. The tiny adapter keeps
 * dependency-free unit-test databases working without weakening production.
 */
function runTransaction(db, worker) {
  if (typeof db?.runTransaction === "function") return db.runTransaction(worker);
  return worker({
    get: (ref) => ref.get(),
    set: (ref, data, options) => ref.set(data, options),
  });
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
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rideId)) {
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

  const now = Date.now();
  const rideRef = db.collection("rides").doc(rideId);
  const ref = db.collection("ridePeerSessions").doc(rideId);
  let assignmentVersion = 0;
  let payload = null;
  await runTransaction(db, async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) {
      const err = new Error("RIDE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }
    const ride = rideSnap.data() || {};
    assertTrackableRide(ride, driverUid, "driver");
    // Compare-and-swap: a delayed upload cannot replace a newer offer. The public
    // callable requires a revision; omission is only for internal legacy fixtures.
    if (typeof input.expectedPeerSessionId === "string") {
      const previous = await tx.get(ref);
      const data = previous.exists ? previous.data() : {};
      if (String(data.sessionId || "") !== input.expectedPeerSessionId ||
          String(data.offerFingerprint || "") !== String(input.expectedOfferFingerprint || "")) {
        const err = new Error("OFFER_REVISION_CHANGED"); err.code = "aborted"; throw err;
      }
    }
    if (ride.assignmentSessionToken && input.assignmentId !== ride.assignmentSessionToken) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }
    if (input?.vehicleId && ride.vehicleId && String(input.vehicleId) !== String(ride.vehicleId)) {
      const err = new Error("VEHICLE_MISMATCH");
      err.code = "permission-denied";
      throw err;
    }

    assignmentVersion = assignmentVersionFromRide(ride);
    const clientAv = Math.floor(Number(input?.assignmentVersion) || 0);
    if (clientAv && clientAv !== assignmentVersion) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }

    payload = {
      rideId,
      driverId: driverUid,
      customerId: String(ride.userId || ""),
      vehicleId: String(ride.vehicleId || ""),
      sessionId: peerSessionId,
      trackingSessionId,
      assignmentVersion,
      assignmentId: String(ride.assignmentSessionToken || ""),
      state: "offer_ready",
      offer: offerSdp,
      offerFingerprint: offerFingerprint(offerSdp),
      answer: null,
      answeredOfferFingerprint: null,
      protocolVersion: P2P_PROTOCOL_VERSION,
      initiatorRole: "driver",
      createdAt: new Date(now),
      updatedAt: new Date(now),
      expiresAt: new Date(now + P2P_SESSION_TTL_MS),
    };
    // Ignore any client-supplied createdAt/expiresAt/updatedAt.
    tx.set(ref, payload);
  });

  return {
    ok: true,
    rideId,
    sessionId: peerSessionId,
    assignmentVersion,
    expiresAtMs: now + P2P_SESSION_TTL_MS,
    protocolVersion: P2P_PROTOCOL_VERSION,
    offerFingerprint: payload.offerFingerprint,
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
  const expectedOfferFingerprint = String(input?.offerFingerprint || "").trim();

  if (!customerUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rideId)) {
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

  const rideRef = db.collection("rides").doc(rideId);
  const ref = db.collection("ridePeerSessions").doc(rideId);
  const now = Date.now();
  await runTransaction(db, async (tx) => {
    const [rideSnap, snap] = await Promise.all([tx.get(rideRef), tx.get(ref)]);
    if (!rideSnap.exists) {
      const err = new Error("RIDE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }
    const ride = rideSnap.data() || {};
    assertTrackableRide(ride, customerUid, "customer");
    if (!snap.exists) {
      const err = new Error("SESSION_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }
    const sess = snap.data() || {};
    if (sess.state === "closed") {
      const err = new Error("SESSION_CLOSED");
      err.code = "failed-precondition";
      throw err;
    }
    const exp = sess.expiresAt?.toMillis?.() ||
      (sess.expiresAt instanceof Date ? sess.expiresAt.getTime() : Number(sess.expiresAt));
    if (!Number.isFinite(exp) || now >= exp) {
      const err = new Error("SESSION_EXPIRED");
      err.code = "failed-precondition";
      throw err;
    }
    if (String(sess.sessionId || "") !== peerSessionId) {
      const err = new Error("ROTATED_SESSION");
      err.code = "failed-precondition";
      throw err;
    }
    const currentOfferFingerprint = String(
      sess.offerFingerprint || offerFingerprint(sess.offer || "")
    );
    if (currentOfferFingerprint.startsWith("sha256_") && !expectedOfferFingerprint) {
      const err = new Error("OFFER_IDENTITY_REQUIRED");
      err.code = "invalid-argument";
      throw err;
    }
    if (expectedOfferFingerprint && expectedOfferFingerprint !== currentOfferFingerprint) {
      const err = new Error("ROTATED_OFFER");
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
    if (ride.assignmentSessionToken && sess.assignmentId !== ride.assignmentSessionToken) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }
    if (Math.floor(Number(sess.assignmentVersion) || 0) !== expectedAv) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }

    tx.set(ref, {
      answer: answerSdp,
      answeredOfferFingerprint: currentOfferFingerprint,
      state: "answer_ready",
      updatedAt: new Date(now),
      // Refresh TTL only when peers actively signal (long-ride stability; no polling).
      expiresAt: new Date(now + P2P_SESSION_TTL_MS),
    }, { merge: true });
  });

  return { ok: true, rideId, sessionId: peerSessionId };
}

/** Driver renews the lease without renegotiating a healthy transport. */
async function renewRidePeerSession(db, input, { nowMs = Date.now } = {}) {
  const uid = String(input?.uid || "");
  const rideId = String(input?.rideId || "");
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  if (!uid) fail("unauthenticated", "AUTH_REQUIRED");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rideId) || !isValidPeerSessionId(input?.peerSessionId) || !input?.offerFingerprint) {
    fail("invalid-argument", "SESSION_IDENTITY_REQUIRED");
  }
  const ref = db.collection("ridePeerSessions").doc(rideId), now = nowMs();
  return db.runTransaction(async (tx) => {
    const [rideSnap, sessionSnap] = await Promise.all([tx.get(db.collection("rides").doc(rideId)), tx.get(ref)]);
    const ride = rideSnap.exists ? rideSnap.data() : null;
    assertTrackableRide(ride, uid, "driver");
    const session = sessionSnap.exists ? sessionSnap.data() : null;
    if (!session || session.state === "closed") fail("failed-precondition", "SESSION_CLOSED");
    if (session.sessionId !== input.peerSessionId || session.offerFingerprint !== input.offerFingerprint) fail("failed-precondition", "ROTATED_SESSION");
    if (!ride.assignmentSessionToken || session.assignmentId !== ride.assignmentSessionToken || input.assignmentId !== ride.assignmentSessionToken ||
        session.driverId !== ride.driverId || session.customerId !== ride.userId || session.vehicleId !== ride.vehicleId) fail("failed-precondition", "STALE_ASSIGNMENT");
    const expires = session.expiresAt?.toMillis?.() || Number(session.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) fail("failed-precondition", "SESSION_EXPIRED");
    // Idempotent retries/snapshot echoes do not extend or write every time.
    if (expires - now > 5 * 60000) return { ok: true, expiresAtMs: expires, unchanged: true };
    const expiresAtMs = now + P2P_SESSION_TTL_MS;
    tx.set(ref, { expiresAt: new Date(expiresAtMs), updatedAt: new Date(now) }, { merge: true });
    return { ok: true, expiresAtMs };
  });
}

/** Current driver can acquire a revision even when the stored SDP belongs to
 * a retired assignment. Only opaque concurrency metadata, never SDP, is returned. */
async function getRidePeerOfferRevision(db, input) {
  const uid = String(input?.uid || ""), rideId = String(input?.rideId || "");
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(rideId)) {
    const err = new Error("INVALID_AUTH_OR_RIDE"); err.code = uid ? "invalid-argument" : "unauthenticated"; throw err;
  }
  return db.runTransaction(async (tx) => {
    const [rideSnap, peerSnap] = await Promise.all([tx.get(db.collection("rides").doc(rideId)), tx.get(db.collection("ridePeerSessions").doc(rideId))]);
    const ride = rideSnap.exists ? rideSnap.data() : null;
    assertTrackableRide(ride, uid, "driver");
    if (!ride.assignmentSessionToken || input.assignmentId !== ride.assignmentSessionToken) {
      const err = new Error("STALE_ASSIGNMENT"); err.code = "failed-precondition"; throw err;
    }
    const previous = peerSnap.exists ? peerSnap.data() : {};
    return { expectedPeerSessionId: String(previous.sessionId || ""), expectedOfferFingerprint: String(previous.offerFingerprint || "") };
  });
}

async function closeRidePeerSession(db, input) {
  const uid = String(input?.uid || "").trim();
  const rideId = String(input?.rideId || "").trim();
  const expectedPeerSessionId = String(input?.peerSessionId || "").trim();
  const expectedOfferFingerprint = String(input?.offerFingerprint || "").trim();
  if (!uid || !rideId) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  const rideRef = db.collection("rides").doc(rideId);
  const ref = db.collection("ridePeerSessions").doc(rideId);
  const now = Date.now();
  let result = { ok: true };
  await runTransaction(db, async (tx) => {
    const [rideSnap, currentSnap] = await Promise.all([tx.get(rideRef), tx.get(ref)]);
    if (!currentSnap.exists) return;
    const ride = rideSnap.exists ? rideSnap.data() || {} : null;
    const current = currentSnap.data() || {};
    const participant = ride
      ? String(ride.driverId || "") === uid || String(ride.userId || "") === uid
      : String(current.driverId || "") === uid || String(current.customerId || "") === uid;
    if (!participant) {
      const err = new Error("NOT_PARTICIPANT");
      err.code = "permission-denied";
      throw err;
    }

    const currentFingerprint = String(
      current.offerFingerprint || offerFingerprint(current.offer || "")
    );
    if (currentFingerprint.startsWith("sha256_") && (!expectedPeerSessionId || !expectedOfferFingerprint)) {
      const err = new Error("SESSION_IDENTITY_REQUIRED"); err.code = "invalid-argument"; throw err;
    }
    if (
      (expectedPeerSessionId && String(current.sessionId || "") !== expectedPeerSessionId) ||
      (expectedOfferFingerprint && currentFingerprint !== expectedOfferFingerprint)
    ) {
      result = { ok: true, skipped: true, reason: "NEWER_SIGNALING_EXISTS" };
      return;
    }

    tx.set(ref, {
      state: "closed",
      offer: null,
      answer: null,
      updatedAt: new Date(now),
      expiresAt: new Date(now),
    }, { merge: true });
  });
  return result;
}

module.exports = {
  P2P_PROTOCOL_VERSION,
  P2P_SESSION_TTL_MS,
  P2P_MAX_SDP_CHARS,
  isValidPeerSessionId,
  createPeerSessionId,
  assignmentVersionFromRide,
  offerFingerprint,
  createRidePeerOffer,
  publishRidePeerAnswer,
  closeRidePeerSession,
  renewRidePeerSession,
  getRidePeerOfferRevision,
};
