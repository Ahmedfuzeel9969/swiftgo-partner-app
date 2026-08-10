/**
 * Task 3B/3C — trusted Owner onboarding (super-admin approval only).
 * Clients must never self-assign partners.role = owner.
 */

"use strict";

const admin = require(require.resolve("firebase-admin", { paths: [__dirname, process.cwd()] }));
const { FieldValue } = require("firebase-admin/firestore");
const { isCallerAuthorizedForDiagnostic } = require("./admin-claims");

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

function sanitizeRejectionReason(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 200);
}

function rejectClientRoleField(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, "role")) {
    throw err("invalid-argument", "ROLE_NOT_ACCEPTED_FROM_CLIENT");
  }
}

async function ensureCallerIsSuperAdmin(db, auth) {
  if (!auth?.uid) throw err("unauthenticated", "AUTH_REQUIRED");
  if (!(await isCallerAuthorizedForDiagnostic(db, auth))) {
    throw err("permission-denied", "SUPER_ADMIN_ONLY");
  }
}

async function loadTargetAuthUser(targetUid) {
  try {
    return await admin.auth().getUser(targetUid);
  } catch (e) {
    if (e?.code === "auth/user-not-found") throw err("not-found", "TARGET_USER_NOT_FOUND");
    throw err("failed-precondition", "TARGET_AUTH_LOOKUP_FAILED");
  }
}

function assertTargetAuthActive(targetUser) {
  if (!targetUser || targetUser.disabled) {
    throw err("permission-denied", "TARGET_ACCOUNT_INACTIVE");
  }
}

function assertPartnerEligible(partner) {
  if (!partner) return;
  if (isBlockedStatus(partner.accountStatus)) {
    throw err("permission-denied", "TARGET_ACCOUNT_INACTIVE");
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
      // Explicit re-request after rejection — fall through to rewrite pending state.
    }
  }

  const fullName = normalizeName(data?.fullName || auth.token?.name);
  if (!fullName) throw err("invalid-argument", "FULL_NAME_REQUIRED");

  const businessName = normalizeName(data?.businessName) || null;
  const email = String(auth.token?.email || "").trim().toLowerCase() || null;

  await appRef.set(
    {
      uid,
      email,
      fullName,
      businessName,
      status: "pending",
      createdAt: appSnap.exists
        ? appSnap.data()?.createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      rejectionReason: null,
      rejectedAt: null,
      rejectedBy: null,
    },
    { merge: true }
  );

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
  await ensureCallerIsSuperAdmin(db, auth);
  rejectClientRoleField(data);

  const targetUid = String(data?.targetUid || data?.uid || "").trim();
  if (!targetUid) throw err("invalid-argument", "MISSING_TARGET_UID");

  const targetUser = await loadTargetAuthUser(targetUid);
  assertTargetAuthActive(targetUser);

  const partnerRef = db.collection("partners").doc(targetUid);
  const appRef = db.collection("owner_applications").doc(targetUid);

  const prePartnerSnap = await partnerRef.get();
  assertPartnerEligible(prePartnerSnap.exists ? prePartnerSnap.data() : null);
  if (prePartnerSnap.exists && prePartnerSnap.data()?.role === "owner") {
    return { ok: true, status: "already_owner", targetUid, idempotent: true };
  }

  return db.runTransaction(async (tx) => {
    const partnerSnap = await tx.get(partnerRef);
    const appSnap = await tx.get(appRef);

    if (partnerSnap.exists) {
      const partner = partnerSnap.data() || {};
      assertPartnerEligible(partner);
      if (partner.role === "owner") {
        return { ok: true, status: "already_owner", targetUid, idempotent: true };
      }
    }

    const appData = appSnap.exists ? appSnap.data() || {} : {};
    if (appSnap.exists) {
      if (appData.status === "rejected") {
        throw err("failed-precondition", "APPLICATION_REJECTED");
      }
      if (appData.status === "approved") {
        if (partnerSnap.exists && partnerSnap.data()?.role === "owner") {
          return { ok: true, status: "already_owner", targetUid, idempotent: true };
        }
      }
      if (appData.status !== "pending") {
        throw err("failed-precondition", "APPLICATION_NOT_PENDING");
      }
    }

    const displayName =
      normalizeName(appData.fullName) ||
      normalizeName(targetUser.displayName) ||
      "Owner";

    if (!partnerSnap.exists) {
      tx.set(partnerRef, {
        uid: targetUid,
        role: "owner",
        accountStatus: "active",
        email: String(targetUser.email || appData.email || "").toLowerCase() || null,
        name: displayName,
        walletBalance: 0,
        totalEarnings: 0,
        totalRidesCompleted: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ownerGrantedAt: FieldValue.serverTimestamp(),
        ownerGrantedBy: auth.uid,
      });
    } else {
      const existing = partnerSnap.data() || {};
      tx.set(
        partnerRef,
        {
          role: "owner",
          updatedAt: FieldValue.serverTimestamp(),
          ownerGrantedAt: FieldValue.serverTimestamp(),
          ownerGrantedBy: auth.uid,
          ...(existing.email ? {} : { email: String(targetUser.email || appData.email || "").toLowerCase() || null }),
          ...(existing.name ? {} : { name: displayName }),
        },
        { merge: true }
      );
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

/**
 * Super-admin rejects a pending owner application. Never mutates partners.role.
 */
async function rejectOwnerAccess(db, auth, data = {}) {
  await ensureCallerIsSuperAdmin(db, auth);
  rejectClientRoleField(data);

  const targetUid = String(data?.targetUid || data?.uid || "").trim();
  if (!targetUid) throw err("invalid-argument", "MISSING_TARGET_UID");

  const reason = sanitizeRejectionReason(data?.reason || data?.rejectionReason);
  if (!reason) throw err("invalid-argument", "REJECTION_REASON_REQUIRED");

  const appRef = db.collection("owner_applications").doc(targetUid);
  const partnerRef = db.collection("partners").doc(targetUid);

  return db.runTransaction(async (tx) => {
    const appSnap = await tx.get(appRef);
    const partnerSnap = await tx.get(partnerRef);

    if (!appSnap.exists) {
      throw err("not-found", "APPLICATION_NOT_FOUND");
    }

    const appData = appSnap.data() || {};
    if (appData.status === "rejected") {
      return { ok: true, status: "already_rejected", targetUid, idempotent: true };
    }
    if (appData.status !== "pending") {
      throw err("failed-precondition", "APPLICATION_NOT_PENDING");
    }

    if (partnerSnap.exists && partnerSnap.data()?.role === "owner") {
      throw err("failed-precondition", "TARGET_ALREADY_OWNER");
    }

    tx.update(appRef, {
      status: "rejected",
      rejectionReason: reason,
      rejectedAt: FieldValue.serverTimestamp(),
      rejectedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("audit_logs").doc(`owner_reject_${targetUid}_${Date.now()}`), {
      action: "owner_access_rejected",
      actorUid: auth.uid,
      targetUid,
      reasonLength: reason.length,
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "rejectOwnerAccess",
    });

    return { ok: true, status: "rejected", targetUid };
  });
}

module.exports = {
  requestOwnerAccess,
  approveOwnerAccess,
  rejectOwnerAccess,
  ensureCallerIsSuperAdmin,
  sanitizeRejectionReason,
};
