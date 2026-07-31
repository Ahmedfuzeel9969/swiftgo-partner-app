/**
 * Dispatch / matching helpers — progressive 1→2→3 km rings + admin candidate limit.
 * Pure functions for Cloud Functions and emulator tests.
 */

"use strict";

const MIN_CANDIDATE_LIMIT = 1;
const MAX_CANDIDATE_LIMIT = 100;
const DEFAULT_CANDIDATE_LIMIT = 10;
/** @deprecated Legacy fixed rings — use buildSearchRingsKm(maxKm) from settings. */
const SEARCH_RINGS_KM = Object.freeze([1, 2, 3]);
const DEFAULT_MAX_SEARCH_RADIUS_KM = 3;
const MAX_SEARCH_RADIUS_KM = 50;
const MAX_SEARCH_RADIUS_METERS_EXTRA = 999;
const MAX_DRIVER_OPEN_BARGAINS = 10;
const MAX_CUSTOMER_ACTIVE_BOOKINGS = 4;
/** Default stale threshold — mirrored in geo-cells.js STALE_LOCATION_MS. */
const STALE_LOCATION_MS = 10 * 60 * 1000;
/** Authoritative searching timeout — createdAt/expiresAt + this → terminal `expired`. */
const SEARCH_EXPIRE_MS = 3 * 60 * 1000;

/** Canonical Customer ownership field on `rides` (never customerId/riderId). */
const CUSTOMER_RIDE_OWNER_FIELD = "userId";

const NON_TERMINAL_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
  "in_progress",
]);

/** Customer may cancel these statuses via trusted cancel callables. */
const CANCELLABLE_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
  "in_progress",
]);

/** Terminal status after 3-minute search with no final assignment. */
const SEARCH_EXPIRED_STATUS = "expired";

/** Assigned statuses a Driver may cancel before start (returns ride to searching). */
const DRIVER_PRE_START_CANCEL_STATUSES = Object.freeze(["accepted", "arrived"]);

const ACTIVE_RIDE_STATUSES = Object.freeze(["accepted", "arrived", "in_progress"]);
const OPEN_OFFER_STATUSES = Object.freeze(["open", "countered"]);

/**
 * Why a driver fixture is ineligible for matching (diagnostic; no PII).
 */
function classifyDriverMatchExclusion(d, { nowMs = Date.now(), staleMs = STALE_LOCATION_MS } = {}) {
  if (!d?.driverId) return "missing_driver_id";
  if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return "missing_location";
  if (d.accountStatus === "blocked") return "blocked";
  if (d.accountStatus === "suspended") return "suspended";
  if (d.status && d.status !== "online") return "offline";
  if (d.activeRideId) return "busy";
  if (d.locationUpdatedAtMs != null) {
    const age = nowMs - Number(d.locationUpdatedAtMs);
    if (!Number.isFinite(age) || age >= staleMs) return "stale_location";
  }
  if (d.missingGeoCell) return "missing_geo_cell";
  if (d.wrongVehicleType) return "wrong_vehicle_type";
  return null;
}

function validateCandidateDriverLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_CANDIDATE_LIMIT || n > MAX_CANDIDATE_LIMIT) {
    const err = new Error("INVALID_CANDIDATE_LIMIT");
    err.code = "invalid-argument";
    throw err;
  }
  return n;
}

/**
 * Validate combined KM + meters search radius from Super Admin UI.
 * @returns {{ maxSearchRadiusKm: number, maxSearchRadiusMeters: number }}
 */
function validateSearchRadius(kmInput, metersInput) {
  const km = Math.max(0, Math.floor(Number(kmInput) || 0));
  const meters = Math.max(0, Math.floor(Number(metersInput) || 0));
  if (km > MAX_SEARCH_RADIUS_KM) {
    const err = new Error("INVALID_SEARCH_RADIUS");
    err.code = "invalid-argument";
    throw err;
  }
  if (meters > MAX_SEARCH_RADIUS_METERS_EXTRA) {
    const err = new Error("INVALID_SEARCH_RADIUS");
    err.code = "invalid-argument";
    throw err;
  }
  const totalMeters = km * 1000 + meters;
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) {
    const err = new Error("INVALID_SEARCH_RADIUS");
    err.code = "invalid-argument";
    throw err;
  }
  const totalKm = totalMeters / 1000;
  if (totalKm > MAX_SEARCH_RADIUS_KM + MAX_SEARCH_RADIUS_METERS_EXTRA / 1000) {
    const err = new Error("INVALID_SEARCH_RADIUS");
    err.code = "invalid-argument";
    throw err;
  }
  return { maxSearchRadiusKm: totalKm, maxSearchRadiusMeters: totalMeters };
}

/**
 * Progressive 1 km steps up to configured max (e.g. 1.5 → [1, 1.5], 5 → [1..5]).
 * @param {number} maxKm
 * @returns {number[]}
 */
/** Max progressive rings per match — avoids O(maxKm) geo loops (504 at large radius). */
const MAX_SEARCH_RING_COUNT = 6;

