"use strict";
const { FieldValue } = require("firebase-admin/firestore");
const { isCallerAuthorizedForDiagnostic, assertAdminInTransaction } = require("./admin-claims");
const { fail, documentId, money, digest } = require("./security-policy");
const { financialRetention } = require("./retention-policy");

async function approveRechargeRequest(db, auth, requestId) {
  if (!(await isCallerAuthorizedForDiagnostic(db, auth))) fail("permission-denied", "SUPER_ADMIN_ONLY");
  documentId(requestId, "RECHARGE");
  const requestRef = db.doc(`rechargeRequests/${requestId}`);
  const ledgerRef = db.doc(`ledger_transactions/recharge_${requestId}`);
  return db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    const [requestSnap, ledgerSnap] = await Promise.all([tx.get(requestRef), tx.get(ledgerRef)]);
    if (!requestSnap.exists) fail("not-found", "RECHARGE_NOT_FOUND");
    const request = requestSnap.data();
    if (request.status === "approved" && ledgerSnap.exists) return { ok: true, idempotent: true, amount: ledgerSnap.data().amount };
    if (request.status !== "pending" || ledgerSnap.exists) fail("failed-precondition", "RECHARGE_NOT_PENDING");
    const amount = money(request.amount);
    documentId(request.driverId, "DRIVER");
    if (!["jazzcash", "easypaisa"].includes(request.method) || typeof request.tid !== "string" || !/^[a-z0-9-]{1,80}$/i.test(request.tid.trim())) {
      fail("failed-precondition", "INVALID_PAYMENT_REFERENCE");
    }
    const reference = db.doc(`payment_references/${digest(`${request.method}:${request.tid.trim().toUpperCase()}`)}`);
    const partnerRef = db.doc(`partners/${request.driverId}`);
    const [partnerSnap, referenceSnap, deletion] = await Promise.all([tx.get(partnerRef), tx.get(reference),
      tx.get(db.doc(`account_deletion_requests/${request.driverId}`))]);
    if (referenceSnap.exists) fail("already-exists", "PAYMENT_REFERENCE_ALREADY_USED");
    if (!partnerSnap.exists) fail("failed-precondition", "PARTNER_NOT_FOUND");
    const balance = partnerSnap.data().walletBalance ?? 0;
    if (partnerSnap.data().accountStatus === "closed" || ["erasure_in_progress", "completed"].includes(deletion.data()?.status))
      fail("failed-precondition", "ACCOUNT_ERASURE_IN_PROGRESS");
    if (typeof balance !== "number" || !Number.isFinite(balance) || Math.abs(balance + amount) > 50000000) fail("failed-precondition", "INVALID_WALLET_BALANCE");
    tx.update(partnerRef, { walletBalance: balance + amount });
    const retention = financialRetention(Date.now());
    tx.update(requestRef, { ...retention, status: "approved", approvedAt: FieldValue.serverTimestamp(), approvedBy: auth.uid, ledgerId: ledgerRef.id });
    tx.create(ledgerRef, { kind: "recharge", requestId, driverId: request.driverId, amount, balanceBefore: balance,
      ...retention, balanceAfter: balance + amount, approvedBy: auth.uid, createdAt: FieldValue.serverTimestamp() });
    tx.create(reference, { ...retention, requestId, ledgerId: ledgerRef.id, createdAt: FieldValue.serverTimestamp() });
    tx.create(db.doc(`audit_logs/recharge_${requestId}`), { action: "recharge_approved", actorUid: auth.uid, targetUid: request.driverId,
      requestId, amount, trustedCreator: "approveRechargeRequest", createdAt: FieldValue.serverTimestamp() });
    return { ok: true, idempotent: false, amount, ledgerId: ledgerRef.id };
  });
}
module.exports = { approveRechargeRequest };
