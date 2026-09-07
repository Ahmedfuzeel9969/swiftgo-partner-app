import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { rideLocationAssignmentVersion } from "../shared/js/ride-location-contract.mjs";
const require = createRequire(import.meta.url), requireServer = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = requireServer("firebase-admin/app");
const { getFirestore, Timestamp } = requireServer("firebase-admin/firestore");
const { getAuth } = requireServer("firebase-admin/auth");
const { publishCustomerRideLocation } = require("../functions/customer-location.js");
const { mirrorRideLocationTransactional } = require("../functions/driver-location.js");
const { createRidePeerOffer, publishRidePeerAnswer } = require("../functions/ride-peer-session.js");
const projectId = "demo-remediation-phase2";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8187" || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9198") {
  throw new Error("ISOLATED_PHASE_TWO_LOOPBACK_EMULATORS_REQUIRED; never target production or the user's preview");
}
let env, app, db, token;
const client = (uid) => env.authenticatedContext(uid).firestore();
const rejected = (code) => (error) => error.code === code;
let serial = 0;
async function seed() {
  const id = `ride_${++serial}`;
  const ride = { id, userId: "customer", driverId: "driver", vehicleId: `car_${serial}`, ownerId: "owner", status: "accepted",
    assignmentSessionToken: `assignment_${serial}_123456`, pickupLocation: { lat: 24.86, lng: 67.01, address: "Fixture pickup" }, dropoffLocation: { lat: 24.87, lng: 67.02, address: "Fixture dropoff" }, farePkr: 200 };
  await db.doc(`rides/${id}`).set(ride);
  const sample = (time = Date.now(), seq = 1) => ({ lat: 24.86, lng: 67.01, observedAt: time, sequence: seq, trackingSessionId: "customer_tracking", accuracyM: 10,
    role: "customer", rideId: id, assignmentVersion: rideLocationAssignmentVersion(ride), assignmentId: ride.assignmentSessionToken });
  const input = (location = sample()) => ({ rideId: id, assignmentSessionToken: ride.assignmentSessionToken, location });
  const locationPath = `rides/${id}/customerLocations/${ride.assignmentSessionToken}`;
  return { ride, sample, input, ref: db.doc(`rides/${id}`), locationRef: db.doc(locationPath), locationPath };
}
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8187, rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.clearFirestore(); app = initializeApp({ projectId }); db = getFirestore(app);
  await db.doc("settings/dispatch").set({ firebaseLocationFallbackEnabled: true, p2pFallbackAfterSeconds: 5 });
  await getAuth(app).createUser({ uid: "customer", email: "phase2-customer@example.test", password: "Local-only-test-123!" }).catch((e) => { if (e.code !== "auth/uid-already-exists") throw e; });
  const signIn = await fetch("http://127.0.0.1:9198/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "phase2-customer@example.test", password: "Local-only-test-123!", returnSecureToken: true }),
  });
  assert.equal(signIn.status, 200); token = (await signIn.json()).idToken;
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test("Firestore denies all direct ride location writes and unrelated reads", async () => {
  const s = await seed();
  for (const uid of ["customer", "driver", "owner", "stranger"]) {
    for (const field of ["customerLocation", "driverLocation"]) await assertFails(updateDoc(doc(client(uid), "rides", s.ride.id), { [field]: s.sample() }));
  }
  await assertSucceeds(getDoc(doc(client("driver"), "rides", s.ride.id)));
  await assertFails(getDoc(doc(client("stranger"), "rides", s.ride.id)));
});
test("customer fallback requires auth, correct customer, active ride and current server assignment", async () => {
  const s = await seed();
  await assert.rejects(publishCustomerRideLocation(db, null, s.input()), rejected("unauthenticated"));
  await assert.rejects(publishCustomerRideLocation(db, "driver", s.input()), rejected("permission-denied"));
  await assert.rejects(publishCustomerRideLocation(db, "customer", { ...s.input(), assignmentSessionToken: "old" }), rejected("failed-precondition"));
  await s.ref.update({ status: "completed" });
  await assert.rejects(publishCustomerRideLocation(db, "customer", s.input()), rejected("failed-precondition"));
});
test("accepted customer position is canonical, visible to driver, and never changes pickup/fare", async () => {
  const s = await seed(), input = s.input();
  input.location.ownerId = "forged"; input.location.farePkr = 1;
  assert.equal((await publishCustomerRideLocation(db, "customer", input)).ok, true);
  const read = (await getDoc(doc(client("driver"), s.locationPath))).data();
  assert.equal(read.location.lat, input.location.lat); assert.equal(read.location.ownerId, undefined);
  const booking = (await s.ref.get()).data();
  assert.equal(booking.customerLocation, undefined);
  assert.deepEqual(booking.pickupLocation, s.ride.pickupLocation); assert.equal(booking.farePkr, 200);
  assert.ok(read.updatedAt.toMillis() > 0);
});
test("exact retries/concurrent duplicates are acknowledged once without a second location write", async () => {
  const s = await seed(), input = s.input();
  const results = await Promise.all([publishCustomerRideLocation(db, "customer", input), publishCustomerRideLocation(db, "customer", input)]);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  const before = (await s.locationRef.get()).data().updatedAt.toMillis();
  assert.equal((await publishCustomerRideLocation(db, "customer", input)).duplicate, true);
  assert.equal((await s.locationRef.get()).data().updatedAt.toMillis(), before);
  await assert.rejects(publishCustomerRideLocation(db, "customer", s.input({ ...input.location, lat: 25 })), rejected("invalid-argument"));
});
test("super-admin Firebase kill switch and interval are enforced on the server, not trusted to a client", async () => {
  const s = await seed();
  await db.doc("settings/dispatch").update({ firebaseLocationFallbackEnabled: false });
  assert.equal((await publishCustomerRideLocation(db, "customer", s.input())).reason, "firebase_disabled");
  assert.equal((await s.locationRef.get()).exists, false);
  await db.doc("settings/dispatch").update({ firebaseLocationFallbackEnabled: true, p2pFallbackAfterSeconds: 60 });
  const input = s.input(); assert.equal((await publishCustomerRideLocation(db, "customer", input)).ok, true);
  assert.equal((await publishCustomerRideLocation(db, "customer", s.input(s.sample(input.location.observedAt + 1, 2)))).reason, "admin_interval");
  await assertFails(updateDoc(doc(client("customer"), "settings", "dispatch"), { firebaseLocationFallbackEnabled: true }));
  await db.doc("settings/dispatch").update({ p2pFallbackAfterSeconds: 5 });
});
test("server rejects malformed coordinates/time/order and impossible sub-second jumps", async () => {
  const s = await seed(), input = s.input(); await publishCustomerRideLocation(db, "customer", input);
  for (const delta of [{ lat: "24.86" }, { lng: 181 }, { observedAt: null }, { observedAt: Date.now() - 60000 }, { observedAt: Date.now() + 60000 },
    { sequence: 0 }, { accuracyM: 90 }, { lat: 25, sequence: 2, observedAt: input.location.observedAt + 100 }, { assignmentId: "retired" }]) {
    await assert.rejects(publishCustomerRideLocation(db, "customer", s.input({ ...input.location, ...delta })), rejected("invalid-argument"));
  }
});
test("mirror reads current vehicle ownership/session instead of a delayed trigger snapshot", async () => {
  const s = await seed(), now = Date.now();
  const vehicle = { driverId: s.ride.driverId, activeRideId: s.ride.id, trackingSessionId: "tracking_live", trackingSessionStartedAt: Timestamp.fromMillis(now - 1000),
    locationUpdatedAt: Timestamp.fromMillis(now), location: { lat: 24.86, lng: 67.01, observedAt: now, sequence: 5, sessionId: "tracking_live", accuracyM: 10 } };
  await db.doc(`vehicles/${s.ride.vehicleId}`).set(vehicle);
  await mirrorRideLocationTransactional(db, s.ride.vehicleId, { ...vehicle, trackingSessionId: "retired", location: { ...vehicle.location, sessionId: "retired", lat: 26 } }, { reportingConfig: {}, silent: true });
  const read = (await s.ref.get()).data();
  assert.equal(read.driverLocation.sessionId, "tracking_live"); assert.equal(read.driverLocation.lat, 24.86);
  assert.equal(read.driverLocation.rideId, s.ride.id); assert.equal(read.driverLocation.assignmentId, s.ride.assignmentSessionToken);
  assert.equal(read.driverLocation.role, "driver");
  await db.doc(`vehicles/${s.ride.vehicleId}`).update({ driverId: "different_driver" });
  assert.equal((await mirrorRideLocationTransactional(db, s.ride.vehicleId, vehicle, { reportingConfig: {}, silent: true })).reason, "vehicle_mismatch");
});
test("signaling binds server assignment identity; same driver/car reassignment invalidates old offer", async () => {
  const s = await seed();
  const offer = await createRidePeerOffer(db, { rideId: s.ride.id, driverUid: "driver", vehicleId: s.ride.vehicleId,
    assignmentId: s.ride.assignmentSessionToken,
    peerSessionId: "peer_abcdefgh123", trackingSessionId: "tracking_live", offerSdp: "v=0\r\no=- offer\r\n" });
  const stored = (await db.doc(`ridePeerSessions/${s.ride.id}`).get()).data(); assert.equal(stored.assignmentId, s.ride.assignmentSessionToken);
  await s.ref.update({ assignmentSessionToken: "new_assignment_12345" });
  await assert.rejects(createRidePeerOffer(db, { rideId: s.ride.id, driverUid: "driver", vehicleId: s.ride.vehicleId,
    assignmentId: s.ride.assignmentSessionToken, peerSessionId: "peer_old_offer_123", trackingSessionId: "tracking_live", offerSdp: "v=0\r\no=- offer\r\n" }), rejected("failed-precondition"));
  await assert.rejects(publishRidePeerAnswer(db, { rideId: s.ride.id, customerUid: "customer", peerSessionId: offer.sessionId, offerFingerprint: offer.offerFingerprint, answerSdp: "v=0\r\no=- answer\r\n" }), rejected("failed-precondition"));
});

