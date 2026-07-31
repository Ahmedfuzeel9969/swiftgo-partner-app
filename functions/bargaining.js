/**
 * Bargaining + final assignment + customer booking-slot checks (Admin SDK).
 */

"use strict";

const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const {
  validateCandidateDriverLimit,
  selectCandidatesProgressive,
  candidateDocId,
  MAX_DRIVER_OPEN_BARGAINS,
  MAX_CUSTOMER_ACTIVE_BOOKINGS,
  NON_TERMINAL_RIDE_STATUSES,
  CANCELLABLE_RIDE_STATUSES,
  SEARCH_EXPIRED_STATUS,
  SEARCH_EXPIRE_MS,
  CUSTOMER_RIDE_OWNER_FIELD,
  ACTIVE_RIDE_STATUSES,
  OPEN_OFFER_STATUSES,
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_MAX_SEARCH_RADIUS_KM,
  buildSearchRingsKm,
  isOpenOfferStatus,
  STALE_LOCATION_MS,
  haversineKm,
  classifyDriverMatchExclusion,
} = require("./matching");
const { loadAndSelectGeoCandidates } = require("./geo-match");
const { seedDriverLocationFromVehicle } = require("./driver-location");
const { computeCancellationFare } = require("./partial-fare");
const { settlePartialCancellation } = require("./settlement");

