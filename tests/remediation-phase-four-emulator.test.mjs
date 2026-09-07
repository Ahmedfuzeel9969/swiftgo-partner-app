import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { rideLocationAssignmentVersion } from "../shared/js/ride-location-contract.mjs";
const require = createRequire(import.meta.url), serverRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = serverRequire("firebase-admin/app");
const { getFirestore, Timestamp } = serverRequire("firebase-admin/firestore");
const { getAuth } = serverRequire("firebase-admin/auth");
const { publishCustomerRideLocation } = require("../functions/customer-location.js");
const { ingestBackgroundDriverLocation, mintBackgroundLocationCredential } = require("../functions/background-location-upload.js");
const { mirrorRideLocationTransactional } = require("../functions/driver-location.js");
const projectId = "demo-remediation-phase4";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8189" || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9196") throw new Error("ISOLATED_PHASE_FOUR_LOOPBACK_REQUIRED");
let env, app, db, serial = 0;
const tokens = {}, client = (uid) => env.authenticatedContext(uid).firestore();
const settings = (patch = {}) => db.doc("settings/dispatch").set({ firebaseLocationFallbackEnabled: true, p2pFallbackAfterSeconds: 5, firebaseFallbackWriteSeconds: 10, ...patch });
async function seed() {
  const id = `phase4_${++serial}`, now = Date.now();
  const ride = { id, userId: "customer", driverId: "driver", vehicleId: `car_${serial}`, ownerId: "owner", status: "accepted",
    assignmentSessionToken: `phase4_assignment_${serial}`, assignedAt: Timestamp.fromMillis(now - 90000) };
  const rideRef = db.doc(`rides/${id}`); await rideRef.set(ride);
  const vehicleRef = db.doc(`vehicles/${ride.vehicleId}`), session = `tracking_${serial}`;
  await vehicleRef.set({ ownerId: "owner", driverId: "driver", activeRideId: id, status: "in_ride", trackingSessionId: session,
    trackingSessionStartedAt: Timestamp.fromMillis(now - 120000), locationUpdatedAt: Timestamp.fromMillis(now - 90000),
    location: { lat: 24.86, lng: 67.01, observedAt: now - 90000, sessionId: session, sequence: 1, accuracyM: 10 } });
  const sample = (seq = 2, stamp = Date.now()) => ({ lat: 24.86, lng: 67.01, observedAt: stamp, sequence: seq, trackingSessionId: session, accuracyM: 10,
    role: "customer", rideId: id, assignmentId: ride.assignmentSessionToken, assignmentVersion: rideLocationAssignmentVersion(ride) });
  const customerInput = (location = sample()) => ({ rideId: id, assignmentSessionToken: ride.assignmentSessionToken, location });
  const customerPath = `rides/${id}/customerLocations/${ride.assignmentSessionToken}`;
  const browserWrite = (seq = 2) => updateDoc(doc(client("driver"), vehicleRef.path), {
    location: { lat: 24.86, lng: 67.01, observedAt: Date.now(), sequence: seq, sessionId: session, accuracyM: 10 }, locationUpdatedAt: serverTimestamp() });
  const nativeInput = (extra = {}) => {
    const credential = mintBackgroundLocationCredential({ driverUid: "driver", rideId: id, vehicleId: ride.vehicleId, trackingSessionId: session,
      assignmentSessionToken: ride.assignmentSessionToken, secret: "local-phase-four-fixture-secret" });
    return { token: credential.token, secret: "local-phase-four-fixture-secret", fix: { ...sample(), sessionId: session }, ...extra };
  };
  return { ride, rideRef, vehicleRef, sample, customerInput, customerPath, browserWrite, nativeInput };
}
const call = async (name, data, uid) => {
  const r = await fetch(`http://127.0.0.1:5109/${projectId}/us-central1/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: r.status, body: await r.json() };
};
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8189, rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.clearFirestore(); app = initializeApp({ projectId }); db = getFirestore(app);
  await db.doc("partners/driver").set({ role: "driver", accountStatus: "active", driverApprovalStatus: "approved" });
  for (const uid of ["customer", "driver", "super", "ordinary"]) {
    const email = `phase4-${uid}@example.test`;
    await getAuth(app).createUser({ uid, email, password: "Local-only-test-123!" });
    if (["super", "ordinary"].includes(uid)) {
      const role = uid === "super" ? "super_admin" : "admin";
      await db.doc(`admin_registry/${uid}`).set({ admin: true, version: 1, role });
      await getAuth(app).setCustomUserClaims(uid, { admin: true, adminVersion: 1, adminRole: role });
    }
    const r = await fetch("http://127.0.0.1:9196/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Local-only-test-123!", returnSecureToken: true }) });
    assert.equal(r.status, 200); tokens[uid] = (await r.json()).idToken;
  }
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test("browser driver write succeeds then server rules block writes faster than admin interval", async () => {
  await settings(); const s = await seed(); await assertSucceeds(s.browserWrite()); await assertFails(s.browserWrite(3));
});
test("admin interval changes immediately affect browser rules, without changing P2P grace", async () => {
  await settings({ firebaseFallbackWriteSeconds: 60 }); const s = await seed();
  await s.vehicleRef.update({ locationUpdatedAt: Timestamp.fromMillis(Date.now() - 5000) }); await assertFails(s.browserWrite());
  await settings({ firebaseFallbackWriteSeconds: 2 }); await assertSucceeds(s.browserWrite());
});
test("browser kill switch and malformed flag cannot be bypassed by session rotation", async () => {
  await settings({ firebaseLocationFallbackEnabled: false }); const s = await seed(); await assertFails(s.browserWrite());
  await assertFails(updateDoc(doc(client("driver"), s.vehicleRef.path), { trackingSessionId: "new_session", trackingSessionStartedAt: serverTimestamp(),
    location: { lat: 24.86, lng: 67.01, sessionId: "new_session" }, locationUpdatedAt: serverTimestamp() }));
  await settings({ firebaseLocationFallbackEnabled: "true" }); await assertFails(s.browserWrite());
});
test("initial grace is enforced by browser rules and both server upload paths", async () => {
  await settings({ p2pFallbackAfterSeconds: 60 }); const s = await seed(); await s.rideRef.update({ assignedAt: Timestamp.now() });
  await assertFails(s.browserWrite());
  assert.equal((await publishCustomerRideLocation(db, "customer", s.customerInput())).reason, "p2p_first_grace");
  assert.equal((await ingestBackgroundDriverLocation(db, s.nativeInput())).reason, "P2P_FIRST_GRACE");
});
test("idle online writes remain available when active-ride location fallback is disabled", async () => {
  await settings({ firebaseLocationFallbackEnabled: false }); const s = await seed();
  await s.vehicleRef.update({ activeRideId: null, status: "online" }); await assertSucceeds(s.browserWrite());
});
test("customer server interval is independent of P2P silence timeout", async () => {
  await settings({ p2pFallbackAfterSeconds: 60, firebaseFallbackWriteSeconds: 2 }); const s = await seed();
  assert.equal((await publishCustomerRideLocation(db, "customer", s.customerInput())).ok, true);
  await db.doc(s.customerPath).update({ updatedAt: Timestamp.fromMillis(Date.now() - 3000) });
  assert.equal((await publishCustomerRideLocation(db, "customer", s.customerInput(s.sample(3, Date.now() + 1)))).ok, true);
});
test("customer server honors current kill switch and leaves no location write", async () => {
  await settings({ firebaseLocationFallbackEnabled: false }); const s = await seed();
  assert.equal((await publishCustomerRideLocation(db, "customer", s.customerInput())).reason, "firebase_disabled");
  assert.equal((await db.doc(s.customerPath).get()).exists, false);
});
test("native upload honors current admin disable without revoking the ride credential", async () => {
  await settings({ firebaseLocationFallbackEnabled: false }); const s = await seed(), input = s.nativeInput();
  assert.equal((await ingestBackgroundDriverLocation(db, input)).reason, "FIREBASE_DISABLED");
  await settings(); assert.equal((await ingestBackgroundDriverLocation(db, input)).accepted, true);
});
test("native force and movement cannot bypass the admin minimum write interval", async () => {
  await settings({ firebaseFallbackWriteSeconds: 60 }); const s = await seed();
  await s.vehicleRef.update({ locationUpdatedAt: Timestamp.fromMillis(Date.now() - 5000) });
  const result = await ingestBackgroundDriverLocation(db, s.nativeInput({ force: true })); assert.equal(result.reason, "CADENCE_SKIP"); assert.equal(result.intervalMs, 60000);
  await settings({ firebaseFallbackWriteSeconds: 2 }); assert.equal((await ingestBackgroundDriverLocation(db, s.nativeInput({ force: true }))).accepted, true);
});
test("mirror re-reads current admin switch; disabled driver locations never reach ride", async () => {
  await settings({ firebaseLocationFallbackEnabled: false }); const s = await seed();
  const result = await mirrorRideLocationTransactional(db, s.ride.vehicleId, {}, { rideId: s.ride.id, reportingConfig: {}, silent: true });
  assert.equal(result.reason, "firebase_disabled"); assert.equal((await s.rideRef.get()).data().driverLocation, undefined);
});
test("real callable rejects unauthenticated and ordinary-admin policy writes", async () => {
  const input = { candidateDriverLimit: 10, firebaseFallbackWriteSeconds: 3 };
  assert.equal((await call("setCandidateDriverLimit", input)).status, 403);
  assert.equal((await call("setCandidateDriverLimit", input, "ordinary")).status, 403);
  assert.equal((await call("setCandidateDriverLimit", input, "customer")).status, 403);
});
test("super admin can save every location field; merge preserves unrelated settings and records audit", async () => {
  await settings({ unrelatedKeep: "kept" });
  const input = { candidateDriverLimit: 10, p2pFallbackAfterSeconds: 17, firebaseFallbackWriteSeconds: 3, firebaseLocationRenderSeconds: 2,
    firebaseHealthyApproachSeconds: 0, firebaseHealthyTripSeconds: 120, customerLocationFallbackSeconds: 90, firebaseLocationFallbackEnabled: true };
  const r = await call("setCandidateDriverLimit", input, "super"); assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = (await db.doc("settings/dispatch").get()).data(); for (const [key, value] of Object.entries(input)) assert.equal(saved[key], value);
  assert.equal(saved.unrelatedKeep, "kept"); const audit = await db.collection("audit_logs").where("action", "==", "admin_settings_saved").get(); assert.ok(audit.size > 0);
});
test("real callable rejects null, numeric strings, fractions and out-of-range controls without modifying settings", async () => {
  await settings(); const before = (await db.doc("settings/dispatch").get()).data();
  for (const patch of [{ p2pFallbackAfterSeconds: 5.9 }, { firebaseFallbackWriteSeconds: "4" }, { firebaseHealthyTripSeconds: 1 }, { firebaseLocationFallbackEnabled: null }, { customerLocationFallbackSeconds: -1 }]) {
    const r = await call("setCandidateDriverLimit", { candidateDriverLimit: 10, ...patch }, "super"); assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.deepEqual((await db.doc("settings/dispatch").get()).data(), before);
});
test("revoked super-admin token immediately loses policy control", async () => {
  await db.doc("admin_registry/super").update({ version: 2 });
  assert.equal((await call("setCandidateDriverLimit", { candidateDriverLimit: 10, firebaseLocationFallbackEnabled: false }, "super")).status, 403);
  await db.doc("admin_registry/super").update({ version: 1 });
});
test("real customer callable reaches only assigned driver, then kill switch stops delivery", async () => {
  await settings(); const s = await seed();
  const r = await call("publishCustomerRideLocation", s.customerInput(), "customer"); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.result.ok, true);
  assert.ok((await assertSucceeds(getDoc(doc(client("driver"), s.customerPath)))).data().location);
  await assertFails(getDoc(doc(client("owner"), s.customerPath)));
  await settings({ firebaseLocationFallbackEnabled: false }); const stopped = await call("publishCustomerRideLocation", s.customerInput(s.sample(3)), "customer");
  assert.equal(stopped.body.result.reason, "firebase_disabled");
});
