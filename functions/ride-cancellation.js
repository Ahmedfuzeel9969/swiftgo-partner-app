/**
 * Canonical booking cancellation contract (Customer / Driver / Super Admin).
 * Uses Admin SDK; clients must call trusted callables only.
 */

"use strict";

const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const {
  CANCELLABLE_RIDE_STATUSES,
  DRIVER_PRE_START_CANCEL_STATUSES,
  SEARCH_EXPIRE_MS,
  CUSTOMER_RIDE_OWNER_FIELD,
  NON_TERMINAL_RIDE_STATUSES,
  candidateDocId,
} = require("./matching");
const {
  closeCandidatesAndOffersForRide,
  reconcileCustomerBookingState,
  matchRideCandidates,
} = require("./bargaining");

const DRIVER_CANCEL_REASON_KEYS = Object.freeze([
  "customer_no_show",
  "vehicle_issue",
  "unsafe",
  "other",
]);

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function rideOwnerUid(ride) {
  return ride?.[CUSTOMER_RIDE_OWNER_FIELD] || null;
}

/**
 * Candidate Driver declines only their invitation — does not terminal the booking.
 */
async function declineRideCandidate(db, { rideId, driverUid }) {
  if (!rideId || !driverUid) throw err("invalid-argument", "MISSING_FIELDS");
  const candRef = db.collection("ride_candidates").doc(candidateDocId(rideId, driverUid));
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(candRef);
    if (!snap.exists) throw err("not-found", "CANDIDATE_NOT_FOUND");
    const cand = snap.data() || {};
    if (cand.driverId !== driverUid) throw err("permission-denied", "NOT_YOUR_CANDIDATE");
    if (cand.status === "declined" || cand.status === "expired" || cand.status === "withdrawn") {
      return { already: true, status: cand.status };
    }
    if (cand.status !== "invited") {
      throw err("failed-precondition", `NOT_DECLINABLE:${cand.status || "unknown"}`);
    }
    tx.update(candRef, {
      status: "declined",
      declinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { already: false, status: "declined" };
  });

  // Ensure ride is still searching — never cancel the booking for everyone.
  const rideSnap = await db.collection("rides").doc(rideId).get();
  if (rideSnap.exists && rideSnap.data()?.status !== "searching_driver") {
    /* no-op: assignment may have won; decline only affects this candidate */
  }

  return {
    ok: true,
    rideId,
    driverUid,
    status: outcome.status,
    already: Boolean(outcome.already),
    bookingTerminal: false,
  };
}

/**
 * Driver withdraws only their own open/countered offer.
 */
async function withdrawRideOffer(db, { offerId, driverUid }) {
  if (!offerId || !driverUid) throw err("invalid-argument", "MISSING_FIELDS");
  const offerRef = db.collection("ride_offers").doc(offerId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(offerRef);
    if (!snap.exists) throw err("not-found", "OFFER_NOT_FOUND");
    const offer = snap.data() || {};
    if (offer.driverId !== driverUid) throw err("permission-denied", "NOT_YOUR_OFFER");
    if (["withdrawn", "rejected", "expired", "accepted"].includes(offer.status)) {
      return { ok: true, offerId, status: offer.status, already: true, bookingTerminal: false };
    }
    tx.update(offerRef, {
      status: "withdrawn",
      updatedAt: FieldValue.serverTimestamp(),
      closedReason: "driver_withdrawn",
    });
    return { ok: true, offerId, status: "withdrawn", already: false, bookingTerminal: false };
  });
}

/**
 * Assigned Driver cancels before start → same booking returns to searching with fresh 3-min window.
 * Rematch excludes the cancelling Driver. Does not create a second ride / extra slot.
 */
