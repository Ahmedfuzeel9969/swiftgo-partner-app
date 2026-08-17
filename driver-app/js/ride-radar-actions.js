/**
 * Driver offers and accept via trusted Cloud Functions (Phase 2A).
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";
import { markDriverOfferSent } from "./dispatch-latency.js";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

/**
 * Fire-and-forget dispatch telemetry. Server validates that this driver owns
 * the candidate invitation before persisting the receipt.
 */
export function recordDispatchDeliveryReceiptClient({
  rideId,
  dispatchTraceId,
  clientReceivedAtMs,
  clientRenderedAtMs,
}) {
  if (!rideId || !dispatchTraceId) return Promise.resolve({ ok: false, reason: "missing_trace" });
  return call("recordDispatchDeliveryReceipt", {
    rideId,
    dispatchTraceId,
    clientReceivedAtMs,
    clientRenderedAtMs,
  }).catch((err) => {
    console.info("[SwiftGo Latency] delivery receipt skipped", {
      rideId,
      code: String(err?.code || err?.message || "unknown"),
    });
    return { ok: false, reason: "call_failed" };
  });
}

/**
 * Propose fare; ride stays open until customer accepts or counters.
 */
export async function submitDriverOffer(params) {
  const { rideId, bidFare, driver, linkedVehicle } = params;
  if (!rideId || !driver?.uid || !linkedVehicle?.id) {
    throw new Error("VEHICLE_NOT_LINKED");
  }

  const { db } = getFirebase();
  if (!db) throw new Error("FIREBASE_UNAVAILABLE");

  const vehicleSnap = await getDoc(doc(db, "vehicles", linkedVehicle.id));
  if (!vehicleSnap.exists() || vehicleSnap.data().driverId !== driver.uid) {
    throw new Error("VEHICLE_NOT_LINKED");
  }
  const plate = vehicleSnap.data().plate || linkedVehicle.plate || "—";
  const ownerId = vehicleSnap.data().ownerId || linkedVehicle.ownerId;
  const bid = Math.max(0, Math.round(Number(bidFare) || 0));

  markDriverOfferSent(rideId, { bidFare: bid });
  const result = await call("submitRideOffer", {
    rideId,
    fare: bid,
    vehicleId: vehicleSnap.id,
    ownerId,
    driverName: driver.displayName || "SwiftGo Driver",
    vehiclePlate: plate,
  });

  return {
    rideId,
    bidFare: bid,
    offerId: result?.offerId,
    offerExpiresAtMs: result?.offerExpiresAtMs ?? null,
    offerSubmittedAtMs: result?.offerSubmittedAtMs ?? null,
    offerTimeoutSeconds: result?.offerTimeoutSeconds ?? null,
    pending: true,
    assigned: false,
  };
}

/**
 * Accept customer's initial estimated fare (direct assignment).
 */
export async function acceptCustomerInitialFare(params) {
  const { rideId, driver, linkedVehicle } = params;
  if (!rideId || !driver?.uid || !linkedVehicle?.id) {
    throw new Error("VEHICLE_NOT_LINKED");
  }

  const { db } = getFirebase();
  if (!db) throw new Error("FIREBASE_UNAVAILABLE");

  const vehicleSnap = await getDoc(doc(db, "vehicles", linkedVehicle.id));
  if (!vehicleSnap.exists() || vehicleSnap.data().driverId !== driver.uid) {
    throw new Error("VEHICLE_NOT_LINKED");
  }
  const plate = vehicleSnap.data().plate || linkedVehicle.plate || "—";
  const ownerId = vehicleSnap.data().ownerId || linkedVehicle.ownerId;

  const result = await call("acceptCustomerInitialFare", {
    rideId,
    vehicleId: vehicleSnap.id,
    ownerId,
    driverName: driver.displayName || "SwiftGo Driver",
    vehiclePlate: plate,
  });

  return {
    rideId,
    bidFare: result?.fare,
    collection: "rides",
    driverId: result?.driverId,
    assigned: true,
  };
}

/**
 * Accept customer counter (or finalize) via trusted assignment.
 */
export async function acceptRideWithBid(params) {
  const { rideId, driver } = params;
  if (!rideId || !driver?.uid) throw new Error("VEHICLE_NOT_LINKED");

  const offerId = `${rideId}_${driver.uid}`;
  const result = await call("finalizeAssignmentFromOffer", {
    offerId,
    as: "driver",
  });
  return {
    rideId,
    bidFare: result?.fare,
    collection: "rides",
    driverId: result?.driverId,
  };
}

/** Decline only this Driver's candidate invitation (does not cancel the booking). */
export async function declineRideCandidateClient(rideId) {
  return call("declineRideCandidate", { rideId });
}

/** Withdraw only this Driver's open offer. */
export async function withdrawRideOfferClient(rideId, driverUid) {
  const offerId = `${rideId}_${driverUid}`;
  return call("withdrawRideOffer", { offerId });
}

/** Assigned Driver cancels before start → trusted rematch. */
export async function cancelAssignedRideByDriverClient(rideId, { cancelReason, cancelReasonKey } = {}) {
  return call("cancelAssignedRideByDriver", {
    rideId,
    cancelReason,
    cancelReasonKey,
  });
}
