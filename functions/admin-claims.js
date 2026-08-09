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
  await ensureSuperAdminUserDocForUid(db, uid, {
    email: String(auth?.token?.email || "").toLowerCase() || null,
    displayName: auth?.token?.name || null,
  });
}

async function ensureSuperAdminUserDocForUid(db, uid, { email = null, displayName = null } = {}) {
  if (!uid) return;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const payload = {
    role: "super_admin",
    email,
    displayName: displayName || email || "Super Admin",
    updatedAt: FieldValue.serverTimestamp(),
    adminRoleSyncedAt: FieldValue.serverTimestamp(),
  };
  if (!snap.exists) {
    payload.walletBalance = 0;
  }
  await ref.set(payload, { merge: true });
}

/** Persist users/{uid}.role = admin for claim-granted operators (not super_admin). */
async function ensureAdminUserDocForUid(db, uid, { email = null, displayName = null } = {}) {
  if (!uid) return;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const existingRole = snap.exists ? snap.data()?.role : null;
  if (existingRole === "super_admin") return;
  const payload = {
    role: "admin",
    email,
    displayName: displayName || email || "Admin",
    updatedAt: FieldValue.serverTimestamp(),
    adminRoleSyncedAt: FieldValue.serverTimestamp(),
  };
  if (!snap.exists) {
    payload.walletBalance = 0;
  }
  await ref.set(payload, { merge: true });
}

async function hasAdminUserRole(db, uid) {
  if (!uid) return false;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return false;
  return snap.data()?.role === "admin";
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

/**
 * Grant ordinary admin claim (admin:true + users/{uid}.role = admin).
 * Security/migration: before 2026-08-09 this callable also wrote role super_admin.
 * Use grantSuperAdminClaim for explicit Super Admin elevation.
 */
async function grantAdminClaim(db, auth, targetUid) {
  if (!(await isAdminAuth(db, auth))) throw err("permission-denied", "ADMIN_ONLY");
  const uid = String(targetUid || "").trim();
  if (!uid) throw err("invalid-argument", "MISSING_UID");
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  const targetUser = await admin.auth().getUser(uid).catch(() => null);
  await ensureAdminUserDocForUid(db, uid, {
    email: String(targetUser?.email || "").toLowerCase() || null,
    displayName: targetUser?.displayName || null,
  });
  await db.collection("admin_registry").doc(uid).set(
    {
      uid,
      admin: true,
      role: "admin",
      grantedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await db.collection("audit_logs").doc(`admin_grant_${uid}_${Date.now()}`).set({
    action: "admin_claim_grant",
    actorUid: auth.uid,
    targetUid: uid,
    role: "admin",
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "grantAdminClaim",
  });
  return { ok: true, targetUid: uid, admin: true, role: "admin" };
}

/** Explicit Super Admin elevation — only persisted super_admin or bootstrap owner. */
async function grantSuperAdminClaim(db, auth, targetUid) {
  if (!(await isCallerAuthorizedForDiagnostic(db, auth))) {
    throw err("permission-denied", "SUPER_ADMIN_ONLY");
  }
  const uid = String(targetUid || "").trim();
  if (!uid) throw err("invalid-argument", "MISSING_UID");
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  const targetUser = await admin.auth().getUser(uid).catch(() => null);
  await ensureSuperAdminUserDocForUid(db, uid, {
    email: String(targetUser?.email || "").toLowerCase() || null,
    displayName: targetUser?.displayName || null,
  });
  await db.collection("admin_registry").doc(uid).set(
    {
      uid,
      admin: true,
      role: "super_admin",
      grantedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await db.collection("audit_logs").doc(`admin_super_grant_${uid}_${Date.now()}`).set({
    action: "admin_super_admin_grant",
    actorUid: auth.uid,
    targetUid: uid,
    role: "super_admin",
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "grantSuperAdminClaim",
  });
  return { ok: true, targetUid: uid, admin: true, role: "super_admin" };
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
    // Only the approved bootstrap owner is synced to super_admin here.
    // Ordinary admin:true operators keep users/{uid}.role = admin.
    if (isBootstrapEmailAuth(auth)) {
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
  hasAdminUserRole,
  ensureSuperAdminUserDoc,
  ensureSuperAdminUserDocForUid,
  ensureAdminUserDocForUid,
  ensureCallerCanAdminWrite,
  requestTouchesDiagnosticControls,
  isCallerAuthorizedForDiagnostic,
  bootstrapAdminClaim,
  initSuperAdminAccess,
  grantAdminClaim,
  grantSuperAdminClaim,
  revokeAdminClaim,
  setAdminEmailBootstrap,
};
