"use strict";
const { createHash } = require("node:crypto");
const { FieldValue, FieldPath } = require("firebase-admin/firestore");
const { assertAdminInTransaction } = require("./admin-claims");
const { documentId, fail } = require("./security-policy");
const { POLICY, millis, financialRetention, clock } = require("./retention-policy");
const HOLD_COLLECTIONS = new Set(["account_deletion_requests", "rides", "bookings", "driver_applications",
  "driver_application_history", "owner_applications", "ledger_transactions", "rechargeRequests", "support_reports"]);
async function setRetentionLegalHold(db, auth, input) {
  if (!HOLD_COLLECTIONS.has(input?.collection) || typeof input?.hold !== "boolean" ||
      !["complaint", "accident", "outstanding_balance", "legal_proceeding", "review_resolved"].includes(input?.reasonCode))
    fail("invalid-argument", "INVALID_LEGAL_HOLD");
  if (input.hold === false && input.reasonCode !== "review_resolved") fail("failed-precondition", "HOLD_RELEASE_REVIEW_REQUIRED");
  const ref = db.doc(`${input.collection}/${documentId(input.id, "RECORD")}`);
  return db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    if (!(await tx.get(ref)).exists) fail("not-found", "RETENTION_RECORD_NOT_FOUND");
    tx.update(ref, { legalHold: input.hold, legalHoldReason: input.reasonCode, legalHoldUpdatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection("audit_logs").doc(), { action: "retention_legal_hold_changed", actorUid: auth.uid,
      category: input.collection, subjectHash: createHash("sha256").update(ref.path).digest("hex"),
      hold: input.hold, reasonCode: input.reasonCode, at: FieldValue.serverTimestamp() });
    return { ok: true, hold: input.hold };
  });
}
async function previewFinancialRetention(db, auth, input = {}, { nowMs = Date.now() } = {}) {
  clock(nowMs);
  await db.runTransaction((tx) => assertAdminInTransaction(tx, db, auth));
  if (input.collection && !["ledger_transactions", "rechargeRequests"].includes(input.collection)) fail("invalid-argument", "FINANCIAL_COLLECTION_NOT_APPROVED");
  let query = db.collection(input.collection || "ledger_transactions").orderBy(FieldPath.documentId());
  if (input.cursor) query = query.startAfter(documentId(input.cursor, "CURSOR"));
  const page = await query.limit(25).get();
  const records = page.docs.map((doc) => {
    const data = doc.data(), at = millis(data.approvedAt) || millis(data.settledAt) || millis(data.createdAt);
    const calculated = at ? financialRetention(at).retainFinancialUntil.getTime() : null;
    const minimum = calculated ? Math.max(calculated, millis(data.retainFinancialUntil) || 0) : null;
    return { id: doc.id, retainUntil: minimum, legalHold: data.legalHold === true,
      disposition: !minimum ? "legacy_date_review_required" : data.legalHold === true ? "held" : minimum > nowMs ? "retain" : "financial_review_required",
      legacyMetadata: data.retentionPolicyVersion !== POLICY.version };
  });
  return { dryRun: true, deleted: 0, policy: POLICY, records, nextCursor: page.size === 25 ? page.docs.at(-1).id : null };
}
module.exports = { HOLD_COLLECTIONS, setRetentionLegalHold, previewFinancialRetention };
