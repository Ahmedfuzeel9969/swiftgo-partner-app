/**
 * Bargaining + final assignment + customer booking-slot checks (Admin SDK).
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const {
  validateCandidateDriverLimit,
  selectCandidatesProgressive,
  candidateDocId,
  MAX_DRIVER_OPEN_BARGAINS,
  MAX_CUSTOMER_ACTIVE_BOOKINGS,
  NON_TERMINAL_RIDE_STATUSES,
  ACTIVE_RIDE_STATUSES,
  OPEN_OFFER_STATUSES,
  DEFAULT_CANDIDATE_LIMIT,
  isOpenOfferStatus,
} = require("./matching");
const { loadAndSelectGeoCandidates } = require("./geo-match");

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

async function readDispatchSettings(db) {
  const snap = await db.collection("settings").doc("dispatch").get();
  const data = snap.exists ? snap.data() || {} : {};
  let limit = DEFAULT_CANDIDATE_LIMIT;
  try {
    if (data.candidateDriverLimit != null) {
      limit = validateCandidateDriverLimit(data.candidateDriverLimit);
    }
  } catch {
    limit = DEFAULT_CANDIDATE_LIMIT;
  }
  return {
    candidateDriverLimit: limit,
    maxDriverOpenBargains: MAX_DRIVER_OPEN_BARGAINS,
    maxCustomerActiveBookings: MAX_CUSTOMER_ACTIVE_BOOKINGS,
  };
}

/**
 * Count customer's non-terminal bookings.
 */