async function cancelAssignedRideByDriver(db, { rideId, driverUid, cancelReason, cancelReasonKey }) {
  if (!rideId || !driverUid) throw err("invalid-argument", "MISSING_FIELDS");
  const reasonKey = DRIVER_CANCEL_REASON_KEYS.includes(String(cancelReasonKey || ""))
    ? String(cancelReasonKey)
    : "other";
  const reasonText = String(cancelReason || reasonKey).trim().slice(0, 200);
  const rideRef = db.collection("rides").doc(rideId);
  const partnerRef = db.collection("partners").doc(driverUid);
  const offerRef = db.collection("ride_offers").doc(candidateDocId(rideId, driverUid));

  const outcome = await db.runTransaction(async (tx) => {
    const [rideSnap, partnerSnap, offerSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(partnerRef),
      tx.get(offerRef),
    ]);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};

    if (ride.status === "searching_driver" && !ride.driverId) {
      throw err("failed-precondition", "NOT_ASSIGNED");
    }
    if (ride.status === "in_progress" || ride.status === "completed") {
      throw err("failed-precondition", `NOT_CANCELLABLE:${ride.status}`);
    }
    if (!DRIVER_PRE_START_CANCEL_STATUSES.includes(String(ride.status || ""))) {
      throw err("failed-precondition", `NOT_CANCELLABLE:${ride.status || "unknown"}`);
    }
    if (ride.driverId !== driverUid) {
      throw err("permission-denied", "NOT_ASSIGNED_DRIVER");
    }

    const now = Date.now();
    tx.update(rideRef, {
      status: "searching_driver",
      driverId: FieldValue.delete(),
      vehicleId: FieldValue.delete(),
      ownerId: FieldValue.delete(),
      driverName: FieldValue.delete(),
      vehiclePlate: FieldValue.delete(),
      assignedAt: FieldValue.delete(),
      matchingStatus: "rematch_pending",
      candidateCount: 0,
      rematchExcludeDriverIds: FieldValue.arrayUnion(driverUid),
      lastDriverCancelUid: driverUid,
      lastDriverCancelReason: reasonText,
      lastDriverCancelReasonKey: reasonKey,
      lastDriverCancelledAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + SEARCH_EXPIRE_MS),
      searchExpireMs: SEARCH_EXPIRE_MS,
      rematchedAt: FieldValue.serverTimestamp(),
    });

    if (partnerSnap.exists && partnerSnap.data()?.activeRideId === rideId) {
      tx.set(
        partnerRef,
        { activeRideId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    if (offerSnap.exists) {
      const ost = offerSnap.data()?.status;
      if (ost === "accepted" || ost === "open" || ost === "countered") {
        tx.update(offerRef, {
          status: "withdrawn",
          closedReason: "driver_cancelled_assignment",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    return {
      status: "searching_driver",
      rematch: true,
      excludeDriverId: driverUid,
      pickup: {
        lat: Number(ride.pickupLocation?.lat),
        lng: Number(ride.pickupLocation?.lng),
      },
      customerUid: rideOwnerUid(ride),
    };
  });

  // Close other candidates/offers from prior match wave, then rematch excluding cancelling driver.
  await closeCandidatesAndOffersForRide(db, rideId, "driver_cancelled_assignment").catch(() => {});

  let matching = null;
  let matchingError = null;
  if (Number.isFinite(outcome.pickup.lat) && Number.isFinite(outcome.pickup.lng)) {
    try {
      matching = await matchRideCandidates(db, {
        rideId,
        pickup: outcome.pickup,
        excludeDriverIds: [driverUid],
      });
    } catch (e) {
      matchingError = String(e?.message || e).slice(0, 200);
    }
  }

  // Same booking remains non-terminal — reconcile should keep slot count stable.
  if (outcome.customerUid) {
    await reconcileCustomerBookingState(db, outcome.customerUid).catch(() => {});
  }

  return {
    ok: true,
    rideId,
    status: "searching_driver",
    rematch: true,
    excludeDriverId: driverUid,
    candidateCount: matching?.candidates?.length ?? 0,
    matchingError,
    cancelledCount: 1,
    skippedCount: 0,
    failedCount: 0,
  };
}

/**
 * Claim-based Super Admin cancellation for eligible non-terminal rides.
 * Started rides (in_progress) are not silently cancelled — requires separate business decision.
 */
async function cancelRideByAdmin(db, { rideId, adminUid, reason }) {
  if (!rideId || !adminUid) throw err("invalid-argument", "MISSING_FIELDS");
  const reasonText = String(reason || "").trim().slice(0, 300);
  if (!reasonText) throw err("invalid-argument", "REASON_REQUIRED");

  const rideRef = db.collection("rides").doc(rideId);

  const outcome = await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};

    if (
      ride.status === "cancelled_by_admin" ||
      String(ride.status || "").startsWith("cancelled") ||
      ride.status === "expired" ||
      ride.status === "no_driver_found" ||
      ride.status === "completed"
    ) {
      return { already: true, status: ride.status, customerUid: rideOwnerUid(ride) };
    }
    if (ride.status === "in_progress") {
      throw err("failed-precondition", "STARTED_RIDE_ADMIN_CANCEL_UNDEFINED");
    }
    if (!NON_TERMINAL_RIDE_STATUSES.includes(String(ride.status || ""))) {
      throw err("failed-precondition", `NOT_CANCELLABLE:${ride.status || "unknown"}`);
    }

    const assignedDriverId = ride.driverId || null;
    let partnerSnap = null;
    let partnerRef = null;
    if (assignedDriverId) {
      partnerRef = db.collection("partners").doc(assignedDriverId);
      partnerSnap = await tx.get(partnerRef);
    }

    const patch = {
      status: "cancelled_by_admin",
      cancelReason: reasonText,
      cancelReasonKey: "admin",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledByAdminUid: adminUid,
      cancelledFromStatus: ride.status,
    };
    if (assignedDriverId) {
      patch.driverId = FieldValue.delete();
      patch.vehicleId = FieldValue.delete();
    }
    tx.update(rideRef, patch);

    if (
      assignedDriverId &&
      partnerRef &&
      partnerSnap?.exists &&
      partnerSnap.data()?.activeRideId === rideId
    ) {
      tx.set(
        partnerRef,
        { activeRideId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    const auditRef = db.collection("admin_audit").doc();
    tx.set(auditRef, {
      action: "cancel_ride",
      rideId,
      adminUid,
      reason: reasonText,
      previousStatus: ride.status,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      already: false,
      status: "cancelled_by_admin",
      customerUid: rideOwnerUid(ride),
      auditId: auditRef.id,
    };
  });

  if (!outcome.already) {
    await closeCandidatesAndOffersForRide(db, rideId, "cancelled_by_admin").catch(() => {});
  }
  if (outcome.customerUid) {
    await reconcileCustomerBookingState(db, outcome.customerUid).catch(() => {});
  }

  return {
    ok: true,
    rideId,
    status: outcome.status,
    already: Boolean(outcome.already),
    auditId: outcome.auditId || null,
    cancelledCount: outcome.already ? 0 : 1,
    skippedCount: outcome.already ? 1 : 0,
    failedCount: 0,
  };
}

module.exports = {
  declineRideCandidate,
  withdrawRideOffer,
  cancelAssignedRideByDriver,
  cancelRideByAdmin,
  DRIVER_CANCEL_REASON_KEYS,
  CANCELLABLE_RIDE_STATUSES,
};
