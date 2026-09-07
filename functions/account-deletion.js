/**
 * Phase 4E — account deletion request + support report (server-trusted).
 * Soft-disables account access; preserves financial ledger / audit / settlement history.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { requestAccountDeletion } = require("./account-deletion-workflow");
const { assertAccountAccessInTransaction } = require("./account-deletion-workflow");
const { documentId, fail } = require("./security-policy");

const RETAINED = [
  "ledger_transactions",
  "audit_logs",
  "settled_rides_and_fares",
  "recharge_and_settlement_records",
];

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ uid: string, email?: string|null, category?: string, message?: string, appId?: string, rideId?: string }} opts
 */
async function submitSupportReport(db, opts) {
  const uid = String(opts?.uid || "").trim();
  if (!uid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }
  const message = String(opts?.message || "").trim();
  if (message.length < 8) {
    const err = new Error("REPORT_TOO_SHORT");
    err.code = "invalid-argument";
    throw err;
  }
  const category = String(opts?.category || "complaint").slice(0, 40);
  const appId = String(opts?.appId || "unknown").slice(0, 40);
  const rideId = opts?.rideId ? documentId(opts.rideId, "RIDE") : null;

  const ref = db.collection("support_reports").doc();
  await db.runTransaction(async (tx) => {
    await assertAccountAccessInTransaction(tx, db, uid);
    const ride = rideId ? await tx.get(db.doc(`rides/${rideId}`)) : null;
    if (rideId && (!ride.exists || ![ride.data().userId, ride.data().driverId, ride.data().ownerId].includes(uid)))
      fail("permission-denied", "SUPPORT_RIDE_PARTICIPANT_REQUIRED");
    tx.set(ref, {
    uid,
    email: opts?.email || null,
    category,
    message: message.slice(0, 2000),
    appId,
    rideId,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
  });

  if (ride) tx.update(ride.ref, { legalHold: true, legalHoldReason: "complaint", legalHoldUpdatedAt: FieldValue.serverTimestamp() });
  tx.set(db.collection("audit_logs").doc(), {
    type: "support_report_created",
    uid,
    reportId: ref.id,
    category,
    at: FieldValue.serverTimestamp(),
  });
  });

  return { ok: true, reportId: ref.id, status: "open" };
}

module.exports = {
  requestAccountDeletion,
  submitSupportReport,
  RETAINED,
};
