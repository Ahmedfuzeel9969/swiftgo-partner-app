/**
 * Ride Radar — local-first pending ride feed via private ride_candidates invitations.
 * Canonical path: ride_candidates (invited) → rides/{rideId} (searching_driver).
 * ride_requests is legacy read-only archive — not queried here.
 */

import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";
import { markT3DriverCandidate } from "./dispatch-latency.js";
import { readLocalCache, writeLocalCache } from "./local-first-cache.js";

const CACHE_NAMESPACE = "ride_radar";
const CACHE_KEY = "pending_list";
const LIST_LIMIT = 40;

/** @typedef {import("./ride-radar-model.js").RadarRide} RadarRide */

/**
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 */
export function haversineKm(a, b) {
  if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function vehicleIcon(key = "", label = "") {
  const map = {
    bike: "🛵",
    go: "🚗",
    "go-plus": "🚙",
    business: "🚘",
    "bike-cargo": "📦",
    suzuki: "🚐",
    truck: "🚚",
  };
  const k = String(key || "").toLowerCase();
  if (map[k]) return map[k];
  const raw = String(label || "").toLowerCase();
  if (raw.includes("bike") || raw.includes("بائیک")) return "🛵";
  if (raw.includes("truck") || raw.includes("ٹرک")) return "🚚";
  return "🚗";
}

function pointFrom(loc) {
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    address: String(loc?.address || loc?.pickup || loc?.destination || "—").slice(0, 200),
  };
}

function fareFrom(data) {
  const v = Number(data?.estimatedFare ?? data?.farePkr ?? data?.fare ?? 0);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/**
 * @param {string} sourceCollection
 * @param {string} id
 * @param {Record<string, unknown>} data
 * @returns {RadarRide}
 */
export function normalizeRadarDoc(sourceCollection, id, data) {
  const pickup = pointFrom(data.pickupLocation || data.pickup);
  const dropoff = pointFrom(data.dropoffLocation || data.dropoff || data.destination);
  const tripKm = Number(data.distanceKm);
  const estimatedFare = fareFrom(data);

  return {
    id,
    sourceCollection,
    status: "pending",
    vehicleType: String(data.vehicleType || "گو").slice(0, 40),
    vehicleTypeKey: String(data.vehicleTypeKey || "").slice(0, 40),
    vehicleIcon: vehicleIcon(data.vehicleTypeKey, data.vehicleType),
    pickup,
    dropoff,
    tripKm: Number.isFinite(tripKm) && tripKm >= 0 ? tripKm : null,
    estimatedFare,
    riderUserId: String(data.userId || data.riderId || ""),
    riderRating: Number(data.riderRating ?? data.customerRating) || null,
    dispatchTraceId: String(data.dispatchTraceId || "").slice(0, 80),
    createdAtMs: timestampToMs(data.createdAt),
    expiresAtMs: rideSearchDeadlineMs(data) || null,
    searchExpireMs: Number(data.searchExpireMs) || null,
    rawStatus: String(data.status || "searching_driver"),
  };
}

function timestampToMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  return 0;
}

/** Server rides.expiresAt (or createdAt + searchExpireMs) — same rule as customer ride-flow. */
export function rideSearchDeadlineMs(ride) {
  const explicitMs = Number(ride?.expiresAtMs);
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
  const fromExpiresAt = timestampToMs(ride?.expiresAt);
  if (fromExpiresAt > 0) return fromExpiresAt;
  const created = timestampToMs(ride?.createdAt) || Number(ride?.createdAtMs) || 0;
  const perRideMs = Number(ride?.searchExpireMs);
  if (created > 0 && Number.isFinite(perRideMs) && perRideMs > 0) return created + perRideMs;
  if (created > 0) return created + 180_000;
  return 0;
}

function isTerminalSearchStatus(status) {
  return (
    status === "expired" ||
    status === "no_driver_found" ||
    status.startsWith("cancelled") ||
    status === "completed"
  );
}

export function isRideSearchExpired(ride, nowMs = Date.now()) {
  // Radar list uses status "pending" for UI — rawStatus holds Firestore rides.status.
  const status = String(ride?.rawStatus || ride?.status || "");
  if (isTerminalSearchStatus(status)) return true;
  if (status && status !== "searching_driver" && status !== "pending") return true;
  const deadline = rideSearchDeadlineMs(ride);
  return deadline > 0 && nowMs >= deadline;
}

