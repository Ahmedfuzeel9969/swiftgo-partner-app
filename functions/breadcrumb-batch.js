/**
 * Phase 6 — submitRideBreadcrumbBatch callable.
 * Updates shadow telemetry only. Never touches fare/settlement/wallet.
 */

"use strict";

const {
  BREADCRUMB_PROTOCOL_VERSION,
  BREADCRUMB_DIAG,
  assignmentVersionFromRide,
  validateBreadcrumbBatch,
  accumulateDenseChordMeters,
} = require("./breadcrumb-schema");

const TELEMETRY_COLLECTION = "rideBreadcrumbTelemetry";

function emptyTelemetry(rideId, driverId, vehicleId, assignmentVersion, trackingSessionId) {
  return {
    protocolVersion: BREADCRUMB_PROTOCOL_VERSION,
    rideId,
    driverId,
    vehicleId,
    assignmentVersion,
    trackingSessionId,
    lastBatchSequence: 0,
    lastFixSequence: 0,
    lastAcceptedObservedAt: null,
    lastAcceptedRawPoint: null,
    lastBatchKey: "",
    denseChordDistanceMeters: 0,
    acceptedPointCount: 0,
    rejectedPointCount: 0,
    gapCount: 0,
    coverageStartAt: null,
    coverageEndAt: null,
    coverageSeconds: 0,
    incompleteCoverage: false,
    updatedAt: null,
  };
}

function batchKey(batch) {
  return `${batch.batchSequence}:${batch.firstFixSequence}:${batch.lastFixSequence}:${batch.trackingSessionId}`;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   driverUid: string,
 *   batch: object,
 * }} input
 */
