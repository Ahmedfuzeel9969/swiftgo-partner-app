"use strict";
const { FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { assertAdminInTransaction } = require("./admin-claims");
const { documentId, fail } = require("./security-policy");
const { POLICY, closureRetention, millis, clock } = require("./retention-policy");
const ACTIVE = ["searching_driver", "accepted", "arrived", "in_progress"];
const RETAINED = ["ledger_transactions", "audit_logs", "settled_rides_and_fares", "recharge_and_settlement_records"];

async function assertAccountAccessAllowed(db, uid) {
  if (!uid) return;
  const request = (await db.doc(`account_deletion_requests/${documentId(uid, "UID")}`).get()).data();
  if (request?.accessBlocked === true || ["pending", "pending_review", "reviewed", "erasure_in_progress", "completed"].includes(request?.status))
    fail("permission-denied", "ACCOUNT_DELETION_PENDING");
}
async function assertAccountAccessInTransaction(tx, db, uid) {
  const state = (await tx.get(db.doc(`account_deletion_requests/${documentId(uid, "UID")}`))).data();
  if (state?.accessBlocked === true || ["pending", "pending_review", "reviewed", "erasure_in_progress", "completed"].includes(state?.status))
    fail("permission-denied", "ACCOUNT_DELETION_PENDING");
}
async function activeObligations(tx, db, uid) {
  const checks = await Promise.all(["userId", "driverId", "ownerId"].map((field) =>
    tx.get(db.collection("rides").where(field, "==", uid).where("status", "in", ACTIVE).limit(1))));
  const legacy = await tx.get(db.collection("bookings").where("userId", "==", uid)
    .where("status", "in", [...ACTIVE, "pending", "scheduled", "current", "searching", "assigned", "ongoing"]).limit(1));
  return !legacy.empty || checks.some((s) => !s.empty);
}
async function deletionBlockers(tx, db, uid) {
  const [request, user, partner, registry, fleet, assigned, reports, ...heldRides] = await Promise.all([
    tx.get(db.doc(`account_deletion_requests/${uid}`)), tx.get(db.doc(`users/${uid}`)), tx.get(db.doc(`partners/${uid}`)),
    tx.get(db.doc(`admin_registry/${uid}`)), tx.get(db.collection("vehicles").where("ownerId", "==", uid).limit(1)),
    tx.get(db.collection("vehicles").where("driverId", "==", uid).limit(1)),
    tx.get(db.collection("support_reports").where("uid", "==", uid).limit(51)),
    ...["userId", "driverId", "ownerId"].map((field) => tx.get(db.collection("rides").where(field, "==", uid).where("legalHold", "==", true).limit(1))),
    ...["customerId", "driverId", "ownerId"].map((field) => tx.get(db.collection("ledger_transactions").where(field, "==", uid).where("legalHold", "==", true).limit(1))),
    tx.get(db.collection("rechargeRequests").where("driverId", "==", uid).where("legalHold", "==", true).limit(1)),
  ]);
  const blockers = [];
  if (registry.data()?.admin === true) blockers.push("admin_handover");
  if (await activeObligations(tx, db, uid)) blockers.push("active_ride");
  if (!fleet.empty) blockers.push("fleet_ownership");
  if (!assigned.empty) blockers.push("vehicle_assignment");
  if ([user.data()?.walletBalance, partner.data()?.walletBalance].some((v) => v != null && (typeof v !== "number" || !Number.isFinite(v) || v !== 0))) blockers.push("financial_balance");
  if ([request, user, partner].some((s) => s.data()?.legalHold === true) || heldRides.some((s) => !s.empty)) blockers.push("legal_hold");
  if (reports.size === 51 || reports.docs.some((s) => s.data().legalHold === true || !["closed", "resolved", "dismissed"].includes(s.data().status))) blockers.push("support_evidence_review");
  return blockers;
}
async function syncDeletionAuthBlock(db, uid, { auth = getAuth() } = {}) {
  documentId(uid, "UID");
  const ref = db.doc(`account_deletion_requests/${uid}`), state = (await ref.get()).data();
  if (!state || state.accessBlocked !== true) fail("failed-precondition", "NO_BLOCKED_DELETION_REQUEST");
  let status = "confirmed";
  try { await auth.updateUser(uid, { disabled: true }); await auth.revokeRefreshTokens(uid); }
  catch (error) { status = error?.code === "auth/user-not-found" ? "account_absent" : "retry_required"; }
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current?.accessBlocked !== true) return;
    tx.update(ref, { authBlockStatus: status, authBlockCheckedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return status;
}
async function requestAccountDeletion(db, opts, dependencies = {}) {
  if (!opts?.uid) fail("unauthenticated", "AUTH_REQUIRED");
  const uid = documentId(opts?.uid, "UID"), ref = db.doc(`account_deletion_requests/${uid}`);
  const nowMs = clock(dependencies.nowMs ?? Date.now());
  const outcome = await db.runTransaction(async (tx) => {
    const [request, user, partner, registry] = await Promise.all([
      tx.get(ref), tx.get(db.doc(`users/${uid}`)), tx.get(db.doc(`partners/${uid}`)), tx.get(db.doc(`admin_registry/${uid}`)),
    ]);
    if (request.exists && ["pending", "pending_review", "reviewed", "erasure_in_progress", "completed"].includes(request.data().status)) {
      // Upgrade legacy pending records so a failed Auth disable can be retried.
      if (request.data().accessBlocked !== true) tx.update(ref, { accessBlocked: true });
      return { alreadyRequested: true, status: request.data().status };
    }
    if (registry.data()?.admin === true) fail("failed-precondition", "ADMIN_HANDOVER_REQUIRED");
    if (await activeObligations(tx, db, uid)) fail("failed-precondition", "ACCOUNT_HAS_ACTIVE_RIDE");
    // Identity is server-derived; no duplicate email/name is needed in this queue.
    const appId = ["customer", "partner", "owner"].includes(opts?.appId) ? opts.appId : "unknown";
    const at = FieldValue.serverTimestamp();
    tx.set(ref, { uid, appId, reason: typeof opts?.reason === "string" ? opts.reason.trim().slice(0, 500) : "",
      status: "pending_review", accessBlocked: true, authBlockStatus: "pending", requestedAt: at, updatedAt: at,
      ...closureRetention(nowMs), retainedCategories: [...RETAINED, "identity_until_due", "held_evidence"],
      erasureCompleted: false, approvalRequired: "SUPER_ADMIN_DISPOSITION_REVIEW" });
    const blocked = { deletionRequested: true, deletionRequestedAt: at, accountStatus: "deletion_pending" };
    if (user.exists) tx.update(user.ref, blocked);
    if (partner.exists) tx.update(partner.ref, { ...blocked, online: false });
    tx.create(db.collection("audit_logs").doc(), { type: "account_deletion_requested", uid, appId, at });
    return { alreadyRequested: false, status: "pending_review" };
  });
  const authBlockStatus = await syncDeletionAuthBlock(db, uid, dependencies);
  return { ok: true, ...outcome, requestId: uid, accessBlocked: true, authBlockStatus, erasureCompleted: false,
    retainedCategories: RETAINED, message: "DELETION_REVIEW_PENDING" };
}
async function reviewAccountDeletion(db, auth, input) {
  const uid = documentId(input?.uid, "UID"), ref = db.doc(`account_deletion_requests/${uid}`);
  if (typeof input?.policyVersion !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(input.policyVersion))
    fail("invalid-argument", "POLICY_REFERENCE_REQUIRED");
  // Review approves only the fixed disposition policy; never asserts erasure.
  return db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    const request = await tx.get(ref);
    if (!request.exists || request.data().accessBlocked !== true || !["pending", "pending_review", "reviewed"].includes(request.data().status))
      fail("failed-precondition", "DELETION_REQUEST_REQUIRED");
    const blockers = await deletionBlockers(tx, db, uid);
    if (input.policyVersion !== POLICY.version) blockers.push("approved_disposition_plan_required");
    const anchor = millis(request.data().accountClosedAt) || millis(request.data().requestedAt);
    if (!anchor) blockers.push("closure_date_missing");
    tx.update(ref, { status: "reviewed", reviewBlockers: blockers, reviewedBy: auth.uid,
      ...(anchor ? closureRetention(anchor) : {}),
      reviewPolicyVersion: input.policyVersion, reviewedAt: FieldValue.serverTimestamp(), erasureCompleted: false });
    tx.create(db.collection("audit_logs").doc(), { type: "account_deletion_reviewed", uid, actorUid: auth.uid,
      blockers, policyVersion: input.policyVersion, at: FieldValue.serverTimestamp() });
    return { ok: true, status: "reviewed", blockers, erasureCompleted: false };
  });
}
module.exports = { ACTIVE, RETAINED, assertAccountAccessAllowed, assertAccountAccessInTransaction, activeObligations,
  syncDeletionAuthBlock, requestAccountDeletion, reviewAccountDeletion, deletionBlockers };
