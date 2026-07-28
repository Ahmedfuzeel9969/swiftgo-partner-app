/**
 * SwiftGo Cloud Functions — settlement, matching, bargaining (Phase 2A).
 * Emulator-ready; do not deploy in this phase unless separately approved.
 */

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { settleRide } = require("./settlement");
const {
  evaluateCustomerBookingGate,
  createCustomerBooking,
  cancelCustomerBooking,
  matchRideCandidates,
  submitRideOffer,
  counterRideOffer,
  rejectRideOffer,
  finalizeAssignmentFromOffer,
  readDispatchSettings,
} = require("./bargaining");
const { validateCandidateDriverLimit } = require("./matching");
const {
  bootstrapAdminClaim,
  grantAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
  isAdminAuth,
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
  getOpsHealthSummary,
  logStructured,
} = require("./ops-monitor");
const { reportGeoCellCoverage } = require("./geo-coverage");

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

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
  if (message === "INVALID_CANDIDATE_LIMIT") return new HttpsError("invalid-argument", message);
  if (message === "MAX_ACTIVE_BOOKINGS" || message === "CONFIRM_EXTRA_BOOKING") {
    return new HttpsError("failed-precondition", message);
  }
  return new HttpsError("internal", message);
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

/** Race-safe booking create (4 concurrent non-terminal max). */
exports.createCustomerBooking = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    const data = request.data || {};
    return await createCustomerBooking(db, {
      customerUid: request.auth.uid,
      confirmedExtraBooking: Boolean(data.confirmedExtraBooking),
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
  } catch (err) {
    throw mapErr(err);
  }
});

exports.cancelCustomerBooking = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  try {
    return await cancelCustomerBooking(db, {
      customerUid: request.auth.uid,
      rideId: String(request.data?.rideId || "").trim(),
    });
  } catch (err) {
    throw mapErr(err);
  }
});

/** Trusted matching after ride create (Admin SDK writes candidates). Phase 3B: geo-scoped only. */
exports.matchRideCandidates = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const rideId = String(request.data?.rideId || "").trim();
  if (!rideId) throw new HttpsError("invalid-argument", "MISSING_RIDE");
  // Clients must not inject driver lists or arbitrary candidate sets.
  if (request.data?.onlineDrivers != null || request.data?.candidates != null) {
    throw new HttpsError("invalid-argument", "CLIENT_CANDIDATE_INJECTION_DENIED");
  }
  const rideSnap = await db.collection("rides").doc(rideId).get();
  if (!rideSnap.exists) throw new HttpsError("not-found", "RIDE_NOT_FOUND");
  const ride = rideSnap.data() || {};
  const isAdmin = await callerIsAdmin(request);
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
  // Admins may pass an explicit 10|20 for controlled tests / ops overrides.
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

/** Super Admin: set candidateDriverLimit to 10 or 20 only. */
exports.setCandidateDriverLimit = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth?.uid || !(await callerIsAdmin(request))) {
    throw new HttpsError("permission-denied", "ADMIN_ONLY");
  }
  try {
    const limit = validateCandidateDriverLimit(request.data?.candidateDriverLimit);
    await db.collection("settings").doc("dispatch").set(
      {
        candidateDriverLimit: limit,
        maxDriverOpenBargains: 10,
        maxCustomerActiveBookings: 4,
        searchRingsKm: [1, 2, 3],
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: request.auth.uid,
      },
      { merge: true }
    );
    return { ok: true, candidateDriverLimit: limit };
  } catch (err) {
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
