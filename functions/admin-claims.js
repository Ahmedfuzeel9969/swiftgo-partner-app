/**
 * Phase 2B — Super Admin custom claims + bootstrap transition.
 */

"use strict";

const admin = require(require.resolve("firebase-admin", { paths: [__dirname, process.cwd()] }));
const { FieldValue } = require("firebase-admin/firestore");

const BOOTSTRAP_ADMIN_EMAIL = "fuzail1158@gmail.com";

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function isBootstrapEmailAuth(auth) {
  const email = String(auth?.token?.email || "").toLowerCase();
  return email === BOOTSTRAP_ADMIN_EMAIL && auth?.token?.email_verified === true;
}

function isClaimAdmin(auth) {
  return auth?.token?.admin === true;
}

async function isEmailBootstrapEnabled(db) {
  const snap = await db.collection("settings").doc("security").get();
  // Default OFF — must explicitly enable transitional bootstrap.
  if (!snap.exists) return false;
  return snap.data()?.adminBootstrapEnabled === true;
}

async function isAdminAuth(db, auth) {
  if (!auth) return false;
  if (isClaimAdmin(auth)) return true;
  if (!(await isEmailBootstrapEnabled(db))) return false;
  return isBootstrapEmailAuth(auth);
}

/** One-time / transitional: bootstrap email may self-grant admin claim. */
async function bootstrapAdminClaim(db, auth) {
  if (!auth?.uid) throw err("unauthenticated", "AUTH_REQUIRED");
  if (!(await isEmailBootstrapEnabled(db))) {
    throw err("failed-precondition", "BOOTSTRAP_DISABLED");
  }
  if (!isBootstrapEmailAuth(auth)) throw err("permission-denied", "NOT_BOOTSTRAP_ADMIN");
  await admin.auth().setCustomUserClaims(auth.uid, { admin: true });
  await db.collection("audit_logs").doc(`admin_bootstrap_${auth.uid}_${Date.now()}`).set({
    action: "admin_claim_bootstrap",
    actorUid: auth.uid,
    targetUid: auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "bootstrapAdminClaim",
  });
  return { ok: true, admin: true };
}

/** Grant admin claim to another user — only existing admins. */
async function grantAdminClaim(db, auth, targetUid) {
  if (!(await isAdminAuth(db, auth))) throw err("permission-denied", "ADMIN_ONLY");
  const uid = String(targetUid || "").trim();
  if (!uid) throw err("invalid-argument", "MISSING_UID");
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  await db.collection("admin_registry").doc(uid).set(
    {
      uid,
      admin: true,
      grantedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await db.collection("audit_logs").doc(`admin_grant_${uid}_${Date.now()}`).set({
    action: "admin_claim_grant",
    actorUid: auth.uid,
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "grantAdminClaim",
  });
  return { ok: true, targetUid: uid, admin: true };
}

/** Revoke admin claim — only existing claim/bootstrap admins. */
async function revokeAdminClaim(db, auth, targetUid) {
  if (!(await isAdminAuth(db, auth))) throw err("permission-denied", "ADMIN_ONLY");
  const uid = String(targetUid || "").trim();
  if (!uid) throw err("invalid-argument", "MISSING_UID");
  if (uid === auth.uid) throw err("failed-precondition", "CANNOT_REVOKE_SELF");
  await admin.auth().setCustomUserClaims(uid, { admin: false });
  await db.collection("admin_registry").doc(uid).set(
    {
      uid,
      admin: false,
      revokedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await db.collection("audit_logs").doc(`admin_revoke_${uid}_${Date.now()}`).set({
    action: "admin_claim_revoke",
    actorUid: auth.uid,
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "revokeAdminClaim",
  });
  return { ok: true, targetUid: uid, admin: false };
}

/** After verified admins have claims, disable email bootstrap path. */
async function setAdminEmailBootstrap(db, auth, enabled) {
  if (!(await isAdminAuth(db, auth))) throw err("permission-denied", "ADMIN_ONLY");
  if (!isClaimAdmin(auth)) {
    throw err("failed-precondition", "CLAIM_ADMIN_REQUIRED_TO_TOGGLE_BOOTSTRAP");
  }
  const value = Boolean(enabled);
  await db.collection("settings").doc("security").set(
    {
      adminBootstrapEnabled: value,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    },
    { merge: true }
  );
  await db.collection("audit_logs").doc(`admin_bootstrap_flag_${Date.now()}`).set({
    action: "admin_bootstrap_flag",
    actorUid: auth.uid,
    adminBootstrapEnabled: value,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "setAdminEmailBootstrap",
  });
  return { ok: true, adminBootstrapEnabled: value };
}

module.exports = {
  BOOTSTRAP_ADMIN_EMAIL,
  isBootstrapEmailAuth,
  isClaimAdmin,
  isEmailBootstrapEnabled,
  isAdminAuth,
  bootstrapAdminClaim,
  grantAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
};
