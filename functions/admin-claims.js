/** Versioned, revocable administration. User profile roles/email are NOT authority. */
"use strict";
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { randomUUID } = require("node:crypto");
const { fail, documentId } = require("./security-policy");
const { LOCATION_DELIVERY_KEYS } = require("./location-delivery-policy");
// Historical display/export compatibility only. Never authorizes a request.
const BOOTSTRAP_ADMIN_EMAIL = "fuzail1158@gmail.com";
const isBootstrapEmailAuth = (auth) => auth?.token?.email_verified === true && String(auth.token.email).toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
const isClaimAdmin = (auth) => auth?.token?.admin === true;

function registryAllows(entry, auth, requiredRole = null) {
  return Boolean(auth?.uid && isClaimAdmin(auth) && Number.isInteger(auth.token.adminVersion) &&
    entry?.admin === true && entry.version === auth.token.adminVersion && entry.role === auth.token.adminRole &&
    ["admin", "super_admin"].includes(entry.role) && (!requiredRole || entry.role === requiredRole));
}
async function assertAdminInTransaction(tx, db, auth, role = "super_admin") {
  if (!auth?.uid) fail("permission-denied", "SUPER_ADMIN_ONLY");
  const snap = await tx.get(db.doc(`admin_registry/${documentId(auth.uid)}`));
  if (!registryAllows(snap.data(), auth, role)) fail("permission-denied", "SUPER_ADMIN_ONLY");
}
async function writeAdminSettings(db, auth, path, payload) {
  await db.runTransaction(async (tx) => {
    await assertAdminInTransaction(tx, db, auth);
    tx.set(db.doc(path), payload, { merge: true });
    tx.create(db.collection("audit_logs").doc(), { action: "admin_settings_saved", actorUid: auth.uid,
      settingsPath: path, fields: Object.keys(payload), createdAt: FieldValue.serverTimestamp() });
  });
}

async function readAdminRole(db, auth) {
  if (!auth?.uid || !isClaimAdmin(auth) || !Number.isInteger(auth.token.adminVersion)) return null;
  const snap = await db.doc(`admin_registry/${documentId(auth.uid)}`).get();
  const entry = snap.exists ? snap.data() : null;
  if (!registryAllows(entry, auth)) return null;
  return entry.role;
}
async function isAdminAuth(db, auth) { return (await readAdminRole(db, auth)) !== null; }
async function isCallerAuthorizedForDiagnostic(db, auth) { return (await readAdminRole(db, auth)) === "super_admin"; }
async function ensureCallerCanAdminWrite(db, auth) { return isCallerAuthorizedForDiagnostic(db, auth); }
async function hasSuperAdminUserRole(db, uid) { const snap = await db.doc(`users/${documentId(uid)}`).get(); return snap.data()?.role === "super_admin"; }
async function hasAdminUserRole(db, uid) { const snap = await db.doc(`users/${documentId(uid)}`).get(); return snap.data()?.role === "admin"; }

