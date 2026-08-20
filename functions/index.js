/**
 * SwiftGo Cloud Functions — settlement, matching, bargaining (Phase 2A).
 * Emulator-ready; do not deploy in this phase unless separately approved.
 */

"use strict";

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { createDispatchTimer, withDispatchTimeout } = require("./dispatch-latency");
const {
  evaluateCustomerBookingGate,
  createCustomerBooking,
  cancelCustomerBooking,
  cancelAllSearchingBookings,
  expireSearchingBooking,
  expireDueSearchingBookings,
  expireDueRideOffers,
  expireRideOffer,
  matchRideCandidates,
  previewCancellationFare,
  submitRideOffer,
  counterRideOffer,
  rejectRideOffer,
  finalizeAssignmentFromOffer,
  acceptCustomerInitialFareAsDriver,
  readDispatchSettings,
  rematchNearbySearchingRidesForVehicle,
  normalizeSearchTimeoutSeconds,
  SEARCH_TIMEOUT_SECONDS_MIN,
  SEARCH_TIMEOUT_SECONDS_MAX,
} = require("./bargaining");
const {
  declineRideCandidate,
  withdrawRideOffer,
  cancelAssignedRideByDriver,
  cancelRideByAdmin,
} = require("./ride-cancellation");
const { submitCompletedRideRating } = require("./ride-rating");
const { validateCandidateDriverLimit } = require("./matching");
const { evaluateVehicleRematchTrigger } = require("./dispatch-rematch");
const {
  bootstrapAdminClaim,
  initSuperAdminAccess,
  grantAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
  isAdminAuth,
  ensureCallerCanAdminWrite,
} = require("./admin-claims");
const { linkVehicleByPin } = require("./pin-link");
const {
  requestAccountDeletion: performAccountDeletionRequest,
  submitSupportReport: performSupportReport,
} = require("./account-deletion");
const {
  recordFunctionError,
  recordSettlementFailure,
  recordMatchingFailure,
  recordAuthDenial,
  recordDispatchDeliverySlo,
  getOpsHealthSummary,
  logStructured,
} = require("./ops-monitor");
const { reportGeoCellCoverage } = require("./geo-coverage");
const { mirrorDriverLocationToRide } = require("./driver-location");
const { settleRide } = require("./settlement");
const { refreshRideViewerPresence } = require("./ride-viewer-presence");
const {
  createRidePeerOffer,
  publishRidePeerAnswer,
  closeRidePeerSession,
} = require("./ride-peer-session");
const { issueP2pTurnCredentials } = require("./p2p-turn-credentials");
const { submitRideBreadcrumbBatch } = require("./breadcrumb-batch");
const { submitRideLocationReportSection } = require("./ride-location-report");
const {
  issueBackgroundLocationCredential,
  refreshBackgroundLocationCredential,
  ingestBackgroundDriverLocation,
} = require("./background-location-upload");

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();
const backgroundLocationUploadSecret = defineSecret("BACKGROUND_LOCATION_UPLOAD_SECRET");

function mapErr(err) {
  const code = err?.code || "internal";
  const message = err?.message || "FAILED";
  const known = [
    "invalid-argument",
    "not-found",
    "permission-denied",
    "failed-precondition",
    "unauthenticated",
    "resource-exhausted",
  ];
  if (known.includes(code)) return new HttpsError(code, message);
  if (message === "INVALID_CANDIDATE_LIMIT" || message === "INVALID_SEARCH_RADIUS") {
    return new HttpsError("invalid-argument", message);
  }
  if (message === "MAX_ACTIVE_BOOKINGS" || message === "CONFIRM_EXTRA_BOOKING") {
    return new HttpsError("failed-precondition", message);
  }
  if (message === "INVALID_PICKUP" || message === "INVALID_DROPOFF") {
    return new HttpsError("invalid-argument", message);
  }
  return new HttpsError("internal", message);
}

function normalizeDispatchTraceId(value) {
  const traceId = String(value || "").trim();
  if (!traceId) return "";
  if (!/^dt_[a-z0-9]+_[a-z0-9]+$/i.test(traceId) || traceId.length > 80) {
    throw new HttpsError("invalid-argument", "INVALID_DISPATCH_TRACE_ID");
  }
  return traceId;
}

async function wrapCall(name, request, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === "unauthenticated" || err?.message === "AUTH_REQUIRED") {
      await recordAuthDenial(db, name).catch(() => {});
    }
    await recordFunctionError(db, name, err).catch(() => {});
    logStructured("ERROR", "callable_failed", {
      function: name,
      code: err?.code || null,
      message: String(err?.message || err).slice(0, 200),
    });
    throw mapErr(err);
  }
}

async function callerIsAdmin(request) {
  return isAdminAuth(db, request.auth);
}

