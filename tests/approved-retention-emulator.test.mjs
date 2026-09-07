import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { requirePhaseSixEmulators, PROJECT } from "./helpers/phase-six-safety.mjs";
requirePhaseSixEmulators();
const require = createRequire(import.meta.url), serverRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = serverRequire("firebase-admin/app");
const { getFirestore } = serverRequire("firebase-admin/firestore");
const { getAuth } = serverRequire("firebase-admin/auth");
const { getStorage } = serverRequire("firebase-admin/storage");
const { POLICY, DAY } = require("../functions/retention-policy.js");
const { requestAccountDeletion, reviewAccountDeletion } = require("../functions/account-deletion-workflow.js");
const { inspectAccountDisposition, executeAccountDispositionPage, SCOPES } = require("../functions/account-disposition.js");
const { disposeIdentityRecord } = require("../functions/identity-disposition.js");
const { previewFinancialRetention, setRetentionLegalHold } = require("../functions/retention-admin.js");
const { beginDriverVerification } = require("../functions/driver-verification.js");
const { requestOwnerAccess, rejectOwnerAccess } = require("../functions/owner-onboarding.js");
const { submitSupportReport } = require("../functions/account-deletion.js");
const { approveRechargeRequest } = require("../functions/recharge.js");
const now = Date.now(), prefix = `approved_${now}`, uid = (name) => `${prefix}_${name}`;
const admin = { uid: uid("super"), token: { admin: true, adminRole: "super_admin", adminVersion: 1 } };
const ordinary = { uid: uid("ordinary"), token: { admin: true, adminRole: "admin", adminVersion: 1 } };
const allowed = { expiryEnabled: false, purgeEnabled: true, policyVersion: POLICY.version, batchLimit: 2 };
let app, db, bucket, env, token;
const fakeAuth = { updateUser: async () => {}, revokeRefreshTokens: async () => {} };
async function requested(name, days = 31, profile = {}) {
  const id = uid(name); await db.doc(`users/${id}`).set({ name: "Private Test", email: "private@example.test", walletBalance: 0, ...profile });
  await requestAccountDeletion(db, { uid: id }, { nowMs: now - days * DAY, auth: fakeAuth });
  await reviewAccountDeletion(db, admin, { uid: id, policyVersion: POLICY.version });
  return id;
}
const execute = (id, extra = {}) => executeAccountDispositionPage(db, admin, { uid: id, confirm: POLICY.version },
  { allowMutation: true, nowMs: now, authService: getAuth(app), ...extra });