async function submitRideBreadcrumbBatch(db, input) {
  const driverUid = String(input?.driverUid || "").trim();
  if (!driverUid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }

  const nowMs = Date.now();
  const validated = validateBreadcrumbBatch(input?.batch, { nowMs });
  if (!validated.ok) {
    const err = new Error(String(validated.reason || "INVALID_BATCH").toUpperCase());
    err.code =
      validated.reason === "unsupported_protocol" ||
      validated.reason === "too_many_points" ||
      validated.reason === "batch_too_large"
        ? "invalid-argument"
        : "invalid-argument";
    throw err;
  }
  const batch = validated.batch;
  const { rideId, vehicleId, driverId } = batch.rideBinding;

  if (driverId !== driverUid) {
    const err = new Error("DRIVER_BINDING_MISMATCH");
    err.code = "permission-denied";
    throw err;
  }

  const rideRef = db.collection("rides").doc(rideId);
  const telemetryRef = db.collection(TELEMETRY_COLLECTION).doc(rideId);
  const vehicleRef = db.collection("vehicles").doc(vehicleId);

  const result = await db.runTransaction(async (tx) => {
    // All required reads before any writes.
    const [rideSnap, telemetrySnap, vehicleSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(telemetryRef),
      tx.get(vehicleRef),
    ]);

    if (!rideSnap.exists) {
      const err = new Error("RIDE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }
    const ride = rideSnap.data() || {};
    if (String(ride.driverId || "") !== driverUid) {
      const err = new Error("NOT_RIDE_DRIVER");
      err.code = "permission-denied";
      throw err;
    }
    if (String(ride.status || "") !== "in_progress") {
      const err = new Error("RIDE_NOT_IN_PROGRESS");
      err.code = "failed-precondition";
      throw err;
    }
    if (String(ride.vehicleId || "") !== vehicleId) {
      const err = new Error("VEHICLE_MISMATCH");
      err.code = "permission-denied";
      throw err;
    }
    if (!vehicleSnap.exists) {
      const err = new Error("VEHICLE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }
    const vehicle = vehicleSnap.data() || {};
    if (String(vehicle.driverId || "") !== driverUid) {
      const err = new Error("VEHICLE_DRIVER_MISMATCH");
      err.code = "permission-denied";
      throw err;
    }
    const vehicleSession = String(vehicle.trackingSessionId || "").trim();
    if (!vehicleSession || vehicleSession !== batch.trackingSessionId) {
      const err = new Error("STALE_TRACKING_SESSION");
      err.code = "failed-precondition";
      throw err;
    }

    const expectedAv = assignmentVersionFromRide(ride);
    if (batch.assignmentVersion !== expectedAv) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }

    let tel = telemetrySnap.exists
      ? { ...emptyTelemetry(rideId, driverUid, vehicleId, expectedAv, batch.trackingSessionId), ...telemetrySnap.data() }
      : emptyTelemetry(rideId, driverUid, vehicleId, expectedAv, batch.trackingSessionId);

    // Session / assignment change resets continuity (no invented bridge).
    const sessionChanged =
      String(tel.trackingSessionId || "") &&
      String(tel.trackingSessionId) !== batch.trackingSessionId;
    const assignmentChanged =
      Number(tel.assignmentVersion || 0) &&
      Number(tel.assignmentVersion) !== expectedAv;

    if (sessionChanged || assignmentChanged) {
      tel = emptyTelemetry(rideId, driverUid, vehicleId, expectedAv, batch.trackingSessionId);
      tel.incompleteCoverage = true;
      tel.gapCount = Number(tel.gapCount || 0) + 1;
    }

    const key = batchKey(batch);
    // Idempotent duplicate
    if (tel.lastBatchKey === key || Number(tel.lastBatchSequence) === batch.batchSequence) {
      if (
        Number(tel.lastBatchSequence) === batch.batchSequence &&
        tel.lastBatchKey === key
      ) {
        return {
          ok: true,
          acknowledged: true,
          duplicate: true,
          diag: BREADCRUMB_DIAG.BATCH_DUPLICATE,
          batchSequence: batch.batchSequence,
          lastFixSequence: Number(tel.lastFixSequence) || batch.lastFixSequence,
          denseChordDistanceMeters: Number(tel.denseChordDistanceMeters) || 0,
          acceptedPointCount: Number(tel.acceptedPointCount) || 0,
          rejectedPointCount: Number(tel.rejectedPointCount) || 0,
          gapCount: Number(tel.gapCount) || 0,
          incompleteCoverage: Boolean(tel.incompleteCoverage),
        };
      }
      // Same sequence different content / out of order — reject
      if (batch.batchSequence <= Number(tel.lastBatchSequence || 0)) {
        const err = new Error("BATCH_OUT_OF_ORDER");
        err.code = "failed-precondition";
        throw err;
      }
    }

    if (batch.batchSequence !== Number(tel.lastBatchSequence || 0) + 1 && Number(tel.lastBatchSequence || 0) > 0) {
      // Allow first batch after reset (lastBatchSequence 0); otherwise require strict next.
      if (!(Number(tel.lastBatchSequence || 0) === 0 && batch.batchSequence >= 1)) {
        if (batch.batchSequence <= Number(tel.lastBatchSequence || 0)) {
          const err = new Error("BATCH_OUT_OF_ORDER");
          err.code = "failed-precondition";
          throw err;
        }
        // Skip ahead — treat as gap, do not invent missing batches' distance.
        tel.gapCount = Number(tel.gapCount || 0) + 1;
        tel.incompleteCoverage = true;
      }
    }

    // Drop already-applied fix sequences (overlap / retry slices) — no double-count.
    const lastFix = Number(tel.lastFixSequence || 0);
    const freshPoints = batch.points.filter((p) => Number(p.sequence) > lastFix);
    if (!freshPoints.length) {
      tel.lastBatchSequence = batch.batchSequence;
      tel.lastBatchKey = key;
      const updatedAtDup = new Date(nowMs);
      tel.updatedAt = updatedAtDup;
      tx.set(telemetryRef, tel, { merge: true });
      return {
        ok: true,
        acknowledged: true,
        duplicate: true,
        diag: BREADCRUMB_DIAG.BATCH_DUPLICATE,
        batchSequence: batch.batchSequence,
        lastFixSequence: lastFix,
        denseChordDistanceMeters: Number(tel.denseChordDistanceMeters) || 0,
        acceptedPointCount: Number(tel.acceptedPointCount) || 0,
        rejectedPointCount: Number(tel.rejectedPointCount) || 0,
        gapCount: Number(tel.gapCount) || 0,
        incompleteCoverage: Boolean(tel.incompleteCoverage),
        sparseTraveledDistanceKm: Number(ride.traveledDistanceKm) || 0,
      };
    }

    const previousAnchor =
      batch.gapBefore || !tel.lastAcceptedRawPoint
        ? null
        : {
            lat: tel.lastAcceptedRawPoint.lat,
            lng: tel.lastAcceptedRawPoint.lng,
            observedAt: tel.lastAcceptedObservedAt,
            sequence: tel.lastFixSequence,
          };

    const chord = accumulateDenseChordMeters(freshPoints, {
      previousAnchor,
      gapBefore: Boolean(batch.gapBefore) || !previousAnchor,
    });

    const prevDist = Number(tel.denseChordDistanceMeters) || 0;
    tel.denseChordDistanceMeters = Math.round((prevDist + chord.distanceMeters) * 100) / 100;
    tel.acceptedPointCount = Number(tel.acceptedPointCount || 0) + chord.acceptedPointCount;
    tel.rejectedPointCount = Number(tel.rejectedPointCount || 0) + chord.rejectedPointCount;
    if (batch.gapBefore) {
      tel.gapCount = Number(tel.gapCount || 0) + 1;
      tel.incompleteCoverage = true;
    }
    tel.lastBatchSequence = batch.batchSequence;
    tel.lastFixSequence = freshPoints[freshPoints.length - 1].sequence;
    tel.lastBatchKey = key;
    tel.trackingSessionId = batch.trackingSessionId;
    tel.assignmentVersion = expectedAv;
    tel.driverId = driverUid;
    tel.vehicleId = vehicleId;
    tel.rideId = rideId;
    tel.protocolVersion = BREADCRUMB_PROTOCOL_VERSION;

    if (chord.lastAccepted) {
      tel.lastAcceptedRawPoint = {
        lat: chord.lastAccepted.lat,
        lng: chord.lastAccepted.lng,
      };
      tel.lastAcceptedObservedAt = chord.lastAccepted.observedAt;
      if (!tel.coverageStartAt) tel.coverageStartAt = batch.points[0].observedAt;
      tel.coverageEndAt = chord.lastAccepted.observedAt;
      if (tel.coverageStartAt && tel.coverageEndAt) {
        tel.coverageSeconds = Math.max(
          0,
          Math.round((tel.coverageEndAt - tel.coverageStartAt) / 1000)
        );
      }
    }

    const updatedAt = new Date(nowMs);
    tel.updatedAt = updatedAt;

    // Shadow only — never write traveledDistanceKm / fare / wallet fields.
    tx.set(telemetryRef, tel, { merge: true });

    return {
      ok: true,
      acknowledged: true,
      duplicate: false,
      diag: BREADCRUMB_DIAG.SHADOW_UPDATED,
      batchSequence: batch.batchSequence,
      lastFixSequence: batch.lastFixSequence,
      denseChordDistanceMeters: tel.denseChordDistanceMeters,
      acceptedPointCount: tel.acceptedPointCount,
      rejectedPointCount: tel.rejectedPointCount,
      gapCount: tel.gapCount,
      incompleteCoverage: Boolean(tel.incompleteCoverage),
      // Compare against sparse checkpoint field without mutating it.
      sparseTraveledDistanceKm: Number(ride.traveledDistanceKm) || 0,
    };
  });

  return result;
}

module.exports = {
  TELEMETRY_COLLECTION,
  emptyTelemetry,
  batchKey,
  submitRideBreadcrumbBatch,
};