function isRadarRideExpired(ride, nowMs = Date.now()) {
  const status = String(ride?.rawStatus || "searching_driver");
  if (isTerminalSearchStatus(status)) return true;
  if (status !== "searching_driver") return true;
  const deadline = rideSearchDeadlineMs(ride);
  return deadline > 0 && nowMs >= deadline;
}

/**
 * @param {RadarRide} ride
 * @param {{ lat: number, lng: number } | null} driverPos
 */
export function enrichRadarRide(ride, driverPos) {
  const pickupKm =
    driverPos && ride.pickup.lat != null
      ? haversineKm(driverPos, { lat: ride.pickup.lat, lng: ride.pickup.lng })
      : null;
  let tripKm = ride.tripKm;
  if (tripKm == null && ride.pickup.lat != null && ride.dropoff.lat != null) {
    tripKm = haversineKm(
      { lat: ride.pickup.lat, lng: ride.pickup.lng },
      { lat: ride.dropoff.lat, lng: ride.dropoff.lng }
    );
  }
  const distanceKm = tripKm ?? 0;
  const base = ride.estimatedFare || 0;
  const perKm = distanceKm > 0 ? base / distanceKm : base / 10;

  const bidOptions = buildBidOptions(base, distanceKm, perKm);

  return {
    ...ride,
    pickupDistanceKm: pickupKm != null ? Number(pickupKm.toFixed(1)) : null,
    tripDistanceKm: tripKm != null ? Number(tripKm.toFixed(1)) : null,
    riderRatingDisplay: ride.riderRating != null ? ride.riderRating.toFixed(1) : "4.8",
    bidOptions,
  };
}

export function buildBidOptions(baseFare, distanceKm, perKm) {
  const base = Math.max(0, Math.round(baseFare));
  const km = Math.max(0.1, distanceKm || 1);
  const rate = perKm > 0 ? perKm : base / km;
  const low = Math.max(50, Math.round(base * 0.95));
  const mid = Math.max(50, base || Math.round(rate * km));
  const high = Math.max(50, Math.round(base * 1.05));
  return [
    { amount: low, perKm: low / km, label: "اقتصادی" },
    { amount: mid, perKm: mid / km, label: "تجویز کردہ" },
    { amount: high, perKm: high / km, label: "زیادہ" },
  ];
}

/**
 * @param {RadarRide[]} rides
 * @param {{ lat: number, lng: number } | null} driverPos
 */
