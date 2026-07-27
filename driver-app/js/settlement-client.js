/**
 * Phase 2A — call trusted completeRideSettlement Cloud Function.
 * Clients must not write commission / wallet / earnings.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

/**
 * @param {{ rideId: string, collectionName?: string }} params
 */
export async function requestRideSettlement(params) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) {
    throw new Error("FIREBASE_UNAVAILABLE");
  }
  const rideId = String(params?.rideId || "").trim();
  if (!rideId) throw new Error("INVALID_RIDE");

  const fn = httpsCallable(functions, "completeRideSettlement");
  const result = await fn({
    rideId,
    collectionName: "rides",
  });
  return result?.data || result;
}
