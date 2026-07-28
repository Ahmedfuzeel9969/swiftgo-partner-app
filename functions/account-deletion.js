/**
 * Phase 4E — account deletion request + support report (server-trusted).
 * Soft-disables account access; preserves financial ledger / audit / settlement history.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const RETAINED = [
  "ledger_transactions",
  "audit_logs",
  "settled_rides_and_fares",
  "recharge_and_settlement_records",
];

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ uid: string, email?: string|null, roleHint?: string, reason?: string, appId?: string }} opts
 */
async function requestAccountDeletion(db, opts) {
  const uid = String(opts?.uid || "").trim();
  if (!uid) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    throw err;
  }

  const reason = String(opts?.reason || "").trim().slice(0, 500);
  const appId = String(opts?.appId || "unknown").slice(0, 40);
  const roleHint = String(opts?.roleHint || "unknown").slice(0, 40);
  const now = FieldValue.serverTimestamp();
  const requestRef = db.collection("account_deletion_requests").doc(uid);

  const existing = await requestRef.get();
  if (existing.exists && existing.data()?.status === "pending") {
    return {
      ok: true,
      alreadyRequested: true,
      requestId: uid,
      status: "pending",
      retainedCategories: RETAINED,
      message: "DELETION_ALREADY_PENDING",
    };
  }

  await db.runTransaction(async (tx) => {
    const userRef = db.collection("users").doc(uid);
    const partnerRef = db.collection("partners").doc(uid);
    const userSnap = await tx.get(userRef);
    const partnerSnap = await tx.get(partnerRef);

    tx.set(
      requestRef,
      {
        uid,
        email: opts?.email || null,
        appId,
        roleHint,
        reason: reason || null,
        status: "pending",
        requestedAt: now,
        updatedAt: now,
        retainedCategories: RETAINED,
        legalNote:
          "DRAFT — Financial ledger, settlement, and audit records are retained as required. Profile/login access is disabled pending operator review.",
      },
      { merge: true }
    );

    if (userSnap.exists) {
      tx.set(
        userRef,
        {
          deletionRequested: true,
          deletionRequestedAt: now,
          accountStatus: "deletion_pending",
        },
        { merge: true }
      );
    }

    if (partnerSnap.exists) {
      tx.set(
        partnerRef,
        {
          deletionRequested: true,
          deletionRequestedAt: now,
          accountStatus: "deletion_pending",
          online: false,
        },
        { merge: true }
      );
    }

    tx.set(db.collection("audit_logs").doc(), {
      type: "account_deletion_requested",
      uid,
      appId,
      roleHint,
      at: now,
      retainedCategories: RETAINED,
    });
  });

  // Disable Auth login after soft-mark (does not erase Auth record / financial data).
  try {
    await getAuth().updateUser(uid, { disabled: true });
  } catch (err) {
    console.warn("[requestAccountDeletion] auth disable", err?.message || err);
  }

  return {
    ok: true,
    alreadyRequested: false,
    requestId: uid,
    status: "pending",
    retainedCategories: RETAINED,
    message: "DELETION_REQUESTED",
  };
}

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
  const rideId = opts?.rideId ? String(opts.rideId).slice(0, 80) : null;

  const ref = db.collection("support_reports").doc();
  await ref.set({
    uid,
    email: opts?.email || null,
    category,
    message: message.slice(0, 2000),
    appId,
    rideId,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
  });

  await db.collection("audit_logs").doc().set({
    type: "support_report_created",
    uid,
    reportId: ref.id,
    category,
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, reportId: ref.id, status: "open" };
}

module.exports = {
  requestAccountDeletion,
  submitSupportReport,
  RETAINED,
};
