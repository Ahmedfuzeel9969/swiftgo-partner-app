/**
 * Server-authoritative active-ride pointer reconciliation.
 * Heals stale partner/vehicle activeRideId without touching rides, ledger, or earnings.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { ACTIVE_RIDE_STATUSES } = require("./matching");

const GENUINE_ACTIVE_STATUSES = Object.freeze([...ACTIVE_RIDE_STATUSES]);

const STALE_POINTER_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "cancelled_by_user",
  "expired",
  "searching_driver",
]);

/**
 * @param {FirebaseFirestore.DocumentSnapshot | null | undefined} rideSnap
 * @param {{ driverUid: string, vehicleId?: string | null, pointerSource: 'partner' | 'vehicle' }} ctx
 */
function classifyPointerRide(rideSnap, ctx) {
  const driverUid = String(ctx.driverUid || "");
  const vehicleId = ctx.vehicleId ? String(ctx.vehicleId) : null;
  const pointerSource = ctx.pointerSource;

  if (!rideSnap || !rideSnap.exists) {
    return { stale: true, block: false, reason: "missing" };
  }

  const data = rideSnap.data() || {};
  const status = String(data.status || "");
  const rideDriver = String(data.driverId || "");
  const rideVehicle = String(data.vehicleId || "");

  if (rideDriver && rideDriver !== driverUid) {
    return { stale: true, block: false, reason: "wrong_driver", rideId: rideSnap.id, status };
  }

  if (GENUINE_ACTIVE_STATUSES.includes(status)) {
    if (
      pointerSource === "vehicle" &&
      vehicleId &&
      rideVehicle &&
      rideVehicle !== vehicleId
    ) {
      return {
        stale: true,
        block: false,
        reason: "wrong_vehicle",
        rideId: rideSnap.id,
        status,
      };
    }
    return {
      stale: false,
      block: true,
      reason: "genuine_active",
      rideId: rideSnap.id,
      status,
    };
  }

  if (STALE_POINTER_STATUSES.includes(status) || !GENUINE_ACTIVE_STATUSES.includes(status)) {
    return {
      stale: true,
      block: false,
      reason: STALE_POINTER_STATUSES.includes(status) ? status : "inactive",
      rideId: rideSnap.id,
      status,
    };
  }

  return { stale: true, block: false, reason: "inactive", rideId: rideSnap.id, status };
}

/**
 * Pure evaluation for tests.
 * @param {{
 *   driverUid: string,
 *   vehicleId?: string | null,
 *   partner?: object,
 *   vehicle?: object,
 *   rideSnaps?: Map<string, FirebaseFirestore.DocumentSnapshot>,
 *   activeRideSnap?: FirebaseFirestore.QuerySnapshot,
 * }} input
 */
function evaluateDriverAvailability(input) {
  const driverUid = String(input.driverUid || "");
  const vehicleId = input.vehicleId ? String(input.vehicleId) : null;
  const partner = input.partner || {};
  const vehicle = input.vehicle || {};
  const rideSnaps = input.rideSnaps || new Map();
  const heals = [];
  let blocked = false;
  let blockReason = null;

  const partnerPtr = String(partner.activeRideId || "").trim();
  if (partnerPtr) {
    const cls = classifyPointerRide(rideSnaps.get(partnerPtr) || null, {
      driverUid,
      vehicleId,
      pointerSource: "partner",
    });
    if (cls.stale) heals.push({ target: "partner", rideId: partnerPtr, reason: cls.reason });
    if (cls.block) {
      blocked = true;
      blockReason = "partner_pointer";
    }
  }

  const vehiclePtr = String(vehicle.activeRideId || "").trim();
  if (vehicleId && vehiclePtr) {
    const cls = classifyPointerRide(rideSnaps.get(vehiclePtr) || null, {
      driverUid,
      vehicleId,
      pointerSource: "vehicle",
    });
    if (cls.stale) heals.push({ target: "vehicle", rideId: vehiclePtr, reason: cls.reason });
    if (cls.block) {
      blocked = true;
      blockReason = blockReason || "vehicle_pointer";
    }
  }

  const activeSnap = input.activeRideSnap;
  if (activeSnap && !activeSnap.empty) {
    blocked = true;
    blockReason = blockReason || "active_ride_query";
  }

  return { blocked, blockReason, heals };
}

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {{ partnerRef?: FirebaseFirestore.DocumentReference, vehicleRef?: FirebaseFirestore.DocumentReference, heals: Array<{ target: string }> }} params
 */
function applyPointerHealsInTx(tx, params) {
  const { partnerRef, vehicleRef, heals } = params;
  const ts = FieldValue.serverTimestamp();
  for (const heal of heals) {
    if (heal.target === "partner" && partnerRef) {
      tx.set(
        partnerRef,
        { activeRideId: FieldValue.delete(), updatedAt: ts },
        { merge: true }
      );
    }
    if (heal.target === "vehicle" && vehicleRef) {
      tx.update(vehicleRef, {
        activeRideId: FieldValue.delete(),
        updatedAt: ts,
      });
    }
  }
}