test("real callable HTTP endpoint requires Firebase auth and delivers customer location to assigned driver", async () => {
  const s = await seed();
  const url = `http://127.0.0.1:5107/${projectId}/us-central1/publishCustomerRideLocation`;
  const call = (data, authenticated) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  const denied = await call(s.input(), false); assert.equal(denied.status, 401);
  const response = await call(s.input(), true), payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(payload.result.ok, true);
  assert.ok((await getDoc(doc(client("driver"), s.locationPath))).data().location);
});

test("customer GPS is private: owner/outsider cannot read; terminal and retired assignment access is revoked", async () => {
  const s = await seed();
  // An authorized listener may attach before the first GPS sample exists.
  assert.equal((await assertSucceeds(getDoc(doc(client("driver"), s.locationPath)))).exists(), false);
  await publishCustomerRideLocation(db, "customer", s.input());
  await assertSucceeds(getDoc(doc(client("customer"), s.locationPath)));
  for (const uid of ["owner", "stranger"]) await assertFails(getDoc(doc(client(uid), s.locationPath)));
  for (const uid of ["driver", "customer", "owner"]) await assertFails(updateDoc(doc(client(uid), s.locationPath), { location: s.sample() }));
  await s.ref.update({ assignmentSessionToken: "replacement_assignment_123" });
  await assertFails(getDoc(doc(client("driver"), s.locationPath)));
  await s.ref.update({ assignmentSessionToken: s.ride.assignmentSessionToken, status: "completed" });
  await assertFails(getDoc(doc(client("customer"), s.locationPath)));
  await assertFails(getDoc(doc(client("driver"), s.locationPath)));
});
