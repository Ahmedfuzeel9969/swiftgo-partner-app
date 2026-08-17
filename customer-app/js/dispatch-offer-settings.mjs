/**
 * Read settings/dispatch.offerTimeoutSeconds for client-side offer expiry fallback.
 */

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const DEFAULT_OFFER_TIMEOUT_SECONDS = 30;
let cachedOfferTimeoutSeconds = DEFAULT_OFFER_TIMEOUT_SECONDS;
let loadPromise = null;

export function getDispatchOfferTimeoutSeconds() {
  return cachedOfferTimeoutSeconds;
}

export function ensureDispatchOfferSettingsLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { ready, db } = getFirebase();
    if (!ready || !db) return cachedOfferTimeoutSeconds;
    try {
      const snap = await getDoc(doc(db, "settings", "dispatch"));
      const sec = Number(snap.data()?.offerTimeoutSeconds);
      if (Number.isFinite(sec) && sec >= 5) {
        cachedOfferTimeoutSeconds = Math.min(300, Math.max(5, Math.round(sec)));
      }
    } catch (err) {
      console.warn("[SwiftGo] dispatch offer timeout read", err);
    }
    return cachedOfferTimeoutSeconds;
  })();
  return loadPromise;
}