async function setProfileRole(db, uid, role, profile = {}) {
  const ref = db.doc(`users/${documentId(uid)}`);
  const snap = await ref.get();
  await ref.set({ ...(!snap.exists ? { walletBalance: 0 } : {}), ...profile, role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
const ensureSuperAdminUserDocForUid = (db, uid, profile) => setProfileRole(db, uid, "super_admin", profile);
const ensureAdminUserDocForUid = (db, uid, profile) => setProfileRole(db, uid, "admin", profile);
const ensureSuperAdminUserDoc = (db, auth) => ensureSuperAdminUserDocForUid(db, auth.uid);

function bootstrapWindow(security) {
  const deadline = security?.adminBootstrapExpiresAt?.toMillis?.() ?? 0;
  return security?.adminBootstrapEnabled === true && deadline > Date.now() && deadline <= Date.now() + 24 * 60 * 60 * 1000;
}
async function isEmailBootstrapEnabled(db) { return bootstrapWindow((await db.doc("settings/security").get()).data()); }

/** Registry is disabled FIRST. Any partial failure leaves old/new tokens denied. */
async function changeAdminRole(db, auth, uid, role, { bootstrap = false } = {}) {
  documentId(uid, "UID");
  const authApi = getAuth();
  const user = await authApi.getUser(uid);
  if (user.disabled) fail("permission-denied", "TARGET_ACCOUNT_INACTIVE");
  const ref = db.doc(`admin_registry/${uid}`);
  const profileRef = db.doc(`users/${uid}`);
  const operationId = randomUUID();
  const version = await db.runTransaction(async (tx) => {
    if (!bootstrap) await assertAdminInTransaction(tx, db, auth);
    const [snap, profile, security] = await Promise.all([
      tx.get(ref), tx.get(profileRef), bootstrap ? tx.get(db.doc("settings/security")) : null,
    ]);
    if (bootstrap && (!bootstrapWindow(security?.data()) || auth.uid !== process.env.ADMIN_BOOTSTRAP_UID || auth.token?.email_verified !== true)) {
      fail("permission-denied", "BOOTSTRAP_DISABLED");
    }
    const version = Number(snap.data()?.version || 0) + 1;
    tx.set(ref, { uid, admin: false, role: "none", version, operationId, changedBy: auth.uid, updatedAt: FieldValue.serverTimestamp() });
    tx.set(profileRef, { ...(!profile.exists ? { walletBalance: 0 } : {}), role: "customer", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (bootstrap) tx.update(db.doc("settings/security"), { adminBootstrapEnabled: false, adminBootstrapUsedAt: FieldValue.serverTimestamp() });
    tx.create(db.doc(`audit_logs/admin_begin_${operationId}`), { action: "admin_role_change_started", actorUid: auth.uid, targetUid: uid, role,
      createdAt: FieldValue.serverTimestamp(), trustedCreator: "changeAdminRole" });
    return version;
  });
  const claims = { ...(user.customClaims || {}), admin: role !== "none", adminVersion: version };
  if (role === "none") delete claims.adminRole; else claims.adminRole = role;
  await authApi.setCustomUserClaims(uid, claims);
  if (role === "none") await authApi.revokeRefreshTokens(uid);
  await db.runTransaction(async (tx) => {
    if (!bootstrap && auth.uid !== uid) await assertAdminInTransaction(tx, db, auth);
    const current = await tx.get(ref);
    if (current.data()?.operationId !== operationId || current.data()?.version !== version) fail("aborted", "ADMIN_CHANGE_SUPERSEDED");
    tx.update(ref, { admin: role !== "none", role, completedAt: FieldValue.serverTimestamp() });
    tx.set(profileRef, { role: role === "none" ? "customer" : role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(db.doc(`audit_logs/admin_done_${operationId}`), { action: "admin_role_change_completed", actorUid: auth.uid, targetUid: uid, role,
      createdAt: FieldValue.serverTimestamp(), trustedCreator: "changeAdminRole" });
  });
  return { ok: true, targetUid: uid, admin: role !== "none", role, adminVersion: version };
}
async function requireSuper(db, auth) {
  if (!(await isCallerAuthorizedForDiagnostic(db, auth))) fail("permission-denied", "SUPER_ADMIN_ONLY");
}
async function grantAdminClaim(db, auth, uid) {
  await requireSuper(db, auth);
  if (uid === auth.uid) fail("failed-precondition", "CANNOT_DEMOTE_SELF");
  return changeAdminRole(db, auth, uid, "admin");
}
async function grantSuperAdminClaim(db, auth, uid) { await requireSuper(db, auth); return changeAdminRole(db, auth, uid, "super_admin"); }
async function revokeAdminClaim(db, auth, uid) {
  await requireSuper(db, auth);
  if (uid === auth.uid) fail("failed-precondition", "CANNOT_REVOKE_SELF");
  return changeAdminRole(db, auth, uid, "none");
}
async function initSuperAdminAccess(db, auth) {
  if (!auth?.uid) fail("unauthenticated", "AUTH_REQUIRED");
  if (await isCallerAuthorizedForDiagnostic(db, auth)) return { ok: true, role: "super_admin", admin: true };
  if (!process.env.ADMIN_BOOTSTRAP_UID || auth.uid !== process.env.ADMIN_BOOTSTRAP_UID || auth.token?.email_verified !== true) {
    fail("permission-denied", "OPERATOR_BOOTSTRAP_REQUIRED");
  }
  return changeAdminRole(db, auth, auth.uid, "super_admin", { bootstrap: true });
}
async function bootstrapAdminClaim(db, auth) { return initSuperAdminAccess(db, auth); }
async function setAdminEmailBootstrap(db, auth, enabled) {
  await requireSuper(db, auth);
  if (typeof enabled !== "boolean") fail("invalid-argument", "INVALID_BOOTSTRAP_FLAG");
  if (enabled && !process.env.ADMIN_BOOTSTRAP_UID) fail("failed-precondition", "OPERATOR_BOOTSTRAP_REQUIRED");
  await db.runTransaction(async (batch) => {
  await assertAdminInTransaction(batch, db, auth);
  batch.set(db.doc("settings/security"), { adminBootstrapEnabled: Boolean(enabled),
    adminBootstrapExpiresAt: Timestamp.fromMillis(enabled ? Date.now() + 15 * 60 * 1000 : 0),
    updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }, { merge: true });
  batch.create(db.collection("audit_logs").doc(), { action: "bootstrap_window_changed", enabled: Boolean(enabled), actorUid: auth.uid,
    createdAt: FieldValue.serverTimestamp(), trustedCreator: "setAdminEmailBootstrap" });
  });
  return { ok: true, adminBootstrapEnabled: Boolean(enabled) };
}
function requestTouchesDiagnosticControls(data) {
  return ["idleMovementTriggerDisabled", "idleDiagnosticDurationMinutes", "idleDiagnosticReason", ...LOCATION_DELIVERY_KEYS]
    .some((key) => Object.prototype.hasOwnProperty.call(data || {}, key));
}
module.exports = { BOOTSTRAP_ADMIN_EMAIL, isBootstrapEmailAuth, isClaimAdmin, registryAllows, assertAdminInTransaction, writeAdminSettings, readAdminRole, isEmailBootstrapEnabled, isAdminAuth,
  hasSuperAdminUserRole, hasAdminUserRole, ensureSuperAdminUserDoc, ensureSuperAdminUserDocForUid, ensureAdminUserDocForUid,
  ensureCallerCanAdminWrite, requestTouchesDiagnosticControls, isCallerAuthorizedForDiagnostic, bootstrapAdminClaim,
  initSuperAdminAccess, grantAdminClaim, grantSuperAdminClaim, revokeAdminClaim, setAdminEmailBootstrap };
