/**
 * SwiftGo Cloud Functions — settlement, matching, bargaining (Phase 2A).
 * Emulator-ready; do not deploy in this phase unless separately approved.
 */

"use strict";

const { onCall: firebaseOnCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineBoolean } = require("firebase-functions/params");
defineBoolean("ENFORCE_APP_CHECK", { default: false });
const { readAppCheckEnforcement } = require("./app-check-policy");
const { assertAccountAccessAllowed, syncDeletionAuthBlock, reviewAccountDeletion } = require("./account-deletion-workflow");
const { normalizeRetentionPolicy, saveRetentionPolicy, purgeExpiredTransientData, runRetentionMaintenance } = require("./data-retention");
const { POLICY: APPROVED_RETENTION_POLICY } = require("./retention-policy");
const { inspectAccountDisposition, executeAccountDispositionPage } = require("./account-disposition");
const { disposeIdentityRecord } = require("./identity-disposition");
const { setRetentionLegalHold, previewFinancialRetention } = require("./retention-admin");
// One policy for every callable. HTTPS native ingest retains its scoped HMAC.
const onCall = (options, handler) => {
  const { allowDeletionRequest = false, ...firebaseOptions } = options;
  return firebaseOnCall({ ...firebaseOptions, enforceAppCheck: readAppCheckEnforcement() }, async (request) => {
    if (request.auth?.uid && !allowDeletionRequest) {
      try { await assertAccountAccessAllowed(db, request.auth.uid); } catch (error) { throw mapErr(error); }
    }
    return handler(request);
  });
};
const { logger } = require("firebase-functions");
const { onDocumentCreated, onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
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
  grantSuperAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
  isAdminAuth,
  readAdminRole,
  writeAdminSettings,
  ensureCallerCanAdminWrite,
  requestTouchesDiagnosticControls,
  isCallerAuthorizedForDiagnostic,
} = require("./admin-claims");
const { linkVehicleByPin } = require("./pin-link");
const { createFleetVehicle, rotateVehicleLinkCode, releaseFleetVehicle } = require("./fleet-security");
const { beginDriverVerification, submitDriverVerification, reviewDriverVerification } = require("./driver-verification");
const { quoteCustomerBooking } = require("./booking-pricing");
const { approveRechargeRequest } = require("./recharge");
const {
  requestAccountDeletion: performAccountDeletionRequest,
  submitSupportReport: performSupportReport,
} = require("./account-deletion");
const {
  requestOwnerAccess: performRequestOwnerAccess,
  approveOwnerAccess: performApproveOwnerAccess,
  rejectOwnerAccess: performRejectOwnerAccess,
} = require("./owner-onboarding");
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
const { publishCustomerRideLocation } = require("./customer-location");
const { applyRideLifecycleTimestampStamp } = require("./ride-lifecycle-timestamps");
const { settleRide } = require("./settlement");
const { refreshRideViewerPresence } = require("./ride-viewer-presence");
const {
  createRidePeerOffer,
  publishRidePeerAnswer,
  closeRidePeerSession,
  renewRidePeerSession,
  getRidePeerOfferRevision,
} = require("./ride-peer-session");
const { issueRideTurnCredentials } = require("./p2p-turn-credentials");
const {
  issueNativeP2pCredential,
  handleNativeP2pAction,
} = require("./native-p2p-transport");
const { submitRideBreadcrumbBatch } = require("./breadcrumb-batch");
const { submitRideLocationReportSection } = require("./ride-location-report");
const {
  issueBackgroundLocationCredential,
  refreshBackgroundLocationCredential,
  ingestBackgroundDriverLocation,
} = require("./background-location-upload");

/**
 * Main-alignment note (Stage 8 tranche 4):
 * Owner/admin/lifecycle exports ported from origin/main.
 * Keep branch-only background location HTTPS exports (issue/refresh/ingest) below.
 */

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
    "unavailable",
    "already-exists",
    "cancelled",
    "aborted",
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
  return isCallerAuthorizedForDiagnostic(db, request.auth);
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
        adminAuth: request.auth,
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

