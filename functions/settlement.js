/**
 * Trusted ride settlement (Admin SDK). Used by Cloud Functions and emulator tests.
 * Clients must never compute commission or write wallet/earnings.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");

const DEFAULT_COMMISSION_PERCENT = 10;

function ledgerIdFor(collectionName, rideId) {
  return `settle_${collectionName}_${rideId}`;
}

function finiteMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : NaN;
}

function resolveGrossFare(ride) {
  const fare = finiteMoney(ride.farePkr ?? ride.estimatedFare ?? ride.driverBidFare);
  if (!Number.isFinite(fare) || fare < 0) {
    return null;
  }
  return Math.round(fare);
}

function resolveCommissionPercent(pricing, ride) {
  const vehicles = pricing?.vehicles || {};
  const key = String(ride.vehicleTypeKey || "").trim();
  if (key && vehicles[key] && Number.isFinite(Number(vehicles[key].commissionPercent))) {
    return Math.max(0, Number(vehicles[key].commissionPercent));
  }
  const type = String(ride.vehicleType || "").trim().toLowerCase();
  for (const [k, cfg] of Object.entries(vehicles)) {
    if (k.toLowerCase() === type && Number.isFinite(Number(cfg?.commissionPercent))) {
      return Math.max(0, Number(cfg.commissionPercent));
    }
  }
  const global = Number(pricing?.commissionPercent);
  if (Number.isFinite(global)) return Math.max(0, global);
  return DEFAULT_COMMISSION_PERCENT;
}

function calculateSplit(grossFare, commissionPercent) {
  const commissionAmount = Math.round((grossFare * commissionPercent) / 100);
  const driverEarnings = Math.max(0, Math.round(grossFare - commissionAmount));
  return { commissionAmount, driverEarnings };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   rideId: string,
 *   collectionName?: string,
 *   callerUid: string,
 *   isAdmin?: boolean,
 * }} params
 */
