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
  isOpenOfferStatus,
  STALE_LOCATION_MS,
  haversineKm,
  classifyDriverMatchExclusion,
} = require("./matching");
const { loadAndSelectGeoCandidates } = require("./geo-match");

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
    for (const item of toClose) {
      await closeCandidatesAndOffersForRide(db, item.id, item.reason).catch(() => {});
    }
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
    .where(CUSTOMER_RIDE_OWNER_FIELD, "==", customerUid)
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
  // Reconcile inflated booking_slots and expire stale searching rides first.
  const reconciled = await reconcileCustomerBookingState(db, customerUid);
  // Live canonical rides for this UID are the only count that may block booking.
  const active = await countCustomerActiveBookings(db, customerUid);
  const count = active.length;

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
  await reconcileCustomerBookingState(db, customerUid);
  const live = await countCustomerActiveBookings(db, customerUid);
  if (live.length >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
    throw err("failed-precondition", "MAX_ACTIVE_BOOKINGS");
  }
  if (live.length >= 1 && !confirmedExtraBooking) {
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
 * Cancel searching booking + release slot (trusted).
 * Closes candidates/offers; reconciles slots from live rides.
 * @param {{ customerUid: string, rideId: string, cancelReason?: string, cancelReasonKey?: string }} params
 */
async function cancelCustomerBooking(db, { customerUid, rideId, cancelReason, cancelReasonKey }) {
  if (!customerUid || !rideId) throw err("invalid-argument", "MISSING_FIELDS");
  const rideRef = db.collection("rides").doc(rideId);
  const reasonKey = CANCEL_REASON_KEYS.includes(String(cancelReasonKey || ""))
    ? String(cancelReasonKey)
    : "other";
  const reasonText = String(cancelReason || reasonKey).trim().slice(0, 200);

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
      return { already: true, status: ride.status };
    }
    if (ride.status === SEARCH_EXPIRED_STATUS || ride.status === "no_driver_found") {
      return { already: true, status: ride.status };
    }
    if (!CANCELLABLE_RIDE_STATUSES.includes(String(ride.status || ""))) {
      throw err("failed-precondition", `NOT_CANCELLABLE:${ride.status || "unknown"}`);
    }
    // searching_driver may still have no driverId; accepted/arrived must release assignee.
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
    };
    if (assignedDriverId) {
      patch.driverId = FieldValue.delete();
      patch.vehicleId = FieldValue.delete();
      patch.previousDriverId = assignedDriverId;
      patch.cancelledFromStatus = ride.status;
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
    return { already: false, status: "cancelled_by_customer", releasedDriverId: assignedDriverId };
  });

  await closeCandidatesAndOffersForRide(db, rideId, "cancelled_by_customer").catch(() => {});
  await reconcileCustomerBookingState(db, customerUid);

  return {
    ok: true,
    rideId,
    status: outcome.status,
    already: Boolean(outcome.already),
    cancelledCount: outcome.already ? 0 : 1,
    skippedCount: outcome.already ? 1 : 0,
    failedCount: 0,
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
async function matchRideCandidates(db, { rideId, pickup, onlineDrivers, candidateDriverLimit, excludeDriverIds }) {
  const settings = await readDispatchSettings(db);
  const limit =
    candidateDriverLimit != null
      ? validateCandidateDriverLimit(candidateDriverLimit)
      : settings.candidateDriverLimit;
  const excludeSet = new Set((excludeDriverIds || []).map((id) => String(id)));
  const rideMeta = await db.collection("rides").doc(rideId).get();
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
      if (distanceKm != null && distanceKm > 3) {
        exclusions.push({ driverId: d.driverId, reason: "beyond_3km" });
      }
    }
    selected = selectCandidatesProgressive(pickup, onlineDrivers, limit, {
      excludeDriverIds: excludeSet,
    });
    metrics = { usedFullFleetScan: false, source: "in_memory", exclusions };
  } else {
    const geo = await loadAndSelectGeoCandidates(db, pickup, limit);
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
      if (distanceKm != null && distanceKm > 3) {
        geoExclusions.push({ driverId: d.driverId, reason: "beyond_3km" });
      }
    }
    metrics = {
      ...geo.metrics,
      source: "geo_scoped",
      exclusions: geoExclusions,
      vehicleDocsRead: geo.metrics?.vehicleDocsRead || 0,
    };

    // When geo yields zero eligible candidates — including stale/busy docs in cells —
    // probe a capped online set within 3 km. Not a full-fleet fan-out.
    if (!selected || selected.length === 0) {
      const probe = await db
        .collection("vehicles")
        .where("status", "==", "online")
        .limit(25)
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
        if (distanceKm == null || distanceKm > 3) continue;
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
      for (const d of probed) {
        const partner = await db.collection("partners").doc(d.driverId).get();
        const p = partner.exists ? partner.data() || {} : {};
        d.accountStatus = p.accountStatus || "active";
        if (p.activeRideId) d.activeRideId = d.activeRideId || p.activeRideId;
      }
      selected = selectCandidatesProgressive(pickup, probed, limit, {
        requireFreshLocation: false,
        staleMs: Math.max(STALE_LOCATION_MS, 10 * 60 * 1000),
        excludeDriverIds: excludeSet,
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
      matchingRingKm: metrics.ringExpandedToKm || null,
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
  reconcileCustomerBookingState,
  cancelAllSearchingBookings,
  evaluateCustomerBookingGate,
  createCustomerBooking,
  releaseCustomerBookingSlot,
  cancelCustomerBooking,
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
  closeSiblingOffers,
  SEARCH_EXPIRE_MS,
  SEARCH_EXPIRED_STATUS,
};