exports.grantSuperAdminClaim = onCall({ region: "us-central1" }, async (request) => {
  try {
    return await grantSuperAdminClaim(db, request.auth, request.data?.uid);
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
      requestIp: request.rawRequest?.ip,
      driverName: request.auth.token?.name || request.data?.driverName,
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Check / confirm gate before creating an extra booking. */
for (const [name, action] of Object.entries({ createFleetVehicle, rotateVehicleLinkCode, releaseFleetVehicle })) {
  exports[name] = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    return wrapCall(name, request, () => action(db, request.auth.uid, name === "createFleetVehicle" ? request.data : request.data?.vehicleId));
  });
}

for (const [name, action] of Object.entries({ beginDriverVerification, submitDriverVerification, reviewDriverVerification })) {
  exports[name] = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    return wrapCall(name, request, () => name === "beginDriverVerification" ? action(db, request.auth.uid) :
      action(db, name === "reviewDriverVerification" ? request.auth : request.auth.uid, request.data));
  });
}

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
exports.quoteCustomerBooking = onCall({ region: "us-central1", timeoutSeconds: 30 }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("quoteCustomerBooking", request, () => quoteCustomerBooking(db, request.auth.uid, request.data));
});

exports.getAdminAccess = onCall({ region: "us-central1" }, async (request) => {
  const role = await readAdminRole(db, request.auth);
  return { authorized: role === "super_admin", role };
});

