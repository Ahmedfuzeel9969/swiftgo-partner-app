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
const { locationGeoFields } = require("./geo-cells");

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
  const displacedDriverId =
    vehicle.driverId && vehicle.driverId !== driverUid ? String(vehicle.driverId) : "";

  await db.runTransaction(async (tx) => {
    const partnerSnapTx = await tx.get(partnerRef);
    const partnerTx = partnerSnapTx.exists ? partnerSnapTx.data() || {} : {};
    const stalePartnerRideId = String(partnerTx.activeRideId || "").trim();
    if (stalePartnerRideId) {
      const staleRideSnap = await tx.get(db.collection("rides").doc(stalePartnerRideId));
      const { classifyPointerRide } = require("./active-ride-reconcile");
      const cls = classifyPointerRide(staleRideSnap, {
        driverUid,
        pointerSource: "partner",
      });
      if (cls.block) {
        throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
      }
      if (cls.stale) {
        tx.set(
          partnerRef,
          { activeRideId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
    }

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
    let displacedPartnerRef = null;
    if (displacedDriverId) {
      displacedPartnerRef = db.collection("partners").doc(displacedDriverId);
      const displacedSnap = await tx.get(displacedPartnerRef);
      if (
        !displacedSnap.exists ||
        String(displacedSnap.data()?.currentVehicleId || "") !== vehicleDoc.id
      ) {
        displacedPartnerRef = null;
      }
    }
    const vehicleUpdate = {
      driverId: driverUid,
      driverName: driverName || "SwiftGo Driver",
      status: "online",
      // Keep pinHash for matching; preserve owner-display pin when present.
      pinHash: vehicle.pinHash || pinHash,
      updatedAt: FieldValue.serverTimestamp(),
    };
    const vLat = Number(vehicle?.location?.lat);
    const vLng = Number(vehicle?.location?.lng);
    if (Number.isFinite(vLat) && Number.isFinite(vLng)) {
      const geo = locationGeoFields(vLat, vLng);
      vehicleUpdate.location = { lat: vLat, lng: vLng };
      vehicleUpdate.locationUpdatedAt = FieldValue.serverTimestamp();
      vehicleUpdate.geoCell = geo.geoCell;
      vehicleUpdate.hotspotId = geo.hotspotId;
      vehicleUpdate.locationGridCell = geo.locationGridCell;
    }
    tx.update(vehicleDoc.ref, vehicleUpdate);
    if (displacedPartnerRef) {
      tx.set(
        displacedPartnerRef,
        { currentVehicleId: null, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
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

const ACTIVE_ASSIGNED = new Set(["accepted", "arrived", "in_progress"]);

async function assertOwnerVehicle(db, ownerUid, vehicleId) {
  if (!ownerUid) throw err("unauthenticated", "AUTH_REQUIRED");
  const id = String(vehicleId || "").trim();
  if (!id) throw err("invalid-argument", "MISSING_VEHICLE");
  const ref = db.collection("vehicles").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw err("not-found", "VEHICLE_NOT_FOUND");
  const vehicle = snap.data() || {};
  if (String(vehicle.ownerId || "") !== ownerUid) {
    throw err("permission-denied", "NOT_VEHICLE_OWNER");
  }
  return { ref, vehicle };
}

async function releaseVehicleDriver(db, { ownerUid, vehicleId }) {
  const { ref, vehicle } = await assertOwnerVehicle(db, ownerUid, vehicleId);
  const driverId = String(vehicle.driverId || "").trim();
  if (!driverId) return { ok: true, released: false, reason: "no_driver" };

  const rideId = String(vehicle.activeRideId || "").trim();
  if (rideId) {
    const rideSnap = await db.collection("rides").doc(rideId).get();
    const status = String(rideSnap.data()?.status || "");
    if (rideSnap.exists && ACTIVE_ASSIGNED.has(status)) {
      throw err("failed-precondition", "DRIVER_ON_ACTIVE_RIDE");
    }
  }

  const partnerRef = db.collection("partners").doc(driverId);
  await db.runTransaction(async (tx) => {
    const partnerSnap = await tx.get(partnerRef);
    const clearPartner =
      partnerSnap.exists &&
      String(partnerSnap.data()?.currentVehicleId || "") === ref.id;
    tx.update(ref, {
      driverId: FieldValue.delete(),
      driverName: FieldValue.delete(),
      activeRideId: FieldValue.delete(),
      status: "offline",
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (clearPartner) {
      tx.set(
        partnerRef,
        { currentVehicleId: null, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
  });

  return { ok: true, released: true, vehicleId: ref.id, driverId };
}

async function rotateVehiclePin(db, { ownerUid, vehicleId }) {
  const { ref } = await assertOwnerVehicle(db, ownerUid, vehicleId);
  const pin = String(1000 + Math.floor(Math.random() * 9000));
  const pinHash = hashVehiclePin(pin);
  const batch = db.batch();
  batch.update(ref, {
    pin,
    pinHash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    db.collection("vehicle_pins").doc(ref.id),
    {
      ownerId: ownerUid,
      pin,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await batch.commit();
  return { ok: true, vehicleId: ref.id, pin };
}

module.exports = {
  linkVehicleByPin,
  releaseVehicleDriver,
  rotateVehiclePin,
};
