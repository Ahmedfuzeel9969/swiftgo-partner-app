/**
 * Native Android P2P hand-off transport.
 *
 * Firebase Auth is used only while the WebView is alive to mint a short-lived,
 * assignment-bound HMAC capability.  A foreground service can then poll the
 * existing Firestore signaling document after the WebView dies without storing
 * a Firebase refresh token.  Location is never relayed by this signaling API;
 * customer Firebase fallback is a separate, admin-gated action.
 */
"use strict";

const crypto = require("crypto");
const {
  createRidePeerOffer,
  publishRidePeerAnswer,
  closeRidePeerSession,
  getRidePeerOfferRevision,
  assignmentVersionFromRide,
  P2P_MAX_SDP_CHARS,
} = require("./ride-peer-session");
const { publishCustomerRideLocation } = require("./customer-location");

const ACTIVE = new Set(["accepted", "arrived", "in_progress"]);
const TOKEN_TTL_MS = 30 * 60_000;
const MIN_TOKEN_TTL_MS = 5 * 60_000;
const MAX_TOKEN_TTL_MS = 30 * 60_000;
const NATIVE_SIGNAL_PATH = "/nativeRidePeerTransport";

function readSecret() {
  const value = String(
    process.env.BACKGROUND_LOCATION_UPLOAD_SECRET ||
    process.env.BG_LOCATION_UPLOAD_SECRET || ""
  ).trim();
  return value || null;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signature(secret, json) {
  return crypto.createHmac("sha256", secret).update(json).digest("base64url");
}

function equal(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validId(value, max = 256) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function validRole(value) {
  return value === "driver" || value === "customer";
}

function mintNativeP2pCredential(input = {}, opts = {}) {
  const secret = opts.secret !== undefined ? opts.secret : readSecret();
  if (!secret) return { ok: false, reason: "SECRET_NOT_CONFIGURED" };
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const role = String(input.role || "");
  const uid = String(input.uid || "").trim();
  const rideId = String(input.rideId || "").trim();
  const vehicleId = String(input.vehicleId || "").trim();
  const assignmentId = String(input.assignmentId || "").trim();
  const trackingSessionId = String(input.trackingSessionId || "").trim();
  if (!validRole(role) || !validId(uid) || !validId(rideId, 128) ||
      !validId(vehicleId) || !validId(assignmentId) ||
      (role === "driver" && !validId(trackingSessionId, 64))) {
    return { ok: false, reason: "INVALID_BINDING" };
  }
  let ttl = Number(input.ttlMs);
  if (!Number.isFinite(ttl)) ttl = TOKEN_TTL_MS;
  ttl = Math.max(MIN_TOKEN_TTL_MS, Math.min(MAX_TOKEN_TTL_MS, Math.floor(ttl)));
  const payload = {
    v: 1,
    scope: "native_p2p",
    role,
    uid,
    rid: rideId,
    vid: vehicleId,
    ast: assignmentId,
    sid: trackingSessionId,
    av: Math.max(1, Math.floor(Number(input.assignmentVersion) || 1)),
    iat: now,
    exp: now + ttl,
  };
  const json = JSON.stringify(payload);
  return {
    ok: true,
    token: `${encode(json)}.${signature(secret, json)}`,
    expiresAtMs: payload.exp,
    ttlMs: ttl,
    signalPath: NATIVE_SIGNAL_PATH,
  };
}

function verifyNativeP2pCredential(token, opts = {}) {
  const secret = opts.secret !== undefined ? opts.secret : readSecret();
  if (!secret) return { ok: false, reason: "SECRET_NOT_CONFIGURED" };
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "INVALID_TOKEN" };
  let payload;
  try { payload = JSON.parse(decode(parts[0])); }
  catch { return { ok: false, reason: "INVALID_TOKEN" }; }
  const json = JSON.stringify(payload);
  if (!equal(signature(secret, json), parts[1])) return { ok: false, reason: "INVALID_SIGNATURE" };
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (payload.v !== 1 || payload.scope !== "native_p2p") return { ok: false, reason: "UNSUPPORTED_VERSION" };
  if (!Number.isFinite(payload.exp) || now >= payload.exp) return { ok: false, reason: "TOKEN_EXPIRED" };
  const claims = {
    role: String(payload.role || ""), uid: String(payload.uid || ""),
    rideId: String(payload.rid || ""), vehicleId: String(payload.vid || ""),
    assignmentId: String(payload.ast || ""), trackingSessionId: String(payload.sid || ""),
    assignmentVersion: Math.floor(Number(payload.av) || 0),
    issuedAtMs: Number(payload.iat) || 0, expiresAtMs: Number(payload.exp) || 0,
  };
  if (!validRole(claims.role) || !validId(claims.uid) || !validId(claims.rideId, 128) ||
      !validId(claims.vehicleId) || !validId(claims.assignmentId) ||
      claims.assignmentVersion < 1 ||
      (claims.role === "driver" && !validId(claims.trackingSessionId, 64))) {
    return { ok: false, reason: "INVALID_BINDING" };
  }
  return { ok: true, claims };
}

function fail(message, code = "failed-precondition") {
  const error = new Error(message); error.code = code; throw error;
}

async function readBoundRide(db, claims) {
  const snap = await db.collection("rides").doc(claims.rideId).get();
  if (!snap.exists) fail("RIDE_NOT_FOUND", "not-found");
  const ride = snap.data() || {};
  if (!ACTIVE.has(String(ride.status || ""))) fail("RIDE_NOT_ACTIVE");
  if (String(ride.driverId || "") === "" || String(ride.userId || "") === "") fail("RIDE_PARTICIPANTS_MISSING");
  const expectedUid = claims.role === "driver" ? ride.driverId : ride.userId;
  if (String(expectedUid) !== claims.uid) fail("NOT_PARTICIPANT", "permission-denied");
  if (String(ride.vehicleId || "") !== claims.vehicleId ||
      String(ride.assignmentSessionToken || "") !== claims.assignmentId ||
      assignmentVersionFromRide(ride) !== claims.assignmentVersion) {
    fail("STALE_ASSIGNMENT");
  }
  return ride;
}

async function issueNativeP2pCredential(db, input = {}, opts = {}) {
  const uid = String(input.uid || "").trim();
  const role = String(input.role || "");
  const rideId = String(input.rideId || "").trim();
  if (!uid) fail("AUTH_REQUIRED", "unauthenticated");
  if (!validRole(role) || !validId(rideId, 128)) fail("INVALID_ARGUMENT", "invalid-argument");
  const snap = await db.collection("rides").doc(rideId).get();
  if (!snap.exists) fail("RIDE_NOT_FOUND", "not-found");
  const ride = snap.data() || {};
  if (!ACTIVE.has(String(ride.status || ""))) fail("RIDE_NOT_ACTIVE");
  if (String(role === "driver" ? ride.driverId : ride.userId) !== uid) fail("NOT_PARTICIPANT", "permission-denied");
  const assignmentId = String(ride.assignmentSessionToken || "");
  const vehicleId = String(ride.vehicleId || "");
  if (!assignmentId || !vehicleId ||
      (input.assignmentId && input.assignmentId !== assignmentId) ||
      (input.vehicleId && input.vehicleId !== vehicleId)) fail("STALE_ASSIGNMENT");
  const minted = mintNativeP2pCredential({
    role, uid, rideId, vehicleId, assignmentId,
    trackingSessionId: role === "driver" ? String(input.trackingSessionId || "") : "",
    assignmentVersion: assignmentVersionFromRide(ride), ttlMs: input.ttlMs,
  }, opts);
  if (!minted.ok) return minted;
  return { ...minted, role, rideId, vehicleId, assignmentId,
    assignmentVersion: assignmentVersionFromRide(ride) };
}

function safeSession(session, role, nowMs = Date.now()) {
  const expiresAtMs = session?.expiresAt?.toMillis?.() ||
    (session?.expiresAt instanceof Date ? session.expiresAt.getTime() : Number(session?.expiresAt));
  if (!session || session.state === "closed" || Number(session.protocolVersion) !== 1 ||
      !Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) return null;
  const base = {
    rideId: String(session.rideId || ""), sessionId: String(session.sessionId || ""),
    trackingSessionId: String(session.trackingSessionId || ""),
    assignmentVersion: Math.floor(Number(session.assignmentVersion) || 0),
    assignmentId: String(session.assignmentId || ""), state: String(session.state || ""),
    offerFingerprint: String(session.offerFingerprint || ""),
    answeredOfferFingerprint: String(session.answeredOfferFingerprint || ""),
    expiresAtMs,
  };
  if (role === "driver") return { ...base, answer: String(session.answer || "").slice(0, P2P_MAX_SDP_CHARS) };
  return { ...base, offer: String(session.offer || "").slice(0, P2P_MAX_SDP_CHARS) };
}

async function readNativePeerState(db, claims, opts = {}) {
  const ride = await readBoundRide(db, claims);
  const snap = await db.collection("ridePeerSessions").doc(claims.rideId).get();
  const session = snap.exists ? snap.data() || {} : null;
  if (session && (String(session.assignmentId || "") !== claims.assignmentId ||
      Math.floor(Number(session.assignmentVersion) || 0) !== claims.assignmentVersion ||
      String(session.driverId || "") !== String(ride.driverId || "") ||
      String(session.customerId || "") !== String(ride.userId || "") ||
      String(session.vehicleId || "") !== String(ride.vehicleId || ""))) {
    return { ok: true, session: null };
  }
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  return { ok: true, session: safeSession(session, claims.role, now) };
}

async function refreshNativeP2pCredential(db, token, opts = {}) {
  const checked = verifyNativeP2pCredential(token, opts);
  if (!checked.ok) return checked;
  const ride = await readBoundRide(db, checked.claims);
  return mintNativeP2pCredential({ ...checked.claims,
    uid: checked.claims.uid, role: checked.claims.role,
    assignmentVersion: assignmentVersionFromRide(ride) }, opts);
}

async function handleNativeP2pAction(db, input = {}, opts = {}) {
  const checked = verifyNativeP2pCredential(input.token, opts);
  if (!checked.ok) return checked;
  const claims = checked.claims;
  await readBoundRide(db, claims);
  const action = String(input.action || "state");
  if (action === "state") return readNativePeerState(db, claims, opts);
  if (action === "refresh") return refreshNativeP2pCredential(db, input.token, opts);
  if (action === "offer") {
    if (claims.role !== "driver") fail("DRIVER_ONLY", "permission-denied");
    return createRidePeerOffer(db, {
      driverUid: claims.uid, rideId: claims.rideId, vehicleId: claims.vehicleId,
      assignmentId: claims.assignmentId, assignmentVersion: claims.assignmentVersion,
      trackingSessionId: claims.trackingSessionId, peerSessionId: input.peerSessionId,
      offerSdp: input.sdp, expectedPeerSessionId: String(input.expectedPeerSessionId || ""),
      expectedOfferFingerprint: String(input.expectedOfferFingerprint || ""),
    });
  }
  if (action === "answer") {
    if (claims.role !== "customer") fail("CUSTOMER_ONLY", "permission-denied");
    return publishRidePeerAnswer(db, { customerUid: claims.uid, rideId: claims.rideId,
      peerSessionId: input.peerSessionId, offerFingerprint: input.offerFingerprint,
      answerSdp: input.sdp });
  }
  if (action === "close") {
    return closeRidePeerSession(db, { uid: claims.uid, rideId: claims.rideId,
      peerSessionId: input.peerSessionId, offerFingerprint: input.offerFingerprint });
  }
  if (action === "customer_fallback") {
    if (claims.role !== "customer") fail("CUSTOMER_ONLY", "permission-denied");
    return publishCustomerRideLocation(db, claims.uid, { rideId: claims.rideId,
      assignmentSessionToken: claims.assignmentId, location: input.fix });
  }
  if (action === "revision") {
    if (claims.role !== "driver") fail("DRIVER_ONLY", "permission-denied");
    return getRidePeerOfferRevision(db, { uid: claims.uid, rideId: claims.rideId,
      assignmentId: claims.assignmentId });
  }
  fail("UNKNOWN_ACTION", "invalid-argument");
}

module.exports = {
  TOKEN_TTL_MS, NATIVE_SIGNAL_PATH, mintNativeP2pCredential,
  verifyNativeP2pCredential, issueNativeP2pCredential,
  refreshNativeP2pCredential, readNativePeerState, handleNativeP2pAction,
};