exports.approveRechargeRequest = onCall({ region: "us-central1" }, async (request) =>
  wrapCall("approveRechargeRequest", request, () => approveRechargeRequest(db, request.auth, request.data?.requestId)));

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
          quoteId: data.quoteId,
          acceptedFare: data.acceptedFare,
        },
      });
      timer.mark("ride_tx_complete", { rideId: created?.id });

      // This callable is kept warm. Match here so invited drivers do not wait
      // for the separate Firestore-created function to cold-start. The
      // document trigger remains as a durable fallback if this attempt fails.
      let matchingStatus = "pending";
      let candidateCount = 0;
      let matchingError = "";
      try {
        const matched = await withDispatchTimeout(
          matchRideCandidates(db, {
            rideId: created.id,
            pickup: {
              lat: created.payload.pickupLocation.lat,
              lng: created.payload.pickupLocation.lng,
            },
            dispatchSettings: created.dispatchSettings,
            _latencyTimer: timer,
          }),
          15000,
          "matchRideCandidates"
        );
        candidateCount = Math.max(0, Number(matched?.candidateCount) || 0);
        matchingStatus = candidateCount ? "candidates_ready" : "no_candidates";
      } catch (matchErr) {
        matchingError = String(matchErr?.message || matchErr).slice(0, 200);
        logger.warn("dispatch_inline_match_deferred_to_trigger", {
          rideId: created.id,
          matchingError,
        });
      }

      const latencyPayload = timer.finish({ rideId: created.id });
      return sanitizeCallableResult({
        id: created.id,
        count: created.count,
        farePkr: created.farePkr,
        estimatedFare: created.estimatedFare,
        dispatchTraceId: String(data.dispatchTraceId || ""),
        matchingStatus,
        candidateCount,
        matchingError,
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
    // The warm booking callable normally completes matching first. Re-read the
    // small ride document to avoid repeating geo queries and candidate writes.
    const currentSnap = await db.collection("rides").doc(rideId).get();
    const current = currentSnap.exists ? currentSnap.data() || {} : {};
    if (
      ["candidates_ready", "no_candidates"].includes(String(current.matchingStatus || "")) &&
      current.matchedAt
    ) {
      return;
    }
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
      adminAuth: request.auth,
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
  if (requestTouchesDiagnosticControls(request.data)) {
    if (!(await isCallerAuthorizedForDiagnostic(db, request.auth))) {
      throw new HttpsError("permission-denied", "SUPER_ADMIN_DIAGNOSTIC_ONLY");
    }
  }
  try {
    const { validateCandidateDriverLimit, validateSearchRadius, buildSearchRingsKm } = require("./matching");
    const {
      validateIdleIntervalMsForCallable,
      validateIdleMoveMetersForCallable,
      validateIdleMovementTriggerDisabledForCallable,
      validateDiagnosticDurationMinutesForCallable,
      sanitizeDiagnosticReason,
      IDLE_DIAGNOSTIC_MAX_DURATION_MS,
    } = require("./idle-publish-config");
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
      const idleMs = request.data.idleLocationIntervalMs;
      if (!validateIdleIntervalMsForCallable(idleMs)) {
        throw new HttpsError("invalid-argument", "IDLE_INTERVAL_OUT_OF_RANGE");
      }
      payload.idleLocationIntervalMs = idleMs;
    }
    if (request.data?.idleLocationMoveMeters != null) {
      const moveM = request.data.idleLocationMoveMeters;
      if (!validateIdleMoveMetersForCallable(moveM)) {
        throw new HttpsError("invalid-argument", "IDLE_MOVE_OUT_OF_RANGE");
      }
      payload.idleLocationMoveMeters = moveM;
    }
    if (request.data?.idleDiagnosticExpiresAt != null) {
      throw new HttpsError("invalid-argument", "IDLE_DIAGNOSTIC_EXPIRY_CLIENT_FORBIDDEN");
    }
    if (request.data?.idleMovementTriggerDisabled != null) {
      if (!validateIdleMovementTriggerDisabledForCallable(request.data.idleMovementTriggerDisabled)) {
        throw new HttpsError("invalid-argument", "IDLE_MOVEMENT_TRIGGER_FLAG_INVALID");
      }
      if (request.data.idleMovementTriggerDisabled === true) {
        const durationMin = request.data?.idleDiagnosticDurationMinutes;
        if (!validateDiagnosticDurationMinutesForCallable(durationMin)) {
          throw new HttpsError("invalid-argument", "IDLE_DIAGNOSTIC_DURATION_OUT_OF_RANGE");
        }
        const durationMs = durationMin * 60_000;
        if (durationMs > IDLE_DIAGNOSTIC_MAX_DURATION_MS) {
          throw new HttpsError("invalid-argument", "IDLE_DIAGNOSTIC_DURATION_OUT_OF_RANGE");
        }
        payload.idleMovementTriggerDisabled = true;
        payload.idleDiagnosticExpiresAt = Timestamp.fromMillis(Date.now() + durationMs);
        payload.idleDiagnosticEnabledBy = request.auth.uid;
        payload.idleDiagnosticEnabledAt = FieldValue.serverTimestamp();
        const reason = sanitizeDiagnosticReason(request.data?.idleDiagnosticReason);
        if (reason) payload.idleDiagnosticReason = reason;
      } else {
        payload.idleMovementTriggerDisabled = false;
        payload.idleDiagnosticExpiresAt = FieldValue.delete();
        payload.idleDiagnosticEnabledBy = FieldValue.delete();
        payload.idleDiagnosticEnabledAt = FieldValue.delete();
        payload.idleDiagnosticReason = FieldValue.delete();
      }
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
    const { locationDeliverySettingsPatch } = require("./location-delivery-policy");
    const deliveryPatch = locationDeliverySettingsPatch(request.data);
    Object.assign(payload, deliveryPatch);

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

    await writeAdminSettings(db, request.auth, "settings/dispatch", payload);
    return {
      ok: true,
      candidateDriverLimit: limit,
      maxSearchRadiusKm: payload.maxSearchRadiusKm ?? null,
      maxSearchRadiusMeters: payload.maxSearchRadiusMeters ?? null,
      searchRingsKm: payload.searchRingsKm,
      idleLocationIntervalMs: payload.idleLocationIntervalMs ?? null,
      idleLocationMoveMeters: payload.idleLocationMoveMeters ?? null,
      idleMovementTriggerDisabled: payload.idleMovementTriggerDisabled ?? null,
      idleDiagnosticExpiresAt: payload.idleDiagnosticExpiresAt ?? null,
      offerTimeoutSeconds: payload.offerTimeoutSeconds ?? null,
      customerLocationFallbackSeconds: payload.customerLocationFallbackSeconds ?? null,
      p2pFallbackAfterSeconds: payload.p2pFallbackAfterSeconds ?? null,
      firebaseLocationFallbackEnabled: payload.firebaseLocationFallbackEnabled ?? null,
      ...deliveryPatch,
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
    await writeAdminSettings(db, request.auth, "settings/pricing",
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
exports.requestAccountDeletion = onCall({ region: "us-central1", allowDeletionRequest: true }, async (request) => {
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
    console.error("[requestAccountDeletion]", err?.code || "internal");
    throw mapErr(err);
  }
});

exports.requestOwnerAccess = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await performRequestOwnerAccess(db, request.auth, request.data || {});
  } catch (err) {
    console.error("[requestOwnerAccess]", err?.message || err);
    throw mapErr(err);
  }
});

/** Task 3B — super-admin grants partners.role = owner (Admin SDK only). */
exports.approveOwnerAccess = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await performApproveOwnerAccess(db, request.auth, request.data || {});
  } catch (err) {
    console.error("[approveOwnerAccess]", err?.message || err);
    throw mapErr(err);
  }
});

