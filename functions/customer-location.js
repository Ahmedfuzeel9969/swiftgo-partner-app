"use strict";
const { FieldValue } = require("firebase-admin/firestore");
const { rideLocationAssignmentVersion, validateRideLocationFix } = require("./ride-location-contract");
const { resolveLocationDeliveryPolicy } = require("./location-delivery-policy");
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Authenticated, active-assignment-only fallback. Clients cannot write ride locations directly. */
async function publishCustomerRideLocation(db, uid, input, opts = {}) {
  if (!uid) fail("unauthenticated", "AUTH_REQUIRED");
  const rideId = input?.rideId;
  if (typeof rideId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(rideId)) fail("invalid-argument", "INVALID_RIDE_ID");
  const nowMs = opts.nowMs ?? Date.now();
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`rides/${rideId}`);
    const [rideSnap, configSnap] = await Promise.all([tx.get(ref), tx.get(db.doc("settings/dispatch"))]);
    if (!rideSnap.exists) fail("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data();
    if (ride.userId !== uid) fail("permission-denied", "NOT_RIDE_CUSTOMER");
    if (!["accepted", "arrived", "in_progress"].includes(ride.status) || !ride.driverId || !ride.vehicleId) {
      fail("failed-precondition", "RIDE_NOT_ACTIVE");
    }
    if (!ride.assignmentSessionToken || input.assignmentSessionToken !== ride.assignmentSessionToken) {
      fail("failed-precondition", "STALE_ASSIGNMENT");
    }
    const locationRef = ref.collection("customerLocations").doc(ride.assignmentSessionToken);
    const locationSnap = await tx.get(locationRef);
    const config = configSnap.exists ? configSnap.data() : {};
    const policy = resolveLocationDeliveryPolicy(config);
    if (!policy.firebaseFallbackEnabled) return { ok: false, reason: "firebase_disabled" };
    const intervalMs = policy.firebaseWriteIntervalMs;
    const assignedMs = ride.assignedAt?.toMillis?.();
    if (assignedMs && nowMs - assignedMs < policy.p2pFirstGraceMs) return { ok: false, reason: "p2p_first_grace" };
    const stored = locationSnap.exists ? locationSnap.data() : {};
    const previous = stored.location?.assignmentId === ride.assignmentSessionToken ? stored.location : null;
    const check = validateRideLocationFix(input.location, {
      nowMs, previous, rideId, role: "customer",
      assignmentVersion: rideLocationAssignmentVersion(ride), assignmentId: ride.assignmentSessionToken,
    });
    if (!check.ok) {
      // A lost response may cause an exact retry; acknowledge it without another write.
      if (check.reason === "duplicate_fix" && previous &&
          ["lat", "lng", "observedAt", "sequence", "trackingSessionId", "accuracyM", "speedMps", "headingDeg", "assignmentId", "assignmentVersion", "role", "rideId"]
            .every((key) => (input.location[key] ?? null) === (previous[key] ?? null))) {
        return { ok: true, duplicate: true };
      }
      fail("invalid-argument", check.reason);
    }
    const previousWriteMs = stored.updatedAt?.toMillis?.() || 0;
    if (previousWriteMs && nowMs - previousWriteMs < intervalMs) return { ok: false, reason: "admin_interval" };
    // Separate from the ride document: fleet owners/candidates must not gain
    // access to the customer's moving GPS just because they can read a booking.
    tx.set(locationRef, { location: check.fix, updatedAt: FieldValue.serverTimestamp(), expiresAt: new Date(nowMs + 60 * 60000) });
    return { ok: true };
  });
}
module.exports = { publishCustomerRideLocation };