exports.completeRideSettlement = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("completeRideSettlement", request, async () => {
    try {
      return await settleRide(db, {
        rideId: request.data?.rideId,
        collectionName: request.data?.collectionName,
        callerUid: request.auth.uid,
        isAdmin: await callerIsAdmin(request),
      });
    } catch (err) {
      await recordSettlementFailure(db, request.data?.rideId, err?.message || err);
      throw err;
    }
  });
});

exports.bootstrapAdminClaim = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await bootstrapAdminClaim(db, request.auth);
  } catch (err) {
    throw mapErr(err);
  }
});

exports.initSuperAdminAccess = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await initSuperAdminAccess(db, request.auth);
  } catch (err) {
    throw mapErr(err);
  }
});

exports.grantAdminClaim = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await grantAdminClaim(db, request.auth, request.data?.uid);
  } catch (err) {
    throw mapErr(err);
  }
});

exports.revokeAdminClaim = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await revokeAdminClaim(db, request.auth, request.data?.uid);
  } catch (err) {
    throw mapErr(err);
  }
});

exports.setAdminEmailBootstrap = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await setAdminEmailBootstrap(db, request.auth, request.data?.enabled);
  } catch (err) {
    throw mapErr(err);
  }
});

exports.linkVehicleByPin = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await linkVehicleByPin(db, {
      driverUid: request.auth.uid,
      pin: request.data?.pin,
      driverName: request.auth.token?.name || request.data?.driverName,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Check / confirm gate before creating an extra booking. */
exports.checkCustomerBookingGate = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await evaluateCustomerBookingGate(db, request.auth.uid, {
      confirmedExtraBooking: Boolean(request.data?.confirmedExtraBooking),
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Cancel all searching bookings for the signed-in customer (unlock slots). */
exports.cancelAllSearchingBookings = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await cancelAllSearchingBookings(db, request.auth.uid);
  } catch (err) {
    throw mapErr(err);
  }
});

function sanitizeCallableResult(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

/** Race-safe booking create (4 concurrent non-terminal max). */
exports.createCustomerBooking = onCall(
  { region: "us-central1", minInstances: 1, timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");

    const timer = createDispatchTimer("createCustomerBooking");
    let created = null;

    try {
      const data = request.data || {};
      timer.mark("callable_start");

      created = await createCustomerBooking(db, {
        customerUid: request.auth.uid,
        confirmedExtraBooking: Boolean(data.confirmedExtraBooking),
        dispatchTraceId: normalizeDispatchTraceId(data.dispatchTraceId),
        ridePayload: {
          pickupLocation: data.pickupLocation,
          dropoffLocation: data.dropoffLocation,
          vehicleType: String(data.vehicleType || "").slice(0, 40),
          vehicleTypeKey: data.vehicleTypeKey
            ? String(data.vehicleTypeKey).slice(0, 40)
            : undefined,
          distanceKm: Math.max(0, Number(data.distanceKm) || 0),
          timeMins: Math.max(0, Number(data.timeMins) || 0),
          farePkr: Math.max(0, Number(data.farePkr) || 0),
          estimatedFare: Math.max(0, Number(data.estimatedFare ?? data.farePkr) || 0),
          promoCode: data.promoCode,
          discountAmount: data.discountAmount,
          originalFare: data.originalFare,
          paymentMethod: data.paymentMethod,
        },
      });
      timer.mark("ride_tx_complete", { rideId: created?.id });

      const latencyPayload = timer.finish({ rideId: created.id });
      return sanitizeCallableResult({
        id: created.id,
        count: created.count,
        dispatchTraceId: String(data.dispatchTraceId || ""),
        matchingStatus: "pending",
        candidateCount: 0,
        matchingError: "",
        latencyMs: Number(latencyPayload?.totalMs) || 0,
      });
    } catch (err) {
      timer.finish({
        rideId: created?.id || "",
        error: String(err?.message || err).slice(0, 120),
      });
      logger.error("[Dispatch Error] createCustomerBooking failed:", err);
      throw mapErr(err);
    }
  }
);

/**
 * Match after a successful booking write. Keeping this work out of the booking
 * callable gives the customer an immediate searching state while preserving
 * server-authoritative geo matching and candidate writes.
 */
exports.dispatchNewRideCandidates = onDocumentCreated(
  { document: "rides/{rideId}", region: "us-central1" },
  async (event) => {
    const rideId = event.params.rideId;
    const ride = event.data?.data() || {};
    if (String(ride.status || "") !== "searching_driver") return;
    const pickup = {
      lat: Number(ride.pickupLocation?.lat),
      lng: Number(ride.pickupLocation?.lng),
    };
    if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
      await db.collection("rides").doc(rideId).set(
        { matchingStatus: "invalid_pickup", matchedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return;
    }
    try {
      await withDispatchTimeout(matchRideCandidates(db, { rideId, pickup }), 15000, "matchRideCandidates");
    } catch (err) {
      const matchingError = String(err?.message || err).slice(0, 200);
      logger.error("dispatch_new_ride_match_failed", { rideId, matchingError });
      await recordMatchingFailure(db, matchingError).catch(() => {});
      await db.collection("rides").doc(rideId).set(
        {
          matchingStatus: "match_failed",
          matchingError,
          matchedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }
);

exports.cancelCustomerBooking = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await cancelCustomerBooking(db, {
      customerUid: request.auth.uid,
      rideId: String(request.data?.rideId || "").trim(),
      cancelReason: request.data?.cancelReason,
      cancelReasonKey: request.data?.cancelReasonKey,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Preview partial fare before cancelling an in-progress ride. */
exports.previewCancellationFare = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await previewCancellationFare(db, {
      customerUid: request.auth.uid,
      rideId: String(request.data?.rideId || "").trim(),
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** 3-minute search timeout — mark ride as expired and free the slot. */
exports.expireSearchingBooking = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await expireSearchingBooking(db, {
      customerUid: request.auth.uid,
      rideId: String(request.data?.rideId || "").trim(),
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/**
 * Batch expire overdue searching rides (indexed expiresAt).
 * Admin-only callable for ops/emulator. Do NOT enable Cloud Scheduler
 * until billing impact is approved (see report).
 */
exports.expireDueSearchingBookings = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const isAdmin = await callerIsAdmin(request);
  if (!isAdmin) throw new HttpsError("permission-denied", "ADMIN_REQUIRED");
  try {
    const limit = request.data?.limit;
    return await expireDueSearchingBookings(db, {
      limit: limit != null ? Number(limit) : 25,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/**
 * P1-B: Admin-only sweeper for per-offer timeouts.
 * Do NOT enable Cloud Scheduler until billing impact is approved.
 */
exports.expireDueRideOffers = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const isAdmin = await callerIsAdmin(request);
  if (!isAdmin) throw new HttpsError("permission-denied", "ADMIN_REQUIRED");
  try {
    const limit = request.data?.limit;
    return await expireDueRideOffers(db, {
      limit: limit != null ? Number(limit) : 25,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/**
 * P1-B: Party-scoped offer expiry (customer or driver on the offer).
 * Used by client timers / reconnect — server re-checks offerExpiresAt.
 */
exports.expireRideOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    const offerId = String(request.data?.offerId || "").trim();
    logger.info("expireRideOffer_invoke", {
      uid: request.auth.uid,
      offerId,
    });
    const result = await expireRideOffer(db, {
      offerId,
      actorUid: request.auth.uid,
    });
    logger.info("expireRideOffer_result", {
      offerId,
      status: result?.status,
      alreadyClosed: result?.alreadyClosed,
      closedReason: result?.closedReason || null,
    });
    return result;
  } catch (err) {
    logger.warn("expireRideOffer_error", {
      message: String(err?.message || err).slice(0, 160),
    });
    throw mapErr(err);
  }
});

/** Trusted matching after ride create (Admin SDK writes candidates). Phase 3B: geo-scoped only. */
exports.matchRideCandidates = onCall(
  { region: "us-central1", minInstances: 1 },
  async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const rideId = String(request.data?.rideId || "").trim();
  if (!rideId) throw new HttpsError("invalid-argument", "MISSING_RIDE");
  // Clients must not inject driver lists or arbitrary candidate sets.
  if (request.data?.onlineDrivers != null || request.data?.candidates != null) {
    throw new HttpsError("invalid-argument", "CLIENT_CANDIDATE_INJECTION_DENIED");
  }
  const [rideSnap, isAdmin] = await Promise.all([
    db.collection("rides").doc(rideId).get(),
    callerIsAdmin(request),
  ]);
  if (!rideSnap.exists) throw new HttpsError("not-found", "RIDE_NOT_FOUND");
  const ride = rideSnap.data() || {};
  if (ride.userId !== request.auth.uid && !isAdmin) {
    throw new HttpsError("permission-denied", "NOT_YOUR_BOOKING");
  }
  const pickup = {
    lat: Number(ride.pickupLocation?.lat),
    lng: Number(ride.pickupLocation?.lng),
  };
  if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
    throw new HttpsError("failed-precondition", "INVALID_PICKUP");
  }
  // Candidate limit comes from Super Admin settings only (customers/drivers cannot bump it).
  // Admins may pass an explicit limit for controlled tests / ops overrides.
  let candidateDriverLimit;
  if (isAdmin && request.data?.candidateDriverLimit != null) {
    candidateDriverLimit = request.data.candidateDriverLimit;
  }
  try {
    return await matchRideCandidates(db, {
      rideId,
      pickup,
      candidateDriverLimit,
    });
  } catch (err) {
    await recordMatchingFailure(db, err?.message || err).catch(() => {});
    throw mapErr(err);
  }
});

/**
 * Best-effort driver receipt telemetry for dispatch SLOs.
 * Only an invited driver may record their own receipt; client timestamps are
 * diagnostic-only while serverReceivedAt is the authoritative event time.
 */
exports.recordDispatchDeliveryReceipt = onCall(
  { region: "us-central1" },
  async (request) => {
    const driverUid = request.auth?.uid;
    if (!driverUid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    const rideId = String(request.data?.rideId || "").trim();
    const dispatchTraceId = normalizeDispatchTraceId(request.data?.dispatchTraceId);
    if (!rideId || !dispatchTraceId) {
      throw new HttpsError("invalid-argument", "MISSING_DISPATCH_RECEIPT_FIELDS");
    }

    const candidateRef = db.collection("ride_candidates").doc(`${rideId}_${driverUid}`);
    const rideRef = db.collection("rides").doc(rideId);
    const receiptRef = rideRef.collection("dispatch_receipts").doc(driverUid);
    const [candidateSnap, rideSnap, priorReceiptSnap] = await Promise.all([
      candidateRef.get(),
      rideRef.get(),
      receiptRef.get(),
    ]);
    const candidate = candidateSnap.exists ? candidateSnap.data() || {} : null;
    const ride = rideSnap.exists ? rideSnap.data() || {} : null;
    if (
      !candidate ||
      candidate.driverId !== driverUid ||
      !["invited", "accepted"].includes(String(candidate.status || "")) ||
      !ride ||
      String(ride.dispatchTraceId || "") !== dispatchTraceId
    ) {
      throw new HttpsError("permission-denied", "DISPATCH_RECEIPT_NOT_INVITED");
    }

    const clientReceivedAtMs = Number(request.data?.clientReceivedAtMs);
    const clientRenderedAtMs = Number(request.data?.clientRenderedAtMs);
    const serverReceivedAtMs = Date.now();
    await receiptRef.set(
      {
        driverId: driverUid,
        dispatchTraceId,
        candidateId: candidateSnap.id,
        clientReceivedAtMs: Number.isFinite(clientReceivedAtMs) ? Math.round(clientReceivedAtMs) : null,
        clientRenderedAtMs: Number.isFinite(clientRenderedAtMs) ? Math.round(clientRenderedAtMs) : null,
        serverReceivedAtMs,
        serverReceivedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    let slo = null;
    if (!priorReceiptSnap.exists) {
      try {
        slo = await recordDispatchDeliverySlo(db, {
          ride,
          candidate,
          nowMs: serverReceivedAtMs,
        });
      } catch (metricErr) {
        logger.warn("dispatch_delivery_metric_failed", {
          rideId,
          message: String(metricErr?.message || metricErr).slice(0, 160),
        });
      }
    }
    logger.info("dispatch_delivery_receipt", {
      rideId,
      driverUid,
      dispatchTraceId,
      firstReceipt: !priorReceiptSnap.exists,
      deliveryMs: slo?.deliveryMs ?? null,
    });
    return { ok: true, firstReceipt: !priorReceiptSnap.exists };
  }
);

exports.submitRideOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await submitRideOffer(db, {
      rideId: request.data?.rideId,
      driverUid: request.auth.uid,
      fare: request.data?.fare,
      vehicleId: request.data?.vehicleId,
      ownerId: request.data?.ownerId,
      driverName: request.auth.token?.name || request.data?.driverName,
      vehiclePlate: request.data?.vehiclePlate,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

exports.counterRideOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await counterRideOffer(db, {
      offerId: request.data?.offerId,
      customerUid: request.auth.uid,
      fare: request.data?.fare,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

exports.rejectRideOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await rejectRideOffer(db, {
      offerId: request.data?.offerId,
      customerUid: request.auth.uid,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Candidate Driver declines only their invitation (booking stays open). */
exports.declineRideCandidate = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await declineRideCandidate(db, {
      rideId: String(request.data?.rideId || "").trim(),
      driverUid: request.auth.uid,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Driver withdraws only their own offer. */
exports.withdrawRideOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await withdrawRideOffer(db, {
      offerId: String(request.data?.offerId || "").trim(),
      driverUid: request.auth.uid,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/**
 * Assigned Driver cancels before start → rematch same booking with fresh 3-min window.
 * Cancelling driver excluded from immediate rematch.
 */
exports.cancelAssignedRideByDriver = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await cancelAssignedRideByDriver(db, {
      rideId: String(request.data?.rideId || "").trim(),
      driverUid: request.auth.uid,
      cancelReason: request.data?.cancelReason,
      cancelReasonKey: request.data?.cancelReasonKey,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Super Admin cancel eligible non-terminal ride (not silent start financial cancel). */
exports.cancelRideByAdmin = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  if (!(await callerIsAdmin(request))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  try {
    return await cancelRideByAdmin(db, {
      rideId: String(request.data?.rideId || "").trim(),
      adminUid: request.auth.uid,
      reason: request.data?.reason,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Customer rates a completed ride; partner aggregates updated server-side only. */
exports.submitCompletedRideRating = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await submitCompletedRideRating(db, {
      customerUid: request.auth.uid,
      rideId: String(request.data?.rideId || "").trim(),
      rating: request.data?.rating,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

exports.finalizeAssignmentFromOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const role = request.data?.as === "driver" ? "driver" : "customer";
  try {
    return await finalizeAssignmentFromOffer(db, {
      offerId: request.data?.offerId,
      actorUid: request.auth.uid,
      actorRole: role,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Driver accepts customer's initial estimated fare (direct assignment). */
exports.acceptCustomerInitialFare = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await acceptCustomerInitialFareAsDriver(db, {
      rideId: request.data?.rideId,
      driverUid: request.auth.uid,
      vehicleId: request.data?.vehicleId,
      ownerId: request.data?.ownerId,
      driverName: request.auth.token?.name || request.data?.driverName,
      vehiclePlate: request.data?.vehiclePlate,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Super Admin: dispatch settings (candidate limit + search radius). */
exports.setCandidateDriverLimit = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await ensureCallerCanAdminWrite(db, request.auth))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  try {
    const { validateCandidateDriverLimit, validateSearchRadius, buildSearchRingsKm } = require("./matching");
    const limit = validateCandidateDriverLimit(request.data?.candidateDriverLimit);

    let radius = null;
    if (
      request.data?.dispatchRadiusKm != null ||
      request.data?.dispatchRadiusMeters != null ||
      request.data?.maxSearchRadiusKm != null ||
      request.data?.maxSearchRadiusMeters != null
    ) {
      if (request.data?.maxSearchRadiusMeters != null && request.data?.maxSearchRadiusKm == null) {
        const totalMeters = Math.round(Number(request.data.maxSearchRadiusMeters));
        radius = validateSearchRadius(Math.floor(totalMeters / 1000), totalMeters % 1000);
      } else if (request.data?.maxSearchRadiusKm != null) {
        const totalKm = Number(request.data.maxSearchRadiusKm);
        radius = validateSearchRadius(Math.floor(totalKm), Math.round((totalKm % 1) * 1000));
      } else {
        radius = validateSearchRadius(
          request.data?.dispatchRadiusKm,
          request.data?.dispatchRadiusMeters
        );
      }
    }

    const payload = {
      candidateDriverLimit: limit,
      maxDriverOpenBargains: 10,
      maxCustomerActiveBookings: 4,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: request.auth.uid,
    };

    if (request.data?.idleLocationIntervalMs != null) {
      const idleMs = Math.round(Number(request.data.idleLocationIntervalMs));
      if (!Number.isFinite(idleMs) || idleMs < 1_000 || idleMs > 30 * 60_000) {
        throw new HttpsError("invalid-argument", "IDLE_INTERVAL_OUT_OF_RANGE");
      }
      payload.idleLocationIntervalMs = idleMs;
    }
    if (request.data?.idleLocationMoveMeters != null) {
      const moveM = Math.round(Number(request.data.idleLocationMoveMeters));
      if (!Number.isFinite(moveM) || moveM < 1 || moveM > 5_000) {
        throw new HttpsError("invalid-argument", "IDLE_MOVE_OUT_OF_RANGE");
      }
      payload.idleLocationMoveMeters = moveM;
    }
    if (request.data?.offerTimeoutSeconds != null) {
      const offerSec = Math.round(Number(request.data.offerTimeoutSeconds));
      if (!Number.isFinite(offerSec) || offerSec < 5 || offerSec > 300) {
        throw new HttpsError("invalid-argument", "OFFER_TIMEOUT_OUT_OF_RANGE");
      }
      payload.offerTimeoutSeconds = offerSec;
    }
    if (request.data?.searchTimeoutSeconds != null) {
      const searchSec = Math.round(Number(request.data.searchTimeoutSeconds));
      if (
        !Number.isFinite(searchSec) ||
        searchSec < SEARCH_TIMEOUT_SECONDS_MIN ||
        searchSec > SEARCH_TIMEOUT_SECONDS_MAX
      ) {
        throw new HttpsError("invalid-argument", "SEARCH_TIMEOUT_OUT_OF_RANGE");
      }
      payload.searchTimeoutSeconds = normalizeSearchTimeoutSeconds(searchSec);
    }

    if (radius) {
      payload.maxSearchRadiusKm = radius.maxSearchRadiusKm;
      payload.maxSearchRadiusMeters = radius.maxSearchRadiusMeters;
      payload.searchRingsKm = buildSearchRingsKm(radius.maxSearchRadiusKm);
    } else {
      const existing = await db.collection("settings").doc("dispatch").get();
      const data = existing.exists ? existing.data() || {} : {};
      const fallbackKm =
        data.maxSearchRadiusKm != null
          ? Number(data.maxSearchRadiusKm)
          : Array.isArray(data.searchRingsKm) && data.searchRingsKm.length
            ? Math.max(...data.searchRingsKm.map(Number).filter(Number.isFinite))
            : 3;
      payload.searchRingsKm = buildSearchRingsKm(fallbackKm);
    }

    await db.collection("settings").doc("dispatch").set(payload, { merge: true });
    return {
      ok: true,
      candidateDriverLimit: limit,
      maxSearchRadiusKm: payload.maxSearchRadiusKm ?? null,
      maxSearchRadiusMeters: payload.maxSearchRadiusMeters ?? null,
      searchRingsKm: payload.searchRingsKm,
      idleLocationIntervalMs: payload.idleLocationIntervalMs ?? null,
      idleLocationMoveMeters: payload.idleLocationMoveMeters ?? null,
      offerTimeoutSeconds: payload.offerTimeoutSeconds ?? null,
    };
  } catch (err) {
    throw mapErr(err);
  }
});

function sanitizeDistanceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((tier) => {
      const upToRaw = tier?.upToKm;
      const upToKm =
        upToRaw === null || upToRaw === undefined || upToRaw === ""
          ? null
          : Number(upToRaw);
      const baseFare = Number(tier?.baseFare);
      const perKmRate = Number(tier?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (upToKm !== null && (!Number.isFinite(upToKm) || upToKm <= 0)) return null;
      return { upToKm, baseFare, perKmRate };
    })
    .filter(Boolean);
}

function sanitizePaceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((tier) => {
      const maxRaw = tier?.maxMinPerKm;
      const maxMinPerKm =
        maxRaw === null || maxRaw === undefined || maxRaw === "" ? null : Number(maxRaw);
      const baseFare = Number(tier?.baseFare);
      const perKmRate = Number(tier?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (maxMinPerKm !== null && (!Number.isFinite(maxMinPerKm) || maxMinPerKm <= 0)) {
        return null;
      }
      return { maxMinPerKm, baseFare, perKmRate };
    })
    .filter(Boolean);
}

function sanitizePricingVehicles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpsError("invalid-argument", "MISSING_VEHICLES");
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpsError("invalid-argument", `INVALID_VEHICLE_${key}`);
    }
    const baseFare = Number(value.baseFare);
    const perKmRate = Number(value.perKmRate);
    const commissionPercent = Number(value.commissionPercent);
    if (!Number.isFinite(baseFare) || baseFare < 0) {
      throw new HttpsError("invalid-argument", `INVALID_BASE_FARE_${key}`);
    }
    if (!Number.isFinite(perKmRate) || perKmRate < 0) {
      throw new HttpsError("invalid-argument", `INVALID_PER_KM_${key}`);
    }
    if (
      !Number.isFinite(commissionPercent) ||
      commissionPercent < 0 ||
      commissionPercent > 100
    ) {
      throw new HttpsError("invalid-argument", `INVALID_COMMISSION_${key}`);
    }
    out[key] = {
      baseFare,
      perKmRate,
      commissionPercent,
      distanceTiers: sanitizeDistanceTiers(value.distanceTiers),
      paceTiers: sanitizePaceTiers(value.paceTiers),
    };
  }
  return out;
}

/** Super Admin: persist financial controls (settings/pricing). */
exports.saveAdminPricingSettings = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await ensureCallerCanAdminWrite(db, request.auth))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  try {
    const data = request.data || {};
    const walletThreshold = Number(data.walletThreshold);
    if (!Number.isFinite(walletThreshold) || walletThreshold > 0) {
      throw new HttpsError("invalid-argument", "INVALID_WALLET_THRESHOLD");
    }
    const vehicles = sanitizePricingVehicles(data.vehicles);
    const go = vehicles.go || {};
    const baseFare = Number(data.baseFare);
    const perKmRate = Number(data.perKmRate);
    const commissionPercent = Number(data.commissionPercent);
    await db.collection("settings").doc("pricing").set(
      {
        walletThreshold,
        baseFare:
          Number.isFinite(baseFare) && baseFare >= 0
            ? baseFare
            : Number.isFinite(go.baseFare)
              ? go.baseFare
              : 0,
        perKmRate:
          Number.isFinite(perKmRate) && perKmRate >= 0
            ? perKmRate
            : Number.isFinite(go.perKmRate)
              ? go.perKmRate
              : 0,
        commissionPercent:
          Number.isFinite(commissionPercent) &&
          commissionPercent >= 0 &&
          commissionPercent <= 100
            ? commissionPercent
            : Number.isFinite(go.commissionPercent)
              ? go.commissionPercent
              : 10,
        vehicles,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: request.auth.uid,
      },
      { merge: true }
    );
    return { ok: true, walletThreshold };
  } catch (err) {
    console.error("[saveAdminPricingSettings]", err?.code || err?.message || err);
    throw mapErr(err);
  }
});

exports.getDispatchSettings = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return readDispatchSettings(db);
});

/** Phase 4E — soft account deletion request (retains financial/audit records). */
exports.requestAccountDeletion = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await performAccountDeletionRequest(db, {
      uid: request.auth.uid,
      email: request.auth.token?.email || null,
      roleHint: request.data?.roleHint,
      reason: request.data?.reason,
      appId: request.data?.appId,
    });
  } catch (err) {
    console.error("[requestAccountDeletion]", err?.message || err);
    throw mapErr(err);
  }
});

/** Phase 4E — complaint / support report (does not alter ledger). */
exports.submitSupportReport = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await performSupportReport(db, {
      uid: request.auth.uid,
      email: request.auth.token?.email || null,
      category: request.data?.category,
      message: request.data?.message,
      appId: request.data?.appId,
      rideId: request.data?.rideId,
    });
  } catch (err) {
    console.error("[submitSupportReport]", err?.message || err);
    throw mapErr(err);
  }
});

/** Mirror assigned driver GPS onto rides; rematch when driver becomes matchable. */
exports.mirrorDriverLocationOnVehicleUpdate = onDocumentWritten(
  { document: "vehicles/{vehicleId}", region: "us-central1" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;
    const before = event.data?.before?.data();

    if (after.activeRideId) {
      const locSame =
        before?.location?.lat === after?.location?.lat &&
        before?.location?.lng === after?.location?.lng &&
        before?.location?.sequence === after?.location?.sequence &&
        before?.location?.observedAt === after?.location?.observedAt;
      const rideSame = before?.activeRideId === after.activeRideId;
      if (!locSame || !rideSame) {
        try {
          await mirrorDriverLocationToRide(db, event.params.vehicleId, after);
        } catch (err) {
          console.warn("[mirrorDriverLocation]", err?.message || err);
        }
      }
    }

    const rematchTrigger = evaluateVehicleRematchTrigger(before, after);
    if (
      !after.activeRideId &&
      after.status === "online" &&
      after.geoCell &&
      rematchTrigger.hasLocation &&
      rematchTrigger.shouldRematch
    ) {
      try {
        const result = await rematchNearbySearchingRidesForVehicle(
          db,
          after,
          event.params.vehicleId
        );
        if (result.rematched > 0) {
          logStructured("INFO", "rematch_on_driver_online", {
            vehicleId: event.params.vehicleId,
            driverId: after.driverId,
            rematched: result.rematched,
            reason: rematchTrigger.reason,
          });
        }
      } catch (err) {
        console.warn("[rematchOnDriverOnline]", err?.message || err);
      }
    }
  }
);

/** Phase 4F — admin ops health / metrics summary (emulator + post-deploy). */
exports.getOpsHealthSummary = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await callerIsAdmin(request))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  return wrapCall("getOpsHealthSummary", request, () => getOpsHealthSummary(db));
});

/** Phase 4F — online vehicles missing geoCell (admin). Matching stays geo-scoped. */
exports.getGeoCellCoverageReport = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await callerIsAdmin(request))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  return wrapCall("getGeoCellCoverageReport", request, () =>
    reportGeoCellCoverage(db, { limit: request.data?.limit })
  );
});

/**
 * Phase 1 P2P prep — customer viewer presence lease refresh (server timestamps only).
 * Does not change driver write frequency.
 */
exports.refreshRideViewerPresence = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("refreshRideViewerPresence", request, () =>
    refreshRideViewerPresence(db, {
      customerUid: request.auth.uid,
      rideId: request.data?.rideId,
      sessionId: request.data?.sessionId,
      leaseVersion: request.data?.leaseVersion,
    })
  );
});

/** Phase 3 — driver publishes bundled WebRTC offer (non-trickle). */
exports.createRidePeerOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("createRidePeerOffer", request, () =>
    createRidePeerOffer(db, {
      driverUid: request.auth.uid,
      rideId: request.data?.rideId,
      offerSdp: request.data?.offerSdp,
      peerSessionId: request.data?.peerSessionId,
      trackingSessionId: request.data?.trackingSessionId,
      assignmentVersion: request.data?.assignmentVersion,
      vehicleId: request.data?.vehicleId,
    })
  );
});

/** Phase 3 — customer publishes bundled WebRTC answer. */
exports.publishRidePeerAnswer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("publishRidePeerAnswer", request, () =>
    publishRidePeerAnswer(db, {
      customerUid: request.auth.uid,
      rideId: request.data?.rideId,
      answerSdp: request.data?.answerSdp,
      peerSessionId: request.data?.peerSessionId,
    })
  );
});

/** Phase 3 — either participant closes signaling session. */
exports.closeRidePeerSession = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("closeRidePeerSession", request, () =>
    closeRidePeerSession(db, {
      uid: request.auth.uid,
      rideId: request.data?.rideId,
    })
  );
});

/** Phase 3 — ephemeral TURN credentials for NAT traversal (coturn REST API). */
exports.getP2pTurnCredentials = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("getP2pTurnCredentials", request, () =>
    issueP2pTurnCredentials({ uid: request.auth.uid })
  );
});

/**
 * Phase 6 — shadow breadcrumb batch (dense chord telemetry only).
 * Does not mutate traveledDistanceKm, fare, wallet, or settlement.
 */
exports.submitRideBreadcrumbBatch = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("submitRideBreadcrumbBatch", request, () =>
    submitRideBreadcrumbBatch(db, {
      driverUid: request.auth.uid,
      batch: request.data?.batch,
    })
  );
});

/** Super Admin: persist location reporting config (settings/locationReporting). Diagnostic only. */
exports.saveAdminLocationReportingSettings = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await ensureCallerCanAdminWrite(db, request.auth))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  try {
    const {
      LOCATION_REPORTING_SCHEMA_VERSION,
      LOCATION_REPORTING_CONFIG_DOC_PATH,
      buildValidatedLocationReportingSettings,
    } = require("./location-reporting-config");
    const config = buildValidatedLocationReportingSettings(request.data || {});
    await db.doc(LOCATION_REPORTING_CONFIG_DOC_PATH).set(
      {
        schemaVersion: LOCATION_REPORTING_SCHEMA_VERSION,
        ...config,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: request.auth.uid,
      },
      { merge: true }
    );
    const { invalidateLocationReportingConfigCache } = require("./location-reporting-config-cache");
    invalidateLocationReportingConfigCache();
    return { ok: true, config };
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (msg.startsWith("INVALID_")) {
      throw new HttpsError("invalid-argument", msg);
    }
    console.error("[saveAdminLocationReportingSettings]", err?.code || err?.message || err);
    throw mapErr(err);
  }
});

/** Per-ride location delivery report — driver/customer diagnostic section submit. */
exports.submitRideLocationReportSection = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("submitRideLocationReportSection", request, () =>
    submitRideLocationReportSection(db, {
      callerUid: request.auth.uid,
      rideId: request.data?.rideId,
      role: request.data?.role,
      assignmentSessionTokenHash: request.data?.assignmentSessionTokenHash,
      section: request.data?.section,
      submitSequence: request.data?.submitSequence,
      finalSubmit: request.data?.finalSubmit,
    })
  );
});