/** Task 3C — super-admin rejects pending owner application. */
exports.rejectOwnerAccess = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await performRejectOwnerAccess(db, request.auth, request.data || {});
  } catch (err) {
    console.error("[rejectOwnerAccess]", err?.message || err);
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

/** Server-authoritative driverArrivedAt / tripStartedAt for location reporting lifecycle. */
exports.stampRideLifecycleTimestamps = onDocumentUpdated(
  { document: "rides/{rideId}", region: "us-central1" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;
    try {
      await applyRideLifecycleTimestampStamp(
        db,
        event.params.rideId,
        before || {},
        after
      );
    } catch (err) {
      console.warn("[stampRideLifecycleTimestamps]", err?.message || err);
    }
  }
);

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
exports.publishCustomerRideLocation = onCall({ region: "us-central1" }, async (request) => {
  try { return await publishCustomerRideLocation(db, request.auth?.uid, request.data); }
  catch (err) { throw mapErr(err); }
});

// Maintenance configuration is super-admin-only. Preview never mutates data.
exports.getPrivacyMaintenanceStatus = onCall({ region: "us-central1" }, async (request) => {
  if (!(await ensureCallerCanAdminWrite(db, request.auth))) throw new HttpsError("permission-denied", "SUPER_ADMIN_ONLY");
  return { policy: normalizeRetentionPolicy((await db.doc("settings/dataRetention").get()).data()),
    approvedPolicy: APPROVED_RETENTION_POLICY,
    schedulerExportEnabled: process.env.ENABLE_RETENTION_SCHEDULE === "true",
    erasureExecutorAvailable: process.env.ENABLE_ACCOUNT_ERASURE === "true" };
});
exports.savePrivacyMaintenanceSettings = onCall({ region: "us-central1" }, async (request) => {
  try { return await saveRetentionPolicy(db, request.auth, request.data); } catch (error) { throw mapErr(error); }
});
exports.previewExpiredPrivateData = onCall({ region: "us-central1" }, async (request) => {
  if (!(await ensureCallerCanAdminWrite(db, request.auth))) throw new HttpsError("permission-denied", "SUPER_ADMIN_ONLY");
  try { return await purgeExpiredTransientData(db, { dryRun: true }); } catch (error) { throw mapErr(error); }
});
exports.retryDeletionAuthBlock = onCall({ region: "us-central1" }, async (request) => {
  if (!(await ensureCallerCanAdminWrite(db, request.auth))) throw new HttpsError("permission-denied", "SUPER_ADMIN_ONLY");
  try { return { authBlockStatus: await syncDeletionAuthBlock(db, request.data?.uid) }; } catch (error) { throw mapErr(error); }
});
exports.reviewAccountDeletion = onCall({ region: "us-central1" }, async (request) => {
  try { return await reviewAccountDeletion(db, request.auth, request.data); } catch (error) { throw mapErr(error); }
});
exports.previewAccountDisposition = onCall({ region: "us-central1" }, async (request) => {
  try { return await inspectAccountDisposition(db, request.auth, request.data?.uid); } catch (error) { throw mapErr(error); }
});
exports.executeAccountDispositionPage = onCall({ region: "us-central1", timeoutSeconds: 480 }, async (request) => {
  try { return await executeAccountDispositionPage(db, request.auth, request.data,
    { allowMutation: process.env.ENABLE_ACCOUNT_ERASURE === "true" }); } catch (error) { throw mapErr(error); }
});
exports.previewIdentityDisposition = onCall({ region: "us-central1" }, async (request) => {
  try { return await disposeIdentityRecord(db, request.auth, request.data, { dryRun: true }); } catch (error) { throw mapErr(error); }
});
exports.executeIdentityDisposition = onCall({ region: "us-central1", timeoutSeconds: 480 }, async (request) => {
  try { return await disposeIdentityRecord(db, request.auth, request.data,
    { dryRun: false, allowMutation: process.env.ENABLE_ACCOUNT_ERASURE === "true" }); } catch (error) { throw mapErr(error); }
});
exports.setRetentionLegalHold = onCall({ region: "us-central1" }, async (request) => {
  try { return await setRetentionLegalHold(db, request.auth, request.data); } catch (error) { throw mapErr(error); }
});
exports.previewFinancialRetention = onCall({ region: "us-central1" }, async (request) => {
  try { return await previewFinancialRetention(db, request.auth, request.data); } catch (error) { throw mapErr(error); }
});
// Merely deploying the ordinary app cannot create a paid/destructive scheduler.
// Both this explicit server deployment opt-in and current admin policy are required.
if (process.env.ENABLE_RETENTION_SCHEDULE === "true") {
  const { onSchedule } = require("firebase-functions/v2/scheduler");
  exports.runPrivacyMaintenance = onSchedule({ schedule: "every 10 minutes", region: "us-central1", timeoutSeconds: 480, maxInstances: 1 },
    async () => runRetentionMaintenance(db, { allowMutation: true }));
}

exports.createRidePeerOffer = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  if (typeof request.data?.expectedPeerSessionId !== "string" || typeof request.data?.expectedOfferFingerprint !== "string") {
    throw new HttpsError("invalid-argument", "OFFER_REVISION_REQUIRED");
  }
  return wrapCall("createRidePeerOffer", request, () =>
    createRidePeerOffer(db, {
      driverUid: request.auth.uid,
      rideId: request.data?.rideId,
      offerSdp: request.data?.offerSdp,
      assignmentId: request.data?.assignmentId,
      peerSessionId: request.data?.peerSessionId,
      trackingSessionId: request.data?.trackingSessionId,
      assignmentVersion: request.data?.assignmentVersion,
      vehicleId: request.data?.vehicleId,
      expectedPeerSessionId: request.data?.expectedPeerSessionId,
      expectedOfferFingerprint: request.data?.expectedOfferFingerprint,
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
      offerFingerprint: request.data?.offerFingerprint,
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
      peerSessionId: request.data?.peerSessionId,
      offerFingerprint: request.data?.offerFingerprint,
    })
  );
});

