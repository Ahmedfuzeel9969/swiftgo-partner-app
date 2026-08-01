/**
 * Ride viewer presence lease — server-authoritative refresh callable.
 * Collection: rideViewerPresence/{rideId_customerUid}
 * Clients cannot forge lastSeenAt / expiresAt.
 */

"use strict";

const PRESENCE_LEASE_TTL_MS = 90_000;
const TRACKABLE = new Set(["accepted", "arrived", "in_progress"]);

function isValidPresenceSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length >= 3 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

function presenceDocId(rideId, customerUid) {
  return `${String(rideId).trim()}_${String(customerUid).trim()}`;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ customerUid: string, rideId: string, sessionId: string, leaseVersion?: number }} input
 */
async function refreshRideViewerPresence(db, input) {
  const customerUid = String(input?.customerUid || "").trim();
  const rideId = String(input?.rideId || "").trim();
  const sessionId = String(input?.sessionId || "").trim();
  const leaseVersion = Math.max(1, Math.floor(Number(input?.leaseVersion) || 1));

  if (!customerUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  if (!rideId || rideId.length > 128) {
    const err = new Error("INVALID_RIDE_ID");
    err.code = "invalid-argument";
    throw err;
  }
  if (!isValidPresenceSessionId(sessionId)) {
    const err = new Error("INVALID_SESSION_ID");
    err.code = "invalid-argument";
    throw err;
  }

  const rideRef = db.collection("rides").doc(rideId);
  const rideSnap = await rideRef.get();
  if (!rideSnap.exists) {
    const err = new Error("RIDE_NOT_FOUND");
    err.code = "not-found";
    throw err;
  }
  const ride = rideSnap.data() || {};
  if (String(ride.userId || "") !== customerUid) {
    const err = new Error("NOT_RIDE_CUSTOMER");
    err.code = "permission-denied";
    throw err;
  }
  const status = String(ride.status || "");
  if (!TRACKABLE.has(status)) {
    const err = new Error("RIDE_NOT_TRACKABLE");
    err.code = "failed-precondition";
    throw err;
  }

  const now = Date.now();
  // Use Date so timestamps bind to whatever Firestore SDK instance `db` uses
  // (avoids dual Timestamp class mismatches in emulator unit tests).
  const seenAt = new Date(now);
  const expiresAt = new Date(now + PRESENCE_LEASE_TTL_MS);
  const docId = presenceDocId(rideId, customerUid);
  const ref = db.collection("rideViewerPresence").doc(docId);

  // Server-derived timestamps only — ignore any client-supplied lastSeenAt/expiresAt.
  await ref.set(
    {
      rideId,
      customerId: customerUid,
      role: "customer",
      state: "visible",
      leaseVersion,
      sessionId,
      lastSeenAt: seenAt,
      expiresAt,
      updatedAt: seenAt,
    },
    { merge: true }
  );

  return {
    ok: true,
    docId,
    leaseTtlMs: PRESENCE_LEASE_TTL_MS,
    expiresAtMs: now + PRESENCE_LEASE_TTL_MS,
  };
}

module.exports = {
  PRESENCE_LEASE_TTL_MS,
  TRACKABLE_STATUSES: TRACKABLE,
  isValidPresenceSessionId,
  presenceDocId,
  refreshRideViewerPresence,
};
