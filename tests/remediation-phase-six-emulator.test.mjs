import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes } from "firebase/storage";
import { requirePhaseSixEmulators, PROJECT } from "./helpers/phase-six-safety.mjs";
requirePhaseSixEmulators();
const require = createRequire(import.meta.url), serverRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = serverRequire("firebase-admin/app");
const { getFirestore } = serverRequire("firebase-admin/firestore");
const { getAuth } = serverRequire("firebase-admin/auth");
const { purgeExpiredTransientData, retireTerminalLiveFields, saveRetentionPolicy, runRetentionMaintenance } = require("../functions/data-retention.js");
const { requestAccountDeletion, reviewAccountDeletion } = require("../functions/account-deletion-workflow.js");
const { applyRideLifecycleTimestampStamp } = require("../functions/ride-lifecycle-timestamps.js");
const { issueRideTurnCredentials } = require("../functions/p2p-turn-credentials.js");
const prefix = `phase6_${Date.now()}`, tokens = {}, now = Date.now();
const uid = (name) => `${prefix}_${name}`;
let env, app, db;
const superAuth = { uid: uid("super"), token: { admin: true, adminRole: "super_admin", adminVersion: 1 } };
const ordinaryAuth = { uid: uid("ordinary"), token: { admin: true, adminRole: "admin", adminVersion: 1 } };
const allowed = { expiryEnabled: false, purgeEnabled: true, policyVersion: "synthetic-policy-v1", batchLimit: 25 };
const fakeAuth = { updateUser: async () => {}, revokeRefreshTokens: async () => {} };
async function account(name) {
  const id = uid(name), email = `${id}@example.test`, password = "Synthetic-only-test-123!";
  await getAuth(app).createUser({ uid: id, email, password });
  if (["super", "ordinary"].includes(name)) {
    const token = name === "super" ? superAuth.token : ordinaryAuth.token;
    await getAuth(app).setCustomUserClaims(id, token);
    await db.doc(`admin_registry/${id}`).set({ admin: true, role: token.adminRole, version: 1 });
  }
  await db.doc(`users/${id}`).set({ name: "Synthetic fixture", walletBalance: 0 });
  const r = await fetch("http://127.0.0.1:9194/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  assert.equal(r.status, 200); tokens[name] = (await r.json()).idToken; return id;
}
async function call(name, data, actor) {
  const r = await fetch(`http://127.0.0.1:5110/${PROJECT}/us-central1/${name}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT,
    firestore: { host: "127.0.0.1", port: 8191, rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") },
    storage: { host: "127.0.0.1", port: 9294, rules: await readFile(new URL("../storage.rules", import.meta.url), "utf8") } });
  // No clearFirestore(), global Auth reset or touching the manual preview. All
  // records are synthetic, uniquely named, and confined to this exact project.
  app = initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` }); db = getFirestore(app);
  await account("super"); await account("ordinary");
  await db.doc("settings/dataRetention").set({ expiryEnabled: false, purgeEnabled: false, policyVersion: "", batchLimit: 25 });
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test("super admin policy validation, revocation, private settings and real callable permissions", async () => {
  assert.equal((await call("getPrivacyMaintenanceStatus", {}, null)).status, 403);
  assert.equal((await call("savePrivacyMaintenanceSettings", allowed, "ordinary")).status, 403);
  assert.equal((await call("savePrivacyMaintenanceSettings", { ...allowed, purgeEnabled: "true" }, "super")).status, 400);
  assert.equal((await call("savePrivacyMaintenanceSettings", allowed, "super")).status, 200);
  const status = await call("getPrivacyMaintenanceStatus", {}, "super");
  assert.equal(status.body.result.schedulerExportEnabled, false); assert.equal(status.body.result.erasureExecutorAvailable, false);
  await assertFails(setDoc(doc(env.authenticatedContext(superAuth.uid, superAuth.token).firestore(), "settings/dataRetention"), allowed));
  await assertFails(getDoc(doc(env.authenticatedContext(ordinaryAuth.uid, ordinaryAuth.token).firestore(), "settings/dataRetention")));
  await db.doc(`admin_registry/${superAuth.uid}`).update({ version: 2 });
  await assert.rejects(saveRetentionPolicy(db, superAuth, allowed), /SUPER_ADMIN_ONLY/);
  await db.doc(`admin_registry/${superAuth.uid}`).update({ version: 1 });
});
test("dry run writes nothing; actual purge deletes only due documents and creates coordinate-free atomic proof", async () => {
  const gone = db.doc(`ridePeerSessions/${uid("expired")}`), fresh = db.doc(`ridePeerSessions/${uid("fresh")}`), held = db.doc(`ridePeerSessions/${uid("held")}`);
  await gone.set({ expiresAt: new Date(now - 1000), offer: "PRIVATE_SDP", lat: 24.86 });
  await fresh.set({ expiresAt: new Date(now + 3600000) }); await held.set({ expiresAt: new Date(now - 1000), legalHold: true });
  const beforeProof = (await db.collection("retention_events").get()).size;
  const preview = await purgeExpiredTransientData(db, { nowMs: now, groups: ["ridePeerSessions"] });
  assert.equal(preview.eligible, 1); assert.equal(preview.deleted, 0); assert.equal((await gone.get()).exists, true);
  assert.equal((await db.collection("retention_events").get()).size, beforeProof);
  await assert.rejects(purgeExpiredTransientData(db, { dryRun: false, groups: ["ridePeerSessions"] }), /PURGE_NOT_APPROVED/);
  const r = await purgeExpiredTransientData(db, { dryRun: false, allowMutation: true, nowMs: now, groups: ["ridePeerSessions"] });
  assert.equal(r.deleted, 1); assert.equal((await gone.get()).exists, false); assert.equal((await fresh.get()).exists, true); assert.equal((await held.get()).exists, true);
  const proof = (await db.collection("retention_events").get()).docs.map((d) => d.data());
  assert.equal(JSON.stringify(proof).includes("PRIVATE_SDP"), false); assert.equal(JSON.stringify(proof).includes("24.86"), false);
});
test("active, unknown and held ride telemetry survive while terminal eligible reports retire", async () => {
  for (const [name, status, hold] of [["active", "in_progress", false], ["done", "completed", false], ["hold", "completed", true]]) {
    await db.doc(`rides/${uid(name)}`).set({ status, legalHold: hold, farePkr: 123 });
    await db.doc(`rideLocationReports/${uid(name)}`).set({ expiresAt: new Date(now - 1) });
  }
  await db.doc(`rideLocationReports/${uid("unknown")}`).set({ expiresAt: new Date(now - 1) });
  const r = await purgeExpiredTransientData(db, { dryRun: false, allowMutation: true, nowMs: now, groups: ["rideLocationReports"] });
  assert.equal(r.deleted, 1); assert.equal((await db.doc(`rideLocationReports/${uid("done")}`).get()).exists, false);
  for (const name of ["active", "hold", "unknown"]) assert.equal((await db.doc(`rideLocationReports/${uid(name)}`).get()).exists, true);
  assert.equal((await db.doc(`rides/${uid("done")}`).get()).data().farePkr, 123);
});
test("collection-group cleanup refuses a same-named subcollection under an unrelated parent", async () => {
  const good = db.doc(`rides/${uid("r")}/customerLocations/a`), bad = db.doc(`unrelated/${uid("r")}/customerLocations/a`);
  await good.set({ expiresAt: new Date(now - 1) }); await bad.set({ expiresAt: new Date(now - 1) });
  const r = await purgeExpiredTransientData(db, { dryRun: false, allowMutation: true, nowMs: now, groups: ["customerLocations"] });
  assert.equal(r.deleted, 1); assert.equal((await bad.get()).exists, true);
});
test("purge re-reads a refreshed lease inside its delete transaction", async () => {
  const ticket = db.doc(`driver_upload_tickets/${uid("refresh")}`); await ticket.set({ expiresAt: new Date(now - 1) });
  const wrapped = { doc: db.doc.bind(db), collection: db.collection.bind(db), collectionGroup: db.collectionGroup.bind(db),
    runTransaction: async (worker) => { await ticket.update({ expiresAt: new Date(now + 3600000) }); return db.runTransaction(worker); } };
  const r = await purgeExpiredTransientData(wrapped, { dryRun: false, allowMutation: true, nowMs: now, groups: ["driver_upload_tickets"] });
  assert.equal(r.deleted, 0); assert.equal((await ticket.get()).exists, true);
});
test("held first page does not starve later expired records", async () => {
  const held = db.doc(`security_rate_limits/${uid("cursor-held")}`), due = db.doc(`security_rate_limits/${uid("cursor-due")}`);
  await held.set({ expiresAt: new Date(now - 1000), legalHold: true }); await due.set({ expiresAt: new Date(now - 1) });
  const options = { dryRun: false, allowMutation: true, nowMs: now, limit: 1, groups: ["security_rate_limits"] };
  assert.equal((await purgeExpiredTransientData(db, options)).deleted, 0);
  assert.equal((await purgeExpiredTransientData(db, options)).deleted, 1);
  assert.equal((await held.get()).exists, true); assert.equal((await due.get()).exists, false);
});
test("terminal field retirement preserves fare, pickup and measured aggregate; active ride is untouched", async () => {
  const rideRef = db.doc(`rides/${uid("scrub")}`), activeRef = db.doc(`rides/${uid("scrub-active")}`);
  const base = { farePkr: 500, pickupLocation: { lat: 1, lng: 2 }, driverLocation: { lat: 3, lng: 4 }, lastTrackedLocation: { lat: 3, lng: 4 }, liveLocationRetireAt: new Date(now - 1) };
  await rideRef.set({ ...base, status: "completed" }); await activeRef.set({ ...base, status: "in_progress" });
  const tel = db.doc(`rideBreadcrumbTelemetry/${uid("scrub")}`); await tel.set({ denseChordDistanceMeters: 1234, lastAcceptedRawPoint: { lat: 3, lng: 4 } });
  const r = await retireTerminalLiveFields(db, { nowMs: now, dryRun: false, allowMutation: true }); assert.equal(r.retired, 1);
  const data = (await rideRef.get()).data(); assert.equal(data.driverLocation, undefined); assert.equal(data.farePkr, 500); assert.deepEqual(data.pickupLocation, base.pickupLocation);
  assert.equal((await tel.get()).data().denseChordDistanceMeters, 1234); assert.equal((await tel.get()).data().lastAcceptedRawPoint, undefined);
  assert.deepEqual((await activeRef.get()).data().driverLocation, base.driverLocation);
});
test("overlapping scheduled maintenance loses the lease and cannot run twice", async () => {
  await db.doc("maintenance_leases/retention").set({ runId: "another-synthetic-run", expiresAt: new Date(now + 60000) });
  const r = await runRetentionMaintenance(db, { allowMutation: true, nowMs: now }); assert.equal(r.reason, "RUN_IN_PROGRESS");
});
test("terminal field cursor advances past a legal hold without changing that ride", async () => {
  const held = db.doc(`rides/${uid("fields-held")}`), due = db.doc(`rides/${uid("fields-due")}`);
  const location = { lat: 1, lng: 2 };
  await held.set({ status: "completed", legalHold: true, liveLocationRetireAt: new Date(now - 2000), driverLocation: location });
  await due.set({ status: "completed", liveLocationRetireAt: new Date(now - 1000), driverLocation: location });
  await db.doc("settings/dataRetention").set({ ...allowed, batchLimit: 1 });
  const options = { nowMs: now, dryRun: false, allowMutation: true };
  try {
    assert.equal((await retireTerminalLiveFields(db, options)).retired, 0);
    assert.equal((await retireTerminalLiveFields(db, options)).retired, 1);
    assert.deepEqual((await held.get()).data().driverLocation, location);
    assert.equal((await due.get()).data().driverLocation, undefined);
  } finally { await db.doc("settings/dataRetention").set(allowed); }
});
test("opt-in scheduled expiry closes only overdue search and offer; preserves active rides and releases lease", async () => {
  const due = db.doc(`rides/${uid("expire-search")}`), fresh = db.doc(`rides/${uid("fresh-search")}`), active = db.doc(`rides/${uid("assigned-search")}`);
  await due.set({ status: "searching_driver", userId: uid("waiting"), expiresAt: new Date(now - 1000), farePkr: 345 });
  await fresh.set({ status: "searching_driver", expiresAt: new Date(now + 3600000) });
  await active.set({ status: "accepted", driverId: "synthetic-driver", expiresAt: new Date(now - 1000) });
  const offer = db.doc(`ride_offers/${uid("expire-offer")}`), freshOffer = db.doc(`ride_offers/${uid("fresh-offer")}`);
  await offer.set({ status: "open", offerExpiresAt: new Date(now - 1000) });
  await freshOffer.set({ status: "open", offerExpiresAt: new Date(now + 3600000) });
  const lease = db.doc("maintenance_leases/retention"); await lease.set({ expiresAt: new Date(0) });
  await db.doc("settings/dataRetention").set({ ...allowed, purgeEnabled: false, expiryEnabled: false });
  try {
    assert.equal((await runRetentionMaintenance(db, { allowMutation: true, nowMs: now })).reason, "POLICY_NOT_ENABLED");
    assert.equal((await due.get()).data().status, "searching_driver");
    await db.doc("settings/dataRetention").update({ expiryEnabled: true });
    const result = await runRetentionMaintenance(db, { allowMutation: true, nowMs: now });
    assert.equal(result.searches.expired, 1); assert.equal(result.searches.failed, 0);
    assert.equal(result.offers.expired, 1); assert.equal(result.offers.failed, 0); assert.equal(result.purge, undefined);
    assert.equal((await due.get()).data().status, "expired"); assert.equal((await due.get()).data().farePkr, 345);
    assert.equal((await fresh.get()).data().status, "searching_driver"); assert.equal((await active.get()).data().status, "accepted");
    assert.equal((await offer.get()).data().status, "expired"); assert.equal((await freshOffer.get()).data().status, "open");
    assert.equal((await lease.get()).data().expiresAt.toMillis(), 0);
  } finally { await db.doc("settings/dataRetention").set(allowed); }
});
for (const role of ["userId", "driverId", "ownerId"]) test(`deletion refuses active ride for ${role} before touching login`, async () => {
  const id = uid(`active-${role}`); await db.doc(`users/${id}`).set({ walletBalance: 0 });
  await db.doc(`rides/${id}`).set({ status: "accepted", [role]: id });
  await assert.rejects(requestAccountDeletion(db, { uid: id }, { auth: fakeAuth }), /ACCOUNT_HAS_ACTIVE_RIDE/);
  assert.equal((await db.doc(`account_deletion_requests/${id}`).get()).exists, false);
});
test("failed Auth blocking is explicit; old token loses app access; admin retry repairs it without duplicate request", async () => {
  const id = await account("requester"); const ledger = db.doc(`ledger_transactions/${id}`); await ledger.set({ amount: 456, ownerId: id });
  const first = await requestAccountDeletion(db, { uid: id, email: "do-not-duplicate@example.test" }, { auth: { updateUser: async () => { throw new Error("synthetic outage"); } } });
  assert.equal(first.authBlockStatus, "retry_required"); assert.equal(first.erasureCompleted, false);
  const client = env.authenticatedContext(id).firestore();
  await assertFails(getDoc(doc(client, `users/${id}`))); await assertSucceeds(getDoc(doc(client, `account_deletion_requests/${id}`)));
  assert.equal((await call("getDispatchSettings", {}, "requester")).status, 403);
  assert.equal((await call("retryDeletionAuthBlock", { uid: id }, "ordinary")).status, 403);
  assert.equal((await call("retryDeletionAuthBlock", { uid: id }, "super")).status, 200);
  assert.equal((await getAuth(app).getUser(id)).disabled, true);
  const retry = await requestAccountDeletion(db, { uid: id }, { auth: getAuth(app) }); assert.equal(retry.alreadyRequested, true);
  const saved = (await db.doc(`account_deletion_requests/${id}`).get()).data(); assert.equal(saved.email, undefined);
  const audits = await db.collection("audit_logs").where("type", "==", "account_deletion_requested").where("uid", "==", id).get(); assert.equal(audits.size, 1);
  assert.deepEqual((await ledger.get()).data(), { amount: 456, ownerId: id });
});
test("deletion review exposes obligations but never claims erased or changes money", async () => {
  const id = uid("review"); await db.doc(`partners/${id}`).set({ walletBalance: 700, role: "owner", accountStatus: "active" });
  await db.doc(`vehicles/${id}`).set({ ownerId: id }); await requestAccountDeletion(db, { uid: id }, { auth: fakeAuth });
  await assert.rejects(reviewAccountDeletion(db, ordinaryAuth, { uid: id, policyVersion: "test-policy" }), /SUPER_ADMIN_ONLY/);
  const r = await reviewAccountDeletion(db, superAuth, { uid: id, policyVersion: "test-policy" });
  assert.equal(r.erasureCompleted, false); assert.ok(r.blockers.includes("fleet_ownership") && r.blockers.includes("financial_balance"));
  assert.equal((await db.doc(`partners/${id}`).get()).data().walletBalance, 700);
});
test("privileged operator must hand over admin authority before requesting deletion", async () => {
  await assert.rejects(requestAccountDeletion(db, { uid: superAuth.uid }, { auth: fakeAuth }), /ADMIN_HANDOVER_REQUIRED/);
});
test("Storage old credentials cannot read or upload proofs after deletion is pending", async () => {
  const id = uid("proof"), owner = env.authenticatedContext(id).storage();
  await db.doc(`driver_upload_tickets/${id}`).set({ ticketId: "testticket", used: false, expiresAt: new Date(now + 3600000) });
  const file = `driver_applications/${id}/testticket_selfie`;
  await assertSucceeds(uploadBytes(ref(owner, file), new Uint8Array([255,216,255,217]), { contentType: "image/jpeg" }));
  await assertSucceeds(getBytes(ref(owner, file)));
  await db.doc(`account_deletion_requests/${id}`).set({ accessBlocked: true, status: "pending_review" });
  await assertFails(getBytes(ref(owner, file)));
  await assertFails(uploadBytes(ref(owner, `driver_applications/${id}/testticket_license`), new Uint8Array([255,216,255,217]), { contentType: "image/jpeg" }));
  await assertSucceeds(getBytes(ref(env.authenticatedContext(superAuth.uid, superAuth.token).storage(), file)));
});
test("late lifecycle delivery cannot stamp a new ride state; terminal stamping is idempotent", async () => {
  const id = uid("lifecycle"), ref = db.doc(`rides/${id}`); await ref.set({ status: "completed" });
  const first = await applyRideLifecycleTimestampStamp(db, id, { status: "in_progress" }, { status: "completed" }); assert.equal(first.stamped, true);
  const before = (await ref.get()).data().closedAt.toMillis();
  await applyRideLifecycleTimestampStamp(db, id, { status: "in_progress" }, { status: "completed" }); assert.equal((await ref.get()).data().closedAt.toMillis(), before);
  await ref.update({ status: "searching_driver" });
  assert.equal((await applyRideLifecycleTimestampStamp(db, id, { status: "accepted" }, { status: "in_progress" })).stamped, false);
});
test("TURN result after ride termination is not returned; issuance metadata has bounded expiry", async () => {
  const id = uid("turn"), ref = db.doc(`rides/${id}`);
  await ref.set({ userId: "c", driverId: "d", vehicleId: "v", status: "accepted", assignmentSessionToken: "assignment" });
  await assert.rejects(issueRideTurnCredentials(db, { uid: "d", rideId: id, assignmentId: "assignment" }, {
    enabled: true, config: { provider: "cloudflare", keyId: "synthetic-key", apiToken: "synthetic-only-token", ttlSec: 3600 },
    fetchFn: async () => { await ref.update({ status: "completed" }); return { ok: true, json: async () => ({ iceServers: [{ urls: ["turn:relay.example.test:3478"], username: "fixture", credential: "fixture" }] }) }; },
  }), /STALE_ASSIGNMENT/);
  const rows = await ref.collection("peerCredentialIssues").get(); assert.equal(rows.size, 1); assert.ok(rows.docs[0].data().expiresAt.toMillis() > now);
});