exports.getRidePeerOfferRevision = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("getRidePeerOfferRevision", request, () => getRidePeerOfferRevision(db, {
    uid: request.auth.uid, rideId: request.data?.rideId, assignmentId: request.data?.assignmentId,
  }));
});

exports.renewRidePeerSession = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("renewRidePeerSession", request, () => renewRidePeerSession(db, {
    uid: request.auth.uid, rideId: request.data?.rideId, peerSessionId: request.data?.peerSessionId,
    offerFingerprint: request.data?.offerFingerprint, assignmentId: request.data?.assignmentId,
  }));
});

// Opt-in secret binding: enabling/deploying the provider is a separate operation.
// P2P_TURN_CONFIG is Secret Manager JSON, never a Hosting/Firestore value.
exports.getP2pTurnCredentials = onCall({ region: "us-central1",
  secrets: process.env.P2P_TURN_ENABLED === "true" ? ["P2P_TURN_CONFIG"] : [],
}, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return wrapCall("getP2pTurnCredentials", request, () =>
    issueRideTurnCredentials(db, { uid: request.auth.uid, rideId: request.data?.rideId,
      assignmentId: request.data?.assignmentId }, { enabled: process.env.P2P_TURN_ENABLED === "true" })
  );
});

/**
 * Validated raw breadcrumb measurements (not the customer live-location route).
 * No direct fare/wallet mutation; cancellation reads server-validated segments.
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
  if (!request.auth?.uid || !(await isCallerAuthorizedForDiagnostic(db, request.auth))) {
    throw new HttpsError("permission-denied", "SUPER_ADMIN_ONLY");
  }
  try {
    const {
      LOCATION_REPORTING_SCHEMA_VERSION,
      LOCATION_REPORTING_CONFIG_DOC_PATH,
      buildValidatedLocationReportingSettings,
    } = require("./location-reporting-config");
    const config = buildValidatedLocationReportingSettings(request.data || {});
    await writeAdminSettings(db, request.auth, LOCATION_REPORTING_CONFIG_DOC_PATH,
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
 * WebView-authenticated hand-off capability for the Android native WebRTC
 * service.  It is assignment-bound, short-lived and contains no Firebase
 * refresh token or permanent TURN secret.
 */
