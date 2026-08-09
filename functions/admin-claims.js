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

async function hasSuperAdminUserRole(db, uid) {
  if (!uid) return false;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return false;
  return snap.data()?.role === "super_admin";
}

/** Persist users/{uid}.role = super_admin (Admin SDK only; clients cannot set this). */
async function ensureSuperAdminUserDoc(db, auth) {
  const uid = auth?.uid;
  if (!uid) return;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const email = String(auth?.token?.email || "").toLowerCase() || null;
  const payload = {
    role: "super_admin",
    email,
    displayName: auth?.token?.name || email || "Super Admin",
    updatedAt: FieldValue.serverTimestamp(),
    adminRoleSyncedAt: FieldValue.serverTimestamp(),
  };
  if (!snap.exists) {
    payload.walletBalance = 0;
  }
  await ref.set(payload, { merge: true });
}

async function isAdminAuth(db, auth) {
  if (!auth) return false;
  if (isClaimAdmin(auth)) return true;
  if (await hasSuperAdminUserRole(db, auth.uid)) return true;
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
  await ensureSuperAdminUserDoc(db, auth);
  await db.collection("audit_logs").doc(`admin_bootstrap_${auth.uid}_${Date.now()}`).set({
    action: "admin_claim_bootstrap",
    actorUid: auth.uid,
    targetUid: auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "bootstrapAdminClaim",
  });
  return { ok: true, admin: true, role: "super_admin" };
}

/** Grant admin claim to another user — only existing admins. */
async function grantAdminClaim(db, auth, targetUid) {
  if (!(await isAdminAuth(db, auth))) throw err("permission-denied", "ADMIN_ONLY");
  const uid = String(targetUid || "").trim();
  if (!uid) throw err("invalid-argument", "MISSING_UID");
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  await db.collection("users").doc(uid).set(
    {
      role: "super_admin",
      updatedAt: FieldValue.serverTimestamp(),
      adminRoleSyncedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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

/** First login: owner email enables bootstrap + admin claim (Admin SDK — no prior settings write needed). */
async function initSuperAdminAccess(db, auth) {
  if (!auth?.uid) throw err("unauthenticated", "AUTH_REQUIRED");
  if (!isBootstrapEmailAuth(auth)) throw err("permission-denied", "NOT_BOOTSTRAP_ADMIN");

  await db.collection("settings").doc("security").set(
    {
      adminBootstrapEnabled: true,
      updatedAt: FieldValue.serverTimestamp(),
      initializedBy: auth.uid,
    },
    { merge: true }
  );

  await admin.auth().setCustomUserClaims(auth.uid, { admin: true });
  await ensureSuperAdminUserDoc(db, auth);

  await db.collection("audit_logs").doc(`admin_init_${auth.uid}_${Date.now()}`).set({
    action: "admin_init_super_access",
    actorUid: auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "initSuperAdminAccess",
  });

  return { ok: true, admin: true, role: "super_admin", adminBootstrapEnabled: true };
}

function requestTouchesDiagnosticControls(data) {
  if (!data || typeof data !== "object") return false;
  if (data.idleMovementTriggerDisabled != null) return true;
  if (data.idleDiagnosticDurationMinutes != null) return true;
  if (data.idleDiagnosticReason != null) return true;
  return false;
}

/** Diagnostic idle controls: persisted super_admin role or approved bootstrap email — not admin:true claim alone. */
async function isCallerAuthorizedForDiagnostic(db, auth) {
  if (!auth?.uid) return false;
  if (await hasSuperAdminUserRole(db, auth.uid)) return true;
  if (!(await isEmailBootstrapEnabled(db))) return false;
  return isBootstrapEmailAuth(auth);
}

/** Callable admin writes: grant owner on first use, or verify existing admin. */
async function ensureCallerCanAdminWrite(db, auth) {
  if (!auth?.uid) return false;
  if (await isAdminAuth(db, auth)) {
    // Keep users/{uid}.role in sync for rules-based writes.
    if (isClaimAdmin(auth) || isBootstrapEmailAuth(auth)) {
      await ensureSuperAdminUserDoc(db, auth);
    }
    return true;
  }
  if (!isBootstrapEmailAuth(auth)) return false;
  await initSuperAdminAccess(db, auth);
  return true;
}

module.exports = {
  BOOTSTRAP_ADMIN_EMAIL,
  isBootstrapEmailAuth,
  isClaimAdmin,
  isEmailBootstrapEnabled,
  isAdminAuth,
  hasSuperAdminUserRole,
  ensureSuperAdminUserDoc,
  ensureCallerCanAdminWrite,
  requestTouchesDiagnosticControls,
  isCallerAuthorizedForDiagnostic,
  bootstrapAdminClaim,
  initSuperAdminAccess,
  grantAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
};