function buildSearchRingsKm(maxKm) {
  const max = Number(maxKm);
  if (!Number.isFinite(max) || max <= 0) return [...SEARCH_RINGS_KM];
  if (max <= 1) return [max];

  const rings = [];
  const push = (km) => {
    const n = Math.round(Number(km) * 1000) / 1000;
    if (!Number.isFinite(n) || n <= 0) return;
    if (rings.length && rings[rings.length - 1] >= n) return;
    rings.push(n);
  };

  push(Math.min(1, max));
  if (max >= 2) push(2);
  if (max >= 3) push(3);

  let step = 5;
  while (rings[rings.length - 1] < max && rings.length < MAX_SEARCH_RING_COUNT - 1) {
    push(Math.min(step, max));
    step = step < 10 ? 10 : Math.min(max, Math.ceil(step * 2));
  }
  push(max);

  return rings.slice(0, MAX_SEARCH_RING_COUNT);
}

function haversineKm(a, b) {
  if (
    !Number.isFinite(a?.lat) ||
    !Number.isFinite(a?.lng) ||
    !Number.isFinite(b?.lat) ||
    !Number.isFinite(b?.lng)
  ) {
    return null;
  }
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

/**
 * Eligibility gate used by progressive selection (Phase 3B).
 * Busy = activeRideId set OR status in_ride / offline / missing location.
 */
function isEligibleMatchDriver(d, { nowMs = Date.now(), staleMs = STALE_LOCATION_MS, requireFreshLocation = false } = {}) {
  if (!d?.driverId) return false;
  if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return false;
  if (d.accountStatus === "blocked" || d.accountStatus === "suspended") return false;
  if (d.status && d.status !== "online") return false;
  if (d.activeRideId) return false;
  if (requireFreshLocation && d.locationUpdatedAtMs == null) return false;
  if (d.locationUpdatedAtMs != null) {
    const age = nowMs - Number(d.locationUpdatedAtMs);
    if (!Number.isFinite(age) || age >= staleMs) return false;
  }
  return true;
}

/**
 * Progressive rings 1→2→3 km until `limit` eligible drivers filled.
 * Drivers sorted by real proximity within each ring; duplicates skipped.
 *
 * @param {{ lat: number, lng: number }} pickup
 * @param {Array<{ driverId: string, lat: number, lng: number, status?: string, accountStatus?: string, activeRideId?: string|null, locationUpdatedAtMs?: number }>} drivers
 * @param {number} limit — validated 1–100
 * @param {{ nowMs?: number, staleMs?: number, ringsKm?: number[] }} [opts]
 */
function selectCandidatesProgressive(pickup, drivers, limit, opts = {}) {
  const cap = validateCandidateDriverLimit(limit);
  const rings = opts.ringsKm || SEARCH_RINGS_KM;
  const eligible = [];
  const seen = new Set();
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const staleMs = opts.staleMs != null ? opts.staleMs : STALE_LOCATION_MS;

  const prepared = (drivers || [])
    .map((d) => {
      const distanceKm = haversineKm(pickup, { lat: d.lat, lng: d.lng });
      return { ...d, distanceKm };
    })
    .filter((d) => {
      if (opts.excludeDriverIds && opts.excludeDriverIds.has(String(d.driverId))) return false;
      return d.distanceKm != null && isEligibleMatchDriver(d, { nowMs, staleMs, requireFreshLocation: opts.requireFreshLocation });
    })
    .sort((a, b) => a.distanceKm - b.distanceKm || String(a.driverId).localeCompare(String(b.driverId)));

  for (const ringKm of rings) {
    for (const d of prepared) {
      if (eligible.length >= cap) break;
      if (seen.has(d.driverId)) continue;
      if (d.distanceKm <= ringKm) {
        seen.add(d.driverId);
        eligible.push({
          driverId: d.driverId,
          distanceKm: Number(d.distanceKm.toFixed(3)),
          ringKm,
        });
      }
    }
    if (eligible.length >= cap) break;
  }

  return eligible.slice(0, cap);
}

function candidateDocId(rideId, driverId) {
  return `${rideId}_${driverId}`;
}

function isNonTerminalRideStatus(status) {
  return NON_TERMINAL_RIDE_STATUSES.includes(status);
}

function isActiveRideStatus(status) {
  return ACTIVE_RIDE_STATUSES.includes(status);
}

function isOpenOfferStatus(status) {
  return OPEN_OFFER_STATUSES.includes(status);
}

module.exports = {
  MIN_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_MAX_SEARCH_RADIUS_KM,
  MAX_SEARCH_RADIUS_KM,
  MAX_SEARCH_RADIUS_METERS_EXTRA,
  SEARCH_RINGS_KM,
  MAX_DRIVER_OPEN_BARGAINS,
  MAX_CUSTOMER_ACTIVE_BOOKINGS,
  STALE_LOCATION_MS,
  SEARCH_EXPIRE_MS,
  CUSTOMER_RIDE_OWNER_FIELD,
  NON_TERMINAL_RIDE_STATUSES,
  CANCELLABLE_RIDE_STATUSES,
  DRIVER_PRE_START_CANCEL_STATUSES,
  SEARCH_EXPIRED_STATUS,
  ACTIVE_RIDE_STATUSES,
  OPEN_OFFER_STATUSES,
  validateCandidateDriverLimit,
  validateSearchRadius,
  buildSearchRingsKm,
  haversineKm,
  isEligibleMatchDriver,
  classifyDriverMatchExclusion,
  selectCandidatesProgressive,
  candidateDocId,
  isNonTerminalRideStatus,
  isActiveRideStatus,
  isOpenOfferStatus,
};
