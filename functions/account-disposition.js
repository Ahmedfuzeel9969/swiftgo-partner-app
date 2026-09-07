"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { FieldValue, FieldPath } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { assertAdminInTransaction } = require("./admin-claims");
const { documentId, fail } = require("./security-policy");
const { POLICY, millis, clock, afterDays, isApprovedPolicy } = require("./retention-policy");
const { deletionBlockers } = require("./account-deletion-workflow");
const { TERMINAL } = require("./data-retention");

// A small allowlist, NOT recursive deletion. Financial evidence and booked route
// remain separately retained. No claim of anonymous data or provider-backup erasure.
const SCOPES = Object.freeze([
  { collection: "rides", field: "userId", remove: ["customerName", "customerPhone", "customerEmail", "customerPhoto", "customerPhotoUrl"] },
  { collection: "rides", field: "driverId", remove: ["driverName", "driverPhone", "driverEmail", "driverPhoto", "driverPhotoUrl"] },
  { collection: "rides", field: "ownerId", remove: ["ownerName", "ownerPhone", "ownerEmail"] },
  { collection: "ride_offers", field: "driverId", remove: ["driverName", "driverPhone", "driverPhoto", "driverPhotoUrl"] },
  { collection: "booking_quotes", field: "userId", delete: true },
  { collection: "booking_quotes", field: "customerId", delete: true },
  { collection: "bookings", field: "userId", remove: ["customerName", "customerPhone", "customerEmail", "name", "email", "phone"] },
  { collection: "support_reports", field: "uid", remove: ["email", "message", "attachments"] },
]);
const PROFILE_FIELDS = ["walletBalance", "totalEarnings", "totalRidesCompleted", "role", "driverApprovalStatus", "createdAt", "legalHold"];
function profileTombstone(data = {}) {
  return { ...Object.fromEntries(PROFILE_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]])),
    accountStatus: "closed", online: false, deletionRequested: true, personalDataErased: true,
    retentionPolicyVersion: POLICY.version, updatedAt: FieldValue.serverTimestamp() };
}
async function inspectAccountDisposition(db, auth, uid, { nowMs = Date.now() } = {}) {
  documentId(uid, "UID"); clock(nowMs);
  return db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    const request = (await tx.get(db.doc(`account_deletion_requests/${uid}`))).data();
    if (!request) fail("not-found", "DELETION_REQUEST_REQUIRED");
    const blockers = await deletionBlockers(tx, db, uid);
    const due = millis(request.personalDataDueAt);
    if (!due) blockers.push("closure_date_missing");
    else if (due > nowMs) blockers.push("personal_period_not_due");
    if (request.reviewPolicyVersion !== POLICY.version) blockers.push("approved_disposition_plan_required");
    return { policy: POLICY, blockers, status: request.status, personalDataDueAt: due,
      approvedIdentityDueAt: millis(request.approvedIdentityDueAt),
      personalDataErased: request.personalDataErased === true, erasureCompleted: false,
      retainedCategories: ["financial_evidence_and_booked_routes", "identity_until_due", "legal_holds", "provider_backups_pending_verification"],
      progress: { step: request.erasureStep || 0, totalSteps: SCOPES.length + 2 },
      dryRun: true };
  });
}
async function requireExecution(tx, db, auth, uid, nowMs, runId) {
  await assertAdminInTransaction(tx, db, auth);
  const [request, config] = await Promise.all([tx.get(db.doc(`account_deletion_requests/${uid}`)), tx.get(db.doc("settings/dataRetention"))]);
  const state = request.data();
  if (!isApprovedPolicy(config.data())) fail("failed-precondition", "APPROVED_RETENTION_POLICY_REQUIRED");
  if (!state?.accessBlocked || state.reviewPolicyVersion !== POLICY.version ||
      !["reviewed", "erasure_in_progress", "completed"].includes(state.status)) fail("failed-precondition", "DELETION_REVIEW_REQUIRED");
  const due = millis(state.personalDataDueAt), anchor = millis(state.accountClosedAt);
  // Recompute the minimum: a corrupted/shortened saved date cannot authorize early erasure.
  if (!due || !anchor || due > nowMs || afterDays(anchor, POLICY.personalDataDays).getTime() > nowMs) fail("failed-precondition", "PERSONAL_PERIOD_NOT_DUE");
  const blockers = await deletionBlockers(tx, db, uid);
  if (blockers.length) fail("failed-precondition", `DELETION_BLOCKED:${blockers.join(",")}`);
  if (runId && state.erasureRunId !== runId) fail("aborted", "ERASURE_LEASE_LOST");
  return { state, limit: Number.isInteger(config.data().batchLimit) ? Math.max(1, Math.min(50, config.data().batchLimit)) : 25 };
}
async function executeAccountDispositionPage(db, auth, input, { allowMutation = false, nowMs = Date.now(), authService } = {}) {
  if (allowMutation !== true || input?.confirm !== POLICY.version) fail("failed-precondition", "ACCOUNT_ERASURE_NOT_ENABLED");
  const uid = documentId(input?.uid, "UID"), now = clock(nowMs), ref = db.doc(`account_deletion_requests/${uid}`), runId = randomUUID();
  const acquired = await db.runTransaction(async (tx) => {
    const { state, limit } = await requireExecution(tx, db, auth, uid, now);
    if (state.personalDataErased === true) return { alreadyComplete: true };
    if ((millis(state.erasureLeaseUntil) || 0) > now) fail("aborted", "ERASURE_RUN_IN_PROGRESS");
    tx.update(ref, { status: "erasure_in_progress", erasureRunId: runId, erasureLeaseUntil: new Date(now + 9 * 60000),
      lastErasureError: FieldValue.delete() });
    return { step: state.erasureStep || 0, cursor: state.erasureCursor || null, limit };
  });
  if (acquired.alreadyComplete) return { ok: true, personalDataErased: true, erasureCompleted: false, idempotent: true };
  try {
    let processed = 0, next = acquired.step, cursor = null;
    if (acquired.step === 0) {
      await db.runTransaction(async (tx) => {
        await requireExecution(tx, db, auth, uid, now, runId);
        const docs = await Promise.all(["users", "partners", "drivers"].map((group) => tx.get(db.doc(`${group}/${uid}`))));
        if (docs.some((doc) => doc.data()?.legalHold === true)) fail("failed-precondition", "PROFILE_LEGAL_HOLD");
        for (const doc of docs) if (doc.exists) tx.set(doc.ref, profileTombstone(doc.data()));
        tx.update(ref, { erasureStep: 1, erasureCursor: null });
      });
      next = 1;
    } else if (acquired.step <= SCOPES.length) {
      const scope = SCOPES[acquired.step - 1];
      let query = db.collection(scope.collection).where(scope.field, "==", uid).orderBy(FieldPath.documentId());
      if (acquired.cursor) query = query.startAfter(documentId(acquired.cursor, "CURSOR"));
      const page = await query.limit(acquired.limit).get();
      for (const candidate of page.docs) {
        await db.runTransaction(async (tx) => {
          await requireExecution(tx, db, auth, uid, now, runId);
          const current = await tx.get(candidate.ref), data = current.data();
          if (data?.legalHold === true) fail("failed-precondition", "RECORD_LEGAL_HOLD");
          if (data && scope.collection === "rides" && !TERMINAL.has(data.status)) fail("failed-precondition", "RIDE_NOT_TERMINAL");
          if (data && scope.collection === "bookings" && !TERMINAL.has(data.status)) fail("failed-precondition", "LEGACY_BOOKING_REVIEW_REQUIRED");
          if (data && scope.collection === "support_reports" && !["closed", "resolved", "dismissed"].includes(data.status)) fail("failed-precondition", "SUPPORT_EVIDENCE_REVIEW_REQUIRED");
          if (data?.[scope.field] === uid) {
            if (scope.delete) tx.delete(current.ref);
            else tx.update(current.ref, { ...Object.fromEntries(scope.remove.map((field) => [field, FieldValue.delete()])),
              personalContactRedactedAt: FieldValue.serverTimestamp() });
          }
          tx.update(ref, { erasureCursor: candidate.id });
        });
        processed++;
      }
      cursor = page.size === acquired.limit ? page.docs.at(-1).id : null;
      next = cursor ? acquired.step : acquired.step + 1;
    } else if (acquired.step === SCOPES.length + 1) {
      // Auth is external to Firestore: failure leaves a retryable step, never success.
      await db.runTransaction((tx) => requireExecution(tx, db, auth, uid, now, runId));
      try { await (authService || getAuth()).deleteUser(uid); }
      catch (error) { if (error?.code !== "auth/user-not-found") throw new Error("AUTH_ERASURE_RETRY_REQUIRED"); }
      next++;
    } else fail("failed-precondition", "INVALID_ERASURE_STEP");
    const complete = next > SCOPES.length + 1;
    await db.runTransaction(async (tx) => {
      await requireExecution(tx, db, auth, uid, now, runId);
      tx.update(ref, { erasureStep: next, erasureCursor: cursor, erasureLeaseUntil: new Date(0),
        ...(complete ? { status: "completed", personalDataErased: true, erasureCompleted: false,
          completedScope: "profile_auth_contact_copies_only", personalDataErasedAt: FieldValue.serverTimestamp(),
          reason: FieldValue.delete(), authBlockStatus: "account_absent" } : {}) });
      const hash = createHash("sha256").update(`account|${uid}|${acquired.step}|${acquired.cursor || ""}`).digest("hex");
      tx.set(db.doc(`retention_events/${hash}`), { category: "account_personal_page", subjectHash: hash, policyVersion: POLICY.version,
        step: acquired.step, processed, at: FieldValue.serverTimestamp() });
    });
    return { ok: true, processed, nextStep: next, personalDataErased: complete, erasureCompleted: false, more: !complete };
  } catch (error) {
    await db.runTransaction(async (tx) => {
      const state = (await tx.get(ref)).data();
      if (state?.erasureRunId === runId) tx.update(ref, { erasureLeaseUntil: new Date(0), lastErasureError: "RETRY_OR_REVIEW_REQUIRED" });
    });
    throw error;
  }
}
module.exports = { SCOPES, profileTombstone, inspectAccountDisposition, executeAccountDispositionPage };
