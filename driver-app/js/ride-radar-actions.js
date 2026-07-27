/**
 * Driver offers and accept via trusted Cloud Functions (Phase 2A).
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
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
    pending: true,
    assigned: false,
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
