/**
 * Phase 2A — customer offer actions via trusted Cloud Functions.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  collection,
  query,
  where,
  onSnapshot,
  limit,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

export async function finalizeOfferAsCustomer(offerId) {
  return call("finalizeAssignmentFromOffer", { offerId, as: "customer" });
}

export async function counterOfferAsCustomer(offerId, fare) {
  return call("counterRideOffer", { offerId, fare });
}

export async function rejectOfferAsCustomer(offerId) {
  return call("rejectRideOffer", { offerId });
}

export async function matchCandidatesForRide(rideId) {
  try {
    return await call("matchRideCandidates", { rideId });
  } catch (err) {
    console.warn("[SwiftGo] matchRideCandidates", err?.code || err?.message);
    return null;
  }
}

/**
 * Watch open/countered offers for a ride (customer view).
 */
export function watchRideOffers(rideId, onData, onError = () => {}) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) {
    onError(new Error("NOT_SIGNED_IN"));
    return () => {};
  }
  const q = query(
    collection(db, "ride_offers"),
    where("rideId", "==", rideId),
    where("customerId", "==", auth.currentUser.uid),
    where("status", "in", ["open", "countered"]),
    limit(20)
  );
  return onSnapshot(
    q,
    (snap) => {
      const offers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      onData(offers);
    },
    onError
  );
}
