/**
 * Phase 2B — vehicle PIN link with lockout (Admin SDK).
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const {
  hashVehiclePin,
  isValidPinFormat,
  evaluatePinAttemptGate,
  nextFailState,
  resetPinAttempts,
} = require("./pin-security");

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

async function linkVehicleByPin(db, { driverUid, pin, driverName }) {
  if (!driverUid) throw err("invalid-argument", "MISSING_DRIVER");
  if (!isValidPinFormat(pin)) throw err("invalid-argument", "INVALID_PIN_FORMAT");

  const partnerRef = db.collection("partners").doc(driverUid);
  const attemptRef = db.collection("pin_attempts").doc(driverUid);
  const nowMs = Date.now();

  const partnerSnap = await partnerRef.get();
  const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
  if (partner.accountStatus === "blocked" || partner.accountStatus === "suspended") {
    throw err("permission-denied", "DRIVER_BLOCKED");
  }

  const attemptSnap = await attemptRef.get();
  const attemptData = attemptSnap.exists ? attemptSnap.data() : {};
  const gate = evaluatePinAttemptGate(attemptData, nowMs);
  if (!gate.allowed) {
    await db.collection("audit_logs").doc(`pin_lock_${driverUid}_${nowMs}`).set({
      action: "pin_link_locked",
      driverId: driverUid,
      reason: gate.reason,
      lockedUntilMs: gate.lockedUntil || null,
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "linkVehicleByPin",
    });
    throw err("resource-exhausted", "PIN_LOCKED");
  }

  const pinHash = hashVehiclePin(pin);
  let vehicleSnap = await db.collection("vehicles").where("pinHash", "==", pinHash).limit(1).get();

  // Legacy compatibility: plaintext pin field (Admin SDK only; clients cannot query).
  if (vehicleSnap.empty) {
    vehicleSnap = await db.collection("vehicles").where("pin", "==", String(pin).trim()).limit(1).get();
  }

  if (vehicleSnap.empty) {
    const failState = nextFailState(attemptData, nowMs);
    await attemptRef.set(failState, { merge: true });
    await db.collection("audit_logs").doc(`pin_fail_${driverUid}_${nowMs}`).set({
      action: "pin_link_failed",
      driverId: driverUid,
      failCount: failState.failCount,
      // Never store the PIN or hash of the attempt input beyond fail metadata.
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "linkVehicleByPin",
    });
    if (failState.lockedUntilMs) throw err("resource-exhausted", "PIN_LOCKED");
    throw err("not-found", "PIN_NOT_FOUND");
  }

  const vehicleDoc = vehicleSnap.docs[0];
  const vehicle = vehicleDoc.data() || {};
  if (vehicle.status === "online" && vehicle.driverId && vehicle.driverId !== driverUid) {
    throw err("failed-precondition", "VEHICLE_IN_USE");
  }

  const previousVehicleId =
    partner.currentVehicleId && partner.currentVehicleId !== vehicleDoc.id
      ? partner.currentVehicleId
      : null;

  await db.runTransaction(async (tx) => {
    if (previousVehicleId) {
      const prevRef = db.collection("vehicles").doc(previousVehicleId);
      const prevSnap = await tx.get(prevRef);
      if (prevSnap.exists && prevSnap.data()?.driverId === driverUid) {
        tx.update(prevRef, {
          driverId: FieldValue.delete(),
          driverName: FieldValue.delete(),
          activeRideId: FieldValue.delete(),
          status: "offline",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    tx.update(vehicleDoc.ref, {
      driverId: driverUid,
      driverName: driverName || "SwiftGo Driver",
      status: "online",
      // Migrate legacy plaintext pin → hash when possible; strip plaintext.
      pinHash: vehicle.pinHash || pinHash,
      pin: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      partnerRef,
      {
        uid: driverUid,
        role: "driver",
        currentVehicleId: vehicleDoc.id,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.set(attemptRef, resetPinAttempts(nowMs), { merge: true });
  });

  await db.collection("audit_logs").doc(`pin_ok_${driverUid}_${nowMs}`).set({
    action: "pin_link_success",
    driverId: driverUid,
    vehicleId: vehicleDoc.id,
    createdAt: FieldValue.serverTimestamp(),
    trustedCreator: "linkVehicleByPin",
  });

  return {
    ok: true,
    vehicleId: vehicleDoc.id,
    plate: vehicle.plate || "—",
    ownerId: vehicle.ownerId || null,
    status: "online",
  };
}

module.exports = {
  linkVehicleByPin,
};
