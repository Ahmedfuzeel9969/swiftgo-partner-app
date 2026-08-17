/**
 * Driver offer inbox — watches open/countered ride_offers.
 * L1: local timer → hide + invoke expireRideOffer (server authoritative).
 */

import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";
import { ensureDispatchOfferSettingsLoaded, getDispatchOfferTimeoutSeconds } from "./dispatch-offer-settings.mjs";

const OPEN_STATUSES = ["open", "countered"];

/** PACKAGE: offer-expiry-diag — read-only runtime observation (remove after one capture). */
function logOfferExpiryDiag(source, payload) {
  const entry = { ts: new Date().toISOString(), source, ...payload };
  console.info("[SwiftGo][offer-expiry-diag]", entry);
  try {
    const ring = (window.__SWIFTGO_OFFER_EXPIRY_DIAG__ = window.__SWIFTGO_OFFER_EXPIRY_DIAG__ || []);
    ring.push(entry);
    if (ring.length > 500) ring.shift();
  } catch {
    /* ignore */
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

export function readOfferSentAt(offerId) {
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

/**
 * Offer deadline — offerSubmittedAtMs + offerTimeout first (never ride search expiry).
 * @param {object|null|undefined} offer
 * @param {{ searchDeadlineMs?: number|null, localSentAtMs?: number|null }} [opts]
 */
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

/** @deprecated use computeOfferDeadlineMs — kept for inbox expiry checks */
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

export async function requestExpireRideOffer(offerId, { source = "inbox" } = {}) {
  const id = String(offerId || "").trim();
  if (!id) return { ok: false, reason: "missing_id" };
  const { ready, functions } = getFirebase();
  if (!ready || !functions) return { ok: false, reason: "functions_unavailable" };
  try {
    console.info("[SwiftGo] expireRideOffer_call", { offerId: id, source });
    const data = await httpsCallable(functions, "expireRideOffer")({ offerId: id }).then(
      (r) => r?.data || r
    );
    console.info("[SwiftGo] expireRideOffer_ok", { offerId: id, source, status: data?.status });
    return { ok: true, data };
  } catch (err) {
    const code = err?.code || err?.message || "";
    console.warn("[SwiftGo] expireRideOffer_fail", { offerId: id, source, code: String(code) });
    return { ok: false, reason: String(code) };
  }
}

/**
 * @param {{
 *   getDriverUid: () => string | null,
 *   onOffersChanged?: (offersByRideId: Map<string, object>) => void,
 *   onCustomerCounter?: (offer: object) => void,
 * }} config
 */
export function createDriverOfferInbox(config) {
  const getDriverUid = config.getDriverUid || (() => null);
  const getSearchDeadlineMsForRide =
    config.getSearchDeadlineMsForRide || (() => null);
  const onOffersChanged = config.onOffersChanged || (() => {});
  const onCustomerCounter = config.onCustomerCounter || (() => {});

  /** @type {Map<string, object>} */
  let offersByRideId = new Map();
  /** @type {Map<string, number>} */
  let lastCounterByOfferId = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  let expiryTimers = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let tickTimer = null;
  let unsub = () => {};
  let primed = false;
  let activeUid = null;
  let listening = false;

  function clearExpiryTimers() {
    for (const t of expiryTimers.values()) clearTimeout(t);
    expiryTimers.clear();
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function searchDeadlineForOffer(offer) {
    const rideId = offer?.rideId;
    if (!rideId) return null;
    const ms = getSearchDeadlineMsForRide(String(rideId));
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  function publishFiltered() {
    const now = Date.now();
    const next = new Map();
    for (const [rideId, offer] of offersByRideId) {
      if (isOfferPastExpiryLocal(offer, now, searchDeadlineForOffer(offer))) continue;
      next.set(rideId, offer);
    }
    onOffersChanged(next);
  }

  function flushExpired(source) {
    const now = Date.now();
    let changed = false;
    for (const [rideId, offer] of [...offersByRideId.entries()]) {
      const searchDl = searchDeadlineForOffer(offer);
      if (!isOfferPastExpiryLocal(offer, now, searchDl)) continue;
      offersByRideId.delete(rideId);
      changed = true;
      void requestExpireRideOffer(offer.id, { source });
    }
    if (changed) publishFiltered();
  }

  function scheduleExpiry(offer) {
    const offerId = offer?.id;
    if (!offerId) return;
    const prev = expiryTimers.get(offerId);
    if (prev) clearTimeout(prev);
    const exp = resolveOfferExpiryMs(offer, searchDeadlineForOffer(offer));
    if (exp == null) {
      console.warn("[SwiftGo] offer missing expiry fields; cannot schedule", offerId);
      return;
    }
    const delay = Math.max(0, exp - Date.now());
    expiryTimers.set(
      offerId,
      setTimeout(() => {
        expiryTimers.delete(offerId);
        for (const [rideId, o] of offersByRideId) {
          if (o.id === offerId) offersByRideId.delete(rideId);
        }
        publishFiltered();
        void requestExpireRideOffer(offerId, { source: "inbox_timer" });
      }, delay)
    );
  }

  function ensureTick() {
    if (tickTimer) return;
    // Survives mobile background setTimeout throttling while the tab is open.
    tickTimer = setInterval(() => flushExpired("inbox_tick"), 1000);
  }

  function onVisibility() {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      flushExpired("inbox_visible");
    }
  }

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

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    ensureTick();
    void ensureDispatchOfferSettingsLoaded().then(() => {
      for (const offer of offersByRideId.values()) scheduleExpiry(offer);
      flushExpired("settings_loaded");
    });

    const q = query(
      collection(db, "ride_offers"),
      where("driverId", "==", uid),
      where("status", "in", OPEN_STATUSES)
    );

    unsub = onSnapshot(
      q,
      (snap) => {
        const next = new Map();
        const seenIds = new Set();
        const now = Date.now();
        for (const docSnap of snap.docs) {
          const offer = { id: docSnap.id, ...docSnap.data() };
          if (!offer.rideId) continue;
          seenIds.add(offer.id);
          scheduleExpiry(offer);
          const searchDl = searchDeadlineForOffer(offer);
          if (isOfferPastExpiryLocal(offer, now, searchDl)) {
            void requestExpireRideOffer(offer.id, { source: "inbox_snapshot" });
            continue;
          }
          next.set(offer.rideId, offer);

          const counter = Math.round(Number(offer.customerCounterFare) || 0);
          const prev = lastCounterByOfferId.get(offer.id) ?? 0;
          const isCountered = offer.status === "countered" && counter > 0;
          if (primed && isCountered && counter !== prev) {
            onCustomerCounter(offer);
          }
          lastCounterByOfferId.set(offer.id, counter);
        }
        for (const [id, timer] of [...expiryTimers.entries()]) {
          if (!seenIds.has(id)) {
            clearTimeout(timer);
            expiryTimers.delete(id);
          }
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
    clearExpiryTimers();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    primed = false;
    listening = false;
    activeUid = null;
    lastCounterByOfferId = new Map();
    offersByRideId = new Map();
  }

  function getOfferForRide(rideId) {
    const raw = offersByRideId.get(rideId) || null;
    const searchDl = raw ? searchDeadlineForOffer(raw) : null;
    const offer = raw && isOfferPastExpiryLocal(raw, Date.now(), searchDl) ? null : raw;
    logOfferExpiryDiag("getOfferForRide", {
      rideId: rideId || null,
      inboxOfferExists: offer != null,
      myOfferStateExists: null,
      offerId: offer?.id ?? raw?.id ?? null,
      offerStatus: offer?.status ?? raw?.status ?? null,
    });
    return offer;
  }

  function rideIdsWithCustomerCounter() {
    const ids = [];
    for (const [rideId, offer] of offersByRideId) {
      if (isOfferPastExpiryLocal(offer)) continue;
      const counter = Math.round(Number(offer.customerCounterFare) || 0);
      if (offer.status === "countered" && counter > 0) ids.push(rideId);
    }
    return ids;
  }

  return { start, stop, getOfferForRide, rideIdsWithCustomerCounter, flushExpired };
}