async function identity(name, status = "rejected", days = 91, collection = "driver_applications") {
  const id = uid(name), ticketId = `ticket_${name}`, proofs = {};
  for (const key of ["cnicFront", "cnicBack", "license", "selfie"]) {
    const path = `driver_applications/${id}/${ticketId}_${key}`, file = bucket.file(path);
    await file.save(Buffer.from(`synthetic-${name}-${key}`), { contentType: "image/png", resumable: false });
    const [meta] = await file.getMetadata(); proofs[key] = { path, generation: String(meta.generation) };
  }
  await db.doc(`partners/${id}`).set({ role: "driver", accountStatus: "active", driverApprovalStatus: status, walletBalance: 0 });
  const key = collection === "driver_application_history" ? `${id}_${ticketId}` : id;
  await db.doc(`${collection}/${key}`).set({ userId: id, ticketId, status, fullName: "Private", cnic: "synthetic",
    reviewedAt: new Date(now - days * DAY), proofs });
  return { id, key, proofs, input: { collection, id: key, confirm: POLICY.version } };
}
const dispose = (input, extra = {}) => disposeIdentityRecord(db, admin, input, { dryRun: false, allowMutation: true, nowMs: now, bucket, ...extra });
async function call(name, data) {
  const r = await fetch(`http://127.0.0.1:5110/${PROJECT}/us-central1/${name}`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: "127.0.0.1", port: 8191,
    rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
  app = initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` }); db = getFirestore(app); bucket = getStorage(app).bucket();
  for (const actor of [admin, ordinary]) await db.doc(`admin_registry/${actor.uid}`).set({ admin: true, role: actor.token.adminRole, version: 1 });
  const email = `${admin.uid}@example.test`, password = "Synthetic-Only-123!";
  await getAuth(app).createUser({ uid: admin.uid, email, password }); await getAuth(app).setCustomUserClaims(admin.uid, admin.token);
  const r = await fetch("http://127.0.0.1:9194/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  token = (await r.json()).idToken; assert.ok(token);
  await db.doc("settings/dataRetention").set(allowed);
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test("real callables keep destructive execution disabled and previews super-admin-only", async () => {
  const status = await call("getPrivacyMaintenanceStatus", {}); assert.equal(status.status, 200);
  assert.equal(status.body.result.approvedPolicy.version, POLICY.version); assert.equal(status.body.result.erasureExecutorAvailable, false);
  assert.equal((await call("executeAccountDispositionPage", { uid: uid("unknown"), confirm: POLICY.version })).status, 400);
  assert.equal((await call("executeIdentityDisposition", { collection: "driver_applications", id: "x", confirm: POLICY.version })).status, 400);
  await assert.rejects(previewFinancialRetention(db, ordinary), /SUPER_ADMIN_ONLY/);
});
test("request anchors do not extend on retry; approved review no longer has permanent policy blocker", async () => {
  const id = await requested("anchors"), ref = db.doc(`account_deletion_requests/${id}`), first = (await ref.get()).data();
  assert.deepEqual(first.reviewBlockers, []); assert.equal(first.retentionPolicyVersion, POLICY.version);
  await requestAccountDeletion(db, { uid: id }, { nowMs: now, auth: fakeAuth }); const last = (await ref.get()).data();
  assert.equal(last.personalDataDueAt.toMillis(), first.personalDataDueAt.toMillis());
  assert.equal(last.accountClosedAt.toMillis(), now - 31 * DAY);
});
test("thirty-day minimum and corrupted short deadline cannot be bypassed", async () => {
  const id = await requested("early", 2);
  await db.doc(`account_deletion_requests/${id}`).update({ personalDataDueAt: new Date(now - DAY) });
  await assert.rejects(execute(id), /PERSONAL_PERIOD_NOT_DUE/);
  assert.equal((await db.doc(`users/${id}`).get()).data().name, "Private Test");
});
test("preview is read-only and zero balance/fleet/legal/support blockers are independently enforced", async () => {
  const id = await requested("blockers", 31, { walletBalance: -50 });
  await db.doc(`vehicles/${id}`).set({ driverId: id });
  await db.doc(`support_reports/${id}`).set({ uid: id, status: "open" });
  await setRetentionLegalHold(db, admin, { collection: "account_deletion_requests", id, hold: true, reasonCode: "legal_proceeding" });
  const before = (await db.doc(`account_deletion_requests/${id}`).get()).updateTime.toMillis();
  const preview = await inspectAccountDisposition(db, admin, id, { nowMs: now });
  for (const blocker of ["financial_balance", "vehicle_assignment", "support_evidence_review", "legal_hold"]) assert.ok(preview.blockers.includes(blocker));
  assert.equal((await db.doc(`account_deletion_requests/${id}`).get()).updateTime.toMillis(), before);
  await assert.rejects(execute(id), /DELETION_BLOCKED/);
});
test("legacy current/scheduled bookings block closure before Auth changes", async () => {
  for (const status of ["current", "scheduled"]) {
    const id = uid(status); await db.doc(`bookings/${id}`).set({ userId: id, status });
    await assert.rejects(requestAccountDeletion(db, { uid: id }, { auth: { updateUser() { throw new Error("AUTH_MUST_NOT_RUN"); } } }), /ACCOUNT_HAS_ACTIVE_RIDE/);
  }
});
test("bounded resumable erasure deletes real Auth, removes own contact copies, preserves other participants and money", async () => {
  const id = await requested("complete"); await getAuth(app).createUser({ uid: id, email: `${id}@example.test` });
  await db.doc(`partners/${id}`).set({ accountStatus: "deletion_pending", name: "Private", walletBalance: 0, totalEarnings: 1200 });
  await db.doc(`ledger_transactions/${id}`).set({ customerId: id, grossFare: 100, createdAt: new Date(now) });
  for (let i = 0; i < 5; i++) await db.doc(`rides/${id}_${i}`).set({ userId: id, status: "completed", customerName: "Remove", driverName: "Keep", farePkr: 100, pickupLocation: { lat: 1, lng: 1 } });
  await db.doc(`support_reports/${id}`).set({ uid: id, status: "resolved", email: "remove", message: "remove" });
  let r, pages = 0;
  do { r = await execute(id); pages++; assert.ok((r.processed || 0) <= 2); assert.ok(pages < 30); } while (r.more);
  assert.ok(pages > SCOPES.length + 2); assert.equal(r.personalDataErased, true); assert.equal(r.erasureCompleted, false);
  await assert.rejects(getAuth(app).getUser(id), (e) => e.code === "auth/user-not-found");
  assert.equal((await db.doc(`users/${id}`).get()).data().name, undefined);
  assert.equal((await db.doc(`partners/${id}`).get()).data().totalEarnings, 1200);
  const ride = (await db.doc(`rides/${id}_0`).get()).data(); assert.equal(ride.customerName, undefined); assert.equal(ride.driverName, "Keep"); assert.equal(ride.farePkr, 100);
  assert.ok(ride.pickupLocation); assert.equal((await db.doc(`ledger_transactions/${id}`).get()).data().grossFare, 100);
  assert.equal((await db.doc(`support_reports/${id}`).get()).data().message, undefined);
  assert.equal((await execute(id)).idempotent, true);
});
test("Auth failure is retryable and never marked complete", async () => {
  const id = await requested("auth_failure");
  await db.doc(`account_deletion_requests/${id}`).update({ erasureStep: SCOPES.length + 1 });
  await assert.rejects(execute(id, { authService: { deleteUser: async () => { throw new Error("outage"); } } }), /AUTH_ERASURE_RETRY_REQUIRED/);
  const state = (await db.doc(`account_deletion_requests/${id}`).get()).data(); assert.notEqual(state.personalDataErased, true); assert.equal(state.erasureStep, SCOPES.length + 1);
  assert.equal(state.lastErasureError, "RETRY_OR_REVIEW_REQUIRED"); assert.equal((await execute(id)).personalDataErased, true);
});
test("policy changes, expired admin claims and concurrent leases stop erasure", async () => {
  const id = await requested("gates");
  await db.doc("settings/dataRetention").update({ policyVersion: "other" }); await assert.rejects(execute(id), /APPROVED_RETENTION_POLICY_REQUIRED/);
  await db.doc("settings/dataRetention").set(allowed);
  await db.doc(`admin_registry/${admin.uid}`).update({ version: 2 }); await assert.rejects(execute(id), /SUPER_ADMIN_ONLY/);
  await db.doc(`admin_registry/${admin.uid}`).update({ version: 1 });
  await db.doc(`account_deletion_requests/${id}`).update({ erasureLeaseUntil: new Date(now + 60000) }); await assert.rejects(execute(id), /ERASURE_RUN_IN_PROGRESS/);
});
test("ninety-day identity preview/hold protect files; due exact-generation deletion is idempotent", async () => {
  const item = await identity("identity"); const ref = db.doc(`driver_applications/${item.id}`);
  const before = (await ref.get()).updateTime.toMillis();
  const preview = await disposeIdentityRecord(db, admin, item.input, { nowMs: now }); assert.equal(preview.eligible, true);
  assert.equal((await ref.get()).updateTime.toMillis(), before);
  await setRetentionLegalHold(db, admin, { collection: "driver_applications", id: item.id, hold: true, reasonCode: "accident" });
  assert.ok((await dispose(item.input)).blockers.includes("identity_legal_hold"));
  await setRetentionLegalHold(db, admin, { collection: "driver_applications", id: item.id, hold: false, reasonCode: "review_resolved" });
  assert.equal((await dispose(item.input)).completed, true); assert.equal((await ref.get()).exists, false);
  for (const proof of Object.values(item.proofs)) assert.equal((await bucket.file(proof.path).exists())[0], false);
  assert.equal((await dispose(item.input)).completed, true);
});
test("accepted identity survives before one-year closure deadline and then retires", async () => {
  const item = await identity("approved", "approved", 800);
  assert.ok((await dispose(item.input)).blockers.includes("identity_date_or_status_review"));
  await requested("approved", 100); assert.ok((await dispose(item.input)).blockers.includes("identity_period_not_due"));
  const nextYear = now + 400 * DAY;
  assert.equal((await dispose(item.input, { nowMs: nextYear })).completed, true);
});
test("Storage outage fences resubmission, records retry and resumes missing files safely", async () => {
  const item = await identity("retry"); let calls = 0;
  const failing = { file(path) { const file = bucket.file(path); return { getMetadata: () => file.getMetadata(), delete: async (options) => {
    if (++calls === 2) throw new Error("synthetic storage outage"); return file.delete(options);
  } }; } };
  await assert.rejects(dispose(item.input, { bucket: failing }), /IDENTITY_OBJECT_RETRY_OR_REVIEW_REQUIRED/);
  assert.equal((await db.doc(`driver_applications/${item.id}`).get()).data().identityErasurePending, true);
  await assert.rejects(beginDriverVerification(db, item.id), /IDENTITY_ERASURE_IN_PROGRESS/);
  assert.equal((await dispose(item.input)).completed, true);
});
test("changed object generation is preserved, never falsely reported erased", async () => {
  const item = await identity("changed"), proof = item.proofs.cnicFront;
  await bucket.file(proof.path).save(Buffer.from("new-generation-do-not-delete"), { resumable: false, contentType: "image/png" });
  await assert.rejects(dispose(item.input), /IDENTITY_OBJECT_RETRY_OR_REVIEW_REQUIRED/);
  assert.equal((await bucket.file(proof.path).exists())[0], true);
  assert.equal((await db.doc(`driver_applications/${item.id}`).get()).exists, true);
});
test("old rejected history retires without deleting new current application", async () => {
  const item = await identity("history", "rejected", 91, "driver_application_history");
  await db.doc(`driver_applications/${item.id}`).set({ userId: item.id, status: "pending", ticketId: "new-ticket" });
  assert.equal((await dispose(item.input)).completed, true);
  assert.equal((await db.doc(`driver_applications/${item.id}`).get()).data().ticketId, "new-ticket");
});
test("history cannot remove proof still referenced by the current identity", async () => {
  const item = await identity("shared_reference", "rejected", 91, "driver_application_history");
  await db.doc(`driver_applications/${item.id}`).set({ userId: item.id, status: "approved", ticketId: "ticket_shared_reference", proofs: item.proofs });
  assert.ok((await dispose(item.input)).blockers.includes("identity_still_referenced"));
  assert.equal((await bucket.file(item.proofs.cnicFront.path).exists())[0], true);
});
test("a hold added between pages stops further erasure; releasing it permits resumption", async () => {
  const id = await requested("later_hold"); await execute(id);
  await db.doc(`rides/${id}`).set({ userId: id, status: "completed", customerName: "Still present" });
  await setRetentionLegalHold(db, admin, { collection: "rides", id, hold: true, reasonCode: "accident" });
  await assert.rejects(execute(id), /DELETION_BLOCKED/);
  assert.equal((await db.doc(`rides/${id}`).get()).data().customerName, "Still present");
  await setRetentionLegalHold(db, admin, { collection: "rides", id, hold: false, reasonCode: "review_resolved" });
  await execute(id); assert.equal((await db.doc(`rides/${id}`).get()).data().customerName, undefined);
});
test("hold arriving after first Storage deletion stops remaining proofs and exposes partial work", async () => {
  const item = await identity("late_identity_hold"); let calls = 0;
  const wrapped = { file(path) { const file = bucket.file(path); return { getMetadata: () => file.getMetadata(), delete: async (options) => {
    await file.delete(options); if (++calls === 1) await db.doc(`driver_applications/${item.id}`).update({ legalHold: true });
  } }; } };
  await assert.rejects(dispose(item.input, { bucket: wrapped }), /IDENTITY_CHANGED_OR_HELD/);
  assert.equal((await bucket.file(item.proofs.cnicBack.path).exists())[0], true);
  assert.equal((await db.doc(`driver_applications/${item.id}`).get()).data().identityErasurePending, true);
});
test("owner reapplication clears prior expiry, rejection has 90-day metadata, and erasure fence blocks replacement", async () => {
  const id = uid("owner"), actor = { uid: id, token: { email: `${id}@example.test` } };
  await requestOwnerAccess(db, actor, { fullName: "Synthetic Owner" });
  await rejectOwnerAccess(db, admin, { targetUid: id, reason: "Synthetic rejection" });
  const ref = db.doc(`owner_applications/${id}`); assert.equal((await ref.get()).data().retentionPolicyVersion, POLICY.version);
  assert.ok((await ref.get()).data().identityDueAt.toMillis() > now + 89 * DAY);
  await requestOwnerAccess(db, actor, { fullName: "Synthetic Owner" }); assert.equal((await ref.get()).data().identityDueAt, undefined);
  await ref.update({ status: "rejected", rejectedAt: new Date(now - 91 * DAY), identityErasurePending: true });
  await assert.rejects(requestOwnerAccess(db, actor, { fullName: "Replacement" }), /IDENTITY_ERASURE_IN_PROGRESS/);
  assert.equal((await dispose({ collection: "owner_applications", id, confirm: POLICY.version })).completed, true);
});
test("financial metadata is stamped atomically, repeated approval does not extend it, expired ledgers only enter review", async () => {
  const id = uid("recharge"); await db.doc(`partners/${id}`).set({ walletBalance: -10, accountStatus: "active" });
  await db.doc(`rechargeRequests/${id}`).set({ driverId: id, status: "pending", method: "jazzcash", amount: 10, tid: id.replaceAll("_", "-") });
  await approveRechargeRequest(db, admin, id); const ledgerRef = db.doc(`ledger_transactions/recharge_${id}`), before = (await ledgerRef.get()).data();
  assert.equal(before.retentionPolicyVersion, POLICY.version); assert.ok(before.retainFinancialUntil.toMillis() > now + 10 * 365 * DAY);
  await approveRechargeRequest(db, admin, id); assert.equal((await ledgerRef.get()).data().retainFinancialUntil.toMillis(), before.retainFinancialUntil.toMillis());
  const preview = await previewFinancialRetention(db, admin, {}, { nowMs: now + 20 * 365 * DAY }); assert.equal(preview.deleted, 0);
  assert.equal((await ledgerRef.get()).exists, true);
});
test("complaint holds both participants' ride evidence and cannot target an unrelated ride", async () => {
  const id = uid("complaint"), customer = uid("complainant"), driver = uid("complained_driver");
  await db.doc(`rides/${id}`).set({ userId: customer, driverId: driver, status: "completed" });
  await assert.rejects(submitSupportReport(db, { uid: uid("outsider"), rideId: id, message: "Synthetic complaint" }), /SUPPORT_RIDE_PARTICIPANT_REQUIRED/);
  await submitSupportReport(db, { uid: customer, rideId: id, message: "Synthetic complaint" });
  assert.equal((await db.doc(`rides/${id}`).get()).data().legalHold, true);
  await requested("complained_driver"); assert.ok((await inspectAccountDisposition(db, admin, driver)).blockers.includes("legal_hold"));
});
test("rules prevent self-removal of legal holds, completed legacy financial history and private job access", async () => {
  const id = uid("rules"), client = env.authenticatedContext(id).firestore();
  await db.doc(`users/${id}`).set({ displayName: "Test", email: "test@example.test", walletBalance: 0, legalHold: true });
  await assertFails(updateDoc(doc(client, `users/${id}`), { legalHold: false }));
  await db.doc(`bookings/${id}`).set({ userId: id, status: "completed", service: "ride", fare: 12, pickup: "a", destination: "b" });
  await assertFails(deleteDoc(doc(client, `bookings/${id}`)));
  await assertFails(updateDoc(doc(client, `bookings/${id}`), { status: "scheduled" }));
  await assertFails(getDoc(doc(client, `identity_erasure_jobs/${id}`)));
  await assertFails(setDoc(doc(env.authenticatedContext(admin.uid, admin.token).firestore(), `identity_erasure_jobs/${id}`), { status: "completed" }));
});
