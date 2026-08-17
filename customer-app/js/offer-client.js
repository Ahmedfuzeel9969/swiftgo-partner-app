/**
 * Phase 2A — customer offer actions via trusted Cloud Functions.
 * L2: local timers + visibility/tick → expireRideOffer (server authoritative).
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
import { ensureDispatchOfferSettingsLoaded, getDispatchOfferTimeoutSeconds } from "./dispatch-offer-settings.mjs";

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

export async function expireRideOfferClient(offerId, { source = "customer" } = {}) {
  const id = String(offerId || "").trim();
  if (!id) return null;
  console.info("[SwiftGo] expireRideOffer_call", { offerId: id, source });
  try {
    const data = await call("expireRideOffer", { offerId: id });
    console.info("[SwiftGo] expireRideOffer_ok", { offerId: id, source, status: data?.status });
    return data;
  } catch (err) {
    console.warn("[SwiftGo] expireRideOffer_fail", {
      offerId: id,
      source,
      code: err?.code || err?.message,
    });
    throw err;
  }
}

export async function matchCandidatesForRide(rideId) {
  if (!rideId) {
    console.warn("[SwiftGo] matchRideCandidates skipped — missing rideId");
    return null;
  }
  try {
    return await call("matchRideCandidates", { rideId });
  } catch (err) {
    console.warn("[SwiftGo] matchRideCandidates", err?.code || err?.message);
    try {
      await new Promise((r) => setTimeout(r, 800));
      return await call("matchRideCandidates", { rideId });
    } catch (retryErr) {
      console.warn("[SwiftGo] matchRideCandidates retry", retryErr?.code || retryErr?.message);
      return null;
    }
  }
}

/** @param {unknown} value */
export function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const OFFER_SENT_STORAGE_PREFIX = "swiftgo_offer_sent_ms:";

export function rememberOfferSentAt(offerId, ms = Date.now()) {
  const id = String(offerId || "").trim();
  if (!id) return;
  try {
    sessionStorage.setItem(`${OFFER_SENT_STORAGE_PREFIX}${id}`, String(ms));
  } catch {
    /* ignore */
  }
}