async function settleRide(db, params) {
  const rideId = String(params.rideId || "").trim();
  const collectionName = "rides";
  if (params.collectionName && params.collectionName !== "rides") {
    const err = new Error("LEGACY_COLLECTION_DENIED");
    err.code = "invalid-argument";
    throw err;
  }
  const callerUid = String(params.callerUid || "").trim();
  const isAdmin = Boolean(params.isAdmin);

  if (!rideId || !callerUid) {
    const err = new Error("INVALID_ARGUMENT");
    err.code = "invalid-argument";
    throw err;
  }

  const ledgerId = ledgerIdFor(collectionName, rideId);
  const rideRef = db.collection(collectionName).doc(rideId);
  const ledgerRef = db.collection("ledger_transactions").doc(ledgerId);
  const pricingRef = db.collection("settings").doc("pricing");
  const auditRef = db.collection("audit_logs").doc(`settle_${ledgerId}_${Date.now()}`);

  return db.runTransaction(async (tx) => {
    const [rideSnap, ledgerSnap, pricingSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(ledgerRef),
      tx.get(pricingRef),
    ]);

    if (!rideSnap.exists) {
      const err = new Error("RIDE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }

    const ride = rideSnap.data() || {};
    const customerId = String(ride.userId || "");
    const driverIdEarly = String(ride.driverId || "");
    const partnerRef = driverIdEarly
      ? db.collection("partners").doc(driverIdEarly)
      : null;
    const slotRef = customerId ? db.collection("booking_slots").doc(customerId) : null;

    // All reads before writes (Firestore transaction rule).
    const [partnerSnap, slotSnap] = await Promise.all([
      partnerRef ? tx.get(partnerRef) : Promise.resolve(null),
      slotRef ? tx.get(slotRef) : Promise.resolve(null),
    ]);

    // Idempotent retry: return existing settlement without re-posting.
    if (ride.status === "completed" && ledgerSnap.exists) {
      const ledger = ledgerSnap.data() || {};
      return {
        alreadySettled: true,
        rideId,
        collectionName,
        settlementId: ledgerId,
        commissionAmount: ledger.commissionAmount,
        driverEarnings: ledger.driverEarnings,
        grossFare: ledger.grossFare,
      };
    }

    if (ride.status === "completed") {
      const err = new Error("ALREADY_COMPLETED");
      err.code = "failed-precondition";
      throw err;
    }

    if (ride.status === "cancelled_by_user" || ride.status === "cancelled") {
      const err = new Error("RIDE_CANCELLED");
      err.code = "failed-precondition";
      throw err;
    }

    if (ride.status !== "in_progress") {
      const err = new Error("INVALID_STATUS");
      err.code = "failed-precondition";
      throw err;
    }

    const driverId = driverIdEarly;
    if (!driverId || !partnerRef) {
      const err = new Error("NO_DRIVER");
      err.code = "failed-precondition";
      throw err;
    }

    if (!isAdmin && driverId !== callerUid) {
      const err = new Error("NOT_ASSIGNED_DRIVER");
      err.code = "permission-denied";
      throw err;
    }

    const partner = partnerSnap?.exists ? partnerSnap.data() || {} : {};

    if (partner.accountStatus === "blocked") {
      const err = new Error("DRIVER_BLOCKED");
      err.code = "permission-denied";
      throw err;
    }

    const grossFare = resolveGrossFare(ride);
    if (grossFare == null || grossFare < 0) {
      const err = new Error("INVALID_FARE");
      err.code = "failed-precondition";
      throw err;
    }

    const pricing = pricingSnap.exists ? pricingSnap.data() || {} : {};
    const commissionPercent = resolveCommissionPercent(pricing, ride);
    const { commissionAmount, driverEarnings } = calculateSplit(grossFare, commissionPercent);

    if (ledgerSnap.exists) {
      // Ledger exists but ride not completed — heal ride to match ledger (no double post).
      const ledger = ledgerSnap.data() || {};
      tx.update(rideRef, {
        status: "completed",
        commissionAmount: ledger.commissionAmount,
        driverEarnings: ledger.driverEarnings,
        settlementId: ledgerId,
        settledAt: FieldValue.serverTimestamp(),
        commissionPercent: ledger.commissionPercent,
      });
      return {
        alreadySettled: true,
        rideId,
        collectionName,
        settlementId: ledgerId,
        commissionAmount: ledger.commissionAmount,
        driverEarnings: ledger.driverEarnings,
        grossFare: ledger.grossFare,
      };
    }

    const ledgerDoc = {
      rideId,
      collectionName,
      customerId,
      driverId,
      ownerId: String(ride.ownerId || ""),
      grossFare,
      commissionAmount,
      driverEarnings,
      commissionPercent,
      type: "ride_settlement",
      idempotencyKey: ledgerId,
      trustedCreator: "completeRideSettlement",
      status: "posted",
      createdAt: FieldValue.serverTimestamp(),
    };

    tx.set(ledgerRef, ledgerDoc);
    tx.update(rideRef, {
      status: "completed",
      commissionAmount,
      driverEarnings,
      settlementId: ledgerId,
      settledAt: FieldValue.serverTimestamp(),
      commissionPercent,
    });
    const partnerUpdate = {
      totalEarnings: FieldValue.increment(driverEarnings),
      totalRidesCompleted: FieldValue.increment(1),
      walletBalance: FieldValue.increment(-commissionAmount),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (partner.activeRideId === rideId) {
      partnerUpdate.activeRideId = FieldValue.delete();
    }
    tx.set(partnerRef, partnerUpdate, { merge: true });

    if (slotRef) {
      const count = slotSnap?.exists ? Math.max(0, Number(slotSnap.data()?.count || 0)) : 0;
      tx.set(
        slotRef,
        { count: Math.max(0, count - 1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    tx.set(auditRef, {
      action: "ride_settlement",
      rideId,
      collectionName,
      settlementId: ledgerId,
      actorUid: callerUid,
      driverId,
      customerId,
      grossFare,
      commissionAmount,
      driverEarnings,
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "completeRideSettlement",
    });

    return {
      alreadySettled: false,
      rideId,
      collectionName,
      settlementId: ledgerId,
      commissionAmount,
      driverEarnings,
      grossFare,
      commissionPercent,
    };
  });
}

function partialLedgerIdFor(rideId) {
  return `settle_partial_${rideId}`;
}

/**
 * Post partial fare ledger when customer cancels in_progress ride.
 * Idempotent — safe to retry if ride already carries settlementId.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   rideId: string,
 *   customerUid: string,
 *   driverId: string,
 *   cancellationFare: number,
 *   traveledDistanceKm: number,
 *   cancelledFromStatus?: string,
 * }} params
 */
async function settlePartialCancellation(db, params) {
  const rideId = String(params.rideId || "").trim();
  const customerUid = String(params.customerUid || "").trim();
  const driverId = String(params.driverId || "").trim();
  const grossFare = Math.round(Number(params.cancellationFare) || 0);
  const traveledDistanceKm = Math.max(0, Number(params.traveledDistanceKm) || 0);

  if (!rideId || !customerUid || !driverId) {
    const err = new Error("INVALID_ARGUMENT");
    err.code = "invalid-argument";
    throw err;
  }
  if (!Number.isFinite(grossFare) || grossFare < 0) {
    const err = new Error("INVALID_FARE");
    err.code = "failed-precondition";
    throw err;
  }

  const ledgerId = partialLedgerIdFor(rideId);
  const rideRef = db.collection("rides").doc(rideId);
  const ledgerRef = db.collection("ledger_transactions").doc(ledgerId);
  const pricingRef = db.collection("settings").doc("pricing");
  const partnerRef = db.collection("partners").doc(driverId);
  const slotRef = db.collection("booking_slots").doc(customerUid);
  const auditRef = db.collection("audit_logs").doc(`partial_cancel_${ledgerId}_${Date.now()}`);

  return db.runTransaction(async (tx) => {
    const [rideSnap, ledgerSnap, pricingSnap, partnerSnap, slotSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(ledgerRef),
      tx.get(pricingRef),
      tx.get(partnerRef),
      tx.get(slotRef),
    ]);

    if (!rideSnap.exists) {
      const err = new Error("RIDE_NOT_FOUND");
      err.code = "not-found";
      throw err;
    }

    const ride = rideSnap.data() || {};
    if (ride.status !== "cancelled_by_customer") {
      const err = new Error("INVALID_STATUS");
      err.code = "failed-precondition";
      throw err;
    }
    if (String(ride.userId || "") !== customerUid) {
      const err = new Error("NOT_YOUR_BOOKING");
      err.code = "permission-denied";
      throw err;
    }

    if (ledgerSnap.exists || ride.settlementId === ledgerId) {
      const ledger = ledgerSnap.exists ? ledgerSnap.data() || {} : {};
      return {
        alreadySettled: true,
        rideId,
        settlementId: ledgerId,
        grossFare: ledger.grossFare ?? grossFare,
        commissionAmount: ledger.commissionAmount,
        driverEarnings: ledger.driverEarnings,
        traveledDistanceKm,
      };
    }

    const pricing = pricingSnap.exists ? pricingSnap.data() || {} : {};
    const commissionPercent = resolveCommissionPercent(pricing, ride);
    const { commissionAmount, driverEarnings } = calculateSplit(grossFare, commissionPercent);

    const ledgerDoc = {
      rideId,
      collectionName: "rides",
      customerId: customerUid,
      driverId,
      ownerId: String(ride.ownerId || ""),
      grossFare,
      commissionAmount,
      driverEarnings,
      commissionPercent,
      traveledDistanceKm,
      type: "partial_cancellation_settlement",
      idempotencyKey: ledgerId,
      trustedCreator: "cancelCustomerBooking",
      status: "posted",
      createdAt: FieldValue.serverTimestamp(),
    };

    tx.set(ledgerRef, ledgerDoc);
    tx.update(rideRef, {
      farePkr: grossFare,
      cancellationFare: grossFare,
      traveledDistanceKm,
      commissionAmount,
      driverEarnings,
      settlementId: ledgerId,
      settledAt: FieldValue.serverTimestamp(),
      commissionPercent,
      partialCancellation: true,
    });

    if (partnerSnap.exists && grossFare > 0) {
      const partner = partnerSnap.data() || {};
      const partnerUpdate = {
        totalEarnings: FieldValue.increment(driverEarnings),
        totalRidesCompleted: FieldValue.increment(1),
        walletBalance: FieldValue.increment(-commissionAmount),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (partner.activeRideId === rideId) {
        partnerUpdate.activeRideId = FieldValue.delete();
      }
      tx.set(partnerRef, partnerUpdate, { merge: true });
    }

    const count = slotSnap?.exists ? Math.max(0, Number(slotSnap.data()?.count || 0)) : 0;
    tx.set(
      slotRef,
      { count: Math.max(0, count - 1), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    tx.set(auditRef, {
      action: "partial_cancellation_settlement",
      rideId,
      settlementId: ledgerId,
      actorUid: customerUid,
      driverId,
      customerId: customerUid,
      grossFare,
      traveledDistanceKm,
      commissionAmount,
      driverEarnings,
      cancelledFromStatus: params.cancelledFromStatus || ride.cancelledFromStatus || "in_progress",
      createdAt: FieldValue.serverTimestamp(),
      trustedCreator: "cancelCustomerBooking",
    });

    return {
      alreadySettled: false,
      rideId,
      settlementId: ledgerId,
      grossFare,
      commissionAmount,
      driverEarnings,
      traveledDistanceKm,
      commissionPercent,
    };
  });
}

module.exports = {
  settleRide,
  settlePartialCancellation,
  ledgerIdFor,
  partialLedgerIdFor,
  resolveGrossFare,
  calculateSplit,
  resolveCommissionPercent,
};
