/**
 * Task 3B — trusted Owner onboarding (super-admin approval only).
 * Clients must never self-assign partners.role = owner.
 */

"use strict";

const admin = require(require.resolve("firebase-admin", { paths: [__dirname, process.cwd()] }));
const { FieldValue } = require("firebase-admin/firestore");
const { ensureCallerCanAdminWrite } = require("./admin-claims");

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function isBlockedStatus(status) {
  return status === "blocked" || status === "suspended";
}

function normalizeName(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function rejectClientRoleField(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, "role")) {
    throw err("invalid-argument", "ROLE_NOT_ACCEPTED_FROM_CLIENT");
  }
}

/**
 * Authenticated user requests fleet-owner access. Creates pending owner_applications/{uid}.
 * Does not write partners.role.
 */
async function requestOwnerAccess(db, auth, data = {}) {
  if (!auth?.uid) throw err("unauthenticated", "AUTH_REQUIRED");
  rejectClientRoleField(data);

  const uid = auth.uid;
  if (String(data?.targetUid || data?.uid || "").trim() && String(data?.targetUid || data?.uid).trim() !== uid) {
    throw err("permission-denied", "CANNOT_REQUEST_FOR_OTHER_UID");
  }

  const partnerSnap = await db.collection("partners").doc(uid).get();
  if (partnerSnap.exists) {
    const partner = partnerSnap.data() || {};
    if (isBlockedStatus(partner.accountStatus)) {
      throw err("permission-denied", "ACCOUNT_BLOCKED");
    }
    if (partner.role === "owner") {
      return { ok: true, status: "already_owner", uid, idempotent: true };
    }
  }

  const appRef = db.collection("owner_applications").doc(uid);
  const appSnap = await appRef.get();
  if (appSnap.exists) {
    const app = appSnap.data() || {};
    if (app.status === "pending") {
      return { ok: true, status: "pending", uid, idempotent: true };
    }
    if (app.status === "approved") {
      const refreshed = await db.collection("partners").doc(uid).get();
      if (refreshed.exists && refreshed.data()?.role === "owner") {
        return { ok: true, status: "already_owner", uid, idempotent: true };
      }
    }
    if (app.status === "rejected") {
      throw err("failed-precondition", "APPLICATION_REJECTED");
    }
  }

  const fullName = normalizeName(data?.fullName || auth.token?.name);
  if (!fullName) throw err("invalid-argument", "FULL_NAME_REQUIRED");

  const businessName = normalizeName(data?.businessName) || null;
  const email = String(auth.token?.email || "").trim().toLowerCase() || null;

  await appRef.set({
    uid,
    email,
    fullName,
    businessName,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection("audit_logs").doc(`owner_request_${uid}_${Date.now()}`).set({
    action: "owner_access_requested",
    actorUid: uid,
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "requestOwnerAccess",
  });

  return { ok: true, status: "pending", uid };
}

/**
 * Super-admin approves owner access and provisions partners/{uid}.role = owner via Admin SDK.
 */
async function approveOwnerAccess(db, auth, data = {}) {
  if (!(await ensureCallerCanAdminWrite(db, auth))) {
    throw err("permission-denied", "ADMIN_ONLY");
  }
  rejectClientRoleField(data);

  const targetUid = String(data?.targetUid || data?.uid || "").trim();
  if (!targetUid) throw err("invalid-argument", "MISSING_TARGET_UID");

  const targetUser = await admin.auth().getUser(targetUid).catch(() => null);
  if (!targetUser) throw err("not-found", "TARGET_USER_NOT_FOUND");

  const partnerRef = db.collection("partners").doc(targetUid);
  const appRef = db.collection("owner_applications").doc(targetUid);

  return db.runTransaction(async (tx) => {
    const partnerSnap = await tx.get(partnerRef);
    const appSnap = await tx.get(appRef);

    if (partnerSnap.exists) {
      const partner = partnerSnap.data() || {};
      if (isBlockedStatus(partner.accountStatus)) {
        throw err("permission-denied", "TARGET_ACCOUNT_BLOCKED");
      }
      if (partner.role === "owner") {
        return { ok: true, status: "already_owner", targetUid, idempotent: true };
      }
    }

    const appData = appSnap.exists ? appSnap.data() || {} : {};
    const displayName =
      normalizeName(appData.fullName) ||
      normalizeName(targetUser.displayName) ||
      "Owner";

    const partnerPayload = {
      uid: targetUid,
      role: "owner",
      accountStatus: "active",
      email: String(targetUser.email || appData.email || "").toLowerCase() || null,
      name: displayName,
      updatedAt: FieldValue.serverTimestamp(),
      ownerGrantedAt: FieldValue.serverTimestamp(),
      ownerGrantedBy: auth.uid,
    };

    if (!partnerSnap.exists) {
      partnerPayload.createdAt = FieldValue.serverTimestamp();
      partnerPayload.walletBalance = 0;
      partnerPayload.totalEarnings = 0;
      partnerPayload.totalRidesCompleted = 0;
      tx.set(partnerRef, partnerPayload, { merge: false });
    } else {
      tx.set(partnerRef, partnerPayload, { merge: true });
    }

    if (appSnap.exists && appData.status === "pending") {
      tx.update(appRef, {
        status: "approved",
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy: auth.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (!appSnap.exists) {
      tx.set(
        appRef,
        {
          uid: targetUid,
          email: partnerPayload.email,
          fullName: displayName,
          status: "approved",
          approvedAt: FieldValue.serverTimestamp(),
          approvedBy: auth.uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          directGrant: true,
        },
        { merge: true }
      );
    }

    tx.set(db.collection("audit_logs").doc(`owner_grant_${targetUid}_${Date.now()}`), {
      action: "owner_partner_granted",
      actorUid: auth.uid,
      targetUid,
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "approveOwnerAccess",
    });

    return { ok: true, status: "granted", targetUid };
  });
}

module.exports = {
  requestOwnerAccess,
  approveOwnerAccess,
};
