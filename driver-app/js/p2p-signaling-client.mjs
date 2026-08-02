/**
 * Phase 3 — signaling callables for P2P (driver).
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

async function call(name, payload) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const res = await httpsCallable(functions, name)(payload);
  return res?.data || res;
}

export function createRidePeerOfferClient(payload) {
  return call("createRidePeerOffer", payload);
}

export function closeRidePeerSessionClient(payload) {
  return call("closeRidePeerSession", payload);
}

export function watchRidePeerSession(rideId, onData, onError = () => {}) {
  const { ready, db, auth } = getFirebase();
  if (!ready || !auth?.currentUser || !rideId) {
    onError(new Error("NOT_SIGNED_IN"));
    return () => {};
  }
  return onSnapshot(
    doc(db, "ridePeerSessions", rideId),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}
