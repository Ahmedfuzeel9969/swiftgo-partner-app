import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { assignmentVersionFromToken, buildBreadcrumbBatch } from "../shared/js/breadcrumb-schema.mjs";
import { requireBreadcrumbEmulators } from "./helpers/breadcrumb-test-safety.mjs";
const require = createRequire(import.meta.url), serverRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = serverRequire("firebase-admin/app");
const { getFirestore, Timestamp } = serverRequire("firebase-admin/firestore");
const { submitRideBreadcrumbBatch } = require("../functions/breadcrumb-batch.js");
const { mirrorRideLocationTransactional } = require("../functions/driver-location.js");
const { previewCancellationFare, cancelCustomerBooking } = require("../functions/bargaining.js");
const { submitRideLocationReportSection, hashAssignmentSessionTokenSync } = require("../functions/ride-location-report.js");
requireBreadcrumbEmulators();
const projectId = "demo-remediation-phase5";
let app, db, env, serial = 0;
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8190,
    rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.clearFirestore(); app = initializeApp({ projectId }); db = getFirestore(app);
  await db.doc("settings/dispatch").set({ firebaseLocationFallbackEnabled: true, p2pFallbackAfterSeconds: 5 });
  await db.doc("settings/locationReporting").set({ enabled: true, uploadMode: "ride_end" });
  await db.doc("settings/pricing").set({ baseFare: 100, perKmRate: 100 });
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });
async function seed() {
  const id = `phase5_${++serial}`, now = Date.now(), vehicleId = `car_${serial}`, driverId = `driver_${serial}`, userId = `customer_${serial}`;
  const assignmentSessionToken = `phase5_assignment_${serial}`, trackingSessionId = `tracking_${serial}`;
  const ride = { id, userId, driverId, vehicleId, status: "in_progress", assignmentSessionToken,
    assignedAt: Timestamp.fromMillis(now - 120000), tripStartedAt: Timestamp.fromMillis(now - 90000),
    pickupLocation: { lat: 24.86, lng: 67 }, dropoffLocation: { lat: 24.87, lng: 67.01 },
    vehicleType: "bike", vehicleTypeKey: "bike", farePkr: 1000, estimatedFare: 1000, distanceKm: 5, timeMins: 20, traveledDistanceKm: 0.1, paymentMethod: "cash" };
  const rideRef = db.doc(`rides/${id}`), vehicleRef = db.doc(`vehicles/${vehicleId}`);
  await rideRef.set(ride);
  await db.doc(`partners/${driverId}`).set({ role: "driver", walletBalance: 0, activeRideId: id });
  await vehicleRef.set({ driverId, activeRideId: id, trackingSessionId, trackingSessionStartedAt: Timestamp.fromMillis(now - 120000),
    locationUpdatedAt: Timestamp.fromMillis(now), location: { lat: 24.86, lng: 67, sessionId: trackingSessionId,
      observedAt: now, sequence: 1, accuracyM: 10, source: "gps" } });
  const points = [
    { lat: 24.86, lng: 67 }, { lat: 24.861, lng: 67 }, { lat: 24.861, lng: 67.001 }, { lat: 24.86, lng: 67.001 },
  ].map((p, n) => ({ ...p, observedAt: now - 50000 + n * 10000, sequence: n + 1, accuracyM: 10 }));
  const batch = buildBreadcrumbBatch({ rideBinding: { rideId: id, driverId, vehicleId }, assignmentSessionToken,
    assignmentVersion: assignmentVersionFromToken(assignmentSessionToken), trackingSessionId, batchSequence: 1, points });
  return { ride, rideRef, vehicleRef, now, batch, points,
    submit: (b = batch) => submitRideBreadcrumbBatch(db, { driverUid: driverId, batch: b }),
    mirror: (opts = {}) => mirrorRideLocationTransactional(db, vehicleId, null, { rideId: id, readVehicleInTxn: true,
      reportingConfig: { enabled: true, uploadMode: "ride_end", collectFirebaseMetrics: true }, silent: true, ...opts }) };
}
test("curved dense distance is server validated and selected at cancellation preview without double counting", async () => {
  const s = await seed(), result = await s.submit(); assert.ok(result.denseChordDistanceMeters > 320);
  assert.equal((await s.rideRef.get()).data().traveledDistanceKm, 0.1);
  const preview = await previewCancellationFare(db, { customerUid: s.ride.userId, rideId: s.ride.id });
  assert.equal(preview.distanceSource, "validated_dense_segments");
  assert.equal(preview.traveledDistanceKm, Math.round(result.denseChordDistanceMeters / 10) / 100);
  assert.equal(preview.distanceCoverageIncomplete, true); assert.ok(preview.cancellationFare < 150);
});
test("duplicate and concurrent breadcrumb submission cannot charge the same path twice", async () => {
  const s = await seed(), result = await Promise.all([s.submit(), s.submit()]);
  assert.equal(result.filter((r) => r.duplicate).length, 1);
  const tel = (await db.doc(`rideBreadcrumbTelemetry/${s.ride.id}`).get()).data(); assert.equal(tel.acceptedPointCount, 4);
  assert.ok(tel.denseChordDistanceMeters < 330);
});
test("same batch ID with different points is rejected, not falsely acknowledged", async () => {
  const s = await seed(); await s.submit();
  await assert.rejects(s.submit({ ...s.batch, points: s.points.map((p, i) => i === 1 ? { ...p, lat: p.lat + 0.0001 } : p) }), /BATCH_OUT_OF_ORDER/);
});
test("GPS session restart retains prior measured distance but never bridges the restart gap", async () => {
  const s = await seed(), first = await s.submit();
  await s.vehicleRef.update({ trackingSessionId: "new_tracking" });
  const points = [{ lat: 24.861, lng: 67.001, observedAt: s.now - 10000, sequence: 1 },
    { lat: 24.861, lng: 67.002, observedAt: s.now - 5000, sequence: 2 }];
  const next = await s.submit({ ...s.batch, trackingSessionId: "new_tracking", firstFixSequence: 1, lastFixSequence: 2, points });
  assert.ok(next.denseChordDistanceMeters > first.denseChordDistanceMeters + 90);
  assert.ok(next.denseChordDistanceMeters < first.denseChordDistanceMeters + 105); assert.equal(next.incompleteCoverage, true);
});
test("pre-trip coordinates, long gaps, stale assignments and terminal uploads cannot inflate billable distance", async () => {
  const s = await seed();
  const points = s.points.map((p, i) => ({ ...p, observedAt: s.now - 110000 + i * 30000 }));
  const r = await s.submit({ ...s.batch, points }); assert.equal(r.denseChordDistanceMeters, 0); assert.equal(r.incompleteCoverage, true);
  await assert.rejects(s.submit({ ...s.batch, assignmentSessionToken: "old_assignment" }), /STALE_ASSIGNMENT/);
  await s.rideRef.update({ status: "completed" }); await assert.rejects(s.submit(), /RIDE_NOT_IN_PROGRESS/);
});
test("cancellation transaction reads the latest committed distance and fixes amount against later batches", async () => {
  const s = await seed(); await s.submit();
  const result = await cancelCustomerBooking(db, { customerUid: s.ride.userId, rideId: s.ride.id });
  const r = (await s.rideRef.get()).data(); assert.equal(r.cancellationDistanceSource, "validated_dense_segments");
  assert.equal(r.cancellationFare, result.cancellationFare); assert.ok(r.cancellationFare <= 1000);
  await assert.rejects(s.submit(), /RIDE_NOT_IN_PROGRESS/);
  const twice = await cancelCustomerBooking(db, { customerUid: s.ride.userId, rideId: s.ride.id });
  assert.equal(twice.cancellationFare, result.cancellationFare); assert.equal(twice.already, true);
});
test("clients cannot write distance measurements or patch the authoritative ride distance", async () => {
  const s = await seed(), driver = env.authenticatedContext(s.ride.driverId).firestore();
  await assertFails(setDoc(doc(driver, `rideBreadcrumbTelemetry/${s.ride.id}`), { denseChordDistanceMeters: 999999 }));
  await assertFails(setDoc(doc(driver, `rides/${s.ride.id}`), { traveledDistanceMeters: 999999 }, { merge: true }));
});
test("transactional mirror records accepted, duplicate, invalid and admin-suppressed outcomes", async () => {
  const s = await seed(); assert.equal((await s.mirror()).mirrored, true);
  assert.equal((await s.mirror()).mirrored, false);
  await s.vehicleRef.update({ "location.lat": 95 }); assert.equal((await s.mirror()).mirrored, false);
  await db.doc("settings/dispatch").update({ firebaseLocationFallbackEnabled: false });
  assert.equal((await s.mirror()).reason, "firebase_disabled");
  await db.doc("settings/dispatch").update({ firebaseLocationFallbackEnabled: true });
  const counts = (await s.rideRef.get()).data().serverMirrorCounters;
  assert.equal(counts.mirrorAttempts, 4); assert.equal(counts.mirrorAccepted, 1);
  assert.equal(counts.mirrorSkippedInvalid, 1); assert.equal(counts.mirrorSkippedPolicy, 1);
});
test("failed mirror transaction is counted separately without committing location", async () => {
  const s = await seed();
  await assert.rejects(s.mirror({ runTransaction: (fn) => db.runTransaction(async (tx) => { await fn(tx); throw new Error("injected_failure"); }) }), /injected_failure/);
  const r = (await s.rideRef.get()).data(); assert.equal(r.driverLocation, undefined);
  assert.equal(r.serverMirrorCounters.mirrorFailed, 1); assert.equal(r.serverMirrorCounters.mirrorAccepted, 0);
});
test("ride-end report receives new paint counters and all server outcomes without coordinates", async () => {
  const s = await seed(); await s.mirror(); await s.mirror();
  await s.rideRef.update({ status: "completed" });
  const section = { measurementVersion: 2, counters: { p2pFramesReceived: 2, p2pFixesAccepted: 2, p2pValidRendered: 2, mapFramesPainted: 60 },
    firstMapFrameAtMs: s.now - 1000, lastMapFrameAtMs: s.now, submitSequence: 1 };
  await submitRideLocationReportSection(db, { callerUid: s.ride.userId, role: "customer", rideId: s.ride.id, section,
    submitSequence: 1, finalSubmit: true, assignmentSessionTokenHash: hashAssignmentSessionTokenSync(s.ride.assignmentSessionToken) });
  const report = (await db.doc(`rideLocationReports/${s.ride.id}`).get()).data();
  assert.equal(report.customer.counters.mapFramesPainted, 60); assert.equal(report.derived.deliveryRatios.renderedToReceived, 1);
  assert.equal(report.server.counters.mirrorAttempts, 2); assert.equal(report.server.counters.mirrorAccepted, 1);
  assert.equal(JSON.stringify(report).includes('"lat"'), false);
});
test("a missing batch never creates a billable bridge even within the normal GPS time gap", async () => {
  const s = await seed(), first = await s.submit();
  const points = [{ lat: 24.861, lng: 67.001, observedAt: s.now - 15000, sequence: 5 }];
  const next = await s.submit({ ...s.batch, batchSequence: 3, firstFixSequence: 5, lastFixSequence: 5, points });
  assert.equal(next.denseChordDistanceMeters, first.denseChordDistanceMeters); assert.equal(next.incompleteCoverage, true);
});