exports.issueNativeP2pCredential = onCall(
  { region: "us-central1", secrets: [backgroundLocationUploadSecret] },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    return wrapCall("issueNativeP2pCredential", request, () =>
      issueNativeP2pCredential(db, {
        uid: request.auth.uid,
        role: request.data?.role,
        rideId: request.data?.rideId,
        vehicleId: request.data?.vehicleId,
        assignmentId: request.data?.assignmentId,
        trackingSessionId: request.data?.trackingSessionId,
      })
    );
  }
);

/** Native HTTPS signaling/policy route; no coordinates are logged here. */
exports.nativeRidePeerTransport = onRequest(
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
      const result = await handleNativeP2pAction(db, body);
      const reason = String(result?.reason || "");
      const status = result?.ok === false && ["INVALID_TOKEN", "INVALID_SIGNATURE", "TOKEN_EXPIRED"].includes(reason)
        ? 401 : result?.ok === false && reason === "SECRET_NOT_CONFIGURED" ? 503 : 200;
      res.status(status).json(result);
    } catch (err) {
      const code = String(err?.code || "");
      const status = code === "permission-denied" ? 403 :
        code === "unauthenticated" ? 401 : code === "invalid-argument" ? 400 :
        code === "not-found" ? 404 : code === "failed-precondition" ? 409 : 500;
      if (status === 500) {
        logger.error("nativeRidePeerTransport_failed", {
          code: err?.code || null,
          message: String(err?.message || err).slice(0, 160),
        });
        await recordFunctionError(db, "nativeRidePeerTransport", err).catch(() => {});
      }
      res.status(status).json({ ok: false, reason: status === 500 ? "INTERNAL" : String(err?.message || "REJECTED").slice(0, 80) });
    }
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
