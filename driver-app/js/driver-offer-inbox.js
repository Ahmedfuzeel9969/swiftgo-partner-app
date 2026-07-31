/**
 * Background watch for driver ride_offers — notifies when customer counters.
 */

import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const OPEN_STATUSES = ["open", "countered"];

/**
 * @param {{
 *   getDriverUid: () => string | null,
 *   onOffersChanged?: (offersByRideId: Map<string, object>) => void,
 *   onCustomerCounter?: (offer: object) => void,
 * }} config
 */
export function createDriverOfferInbox(config) {
  const getDriverUid = config.getDriverUid || (() => null);
  const onOffersChanged = config.onOffersChanged || (() => {});
  const onCustomerCounter = config.onCustomerCounter || (() => {});

  /** @type {Map<string, object>} */
  let offersByRideId = new Map();
  /** @type {Map<string, number>} */
  let lastCounterByOfferId = new Map();
  let unsub = () => {};
  let primed = false;
  let activeUid = null;
  let listening = false;

  function start() {
    const uid = getDriverUid();
    if (!uid) {
      stop();
      onOffersChanged(offersByRideId);
      return;
    }
    if (listening && activeUid === uid) return;

    stop();
    activeUid = uid;

    const { db } = getFirebase();
    if (!db) return;

    const q = query(
      collection(db, "ride_offers"),
      where("driverId", "==", uid),
      where("status", "in", OPEN_STATUSES)
    );

    unsub = onSnapshot(
      q,
      (snap) => {
        const next = new Map();
        for (const doc of snap.docs) {
          const offer = { id: doc.id, ...doc.data() };
          if (!offer.rideId) continue;
          next.set(offer.rideId, offer);

          const counter = Math.round(Number(offer.customerCounterFare) || 0);
          const prev = lastCounterByOfferId.get(offer.id) ?? 0;
          const isCountered = offer.status === "countered" && counter > 0;
          if (primed && isCountered && counter !== prev) {
            onCustomerCounter(offer);
          }
          lastCounterByOfferId.set(offer.id, counter);
        }
        offersByRideId = next;
        primed = true;
        listening = true;
        onOffersChanged(offersByRideId);
      },
      (err) => {
        console.warn("[SwiftGo] driver offer inbox", err);
        listening = false;
      }
    );
  }

  function stop() {
    unsub();
    unsub = () => {};
    primed = false;
    listening = false;
    activeUid = null;
    lastCounterByOfferId = new Map();
    offersByRideId = new Map();
  }

  function getOfferForRide(rideId) {
    return offersByRideId.get(rideId) || null;
  }

  function rideIdsWithCustomerCounter() {
    const ids = [];
    for (const [rideId, offer] of offersByRideId) {
      const counter = Math.round(Number(offer.customerCounterFare) || 0);
      if (offer.status === "countered" && counter > 0) ids.push(rideId);
    }
    return ids;
  }

  return { start, stop, getOfferForRide, rideIdsWithCustomerCounter };
}