/**
 * Read pointer rides + active ride query, heal stale pointers, optionally assert availability.
 * @param {FirebaseFirestore.Transaction} tx
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   driverUid: string,
 *   vehicleId?: string | null,
 *   partnerRef: FirebaseFirestore.DocumentReference,
 *   vehicleRef?: FirebaseFirestore.DocumentReference | null,
 *   partnerSnap: FirebaseFirestore.DocumentSnapshot,
 *   vehicleSnap?: FirebaseFirestore.DocumentSnapshot | null,
 *   healOnly?: boolean,
 * }} opts
 */
async function reconcileDriverAvailabilityInTx(tx, db, opts) {
  const driverUid = String(opts.driverUid || "");
  const vehicleId = opts.vehicleId ? String(opts.vehicleId) : null;
  const partner = opts.partnerSnap?.exists ? opts.partnerSnap.data() || {} : {};
  const vehicle = opts.vehicleSnap?.exists ? opts.vehicleSnap.data() || {} : {};

  const rideIds = new Set();
  const partnerPtr = String(partner.activeRideId || "").trim();
  const vehiclePtr = String(vehicle.activeRideId || "").trim();
  if (partnerPtr) rideIds.add(partnerPtr);
  if (vehiclePtr) rideIds.add(vehiclePtr);

  /** @type {Map<string, FirebaseFirestore.DocumentSnapshot>} */
  const rideSnaps = new Map();
  for (const id of rideIds) {
    rideSnaps.set(id, await tx.get(db.collection("rides").doc(id)));
  }

  const activeQuery = db
    .collection("rides")
    .where("driverId", "==", driverUid)
    .where("status", "in", [...GENUINE_ACTIVE_STATUSES])
    .limit(1);
  const activeRideSnap = await tx.get(activeQuery);

  const evaluation = evaluateDriverAvailability({
    driverUid,
    vehicleId,
    partner,
    vehicle,
    rideSnaps,
    activeRideSnap,
  });

  applyPointerHealsInTx(tx, {
    partnerRef: opts.partnerRef,
    vehicleRef: opts.vehicleRef || null,
    heals: evaluation.heals,
  });

  if (!opts.healOnly && evaluation.blocked) {
    const e = new Error("DRIVER_HAS_ACTIVE_RIDE");
    e.code = "failed-precondition";
    throw e;
  }

  return evaluation;
}

/**
 * Heal stale pointers outside assignment flow (e.g. rematch, PIN link prep).
 */
async function healStaleDriverPointers(db, { driverUid, vehicleId = null } = {}) {
  if (!driverUid) return { healed: false, heals: [] };
  const partnerRef = db.collection("partners").doc(driverUid);
  const vehicleRef = vehicleId ? db.collection("vehicles").doc(String(vehicleId)) : null;

  return db.runTransaction(async (tx) => {
    const [partnerSnap, vehicleSnap] = await Promise.all([
      tx.get(partnerRef),
      vehicleRef ? tx.get(vehicleRef) : Promise.resolve(null),
    ]);
    const evaluation = await reconcileDriverAvailabilityInTx(tx, db, {
      driverUid,
      vehicleId,
      partnerRef,
      vehicleRef,
      partnerSnap,
      vehicleSnap,
      healOnly: true,
    });
    return { healed: evaluation.heals.length > 0, heals: evaluation.heals };
  });
}

/**
 * After healing, determine if driver can rematch / go online for dispatch.
 */
async function isDriverAvailableForRematch(db, vehicle) {
  const driverId = String(vehicle?.driverId || "");
  const vehicleId = String(vehicle?.id || vehicle?.vehicleId || "");
  if (!driverId || !vehicleId) return false;
  if (vehicle.status !== "online") return false;

  await healStaleDriverPointers(db, { driverUid: driverId, vehicleId });

  const [partnerSnap, vehicleSnap] = await Promise.all([
    db.collection("partners").doc(driverId).get(),
    db.collection("vehicles").doc(vehicleId).get(),
  ]);
  const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
  const vData = vehicleSnap.exists ? vehicleSnap.data() || {} : {};

  if (partner.accountStatus === "blocked" || partner.accountStatus === "suspended") {
    return false;
  }
  if (partner.activeRideId || vData.activeRideId) return false;

  const activeSnap = await db
    .collection("rides")
    .where("driverId", "==", driverId)
    .where("status", "in", [...GENUINE_ACTIVE_STATUSES])
    .limit(1)
    .get();
  return activeSnap.empty;
}

module.exports = {
  GENUINE_ACTIVE_STATUSES,
  STALE_POINTER_STATUSES,
  classifyPointerRide,
  evaluateDriverAvailability,
  applyPointerHealsInTx,
  reconcileDriverAvailabilityInTx,
  healStaleDriverPointers,
  isDriverAvailableForRematch,
};