export function enrichRadarList(rides, driverPos) {
  return rides
    .map((r) => enrichRadarRide(r, driverPos))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** @param {string} driverUid */
export function readCachedRadarRides(driverUid) {
  const cached = readLocalCache(driverUid, CACHE_NAMESPACE, CACHE_KEY);
  if (!cached?.payload?.rides) return null;
  return {
    rides: /** @type {RadarRide[]} */ (cached.payload.rides),
    savedAt: cached.savedAt,
  };
}

function persistRadar(driverUid, rides) {
  writeLocalCache(driverUid, CACHE_NAMESPACE, CACHE_KEY, { rides });
}

function classifyListenerError(err) {
  const code = String(err?.code || err?.message || "listen_error").toLowerCase();
  if (code.includes("permission") || code.includes("denied")) return "permission_denied";
  if (code.includes("index") || code.includes("failed-precondition")) return "missing_index";
  if (code.includes("precondition")) return "failed_precondition";
  return "listen_error";
}

function usableCandidateRidePreview(preview) {
  return (
    preview &&
    typeof preview === "object" &&
    String(preview.status || "") === "searching_driver" &&
    Number.isFinite(Number(preview.pickupLocation?.lat)) &&
    Number.isFinite(Number(preview.pickupLocation?.lng)) &&
    Number.isFinite(Number(preview.dropoffLocation?.lat)) &&
    Number.isFinite(Number(preview.dropoffLocation?.lng))
  );
}

/**
 * @param {string} driverUid
 * @param {(state: { rides: RadarRide[], source: "cache"|"remote", syncing: boolean, savedAt?: string, invitedCandidateCount?: number, rideFetchErrors?: number, listenerError?: string }) => void} onData
 * @param {() => { lat: number, lng: number } | null} getDriverPosition
 * @param {() => boolean} [getIsBusy] — when true, no radar feed (driver on active ride)
 * @param {(ride: RadarRide, meta: { candidateId: string, receivedAtMs: number }) => void} [onCandidateHydrated]
 */
export function subscribePendingRadarRides(
  driverUid,
  onData,
  getDriverPosition,
  getIsBusy,
  onCandidateHydrated = () => {}
) {
  if (!driverUid) return () => {};
  if (getIsBusy?.()) {
    onData({ rides: [], source: "remote", syncing: false });
    return () => {};
  }

  const cached = readCachedRadarRides(driverUid);
  if (cached) {
    const now = Date.now();
    const alive = cached.rides.filter((r) => !isRadarRideExpired(r, now));
    onData({
      rides: enrichRadarList(alive, getDriverPosition()),
      source: "cache",
      syncing: true,
      savedAt: cached.savedAt,
    });
  }

  const { ready, db } = getFirebase();
  if (!ready || !db) {
    onData({
      rides: cached ? enrichRadarList(cached.rides, getDriverPosition()) : [],
      source: "cache",
      syncing: false,
      savedAt: cached?.savedAt,
    });
    return () => {};
  }

  const merged = new Map();
  let stopped = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let expiryTick = null;

  const emit = (syncing, meta = {}) => {
    if (stopped) return;
    if (getIsBusy?.()) {
      onData({ rides: [], source: "remote", syncing: false });
      return;
    }
    const now = Date.now();
    const alive = [...merged.values()].filter((r) => !isRadarRideExpired(r, now));
    const list = enrichRadarList(alive, getDriverPosition());
    persistRadar(
      driverUid,
      list.map(({ bidOptions, pickupDistanceKm, tripDistanceKm, riderRatingDisplay, ...core }) => core)
    );
    onData({
      rides: list,
      source: "remote",
      syncing: Boolean(syncing),
      savedAt: new Date().toISOString(),
      invitedCandidateCount: meta.invitedCandidateCount ?? snapInvitedCount,
      rideFetchErrors: meta.rideFetchErrors ?? 0,
      listenerError: meta.listenerError || "",
    });
  };

  let snapInvitedCount = 0;

  // Phase 2A: only rides where this driver is an invited candidate.
  const candQuery = query(
    collection(db, "ride_candidates"),
    where("driverId", "==", driverUid),
    where("status", "==", "invited"),
    limit(LIST_LIMIT)
  );

  const unsubCand = onSnapshot(
    candQuery,
    async (snap) => {
      const next = new Map();
      let rideFetchErrors = 0;
      snapInvitedCount = snap.size;
      await Promise.all(
        snap.docs.map(async (candDoc) => {
          const cand = candDoc.data() || {};
          const rideId = cand.rideId;
          if (!rideId) return;
          try {
            // New candidates contain a trusted server-written card preview.
            // Legacy candidates still use the canonical ride read as fallback.
            let data = cand.ridePreview;
            if (!usableCandidateRidePreview(data)) {
              const rideSnap = await getDoc(doc(db, "rides", rideId));
              if (!rideSnap.exists()) {
                rideFetchErrors += 1;
                return;
              }
              data = rideSnap.data() || {};
            }
            if (data.status !== "searching_driver") return;
            if (isRideSearchExpired(data)) return;
            const ride = normalizeRadarDoc("rides", rideId, {
              ...data,
              dispatchTraceId: cand.dispatchTraceId || data.dispatchTraceId || "",
              candidateDistanceKm: cand.distanceKm,
              candidateRingKm: cand.ringKm,
            });
            next.set(`rides:${rideId}`, ride);
            onCandidateHydrated(ride, {
              candidateId: candDoc.id,
              receivedAtMs: Date.now(),
            });
          } catch (err) {
            rideFetchErrors += 1;
            console.warn("[SwiftGo Radar] candidate hydrate", rideId, err);
          }
        })
      );
      if (stopped) return;
      merged.clear();
      for (const [k, v] of next) merged.set(k, v);
      for (const ride of next.values()) {
        markT3DriverCandidate(ride.id, { invitedCount: snapInvitedCount });
      }
      emit(false, { invitedCandidateCount: snapInvitedCount, rideFetchErrors });
    },
    (err) => {
      const listenerError = classifyListenerError(err);
      console.warn("[SwiftGo Radar] Firestore listen ride_candidates", listenerError, err);
      emit(false, {
        invitedCandidateCount: snapInvitedCount,
        rideFetchErrors: 0,
        listenerError,
      });
    }
  );

  expiryTick = setInterval(() => emit(false), 1000);

  return () => {
    stopped = true;
    if (expiryTick) clearInterval(expiryTick);
    unsubCand();
  };
}
