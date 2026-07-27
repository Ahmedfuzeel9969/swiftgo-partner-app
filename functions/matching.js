/**
 * Dispatch / matching helpers — progressive 1→2→3 km rings + admin candidate limit.
 * Pure functions for Cloud Functions and emulator tests.
 */

"use strict";

const ALLOWED_CANDIDATE_LIMITS = Object.freeze([10, 20]);
const DEFAULT_CANDIDATE_LIMIT = 10;
const SEARCH_RINGS_KM = Object.freeze([1, 2, 3]);
const MAX_DRIVER_OPEN_BARGAINS = 10;
const MAX_CUSTOMER_ACTIVE_BOOKINGS = 4;
/** Default stale threshold — mirrored in geo-cells.js STALE_LOCATION_MS. */
const STALE_LOCATION_MS = 3 * 60 * 1000;

const NON_TERMINAL_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
  "in_progress",
]);

const ACTIVE_RIDE_STATUSES = Object.freeze(["accepted", "arrived", "in_progress"]);
const OPEN_OFFER_STATUSES = Object.freeze(["open", "countered"]);

function validateCandidateDriverLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || !ALLOWED_CANDIDATE_LIMITS.includes(n)) {
    const err = new Error("INVALID_CANDIDATE_LIMIT");
    err.code = "invalid-argument";
    throw err;
  }
  return n;
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
    if (!Number.isFinite(age) || age > staleMs) return false;
  }
  return true;
}

/**
 * Progressive rings 1→2→3 km until `limit` eligible drivers filled.
 * Drivers sorted by real proximity within each ring; duplicates skipped.
 *
 * @param {{ lat: number, lng: number }} pickup
 * @param {Array<{ driverId: string, lat: number, lng: number, status?: string, accountStatus?: string, activeRideId?: string|null, locationUpdatedAtMs?: number }>} drivers
 * @param {number} limit — validated 10 or 20
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
    .filter((d) => d.distanceKm != null && isEligibleMatchDriver(d, { nowMs, staleMs, requireFreshLocation: opts.requireFreshLocation }))
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
  ALLOWED_CANDIDATE_LIMITS,
  DEFAULT_CANDIDATE_LIMIT,
  SEARCH_RINGS_KM,
  MAX_DRIVER_OPEN_BARGAINS,
  MAX_CUSTOMER_ACTIVE_BOOKINGS,
  STALE_LOCATION_MS,
  NON_TERMINAL_RIDE_STATUSES,
  ACTIVE_RIDE_STATUSES,
  OPEN_OFFER_STATUSES,
  validateCandidateDriverLimit,
  haversineKm,
  isEligibleMatchDriver,
  selectCandidatesProgressive,
  candidateDocId,
  isNonTerminalRideStatus,
  isActiveRideStatus,
  isOpenOfferStatus,
};
