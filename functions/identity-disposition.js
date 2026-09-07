"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { assertAdminInTransaction } = require("./admin-claims");
const { fail, documentId } = require("./security-policy");
const { POLICY, clock, millis, identityDueAt, isApprovedPolicy } = require("./retention-policy");
const { deletionBlockers } = require("./account-deletion-workflow");
const COLLECTIONS = new Set(["driver_applications", "driver_application_history", "owner_applications"]);
const PROOFS = ["cnicFront", "cnicBack", "license", "selfie"];
function proofTargets(collection, data, uid) {
  if (collection === "owner_applications") return [];
  const ticket = documentId(data.ticketId, "TICKET");
  return PROOFS.map((key) => {
    const proof = data.proofs?.[key], path = `driver_applications/${uid}/${ticket}_${key}`;
    if (proof?.path !== path || !/^[0-9]{1,30}$/.test(String(proof?.generation || ""))) fail("failed-precondition", "IDENTITY_PROOF_REVIEW_REQUIRED");
    return { path, generation: String(proof.generation), key };
  });
}
async function disposeIdentityRecord(db, auth, input, { dryRun = true, allowMutation = false, nowMs = Date.now(), bucket } = {}) {
  if (typeof dryRun !== "boolean") fail("invalid-argument", "INVALID_DISPOSITION_MODE");
  if (!dryRun && (allowMutation !== true || input?.confirm !== POLICY.version)) fail("failed-precondition", "ACCOUNT_ERASURE_NOT_ENABLED");
  if (!COLLECTIONS.has(input?.collection)) fail("invalid-argument", "IDENTITY_COLLECTION_NOT_APPROVED");
  const id = documentId(input?.id, "APPLICATION"), now = clock(nowMs), ref = db.doc(`${input.collection}/${id}`);
  const key = createHash("sha256").update(ref.path).digest("hex"), jobRef = db.doc(`identity_erasure_jobs/${key}`), runId = randomUUID();
  async function check(tx, requireLease = false) {
    await assertAdminInTransaction(tx, db, auth);
    const [snap, config, job] = await Promise.all([tx.get(ref), tx.get(db.doc("settings/dataRetention")), tx.get(jobRef)]);
    if (!snap.exists) return { absent: true, job: job.data() };
    const data = snap.data(), uid = documentId(data.userId || data.uid || (input.collection !== "driver_application_history" ? id : ""), "SUBJECT");
    const request = (await tx.get(db.doc(`account_deletion_requests/${uid}`))).data() || {};
    const due = identityDueAt(data, request), blockers = await deletionBlockers(tx, db, uid);
    if (input.collection === "driver_application_history") {
      const current = (await tx.get(db.doc(`driver_applications/${uid}`))).data();
      if (current?.ticketId === data.ticketId) blockers.push("identity_still_referenced");
    }
    if (data.legalHold === true) blockers.push("identity_legal_hold");
    if (!due) blockers.push("identity_date_or_status_review");
    else if (due.getTime() > now) blockers.push("identity_period_not_due");
    const targets = proofTargets(input.collection, data, uid);
    if (!dryRun && !isApprovedPolicy(config.data())) fail("failed-precondition", "APPROVED_RETENTION_POLICY_REQUIRED");
    if (requireLease && job.data()?.runId !== runId) fail("aborted", "IDENTITY_LEASE_LOST");
    return { data, uid, due, blockers, targets, job: job.data() };
  }
  const plan = await db.runTransaction(async (tx) => {
    const state = await check(tx);
    if (state.absent || dryRun || state.blockers.length) return state;
    if ((millis(state.job?.leaseUntil) || 0) > now) fail("aborted", "IDENTITY_RUN_IN_PROGRESS");
    // Fence application replacement/review until exact-generation deletion completes.
    tx.update(ref, { identityErasurePending: true });
    tx.set(jobRef, { runId, leaseUntil: new Date(now + 9 * 60000), status: "in_progress", policyVersion: POLICY.version,
      subjectHash: key, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return state;
  });
  if (plan.absent) return { dryRun, absent: true, completed: plan.job?.status === "completed", blockers: [] };
  if (dryRun || plan.blockers.length) return { dryRun, completed: false, eligible: !plan.blockers.length, blockers: plan.blockers,
    dueAt: plan.due?.getTime() || null, proofCount: plan.targets.length };
  try {
    const storage = bucket || (plan.targets.length ? getStorage().bucket() : null);
    for (const target of plan.targets) {
      const live = await db.runTransaction((tx) => check(tx, true));
      if (live.absent || live.blockers.length || !live.targets.some((p) => p.path === target.path && p.generation === target.generation))
        fail("failed-precondition", "IDENTITY_CHANGED_OR_HELD");
      // Do not select a generation to hide a newer live object. A changed live
      // generation MUST fail the precondition, leaving the record for review.
      try {
        const file = storage.file(target.path), [metadata] = await file.getMetadata();
        if (String(metadata.generation) !== target.generation) throw new Error("IDENTITY_GENERATION_CHANGED");
        await file.delete({ ifGenerationMatch: target.generation });
      }
      catch (error) { if (Number(error?.code) !== 404) throw new Error("IDENTITY_OBJECT_RETRY_OR_REVIEW_REQUIRED"); }
    }
    await db.runTransaction(async (tx) => {
      const current = await check(tx, true);
      if (current.absent || current.blockers.length) fail("failed-precondition", "IDENTITY_CHANGED_OR_HELD");
      tx.delete(ref);
      tx.set(jobRef, { status: "completed", policyVersion: POLICY.version, subjectHash: key, leaseUntil: new Date(0),
        completedAt: FieldValue.serverTimestamp(), providerBackupsVerified: false });
      tx.set(db.doc(`retention_events/identity_${key}`), { category: input.collection, subjectHash: key,
        policyVersion: POLICY.version, deletedAt: FieldValue.serverTimestamp(), providerBackupsVerified: false });
    });
    return { dryRun: false, completed: true, proofCount: plan.targets.length, providerBackupsVerified: false };
  } catch (error) {
    await db.runTransaction(async (tx) => {
      if ((await tx.get(jobRef)).data()?.runId === runId) tx.update(jobRef, { status: "retry_required", leaseUntil: new Date(0) });
    });
    throw error;
  }
}
module.exports = { COLLECTIONS, proofTargets, disposeIdentityRecord };