async function countCustomerActiveBookings(db, customerUid) {
  const snap = await db
    .collection("rides")
    .where("userId", "==", customerUid)
    .where("status", "in", [...NON_TERMINAL_RIDE_STATUSES])
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Gate creating booking 2–4 (needs confirm) or reject 5+.
 * Prefer booking_slots counter when present (race-safe); else live query.
 * @returns {{ allowed: boolean, needsConfirmation?: boolean, activeBookings?: object[], reason?: string, count?: number }}
 */
async function evaluateCustomerBookingGate(db, customerUid, { confirmedExtraBooking = false } = {}) {
  const slotSnap = await db.collection("booking_slots").doc(customerUid).get();
  const active = await countCustomerActiveBookings(db, customerUid);
  const count = slotSnap.exists
    ? Math.max(Number(slotSnap.data()?.count || 0), active.length)
    : active.length;

  if (count >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
    return {
      allowed: false,
      reason: "MAX_ACTIVE_BOOKINGS",
      count,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  if (count >= 1 && !confirmedExtraBooking) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: "CONFIRM_EXTRA_BOOKING",
      count,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  return {
    allowed: true,
    count,
    activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
  };
}

/**
 * Atomic create with booking_slots counter (race-safe 4-booking limit).
 */
async function createCustomerBooking(db, { customerUid, ridePayload, confirmedExtraBooking = false }) {
  if (!customerUid || !ridePayload) throw err("invalid-argument", "MISSING_FIELDS");
  const slotRef = db.collection("booking_slots").doc(customerUid);
  const rideRef = db.collection("rides").doc();

  return db.runTransaction(async (tx) => {
    const slotSnap = await tx.get(slotRef);
    const count = slotSnap.exists ? Math.max(0, Number(slotSnap.data()?.count || 0)) : 0;
    if (count >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
      throw err("failed-precondition", "MAX_ACTIVE_BOOKINGS");
    }
    if (count >= 1 && !confirmedExtraBooking) {
      throw err("failed-precondition", "CONFIRM_EXTRA_BOOKING");
    }

    const payload = {
      ...ridePayload,
      userId: customerUid,
      status: "searching_driver",
      createdAt: FieldValue.serverTimestamp(),
    };
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });
    tx.set(rideRef, payload);
    tx.set(
      slotRef,
      {
        count: count + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { id: rideRef.id, count: count + 1 };
  });
}

/**
 * Release one non-terminal slot (cancel / complete / expire).
 */
async function releaseCustomerBookingSlot(db, customerUid) {
  if (!customerUid) return;
  const slotRef = db.collection("booking_slots").doc(customerUid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(slotRef);
    const count = snap.exists ? Math.max(0, Number(snap.data()?.count || 0)) : 0;
    tx.set(
      slotRef,
      { count: Math.max(0, count - 1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
}

/**
 * Cancel searching booking + release slot (trusted).
 */
async function cancelCustomerBooking(db, { customerUid, rideId }) {
  const rideRef = db.collection("rides").doc(rideId);
  const slotRef = db.collection("booking_slots").doc(customerUid);
  await db.runTransaction(async (tx) => {
    const [rideSnap, slotSnap] = await Promise.all([tx.get(rideRef), tx.get(slotRef)]);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};
    if (ride.userId !== customerUid) throw err("permission-denied", "NOT_YOUR_BOOKING");
    if (ride.status !== "searching_driver") throw err("failed-precondition", "NOT_CANCELLABLE");
    tx.update(rideRef, { status: "cancelled_by_user" });
    const count = slotSnap.exists ? Math.max(0, Number(slotSnap.data()?.count || 0)) : 0;
    tx.set(
      slotRef,
      { count: Math.max(0, count - 1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
  return { ok: true, rideId };
}

/**
 * After ride create: select candidates and write ride_candidates docs.
 * Phase 3B: when `onlineDrivers` is omitted, loads via geo-scoped cell/hotspot
 * queries only (never full online fleet). Passing `onlineDrivers` remains for
 * pure unit fixtures that already built an in-memory list.
 */
async function matchRideCandidates(db, { rideId, pickup, onlineDrivers, candidateDriverLimit }) {
  const settings = await readDispatchSettings(db);
  const limit =
    candidateDriverLimit != null
      ? validateCandidateDriverLimit(candidateDriverLimit)
      : settings.candidateDriverLimit;

  let selected;
  let metrics = { usedFullFleetScan: false, source: "in_memory" };
  if (Array.isArray(onlineDrivers)) {
    selected = selectCandidatesProgressive(pickup, onlineDrivers, limit);
  } else {
    const geo = await loadAndSelectGeoCandidates(db, pickup, limit);
    selected = geo.selected;
    metrics = { ...geo.metrics, source: "geo_scoped" };
  }

  const batch = db.batch();
  for (const c of selected) {
    const id = candidateDocId(rideId, c.driverId);
    batch.set(db.collection("ride_candidates").doc(id), {
      rideId,
      driverId: c.driverId,
      distanceKm: c.distanceKm,
      ringKm: c.ringKm,
      status: "invited",
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  batch.set(
    db.collection("rides").doc(rideId),
    {
      candidateCount: selected.length,
      candidateDriverLimit: limit,
      matchingStatus: selected.length ? "candidates_ready" : "no_candidates",
      matchingRingKm: metrics.ringExpandedToKm || null,
      matchedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await batch.commit();
  return { candidates: selected, candidateDriverLimit: limit, metrics };
}

async function countDriverOpenBargains(db, driverUid) {
  const snap = await db
    .collection("ride_offers")
    .where("driverId", "==", driverUid)
    .where("status", "in", [...OPEN_OFFER_STATUSES])
    .get();
  return snap.size;
}

async function driverHasActiveRide(db, driverUid) {
  const snap = await db
    .collection("rides")
    .where("driverId", "==", driverUid)
    .where("status", "in", [...ACTIVE_RIDE_STATUSES])
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Submit or update a private offer (does not assign the ride).
 */
async function submitRideOffer(db, params) {
  const {
    rideId,
    driverUid,
    fare,
    vehicleId,
    ownerId,
    driverName,
    vehiclePlate,
  } = params;

  if (!rideId || !driverUid || !vehicleId) throw err("invalid-argument", "MISSING_FIELDS");
  const bid = Math.max(0, Math.round(Number(fare) || 0));
  if (!Number.isFinite(bid) || bid < 0) throw err("invalid-argument", "INVALID_FARE");

  const existingOfferId = `${rideId}_${driverUid}`;
  const openCountSnap = await db
    .collection("ride_offers")
    .where("driverId", "==", driverUid)
    .where("status", "in", [...OPEN_OFFER_STATUSES])
    .get();
  const otherOpen = openCountSnap.docs.filter((d) => d.id !== existingOfferId).length;
  const hasExistingOpen = openCountSnap.docs.some((d) => d.id === existingOfferId);
  if (!hasExistingOpen && otherOpen >= MAX_DRIVER_OPEN_BARGAINS) {
    throw err("failed-precondition", "MAX_OPEN_BARGAINS");
  }
  if (await driverHasActiveRide(db, driverUid)) {
    throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
  }

  const rideRef = db.collection("rides").doc(rideId);
  const candRef = db.collection("ride_candidates").doc(candidateDocId(rideId, driverUid));
  const offerRef = db.collection("ride_offers").doc(existingOfferId);
  const partnerRef = db.collection("partners").doc(driverUid);

  return db.runTransaction(async (tx) => {
    const [rideSnap, candSnap, offerSnap, partnerSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(candRef),
      tx.get(offerRef),
      tx.get(partnerRef),
    ]);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};
    if (ride.status !== "searching_driver") throw err("failed-precondition", "NOT_NEGOTIATING");
    if (!candSnap.exists || candSnap.data()?.status !== "invited") {
      throw err("permission-denied", "NOT_A_CANDIDATE");
    }
    const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
    if (partner.accountStatus === "blocked") throw err("permission-denied", "DRIVER_BLOCKED");
    if (partner.accountStatus === "suspended") throw err("permission-denied", "DRIVER_SUSPENDED");
    if (partner.activeRideId) throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");

    const prev = offerSnap.exists ? offerSnap.data() : null;
    if (prev && ["rejected", "withdrawn", "expired", "accepted"].includes(prev.status)) {
      throw err("failed-precondition", "OFFER_NOT_OPEN");
    }

    const payload = {
      rideId,
      driverId: driverUid,
      customerId: ride.userId,
      fare: bid,
      status: "open",
      vehicleId,
      ownerId: ownerId || null,
      driverName: driverName || "SwiftGo Driver",
      vehiclePlate: vehiclePlate || "—",
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!offerSnap.exists) {
      payload.createdAt = FieldValue.serverTimestamp();
    } else if (prev?.status === "countered") {
      payload.status = "open";
      payload.customerCounterFare = FieldValue.delete();
    } else {
      payload.status = prev?.status || "open";
    }

    tx.set(offerRef, payload, { merge: true });
    return { offerId: existingOfferId, fare: bid, status: payload.status, assigned: false };
  });
}

/**
 * Customer counter on a specific offer.
 */
async function counterRideOffer(db, { offerId, customerUid, fare }) {
  const bid = Math.max(0, Math.round(Number(fare) || 0));
  const offerRef = db.collection("ride_offers").doc(offerId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(offerRef);
    if (!snap.exists) throw err("not-found", "OFFER_NOT_FOUND");
    const offer = snap.data() || {};
    if (offer.customerId !== customerUid) throw err("permission-denied", "NOT_YOUR_BOOKING");
    if (!isOpenOfferStatus(offer.status) && offer.status !== "open") {
      throw err("failed-precondition", "OFFER_NOT_OPEN");
    }
    if (["rejected", "withdrawn", "expired", "accepted"].includes(offer.status)) {
      throw err("failed-precondition", "OFFER_CLOSED");
    }
    tx.update(offerRef, {
      customerCounterFare: bid,
      status: "countered",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { offerId, status: "countered", customerCounterFare: bid };
  });
}

/**
 * Customer rejects a specific open offer (does not cancel the booking).
 */
async function rejectRideOffer(db, { offerId, customerUid }) {
  const offerRef = db.collection("ride_offers").doc(offerId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(offerRef);
    if (!snap.exists) throw err("not-found", "OFFER_NOT_FOUND");
    const offer = snap.data() || {};
    if (offer.customerId !== customerUid) throw err("permission-denied", "NOT_YOUR_BOOKING");
    if (["rejected", "withdrawn", "expired", "accepted"].includes(offer.status)) {
      throw err("failed-precondition", "OFFER_CLOSED");
    }
    tx.update(offerRef, {
      status: "rejected",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { offerId, status: "rejected" };
  });
}

/**
 * Atomic final assignment from an open/countered offer (customer accepts or driver accepts counter).
 */
async function finalizeAssignmentFromOffer(db, params) {
  const { offerId, actorUid, actorRole } = params;
  // actorRole: 'customer' | 'driver'
  const offerRef = db.collection("ride_offers").doc(offerId);

  return db.runTransaction(async (tx) => {
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw err("not-found", "OFFER_NOT_FOUND");
    const offer = offerSnap.data() || {};

    if (["rejected", "withdrawn", "expired"].includes(offer.status)) {
      throw err("failed-precondition", "OFFER_CLOSED");
    }
    if (offer.status === "accepted") {
      // idempotent
      return { alreadyAssigned: true, rideId: offer.rideId, driverId: offer.driverId };
    }

    const rideRef = db.collection("rides").doc(offer.rideId);
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};

    if (ride.status !== "searching_driver") {
      throw err("failed-precondition", "RIDE_NOT_AVAILABLE");
    }

    if (actorRole === "customer" && ride.userId !== actorUid) {
      throw err("permission-denied", "NOT_YOUR_BOOKING");
    }
    if (actorRole === "driver" && offer.driverId !== actorUid) {
      throw err("permission-denied", "NOT_YOUR_OFFER");
    }

    const partnerRef = db.collection("partners").doc(offer.driverId);
    const partnerSnap = await tx.get(partnerRef);
    const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
    if (partner.accountStatus === "blocked") throw err("permission-denied", "DRIVER_BLOCKED");
    if (partner.accountStatus === "suspended") throw err("permission-denied", "DRIVER_SUSPENDED");
    if (partner.activeRideId) throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");

    let finalFare = Math.round(Number(offer.fare) || 0);
    if (actorRole === "driver" && offer.status === "countered") {
      finalFare = Math.round(Number(offer.customerCounterFare) || 0);
      if (finalFare <= 0) throw err("failed-precondition", "NO_COUNTER");
    }

    // Assign ride
    tx.update(rideRef, {
      status: "accepted",
      driverId: offer.driverId,
      vehicleId: offer.vehicleId,
      ownerId: offer.ownerId,
      driverName: offer.driverName,
      vehiclePlate: offer.vehiclePlate,
      farePkr: finalFare,
      estimatedFare: finalFare,
      driverBidFare: finalFare,
      assignedAt: FieldValue.serverTimestamp(),
    });

    tx.update(offerRef, {
      status: "accepted",
      fare: finalFare,
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(
      partnerRef,
      { activeRideId: offer.rideId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    return {
      alreadyAssigned: false,
      rideId: offer.rideId,
      driverId: offer.driverId,
      fare: finalFare,
      needsOfferCleanup: true,
    };
  }).then(async (result) => {
    if (result.needsOfferCleanup) {
      await closeSiblingOffers(db, result.rideId, result.driverId, offerId);
    }
    return result;
  });
}

/**
 * After assignment: expire other offers on the ride; withdraw driver's other open offers.
 */
async function closeSiblingOffers(db, rideId, driverId, winningOfferId) {
  const batch = db.batch();
  const onRide = await db.collection("ride_offers").where("rideId", "==", rideId).get();
  for (const doc of onRide.docs) {
    if (doc.id === winningOfferId) continue;
    const st = doc.data()?.status;
    if (isOpenOfferStatus(st) || st === "open") {
      batch.update(doc.ref, {
        status: "expired",
        updatedAt: FieldValue.serverTimestamp(),
        closedReason: "ride_assigned_other_driver",
      });
    }
  }
  const driverOffers = await db
    .collection("ride_offers")
    .where("driverId", "==", driverId)
    .where("status", "in", [...OPEN_OFFER_STATUSES])
    .get();
  for (const doc of driverOffers.docs) {
    if (doc.id === winningOfferId) continue;
    batch.update(doc.ref, {
      status: "withdrawn",
      updatedAt: FieldValue.serverTimestamp(),
      closedReason: "driver_assigned_elsewhere",
    });
  }
  await batch.commit();
}

module.exports = {
  readDispatchSettings,
  countCustomerActiveBookings,
  evaluateCustomerBookingGate,
  createCustomerBooking,
  releaseCustomerBookingSlot,
  cancelCustomerBooking,
  matchRideCandidates,
  countDriverOpenBargains,
  driverHasActiveRide,
  submitRideOffer,
  counterRideOffer,
  rejectRideOffer,
  finalizeAssignmentFromOffer,
  closeSiblingOffers,
};
