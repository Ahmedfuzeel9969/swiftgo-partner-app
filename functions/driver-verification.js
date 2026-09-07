"use strict";
const { randomUUID } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { fail, documentId, takeRateLimit } = require("./security-policy");
const { assertAdminInTransaction } = require("./admin-claims");
const { POLICY, afterDays } = require("./retention-policy");
const PROOFS = Object.freeze(["cnicFront", "cnicBack", "license", "selfie"]);
function textField(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail("invalid-argument", `INVALID_${name}`);
  return value.trim();
}
function validateApplication(data) {
  const cnic = String(data?.cnic || "").replace(/[- ]/g, "");
  if (!/^\d{13}$/.test(cnic)) fail("invalid-argument", "INVALID_CNIC");
  return { fullName: textField(data.fullName, "NAME", 120), cnic,
    licenseNumber: textField(data.licenseNumber, "LICENSE", 40) };
}
async function beginDriverVerification(db, uid, { now = Date.now() } = {}) {
  documentId(uid);
  await takeRateLimit(db, "driver_verification", uid, { limit: 3, windowMs: 86400000, now });
  const ticketId = randomUUID();
  await db.runTransaction(async (tx) => {
    const [partner, application] = await Promise.all([tx.get(db.doc(`partners/${uid}`)), tx.get(db.doc(`driver_applications/${uid}`))]);
    if (!partner.exists || partner.data().accountStatus !== "active") fail("permission-denied", "PARTNER_INACTIVE");
    if (application.data()?.identityErasurePending === true) fail("failed-precondition", "IDENTITY_ERASURE_IN_PROGRESS");
    if (partner.data().driverApprovalStatus === "approved" || application.data()?.status === "pending") fail("failed-precondition", "APPLICATION_ALREADY_SUBMITTED");
    tx.set(db.doc(`driver_upload_tickets/${uid}`), { ticketId, expiresAt: Timestamp.fromMillis(now + 15 * 60000), used: false });
  });
  return { ticketId, paths: Object.fromEntries(PROOFS.map((key) => [key, `driver_applications/${uid}/${ticketId}_${key}`])) };
}
async function inspectProof(path) {
  const [meta] = await getStorage().bucket().file(path).getMetadata();
  if (!/^(image\/jpeg|image\/png|image\/webp)$/.test(meta.contentType) || !(Number(meta.size) > 0 && Number(meta.size) < 5 * 1024 * 1024)) {
    fail("failed-precondition", "INVALID_PROOF_IMAGE");
  }
  return { path, generation: String(meta.generation), size: Number(meta.size), contentType: meta.contentType };
}
async function submitDriverVerification(db, uid, data, { proofInspector = inspectProof, now = Date.now() } = {}) {
  documentId(uid);
  const input = validateApplication(data);
  const ticketId = documentId(data.ticketId, "TICKET");
  const ticketRef = db.doc(`driver_upload_tickets/${uid}`);
  const initial = (await ticketRef.get()).data();
  if (initial?.ticketId !== ticketId || initial.used || initial.expiresAt.toMillis() <= now) fail("failed-precondition", "UPLOAD_TICKET_EXPIRED");
  const proofs = Object.fromEntries(await Promise.all(PROOFS.map(async (key) => {
    const path = `driver_applications/${uid}/${ticketId}_${key}`;
    return [key, await proofInspector(path)];
  })));
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`driver_applications/${uid}`);
    const [ticket, previous, partner] = await Promise.all([tx.get(ticketRef), tx.get(ref), tx.get(db.doc(`partners/${uid}`))]);
    if (previous.data()?.identityErasurePending === true) fail("failed-precondition", "IDENTITY_ERASURE_IN_PROGRESS");
    if (previous.data()?.ticketId === ticketId) return { ok: true, status: previous.data().status, idempotent: true };
    if (ticket.data()?.ticketId !== ticketId || ticket.data().used || ticket.data().expiresAt.toMillis() <= now) fail("failed-precondition", "UPLOAD_TICKET_EXPIRED");
    if (!partner.exists || partner.data().accountStatus !== "active") fail("permission-denied", "PARTNER_INACTIVE");
    if (previous.exists && previous.data().status !== "rejected") fail("failed-precondition", "APPLICATION_ALREADY_SUBMITTED");
    if (previous.exists) tx.create(db.doc(`driver_application_history/${uid}_${documentId(previous.data().ticketId)}`), previous.data());
    tx.set(ref, { ...input, userId: uid, ticketId, proofs, status: "pending", retentionPolicyVersion: POLICY.version, createdAt: FieldValue.serverTimestamp() });
    tx.update(ticketRef, { used: true });
    tx.update(db.doc(`partners/${uid}`), { driverApprovalStatus: "pending", driverApplicationId: uid, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, status: "pending" };
  });
}
async function reviewDriverVerification(db, auth, data) {
  const uid = documentId(data?.uid, "DRIVER");
  if (!["approved", "rejected"].includes(data?.decision)) fail("invalid-argument", "INVALID_DECISION");
  const reason = data.decision === "rejected" ? textField(data.reason, "REASON", 200) : "";
  return db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    const ref = db.doc(`driver_applications/${uid}`);
    const partnerRef = db.doc(`partners/${uid}`);
    const [application, partner] = await Promise.all([tx.get(ref), tx.get(partnerRef)]);
    if (!application.exists || application.data().status !== "pending") fail("failed-precondition", "APPLICATION_NOT_PENDING");
    if (application.data()?.identityErasurePending === true) fail("failed-precondition", "IDENTITY_ERASURE_IN_PROGRESS");
    if (data.ticketId !== application.data().ticketId) fail("failed-precondition", "APPLICATION_CHANGED_REFRESH_REQUIRED");
    if (!partner.exists || partner.data().accountStatus !== "active") fail("failed-precondition", "PARTNER_INACTIVE");
    if (!PROOFS.every((key) => application.data().proofs?.[key]?.generation)) fail("failed-precondition", "PROOFS_INCOMPLETE");
    tx.update(ref, { status: data.decision, reason, reviewedBy: auth.uid, reviewedAt: FieldValue.serverTimestamp(),
      retentionPolicyVersion: POLICY.version,
      identityDueAt: data.decision === "rejected" ? afterDays(Date.now(), POLICY.rejectedIdentityDays) : FieldValue.delete() });
    tx.update(partnerRef, { driverApprovalStatus: data.decision, driverApplicationId: uid, updatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection("audit_logs").doc(), { action: "driver_verification_reviewed", actorUid: auth.uid, targetUid: uid,
      decision: data.decision, createdAt: FieldValue.serverTimestamp() });
    return { ok: true, status: data.decision };
  });
}
module.exports = { PROOFS, validateApplication, beginDriverVerification, submitDriverVerification, reviewDriverVerification };
