/**
 * Phase 6 — submitRideBreadcrumbBatch callable.
 * Validates measured raw segments. Never writes a fare/wallet; cancellation
 * reads this server-owned measurement in its own settlement transaction.
 */

"use strict";

const {
  BREADCRUMB_PROTOCOL_VERSION,
  BREADCRUMB_DIAG,
  validateBreadcrumbBatch,
  accumulateDenseChordMeters,
  assignmentVersionFromToken,
} = require("./breadcrumb-schema");

const TELEMETRY_COLLECTION = "rideBreadcrumbTelemetry";
const { createHash } = require("node:crypto");
const { timestampToMs } = require("./server-mirror-aggregate");
const { normalizeLocationReportingConfig } = require("./location-reporting-config");

function emptyTelemetry(rideId, driverId, vehicleId, assignmentVersion, trackingSessionId, assignmentSessionToken) {
  return {
    protocolVersion: BREADCRUMB_PROTOCOL_VERSION,
    measurementVersion: 2,
    rideId,
    driverId,
    vehicleId,
    assignmentVersion,
    assignmentSessionToken: assignmentSessionToken || "",
    trackingSessionId,
    lastBatchSequence: 0,
    lastFixSequence: 0,
    lastAcceptedObservedAt: null,
    lastAcceptedRawPoint: null,
    lastDistanceAnchor: null,
    lastBatchKey: "",
    lastBatchDigest: "",
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
function batchDigest(batch) {
  return createHash("sha256").update(JSON.stringify({ key: batchKey(batch), points: batch.points, gapBefore: batch.gapBefore })).digest("hex");
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
    const [rideSnap, telemetrySnap, vehicleSnap, reportingSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(telemetryRef),
      tx.get(vehicleRef),
      tx.get(db.doc("settings/locationReporting")),
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
    if (String(vehicle.activeRideId || "") !== rideId) {
      const err = new Error("VEHICLE_ACTIVE_RIDE_MISMATCH");
      err.code = "failed-precondition";
      throw err;
    }
    const vehicleSession = String(vehicle.trackingSessionId || "").trim();
    if (!vehicleSession || vehicleSession !== batch.trackingSessionId) {
      const err = new Error("STALE_TRACKING_SESSION");
      err.code = "failed-precondition";
      throw err;
    }

    const serverToken = String(ride.assignmentSessionToken || "").trim();
    if (!serverToken) {
      // Orphan/legacy: refuse rather than inventing a client-chosen assignment token.
      const err = new Error("ASSIGNMENT_TOKEN_MISSING");
      err.code = "failed-precondition";
      throw err;
    }
    if (serverToken !== String(batch.assignmentSessionToken || "").trim()) {
      const err = new Error("STALE_ASSIGNMENT");
      err.code = "failed-precondition";
      throw err;
    }

    // assignmentVersion must be derived from the server token — never trust an arbitrary client value.
    const expectedAv = assignmentVersionFromToken(serverToken);
    if (expectedAv < 1) {
      const err = new Error("ASSIGNMENT_TOKEN_MISSING");
      err.code = "failed-precondition";
      throw err;
    }
    if (Math.floor(Number(batch.assignmentVersion) || 0) !== expectedAv) {
      const err = new Error("ASSIGNMENT_VERSION_MISMATCH");
      err.code = "failed-precondition";
      throw err;
    }

    const tripStartedAtMs = timestampToMs(ride.tripStartedAt);
    if (!tripStartedAtMs) { const e = new Error("TRIP_START_MISSING"); e.code = "failed-precondition"; throw e; }
    let tel = telemetrySnap.exists
      ? {
          ...emptyTelemetry(
            rideId,
            driverUid,
            vehicleId,
            expectedAv,
            batch.trackingSessionId,
            serverToken
          ),
          ...telemetrySnap.data(),
        }
      : emptyTelemetry(
          rideId,
          driverUid,
          vehicleId,
          expectedAv,
          batch.trackingSessionId,
          serverToken
        );

    // Session / assignment-token change resets continuity (no invented bridge).
    const sessionChanged =
      String(tel.trackingSessionId || "") &&
      String(tel.trackingSessionId) !== batch.trackingSessionId;
    const assignmentChanged =
      String(tel.assignmentSessionToken || "") &&
      String(tel.assignmentSessionToken) !== serverToken;

    if (sessionChanged || assignmentChanged || tel.measurementVersion !== 2 ||
        (telemetrySnap.exists && telemetrySnap.data().measurementVersion !== 2)) {
      const prior = tel;
      tel = emptyTelemetry(
        rideId,
        driverUid,
        vehicleId,
        expectedAv,
        batch.trackingSessionId,
        serverToken
      );
      tel.incompleteCoverage = true;
      // Retain measured distance across a GPS restart of the SAME assignment,
      // but do not invent a connecting segment. Old shadow data stays legacy.
      if (!assignmentChanged && telemetrySnap.data()?.measurementVersion === 2) {
        for (const key of ["denseChordDistanceMeters", "acceptedPointCount", "rejectedPointCount", "coverageStartAt", "coverageEndAt", "coverageSeconds", "gapCount"])
          tel[key] = prior[key];
      }
      tel.gapCount = Number(tel.gapCount || 0) + 1;
    }

    const key = batchKey(batch);
    const digest = batchDigest(batch);
    // Idempotent duplicate
    if (tel.lastBatchKey === key || Number(tel.lastBatchSequence) === batch.batchSequence) {
      if (
        Number(tel.lastBatchSequence) === batch.batchSequence &&
        tel.lastBatchKey === key && tel.lastBatchDigest === digest
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

    let missingBatch = false;
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
        missingBatch = true;
      }
    }

    // Drop already-applied fix sequences (overlap / retry slices) — no double-count.
    const lastFix = Number(tel.lastFixSequence || 0);
    const freshPoints = batch.points.filter((p) => p.sequence > lastFix && p.observedAt >= tripStartedAtMs &&
      p.observedAt > (tel.coverageEndAt || 0) && p.observedAt <= nowMs);
    if (!freshPoints.length) {
      tel.lastBatchSequence = batch.batchSequence;
      tel.lastBatchKey = key;
      tel.lastBatchDigest = digest;
      tel.lastFixSequence = Math.max(lastFix, batch.lastFixSequence);
      tel.incompleteCoverage = true;
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
      missingBatch || batch.gapBefore || !tel.lastAcceptedRawPoint || tel.lastDistanceAnchor === null
        ? null
        : {
            lat: tel.lastAcceptedRawPoint.lat,
            lng: tel.lastAcceptedRawPoint.lng,
            observedAt: tel.lastAcceptedObservedAt,
            sequence: tel.lastFixSequence,
          };

    const chord = accumulateDenseChordMeters(freshPoints, {
      previousAnchor,
      distanceAnchor: tel.lastDistanceAnchor || previousAnchor,
      gapBefore: Boolean(batch.gapBefore) || !previousAnchor,
    });

    const prevDist = Number(tel.denseChordDistanceMeters) || 0;
    tel.denseChordDistanceMeters = Math.round((prevDist + chord.distanceMeters) * 100) / 100;
    tel.acceptedPointCount = Number(tel.acceptedPointCount || 0) + chord.acceptedPointCount;
    tel.rejectedPointCount = Number(tel.rejectedPointCount || 0) + chord.rejectedPointCount;
    tel.gapCount += chord.gapCount;
    if (chord.gapCount || freshPoints.length !== batch.points.length) tel.incompleteCoverage = true;
    if (batch.gapBefore) {
      tel.gapCount = Number(tel.gapCount || 0) + 1;
      tel.incompleteCoverage = true;
    }
    tel.lastBatchSequence = batch.batchSequence;
    tel.lastFixSequence = freshPoints[freshPoints.length - 1].sequence;
    tel.lastBatchKey = key;
    tel.lastBatchDigest = digest;
    tel.lastDistanceAnchor = chord.distanceAnchor;
    tel.trackingSessionId = batch.trackingSessionId;
    tel.assignmentVersion = expectedAv;
    tel.assignmentSessionToken = serverToken;
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
      if (!tel.coverageStartAt) tel.coverageStartAt = freshPoints[0].observedAt;
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
    // Same super-admin retention window as the associated location report.
    // A purge additionally requires a terminal ride and approved maintenance policy.
    tel.expiresAt = new Date(nowMs + normalizeLocationReportingConfig(reportingSnap.data()).retentionDays * 86400000);

    // Server-owned measurement only; no mutable client distance/fare accepted.
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