const CANCEL_REASON_KEYS = Object.freeze([
  "taking_too_long",
  "booked_by_mistake",
  "found_alternative",
  "other",
]);

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function timestampToMs(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

function rideOwnerUid(ride) {
  return ride?.[CUSTOMER_RIDE_OWNER_FIELD] || null;
}

function isOwnedByCustomer(ride, customerUid) {
  return Boolean(customerUid) && rideOwnerUid(ride) === customerUid;
}

function isCancellableSearching(ride) {
  return CANCELLABLE_RIDE_STATUSES.includes(String(ride?.status || ""));
}

function rideExpireAtMs(ride) {
  const fromField = timestampToMs(ride?.expiresAt);
  if (fromField > 0) return fromField;
  const created = timestampToMs(ride?.createdAt);
  if (created > 0) return created + SEARCH_EXPIRE_MS;
  // Missing timestamps → treat as overdue (ghost cleanup).
  return 0;
}

function isSearchingPastExpiry(ride, nowMs = Date.now()) {
  if (String(ride?.status || "") !== "searching_driver") return false;
  if (ride?.driverId) return false;
  const exp = rideExpireAtMs(ride);
  if (exp <= 0) return true;
  return nowMs >= exp;
}

/**
 * Close invited candidates + open offers for a ride (best-effort, idempotent).
 */
async function closeCandidatesAndOffersForRide(db, rideId, closedReason) {
  if (!rideId) return { candidates: 0, offers: 0 };
  const [cands, offers] = await Promise.all([
    db.collection("ride_candidates").where("rideId", "==", rideId).get(),
    db.collection("ride_offers").where("rideId", "==", rideId).get(),
  ]);
  if (cands.empty && offers.empty) return { candidates: 0, offers: 0 };
  const batch = db.batch();
  let candN = 0;
  let offerN = 0;
  for (const doc of cands.docs) {
    const st = doc.data()?.status;
    if (st === "invited" || st === "open") {
      batch.update(doc.ref, {
        status: "expired",
        closedReason: closedReason || "ride_closed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      candN += 1;
    }
  }
  for (const doc of offers.docs) {
    const st = doc.data()?.status;
    if (isOpenOfferStatus(st)) {
      batch.update(doc.ref, {
        status: "expired",
        closedReason: closedReason || "ride_closed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      offerN += 1;
    }
  }
  if (candN || offerN) await batch.commit();
  return { candidates: candN, offers: offerN };
}

/**
 * Expire overdue searching rides for one customer and sync booking_slots to live count.
 * Authoritative rule: searching + unassigned + past expiresAt (or createdAt+3m) → `expired`.
 */
async function reconcileCustomerBookingState(db, customerUid, { nowMs = Date.now() } = {}) {
  if (!customerUid) return { activeCount: 0, expired: 0, activeBookings: [] };
  const active = await countCustomerActiveBookings(db, customerUid);
  const toClose = [];

  for (const ride of active) {
    if (!isSearchingPastExpiry(ride, nowMs)) continue;
    toClose.push({
      id: ride.id,
      status: SEARCH_EXPIRED_STATUS,
      reason: "search_timeout_3min",
    });
  }

  if (toClose.length) {
    const batch = db.batch();
    for (const item of toClose) {
      batch.update(db.collection("rides").doc(item.id), {
        status: item.status,
        expiredAt: FieldValue.serverTimestamp(),
        expireReason: item.reason,
        cancelledAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    await Promise.all(
      toClose.map((item) =>
        closeCandidatesAndOffersForRide(db, item.id, item.reason).catch(() => ({
          candidates: 0,
          offers: 0,
        }))
      )
    );
  }

  const refreshed = await countCustomerActiveBookings(db, customerUid);
  await db.collection("booking_slots").doc(customerUid).set(
    {
      count: refreshed.length,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    activeCount: refreshed.length,
    expired: toClose.length,
    activeBookings: refreshed.map((r) => ({ id: r.id, status: r.status })),
  };
}

/**
 * Customer cancels every searching_driver ride and frees slots (self-service unlock).
 * Returns cancelled / skipped / failed with safe reasons — never invents success.
 */
async function cancelAllSearchingBookings(db, customerUid) {
  if (!customerUid) throw err("invalid-argument", "MISSING_FIELDS");
  // Expire overdue searching first so ghosts do not block cancellation UX.
  await reconcileCustomerBookingState(db, customerUid);

  const snap = await db
    .collection("rides")
    .where(CUSTOMER_RIDE_OWNER_FIELD, "==", customerUid)
    .where("status", "==", "searching_driver")
    .limit(10)
    .get();

  const cancelled = [];
  const skipped = [];
  const failed = [];

  for (const doc of snap.docs) {
    try {
      const result = await cancelCustomerBooking(db, {
        customerUid,
        rideId: doc.id,
        cancelReasonKey: "other",
        cancelReason: "bulk_clear_searching",
      });
      cancelled.push({ id: doc.id, status: result.status });
    } catch (e) {
      failed.push({ id: doc.id, reason: String(e?.message || e) });
    }
  }

  const remaining = await countCustomerActiveBookings(db, customerUid);
  const blockingAssigned = remaining
    .filter((r) => ACTIVE_RIDE_STATUSES.includes(r.status))
    .map((r) => ({ id: r.id, status: r.status }));

  for (const r of remaining) {
    if (r.status === "searching_driver") {
      skipped.push({ id: r.id, reason: "STILL_SEARCHING" });
    }
  }

  await reconcileCustomerBookingState(db, customerUid);

  return {
    ok: failed.length === 0,
    cancelledCount: cancelled.length,
    cancelled,
    skipped,
    failed,
    blockingAssigned,
    activeCount: remaining.length,
    activeBookings: remaining.map((r) => ({ id: r.id, status: r.status })),
  };
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

  let maxSearchRadiusMeters = Math.round(DEFAULT_MAX_SEARCH_RADIUS_KM * 1000);
  if (data.maxSearchRadiusMeters != null && Number.isFinite(Number(data.maxSearchRadiusMeters))) {
    maxSearchRadiusMeters = Math.max(0, Math.round(Number(data.maxSearchRadiusMeters)));
  } else if (data.maxSearchRadiusKm != null && Number.isFinite(Number(data.maxSearchRadiusKm))) {
    maxSearchRadiusMeters = Math.round(Number(data.maxSearchRadiusKm) * 1000);
  } else if (Array.isArray(data.searchRingsKm) && data.searchRingsKm.length) {
    const legacyMax = Math.max(
      ...data.searchRingsKm.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
    );
    if (Number.isFinite(legacyMax) && legacyMax > 0) {
      maxSearchRadiusMeters = Math.round(legacyMax * 1000);
    }
  }
  if (maxSearchRadiusMeters <= 0) {
    maxSearchRadiusMeters = Math.round(DEFAULT_MAX_SEARCH_RADIUS_KM * 1000);
  }
  const maxSearchRadiusKm =
    maxSearchRadiusMeters > 0 ? maxSearchRadiusMeters / 1000 : DEFAULT_MAX_SEARCH_RADIUS_KM;
  const searchRingsKm = buildSearchRingsKm(maxSearchRadiusKm);

  return {
    candidateDriverLimit: limit,
    maxSearchRadiusKm,
    maxSearchRadiusMeters,
    searchRingsKm,
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
    .where(CUSTOMER_RIDE_OWNER_FIELD, "==", customerUid)
    .where("status", "in", [...NON_TERMINAL_RIDE_STATUSES])
    .limit(5)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Gate creating booking 2–4 (needs confirm) or reject 5+.
 * Prefer booking_slots counter when present (race-safe); else live query.
 * @returns {{ allowed: boolean, needsConfirmation?: boolean, activeBookings?: object[], reason?: string, count?: number }}
 */
async function evaluateCustomerBookingGate(db, customerUid, { confirmedExtraBooking = false } = {}) {
  // Reconcile inflated booking_slots and expire stale searching rides first.
  const reconciled = await reconcileCustomerBookingState(db, customerUid);
  const count = reconciled.activeCount;
  const active = reconciled.activeBookings || [];

  if (count >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
    return {
      allowed: false,
      reason: "MAX_ACTIVE_BOOKINGS",
      count,
      expiredStale: reconciled.expired,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  if (count >= 1 && !confirmedExtraBooking) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: "CONFIRM_EXTRA_BOOKING",
      count,
      expiredStale: reconciled.expired,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  return {
    allowed: true,
    count,
    expiredStale: reconciled.expired,
    activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
  };
}

/**
 * Atomic create with booking_slots counter (race-safe 4-booking limit).
 * Slot counter is synced to live non-terminal rides before the transaction.
 */
async function createCustomerBooking(db, { customerUid, ridePayload, confirmedExtraBooking = false }) {
  if (!customerUid || !ridePayload) throw err("invalid-argument", "MISSING_FIELDS");

  const pickupLat = Number(ridePayload.pickupLocation?.lat);
  const pickupLng = Number(ridePayload.pickupLocation?.lng);
  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
    throw err("invalid-argument", "INVALID_PICKUP");
  }
  const dropLat = Number(ridePayload.dropoffLocation?.lat);
  const dropLng = Number(ridePayload.dropoffLocation?.lng);
  if (!Number.isFinite(dropLat) || !Number.isFinite(dropLng)) {
    throw err("invalid-argument", "INVALID_DROPOFF");
  }

  // Sync slots to live rides and expire stale searching docs before limit checks.
  const reconciled = await reconcileCustomerBookingState(db, customerUid);
  const liveCount = reconciled.activeCount;
  if (liveCount >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
    throw err("failed-precondition", "MAX_ACTIVE_BOOKINGS");
  }
  if (liveCount >= 1 && !confirmedExtraBooking) {
    throw err("failed-precondition", "CONFIRM_EXTRA_BOOKING");
  }

  const slotRef = db.collection("booking_slots").doc(customerUid);
  const rideRef = db.collection("rides").doc();

  return db.runTransaction(async (tx) => {
    const slotSnap = await tx.get(slotRef);
    // Post-reconcile slots track live non-terminal count; TX remains race-safe.
    const count = slotSnap.exists ? Math.max(0, Number(slotSnap.data()?.count || 0)) : 0;
    if (count >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
      throw err("failed-precondition", "MAX_ACTIVE_BOOKINGS");
    }
    if (count >= 1 && !confirmedExtraBooking) {
      throw err("failed-precondition", "CONFIRM_EXTRA_BOOKING");
    }

    const now = Date.now();
    const payload = {
      ...ridePayload,
      [CUSTOMER_RIDE_OWNER_FIELD]: customerUid,
      userId: customerUid,
      status: "searching_driver",
      createdAt: FieldValue.serverTimestamp(),
      // Server-controlled search deadline — clients must not overwrite (rules deny).
      expiresAt: Timestamp.fromMillis(now + SEARCH_EXPIRE_MS),
      searchExpireMs: SEARCH_EXPIRE_MS,
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
 * Preview partial fare if customer cancels an in-progress ride.
 */
async function previewCancellationFare(db, { customerUid, rideId }) {
  if (!customerUid || !rideId) throw err("invalid-argument", "MISSING_FIELDS");
  const rideSnap = await db.collection("rides").doc(rideId).get();
  if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
  const ride = rideSnap.data() || {};
  if (!isOwnedByCustomer(ride, customerUid)) {
    throw err("permission-denied", "NOT_YOUR_BOOKING");
  }
  if (String(ride.status || "") !== "in_progress") {
    return {
      rideId,
      status: ride.status || null,
      partialFareApplies: false,
      cancellationFare: 0,
      traveledDistanceKm: 0,
      baseFare: 0,
      perKmRate: 0,
    };
  }
  const pricingSnap = await db.collection("settings").doc("pricing").get();
  const pricing = pricingSnap.exists ? pricingSnap.data() || {} : {};
  const breakdown = computeCancellationFare(pricing, ride);
  return {
    rideId,
    status: ride.status,
    partialFareApplies: true,
    ...breakdown,
  };
}

/**
 * Cancel booking + release slot (trusted).
 * Pre-start cancel is free; in_progress charges base fare + traveled distance.
 * @param {{ customerUid: string, rideId: string, cancelReason?: string, cancelReasonKey?: string }} params
 */
async function cancelCustomerBooking(db, { customerUid, rideId, cancelReason, cancelReasonKey }) {
  if (!customerUid || !rideId) throw err("invalid-argument", "MISSING_FIELDS");
  const rideRef = db.collection("rides").doc(rideId);
  const reasonKey = CANCEL_REASON_KEYS.includes(String(cancelReasonKey || ""))
    ? String(cancelReasonKey)
    : "other";
  const reasonText = String(cancelReason || reasonKey).trim().slice(0, 200);

  const preSnap = await rideRef.get();
  if (!preSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
  const preRide = preSnap.data() || {};
  if (!isOwnedByCustomer(preRide, customerUid)) {
    throw err("permission-denied", "NOT_YOUR_BOOKING");
  }

  let partialBreakdown = null;
  if (String(preRide.status || "") === "in_progress") {
    const pricingSnap = await db.collection("settings").doc("pricing").get();
    partialBreakdown = computeCancellationFare(
      pricingSnap.exists ? pricingSnap.data() || {} : {},
      preRide
    );
  }

  const outcome = await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};
    if (!isOwnedByCustomer(ride, customerUid)) {
      throw err("permission-denied", "NOT_YOUR_BOOKING");
    }
    // Idempotent: already customer-cancelled.
    if (
      ride.status === "cancelled_by_customer" ||
      ride.status === "cancelled_by_user" ||
      ride.status === "cancelled_by_system"
    ) {
      return {
        already: true,
        status: ride.status,
        cancellationFare: Number(ride.cancellationFare ?? ride.farePkr) || 0,
        traveledDistanceKm: Number(ride.traveledDistanceKm) || 0,
      };
    }
    if (ride.status === SEARCH_EXPIRED_STATUS || ride.status === "no_driver_found") {
      return {
        already: true,
        status: ride.status,
        cancellationFare: 0,
        traveledDistanceKm: 0,
      };
    }
    if (!CANCELLABLE_RIDE_STATUSES.includes(String(ride.status || ""))) {
      throw err("failed-precondition", `NOT_CANCELLABLE:${ride.status || "unknown"}`);
    }
    const assignedDriverId = ride.driverId || null;
    let partnerRef = null;
    let partnerSnap = null;
    if (assignedDriverId) {
      partnerRef = db.collection("partners").doc(assignedDriverId);
      partnerSnap = await tx.get(partnerRef);
    }
    const patch = {
      status: "cancelled_by_customer",
      cancelReason: reasonText || reasonKey,
      cancelReasonKey: reasonKey,
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledFromStatus: ride.status,
    };
    if (String(ride.status || "") === "in_progress" && partialBreakdown) {
      patch.traveledDistanceKm = partialBreakdown.traveledDistanceKm;
      patch.cancellationFare = partialBreakdown.cancellationFare;
      patch.farePkr = partialBreakdown.cancellationFare;
      patch.partialCancellation = true;
    }
    if (assignedDriverId) {
      patch.previousDriverId = assignedDriverId;
      if (String(ride.status || "") !== "in_progress") {
        patch.driverId = FieldValue.delete();
        patch.vehicleId = FieldValue.delete();
      }
    }
    tx.update(rideRef, patch);
    if (
      assignedDriverId &&
      partnerRef &&
      partnerSnap?.exists &&
      partnerSnap.data()?.activeRideId === rideId &&
      String(ride.status || "") !== "in_progress"
    ) {
      tx.set(
        partnerRef,
        { activeRideId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    return {
      already: false,
      status: "cancelled_by_customer",
      releasedDriverId: assignedDriverId,
      cancelledFromStatus: ride.status,
      partialBreakdown:
        String(ride.status || "") === "in_progress" ? partialBreakdown : null,
    };
  });

  await closeCandidatesAndOffersForRide(db, rideId, "cancelled_by_customer").catch(() => {});

  let settlement = null;
  if (
    !outcome.already &&
    outcome.partialBreakdown &&
    outcome.releasedDriverId &&
    outcome.partialBreakdown.cancellationFare >= 0
  ) {
    try {
      settlement = await settlePartialCancellation(db, {
        rideId,
        customerUid,
        driverId: outcome.releasedDriverId,
        cancellationFare: outcome.partialBreakdown.cancellationFare,
        traveledDistanceKm: outcome.partialBreakdown.traveledDistanceKm,
        cancelledFromStatus: outcome.cancelledFromStatus,
      });
    } catch (settleErr) {
      console.warn("[cancelCustomerBooking] partial settlement failed:", settleErr);
    }
  }

  await reconcileCustomerBookingState(db, customerUid);

  return {
    ok: true,
    rideId,
    status: outcome.status,
    already: Boolean(outcome.already),
    cancelledCount: outcome.already ? 0 : 1,
    skippedCount: outcome.already ? 1 : 0,
    failedCount: 0,
    partialFareApplies: Boolean(outcome.partialBreakdown),
    cancellationFare: outcome.partialBreakdown?.cancellationFare ?? outcome.cancellationFare ?? 0,
    traveledDistanceKm:
      outcome.partialBreakdown?.traveledDistanceKm ?? outcome.traveledDistanceKm ?? 0,
    settlement,
  };
}

/**
 * Mark a searching ride as `expired` after the 3-minute search window.
 * Atomic vs assignment: only wins if status is still searching_driver and unassigned.
 * Idempotent; closes candidates/offers; reconciles slots. No settlement side effects.
 *
 * @param {{ customerUid?: string, rideId: string, nowMs?: number, force?: boolean }} params
 *   force — skip clock check (admin/test only); still requires searching + unassigned
 */
async function expireSearchingBooking(db, { customerUid, rideId, nowMs = Date.now(), force = false }) {
  if (!rideId) throw err("invalid-argument", "MISSING_FIELDS");
  const rideRef = db.collection("rides").doc(rideId);

  const outcome = await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};

    if (customerUid && !isOwnedByCustomer(ride, customerUid)) {
      throw err("permission-denied", "NOT_YOUR_BOOKING");
    }

    // Idempotent terminal outcomes
    if (ride.status === SEARCH_EXPIRED_STATUS || ride.status === "no_driver_found") {
      return { changed: false, status: ride.status, reason: "already_expired" };
    }
    if (ACTIVE_RIDE_STATUSES.includes(ride.status) || ride.status === "completed") {
      return { changed: false, status: ride.status, reason: "already_assigned_or_done" };
    }
    if (String(ride.status || "").startsWith("cancelled")) {
      return { changed: false, status: ride.status, reason: "already_cancelled" };
    }

    // Assignment wins the race if already claimed.
    if (ride.status !== "searching_driver" || ride.driverId) {
      throw err("failed-precondition", "RIDE_NOT_EXPIREABLE");
    }

    if (!force && !isSearchingPastExpiry(ride, nowMs)) {
      throw err("failed-precondition", "NOT_YET_EXPIRED");
    }

    tx.update(rideRef, {
      status: SEARCH_EXPIRED_STATUS,
      expireReason: "search_timeout_3min",
      expiredAt: FieldValue.serverTimestamp(),
      cancelledAt: FieldValue.serverTimestamp(),
    });
    return { changed: true, status: SEARCH_EXPIRED_STATUS, reason: "search_timeout_3min" };
  });

  if (outcome.changed) {
    await closeCandidatesAndOffersForRide(db, rideId, "search_timeout_3min").catch(() => {});
  }
  const owner = customerUid || null;
  if (owner) {
    await reconcileCustomerBookingState(db, owner, { nowMs });
  } else {
    const snap = await rideRef.get();
    const uid = rideOwnerUid(snap.data() || {});
    if (uid) await reconcileCustomerBookingState(db, uid, { nowMs });
  }

  return {
    ok: true,
    rideId,
    status: outcome.status,
    changed: Boolean(outcome.changed),
    reason: outcome.reason,
  };
}

/**
 * Batch expire overdue searching rides (indexed expiresAt query).
 * Limited batch — never full-collection scan.
 *
 * Cost (per invocation, default limit=25):
 * - 1 query read up to `limit` docs
 * - per ride: 1 transactional read+write + candidate/offer reads/writes (typically small)
 *
 * @returns {{ processed, expired, skipped, failed, readsEstimate, writesEstimate }}
 */
async function expireDueSearchingBookings(db, { limit = 25, nowMs = Date.now() } = {}) {
  const batchLimit = Math.max(1, Math.min(50, Number(limit) || 25));
  const nowTs = Timestamp.fromMillis(nowMs);
  let snap;
  try {
    snap = await db
      .collection("rides")
      .where("status", "==", "searching_driver")
      .where("expiresAt", "<=", nowTs)
      .orderBy("expiresAt", "asc")
      .limit(batchLimit)
      .get();
  } catch (e) {
    // Emulator / missing index fallback: scan customer's active is not global —
    // use a capped status-only query then filter in memory (still not full fleet of all statuses).
    const fallback = await db
      .collection("rides")
      .where("status", "==", "searching_driver")
      .limit(batchLimit)
      .get();
    const docs = fallback.docs.filter((d) => isSearchingPastExpiry(d.data(), nowMs));
    snap = { docs, empty: docs.length === 0, size: docs.length };
  }

  let expired = 0;
  let skipped = 0;
  let failed = 0;
  let writes = 0;
  for (const doc of snap.docs) {
    try {
      const result = await expireSearchingBooking(db, {
        rideId: doc.id,
        customerUid: rideOwnerUid(doc.data() || {}),
        nowMs,
      });
      if (result.changed) {
        expired += 1;
        writes += 2;
      } else {
        skipped += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    processed: snap.size,
    expired,
    skipped,
    failed,
    readsEstimate: snap.size + expired * 2,
    writesEstimate: writes + expired,
    limit: batchLimit,
  };
}

/**
 * After ride create: select candidates and write ride_candidates docs.
 * Phase 3B: when `onlineDrivers` is omitted, loads via geo-scoped cell/hotspot
 * queries only (never full online fleet). Passing `onlineDrivers` remains for
 * pure unit fixtures that already built an in-memory list.
 */
async function matchRideCandidates(db, { rideId, pickup, onlineDrivers, candidateDriverLimit, excludeDriverIds, _latencyTimer }) {
  const matchStart = Date.now();
  const [settings, rideMeta] = await Promise.all([
    readDispatchSettings(db),
    db.collection("rides").doc(rideId).get(),
  ]);
  const limit =
    candidateDriverLimit != null
      ? validateCandidateDriverLimit(candidateDriverLimit)
      : settings.candidateDriverLimit;
  const maxRadiusKm =
    Number.isFinite(Number(settings.maxSearchRadiusKm)) && Number(settings.maxSearchRadiusKm) > 0
      ? Number(settings.maxSearchRadiusKm)
      : DEFAULT_MAX_SEARCH_RADIUS_KM;
  const searchRingsKm =
    Array.isArray(settings.searchRingsKm) && settings.searchRingsKm.length
      ? settings.searchRingsKm
      : buildSearchRingsKm(maxRadiusKm);
  const excludeSet = new Set((excludeDriverIds || []).map((id) => String(id)));
  if (rideMeta.exists) {
    const fromRide = rideMeta.data()?.rematchExcludeDriverIds;
    if (Array.isArray(fromRide)) {
      for (const id of fromRide) excludeSet.add(String(id));
    }
  }

  const createdMs = timestampToMs(rideMeta.exists ? rideMeta.data()?.createdAt : null);
  const elapsedSeconds = createdMs > 0 ? Math.max(0, Math.round((Date.now() - createdMs) / 1000)) : 0;
  console.log(
    "[Dispatch Debug] Searching candidates for booking:",
    rideId,
    "Time elapsed:",
    elapsedSeconds
  );

  let selected;
  let metrics = { usedFullFleetScan: false, source: "in_memory", exclusions: [] };
  if (Array.isArray(onlineDrivers)) {
    const exclusions = [];
    for (const d of onlineDrivers) {
      if (excludeSet.has(String(d.driverId))) {
        exclusions.push({ driverId: d.driverId, reason: "excluded_driver" });
        continue;
      }
      const reason = classifyDriverMatchExclusion(d, {
        nowMs: Date.now(),
        staleMs: STALE_LOCATION_MS,
      });
      if (reason) {
        exclusions.push({ driverId: d.driverId, reason });
        continue;
      }
      const distanceKm = haversineKm(pickup, { lat: d.lat, lng: d.lng });
      if (distanceKm != null && distanceKm > maxRadiusKm) {
        exclusions.push({ driverId: d.driverId, reason: "beyond_search_radius" });
      }
    }
    selected = selectCandidatesProgressive(pickup, onlineDrivers, limit, {
      excludeDriverIds: excludeSet,
      ringsKm: searchRingsKm,
    });
    metrics = { usedFullFleetScan: false, source: "in_memory", exclusions };
  } else {
    const geo = await loadAndSelectGeoCandidates(db, pickup, limit, {
      ringsKm: searchRingsKm,
      maxRadiusKm,
    });
    selected = (geo.selected || []).filter((c) => !excludeSet.has(String(c.driverId)));
    const geoExclusions = [];
    for (const d of geo.drivers || []) {
      if (excludeSet.has(String(d.driverId))) {
        geoExclusions.push({ driverId: d.driverId, reason: "excluded_driver" });
        continue;
      }
      if (d.locationUpdatedAtMs == null) {
        geoExclusions.push({ driverId: d.driverId, reason: "missing_location_timestamp" });
        continue;
      }
      const reason = classifyDriverMatchExclusion(d, {
        nowMs: Date.now(),
        staleMs: STALE_LOCATION_MS,
      });
      if (reason) {
        geoExclusions.push({ driverId: d.driverId, reason });
        continue;
      }
      const distanceKm = haversineKm(pickup, { lat: d.lat, lng: d.lng });
      if (distanceKm != null && distanceKm > maxRadiusKm) {
        geoExclusions.push({ driverId: d.driverId, reason: "beyond_search_radius" });
      }
    }
    metrics = {
      ...geo.metrics,
      source: "geo_scoped",
      exclusions: geoExclusions,
      vehicleDocsRead: geo.metrics?.vehicleDocsRead || 0,
    };

    // When geo yields zero eligible candidates — probe a capped online set within search radius.
    if (!selected || selected.length === 0) {
      const probe = await db
        .collection("vehicles")
        .where("status", "==", "online")
        .limit(75)
        .get();
      metrics.usedCappedOnlineProbe = true;
      metrics.probeReason =
        (metrics.vehicleDocsRead || 0) === 0 ? "empty_geo_cells" : "geo_selected_empty";
      metrics.probeDocsRead = probe.size;
      const probed = [];
      for (const doc of probe.docs) {
        const v = doc.data() || {};
        if (!v.driverId) continue;
        const lat = Number(v.location?.lat);
        const lng = Number(v.location?.lng);
        const distanceKm = haversineKm(pickup, { lat, lng });
        if (distanceKm == null || distanceKm > maxRadiusKm) continue;
        let locationUpdatedAtMs = null;
        const ts = v.locationUpdatedAt;
        if (ts && typeof ts.toMillis === "function") locationUpdatedAtMs = ts.toMillis();
        else if (typeof ts?.seconds === "number") locationUpdatedAtMs = ts.seconds * 1000;
        probed.push({
          vehicleId: doc.id,
          driverId: v.driverId,
          lat,
          lng,
          status: v.status,
          activeRideId: v.activeRideId || null,
          locationUpdatedAtMs,
          accountStatus: "active",
        });
      }
      await Promise.all(
        probed.map((d) =>
          db
            .collection("partners")
            .doc(d.driverId)
            .get()
            .then((partner) => {
              const p = partner.exists ? partner.data() || {} : {};
              d.accountStatus = p.accountStatus || "active";
              if (p.activeRideId) d.activeRideId = d.activeRideId || p.activeRideId;
            })
            .catch(() => {
              d.accountStatus = d.accountStatus || "active";
            })
        )
      );
      selected = selectCandidatesProgressive(pickup, probed, limit, {
        requireFreshLocation: false,
        staleMs: Math.max(STALE_LOCATION_MS, 10 * 60 * 1000),
        excludeDriverIds: excludeSet,
        ringsKm: searchRingsKm,
      });
      metrics.source = "geo_scoped_plus_capped_probe";
    }
  }

  selected = (selected || []).filter((c) => !excludeSet.has(String(c.driverId)));

  console.log(
    "[Dispatch Debug] Candidates ready for booking:",
    rideId,
    "count:",
    selected.length,
    "source:",
    metrics.source,
    "elapsedSeconds:",
    elapsedSeconds
  );

  // Do not resurrect declined/closed candidates on rematch; only invite new or refresh invited.
  const existingByDriver = new Map();
  if (selected.length) {
    const existingSnap = await db
      .collection("ride_candidates")
      .where("rideId", "==", rideId)
      .get();
    for (const doc of existingSnap.docs) {
      const data = doc.data() || {};
      if (data.driverId) existingByDriver.set(String(data.driverId), { id: doc.id, ...data });
    }
  }

  const toInvite = [];
  for (const c of selected) {
    const prev = existingByDriver.get(String(c.driverId));
    const prevStatus = String(prev?.status || "");
    if (prevStatus && prevStatus !== "invited") continue;
    toInvite.push(c);
  }

  const batch = db.batch();
  for (const c of toInvite) {
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
  const invitedDriverIds = new Set([
    ...toInvite.map((c) => String(c.driverId)),
    ...[...existingByDriver.entries()]
      .filter(([, v]) => v.status === "invited")
      .map(([id]) => id),
  ]);
  const candidateCount = invitedDriverIds.size || toInvite.length;

  batch.set(
    db.collection("rides").doc(rideId),
    {
      candidateCount,
      candidateDriverLimit: limit,
      matchingStatus: candidateCount ? "candidates_ready" : "no_candidates",
      matchingRingKm: metrics.ringExpandedToKm || maxRadiusKm || null,
      maxSearchRadiusKm: maxRadiusKm,
      matchingSource: metrics.source || null,
      matchingExclusions: (metrics.exclusions || []).slice(0, 20),
      matchingVehicleDocsRead: metrics.vehicleDocsRead ?? null,
      matchingUsedProbe: Boolean(metrics.usedCappedOnlineProbe),
      matchingProbeReason: metrics.probeReason || null,
      matchedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await batch.commit();
  const matchMs = Date.now() - matchStart;
  console.log(
    JSON.stringify({
      type: "dispatch_latency",
      side: "server",
      label: "matchRideCandidates",
      rideId,
      totalMs: matchMs,
      candidateCount: toInvite.length,
      source: metrics.source,
    })
  );
  _latencyTimer?.mark?.("candidates_committed", {
    rideId,
    candidateCount: toInvite.length,
    matchMs,
  });
  return {
    candidates: toInvite,
    candidateDriverLimit: limit,
    metrics,
    elapsedSeconds,
    candidateCount,
  };
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

    const vehicleRef = offer.vehicleId
      ? db.collection("vehicles").doc(offer.vehicleId)
      : null;
    const vehicleSnap = vehicleRef ? await tx.get(vehicleRef) : null;
    if (!vehicleSnap?.exists || vehicleSnap.data()?.driverId !== offer.driverId) {
      throw err("permission-denied", "VEHICLE_NOT_LINKED");
    }
    if (vehicleSnap.data()?.activeRideId) throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");

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

    tx.update(vehicleRef, {
      status: "in_ride",
      activeRideId: offer.rideId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const candRef = db.collection("ride_candidates").doc(
      candidateDocId(offer.rideId, offer.driverId)
    );
    tx.set(
      candRef,
      {
        rideId: offer.rideId,
        driverId: offer.driverId,
        status: "accepted",
        updatedAt: FieldValue.serverTimestamp(),
        closedReason: "driver_assigned",
      },
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
    if (!result.alreadyAssigned && result.rideId) {
      const offerSnap = await db.collection("ride_offers").doc(offerId).get();
      const vehicleId = offerSnap.data()?.vehicleId;
      if (vehicleId) {
        await seedDriverLocationFromVehicle(db, result.rideId, vehicleId).catch((err) => {
          console.warn("[seedDriverLocation]", err?.message || err);
        });
      }
    }
    return result;
  });
}

/**
 * Driver accepts the customer's initial estimated fare (direct assignment, no counter round-trip).
 */
async function acceptCustomerInitialFareAsDriver(db, params) {
  const {
    rideId,
    driverUid,
    vehicleId,
    ownerId,
    driverName,
    vehiclePlate,
  } = params;

  if (!rideId || !driverUid || !vehicleId) throw err("invalid-argument", "MISSING_FIELDS");

  if (await driverHasActiveRide(db, driverUid)) {
    throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
  }

  const existingOfferId = `${rideId}_${driverUid}`;
  const rideRef = db.collection("rides").doc(rideId);
  const candRef = db.collection("ride_candidates").doc(candidateDocId(rideId, driverUid));
  const offerRef = db.collection("ride_offers").doc(existingOfferId);
  const partnerRef = db.collection("partners").doc(driverUid);
  const vehicleRef = db.collection("vehicles").doc(vehicleId);

  const result = await db.runTransaction(async (tx) => {
    const [rideSnap, candSnap, offerSnap, partnerSnap, vehicleSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(candRef),
      tx.get(offerRef),
      tx.get(partnerRef),
      tx.get(vehicleRef),
    ]);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};
    if (ride.status !== "searching_driver") throw err("failed-precondition", "RIDE_NOT_AVAILABLE");
    if (!candSnap.exists || candSnap.data()?.status !== "invited") {
      throw err("permission-denied", "NOT_A_CANDIDATE");
    }

    const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
    if (partner.accountStatus === "blocked") throw err("permission-denied", "DRIVER_BLOCKED");
    if (partner.accountStatus === "suspended") throw err("permission-denied", "DRIVER_SUSPENDED");
    if (partner.activeRideId) throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
    if (!vehicleSnap.exists || vehicleSnap.data()?.driverId !== driverUid) {
      throw err("permission-denied", "VEHICLE_NOT_LINKED");
    }
    if (vehicleSnap.data()?.activeRideId) throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");

    const prev = offerSnap.exists ? offerSnap.data() : null;
    if (prev?.status === "accepted") {
      return {
        alreadyAssigned: true,
        rideId,
        driverId: driverUid,
        fare: Math.round(Number(prev.fare) || Number(ride.estimatedFare) || 0),
      };
    }

    const finalFare = Math.round(Number(ride.estimatedFare ?? ride.farePkr ?? 0));
    if (!Number.isFinite(finalFare) || finalFare <= 0) {
      throw err("failed-precondition", "INVALID_FARE");
    }

    tx.update(vehicleRef, {
      status: "in_ride",
      activeRideId: rideId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(candRef, {
      status: "accepted",
      updatedAt: FieldValue.serverTimestamp(),
      closedReason: "driver_assigned",
    });

    tx.update(rideRef, {
      status: "accepted",
      driverId: driverUid,
      vehicleId,
      ownerId: ownerId || null,
      driverName: driverName || "SwiftGo Driver",
      vehiclePlate: vehiclePlate || "—",
      farePkr: finalFare,
      estimatedFare: finalFare,
      driverBidFare: finalFare,
      assignedAt: FieldValue.serverTimestamp(),
    });

    const offerPayload = {
      rideId,
      driverId: driverUid,
      customerId: ride.userId,
      fare: finalFare,
      status: "accepted",
      vehicleId,
      ownerId: ownerId || null,
      driverName: driverName || "SwiftGo Driver",
      vehiclePlate: vehiclePlate || "—",
      acceptedAtCustomerFare: true,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!offerSnap.exists) {
      offerPayload.createdAt = FieldValue.serverTimestamp();
    }
    tx.set(offerRef, offerPayload, { merge: true });

    tx.set(
      partnerRef,
      { activeRideId: rideId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    return {
      alreadyAssigned: false,
      rideId,
      driverId: driverUid,
      fare: finalFare,
      needsOfferCleanup: true,
    };
  });

  if (result.needsOfferCleanup) {
    await closeSiblingOffers(db, result.rideId, driverUid, existingOfferId);
  }
  if (!result.alreadyAssigned) {
    await seedDriverLocationFromVehicle(db, result.rideId, vehicleId).catch((err) => {
      console.warn("[seedDriverLocation]", err?.message || err);
    });
  }

  return {
    ok: true,
    rideId: result.rideId,
    driverId: result.driverId,
    fare: result.fare,
    assigned: true,
    alreadyAssigned: Boolean(result.alreadyAssigned),
  };
}

/**
 * After assignment: expire other offers on the ride; withdraw driver's other open offers
 * and pending ride_candidates invitations on other rides.
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
  await closeDriverOtherCandidates(db, driverId, rideId);
}

/**
 * Driver may serve one ride at a time — withdraw invited candidates on other rides.
 */
async function closeDriverOtherCandidates(db, driverId, winningRideId) {
  const snap = await db
    .collection("ride_candidates")
    .where("driverId", "==", driverId)
    .where("status", "==", "invited")
    .get();
  if (snap.empty) return { withdrawn: 0, accepted: 0 };

  const batch = db.batch();
  let withdrawn = 0;
  let accepted = 0;
  for (const doc of snap.docs) {
    const cand = doc.data() || {};
    const candRideId = cand.rideId || String(doc.id).split("_")[0];
    if (candRideId === winningRideId) {
      batch.update(doc.ref, {
        status: "accepted",
        updatedAt: FieldValue.serverTimestamp(),
        closedReason: "driver_assigned",
      });
      accepted += 1;
    } else {
      batch.update(doc.ref, {
        status: "withdrawn",
        updatedAt: FieldValue.serverTimestamp(),
        closedReason: "driver_assigned_elsewhere",
      });
      withdrawn += 1;
    }
  }
  await batch.commit();
  return { withdrawn, accepted };
}

const NEARBY_REMATCH_RIDE_LIMIT = 40;
const NEARBY_REMATCH_KM = 3;

/**
 * When a driver becomes matchable (online + location), invite them to nearby searching rides.
 */
async function rematchNearbySearchingRidesForVehicle(db, vehicle) {
  const driverId = vehicle?.driverId;
  const lat = Number(vehicle?.location?.lat);
  const lng = Number(vehicle?.location?.lng);
  if (!driverId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { rematched: 0, skipped: "no_location" };
  }
  if (vehicle.status !== "online" || vehicle.activeRideId) {
    return { rematched: 0, skipped: "not_available" };
  }

  const partnerSnap = await db.collection("partners").doc(driverId).get();
  const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
  if (
    partner.accountStatus === "blocked" ||
    partner.accountStatus === "suspended" ||
    partner.activeRideId
  ) {
    return { rematched: 0, skipped: "partner_unavailable" };
  }

  const snap = await db
    .collection("rides")
    .where("status", "==", "searching_driver")
    .orderBy("createdAt", "desc")
    .limit(NEARBY_REMATCH_RIDE_LIMIT)
    .get();

  let rematched = 0;
  for (const doc of snap.docs) {
    const ride = doc.data() || {};
    const pickup = {
      lat: Number(ride.pickupLocation?.lat),
      lng: Number(ride.pickupLocation?.lng),
    };
    if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) continue;
    const km = haversineKm(pickup, { lat, lng });
    if (km == null || km > NEARBY_REMATCH_KM) continue;
    try {
      await matchRideCandidates(db, { rideId: doc.id, pickup });
      rematched += 1;
    } catch (err) {
      console.warn("[rematchOnDriverOnline]", doc.id, err?.message || err);
    }
  }
  return { rematched };
}

module.exports = {
  readDispatchSettings,
  countCustomerActiveBookings,
  reconcileCustomerBookingState,
  cancelAllSearchingBookings,
  evaluateCustomerBookingGate,
  createCustomerBooking,
  releaseCustomerBookingSlot,
  cancelCustomerBooking,
  previewCancellationFare,
  expireSearchingBooking,
  expireDueSearchingBookings,
  closeCandidatesAndOffersForRide,
  matchRideCandidates,
  countDriverOpenBargains,
  driverHasActiveRide,
  submitRideOffer,
  counterRideOffer,
  rejectRideOffer,
  finalizeAssignmentFromOffer,
  acceptCustomerInitialFareAsDriver,
  closeSiblingOffers,
  rematchNearbySearchingRidesForVehicle,
  SEARCH_EXPIRE_MS,
  SEARCH_EXPIRED_STATUS,
};