/**
 * Issue short-lived HMAC credential for Android background location upload.
 * Auth required — assigned driver only.
 */
exports.issueBackgroundLocationCredential = onCall(
  { region: "us-central1", secrets: [backgroundLocationUploadSecret] },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    return wrapCall("issueBackgroundLocationCredential", request, () =>
      issueBackgroundLocationCredential(db, {
        driverUid: request.auth.uid,
        rideId: request.data?.rideId,
        vehicleId: request.data?.vehicleId,
        trackingSessionId: request.data?.trackingSessionId,
        assignmentSessionToken: request.data?.assignmentSessionToken,
        ttlMs: request.data?.ttlMs,
      })
    );
  }
);

/**
 * Native HTTPS credential rotation (no Firebase Auth SDK).
 * Accepts a still-valid scoped HMAC token; revalidates assignment; returns successor.
 */
exports.refreshBackgroundDriverLocationCredential = onRequest(
  { region: "us-central1", cors: true, secrets: [backgroundLocationUploadSecret] },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
      return;
    }
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const result = await refreshBackgroundLocationCredential(db, {
        token: body.token,
      });
      const status =
        result?.ok === true
          ? 200
          : result?.reason === "TOKEN_EXPIRED" ||
              result?.reason === "INVALID_SIGNATURE" ||
              result?.reason === "INVALID_TOKEN"
            ? 401
            : result?.reason === "SECRET_NOT_CONFIGURED"
              ? 503
              : 403;
      res.status(status).json(result);
    } catch (err) {
      logger.error("refreshBackgroundDriverLocationCredential_failed", {
        code: err?.code || null,
        message: String(err?.message || err).slice(0, 200),
      });
      await recordFunctionError(db, "refreshBackgroundDriverLocationCredential", err).catch(
        () => {}
      );
      res.status(500).json({ ok: false, reason: "INTERNAL" });
    }
  }
);

/**
 * Native HTTPS ingest (no Firebase Auth SDK — uses scoped HMAC token).
 * Writes only vehicles/{vehicleId}; mirror CF updates rides.driverLocation.
 */
exports.ingestBackgroundDriverLocation = onRequest(
  { region: "us-central1", cors: true, secrets: [backgroundLocationUploadSecret] },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
      return;
    }
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const result = await ingestBackgroundDriverLocation(db, {
        token: body.token,
        fix: body.fix,
        force: Boolean(body.force),
      });
      const status =
        result?.reason === "TOKEN_EXPIRED" || result?.reason === "INVALID_SIGNATURE"
          ? 401
          : result?.reason === "SECRET_NOT_CONFIGURED"
            ? 503
            : 200;
      res.status(status).json(result);
    } catch (err) {
      logger.error("ingestBackgroundDriverLocation_failed", {
        code: err?.code || null,
        message: String(err?.message || err).slice(0, 200),
      });
      await recordFunctionError(db, "ingestBackgroundDriverLocation", err).catch(() => {});
      res.status(500).json({ ok: false, accepted: false, reason: "INTERNAL" });
    }
  }
);