function readOfferSentAt(offerId) {
  const id = String(offerId || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(`${OFFER_SENT_STORAGE_PREFIX}${id}`);
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

export function getOfferTimeoutSeconds(offer) {
  const fromDoc = Number(offer?.offerTimeoutSeconds);
  const fromAdmin = getDispatchOfferTimeoutSeconds();
  if (Number.isFinite(fromDoc) && fromDoc >= 5 && fromDoc <= 300) {
    const searchPollution = Number(offer?.searchTimeoutSeconds);
    if (
      Number.isFinite(searchPollution) &&
      fromDoc === searchPollution &&
      fromAdmin >= 5 &&
      fromAdmin !== fromDoc
    ) {
      return fromAdmin;
    }
    return Math.round(fromDoc);
  }
  return fromAdmin > 0 ? fromAdmin : 30;
}

export function computeOfferDeadlineMs(offer, opts = {}) {
  if (!offer || typeof offer !== "object") return null;
  const searchDeadlineMs = opts.searchDeadlineMs ?? null;
  const timeoutSec = getOfferTimeoutSeconds(offer);

  const submittedMs = Number(offer.offerSubmittedAtMs);
  if (Number.isFinite(submittedMs) && submittedMs > 0) {
    return submittedMs + timeoutSec * 1000;
  }
  if (opts.localSentAtMs != null && Number.isFinite(opts.localSentAtMs)) {
    return opts.localSentAtMs + timeoutSec * 1000;
  }
  const storedSent = readOfferSentAt(offer.id);
  if (storedSent != null) return storedSent + timeoutSec * 1000;

  const base = timestampToMs(offer.createdAt) || timestampToMs(offer.updatedAt);
  const fromBase = base != null ? base + timeoutSec * 1000 : null;

  let candidate = fromBase;
  if (candidate == null) {
    const explicitMs = Number(offer.offerExpiresAtMs);
    if (Number.isFinite(explicitMs) && explicitMs > 0) candidate = explicitMs;
    else {
      const direct = timestampToMs(offer.offerExpiresAt);
      if (direct != null) candidate = direct;
    }
  }

  if (
    candidate != null &&
    searchDeadlineMs != null &&
    Math.abs(candidate - searchDeadlineMs) < 5000
  ) {
    if (fromBase != null && Math.abs(fromBase - searchDeadlineMs) >= 5000) return fromBase;
    if (storedSent != null) return storedSent + timeoutSec * 1000;
    if (opts.localSentAtMs != null) return opts.localSentAtMs + timeoutSec * 1000;
    if (base != null) return base + timeoutSec * 1000;
    return Date.now() + timeoutSec * 1000;
  }
  return candidate;
}

export function resolveOfferExpiryMs(offer, searchDeadlineMs = null) {
  return computeOfferDeadlineMs(offer, { searchDeadlineMs });
}

export function offerExpiresAtMs(offer) {
  return resolveOfferExpiryMs(offer);
}

export function isOfferPastExpiryLocal(offer, nowMs = Date.now(), searchDeadlineMs = null) {
  const exp = resolveOfferExpiryMs(offer, searchDeadlineMs);
  if (exp == null) return false;
  return nowMs >= exp;
}

/**
 * Watch open/countered offers for a ride (customer view).
 * @param {string} rideId
 * @param {(offers: object[]) => void} onData
 * @param {(err: Error) => void} [onError]
 * @param {{ getSearchDeadlineMs?: () => number|null }} [opts]
 */
export function watchRideOffers(rideId, onData, onError = () => {}, opts = {}) {
  const getSearchDeadlineMs = opts.getSearchDeadlineMs || (() => null);
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

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {object[]} */
  let latestRaw = [];
  let tickTimer = null;

  function clearTimers() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function requestExpire(offerId) {
    expireRideOfferClient(offerId, { source: "customer_watch" }).catch(() => {});
  }

  function emitAlive() {
    const now = Date.now();
    const searchDl = getSearchDeadlineMs();
    const alive = latestRaw.filter((o) => !isOfferPastExpiryLocal(o, now, searchDl));
    onData(alive);
  }

  function flushExpired(source) {
    const now = Date.now();
    const searchDl = getSearchDeadlineMs();
    let changed = false;
    for (const offer of latestRaw) {
      if (!isOfferPastExpiryLocal(offer, now, searchDl)) continue;
      changed = true;
      requestExpire(offer.id);
    }
    if (changed) emitAlive();
    else if (source === "tick") {
      /* keep UI in sync near boundary */
      emitAlive();
    }
  }

  function schedule(offer) {
    const id = offer?.id;
    if (!id) return;
    const prev = timers.get(id);
    if (prev) clearTimeout(prev);
    const exp = computeOfferDeadlineMs(offer, { searchDeadlineMs: getSearchDeadlineMs() });
    if (exp == null) {
      console.warn("[SwiftGo] customer offer missing expiry fields", id);
      return;
    }
    const delay = Math.max(0, exp - Date.now());
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        flushExpired("customer_timer");
      }, delay)
    );
  }

  function onVisibility() {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      flushExpired("customer_visible");
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  tickTimer = setInterval(() => flushExpired("customer_tick"), 1000);
  void ensureDispatchOfferSettingsLoaded().then(() => {
    for (const offer of latestRaw) schedule(offer);
    flushExpired("settings_loaded");
  });

  const unsub = onSnapshot(
    q,
    (snap) => {
      latestRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const seen = new Set();
      const now = Date.now();
      for (const offer of latestRaw) {
        if (Number(offer.offerSubmittedAtMs) > 0) {
          rememberOfferSentAt(offer.id, Number(offer.offerSubmittedAtMs));
        }
        seen.add(offer.id);
        schedule(offer);
        if (isOfferPastExpiryLocal(offer, now)) requestExpire(offer.id);
      }
      for (const [id, t] of [...timers.entries()]) {
        if (!seen.has(id)) {
          clearTimeout(t);
          timers.delete(id);
        }
      }
      emitAlive();
    },
    onError
  );

  return () => {
    clearTimers();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    unsub();
  };
}
