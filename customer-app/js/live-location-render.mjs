/**
 * Phase 1 — freshness, timestamp-aware marker interpolation, heading choice.
 * Pure helpers; map.js owns the single RAF loop.
 *
 * Coordinate policy (aligned with server envelope): only finite numbers in range.
 * Numeric strings are rejected.
 */

export const FRESHNESS_FRESH_MS = 15_000;
export const FRESHNESS_DELAYED_MS = 45_000;

export const ANIM_MIN_MS = 400;
export const ANIM_MAX_MS = 8_000;
export const ANIM_SNAP_STALE_MS = 30_000;
export const ANIM_SNAP_DISTANCE_M = 450;

export const FRESHNESS = Object.freeze({
  FRESH: "fresh",
  DELAYED: "delayed",
  STALE: "stale",
  UNKNOWN: "unknown",
});

export function isValidLatLng(lat, lng) {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Firestore Timestamp → milliseconds.
 * Supports toMillis(), {seconds,nanoseconds}, and numeric ms in unit tests.
 * Never uses Number(FirestoreTimestamp).
 */
export function timestampToMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
    const nanos = typeof value.nanoseconds === "number" ? value.nanoseconds : 0;
    const ms = value.seconds * 1000 + Math.floor(nanos / 1e6);
    return ms > 0 ? ms : null;
  }
  return null;
}

export function resolveFreshness(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return FRESHNESS.UNKNOWN;
  if (ageMs <= FRESHNESS_FRESH_MS) return FRESHNESS.FRESH;
  if (ageMs <= FRESHNESS_DELAYED_MS) return FRESHNESS.DELAYED;
  return FRESHNESS.STALE;
}

/**
 * Age of the mirrored driver location for UI freshness.
 * Uses the newest trustworthy timestamp among server + client fields.
 * Far-future device clocks (observedAt >> now) are ignored so they cannot
 * force a permanent "fresh" state — and cannot hide a newer server time either.
 *
 * Candidates (newest wins):
 * 1. ride.driverLocation.receivedAt (server)
 * 2. ride.driverLocationUpdatedAt (server / arbiter)
 * 3. ride.driverLocationReceivedAt (legacy client)
 * 4. ride.driverLocation.observedAt (device) when not far ahead of now
 *
 * Why newest-wins: arbiter/P2P paints often keep a stale nested receivedAt via
 * object spread while observedAt / driverLocationUpdatedAt are fresh. Preferring
 * only receivedAt incorrectly showed "Fresh driver location unavailable".
 */
export function locationAgeMs(ride, nowMs = Date.now()) {
  const loc = ride?.driverLocation;
  const skewLimit = nowMs + 5_000;
  const candidates = [];

  const receivedNested = timestampToMs(loc?.receivedAt);
  if (receivedNested != null && receivedNested <= skewLimit) candidates.push(receivedNested);

  const updated = timestampToMs(ride?.driverLocationUpdatedAt);
  if (updated != null && updated <= skewLimit) candidates.push(updated);

  const legacyTop = timestampToMs(ride?.driverLocationReceivedAt);
  if (legacyTop != null && legacyTop <= skewLimit) candidates.push(legacyTop);

  const observed = timestampToMs(loc?.observedAt);
  if (observed != null) {
    if (observed > skewLimit) {
      // Far-future device clock — ignore observedAt; fall through to other candidates.
    } else {
      candidates.push(observed);
    }
  }

  if (!candidates.length) {
    // Only a far-future observedAt (or nothing) → unknown freshness.
    if (observed != null && observed > skewLimit) return null;
    return null;
  }
  const newest = Math.max(...candidates);
  return Math.max(0, nowMs - newest);
}

export function computeAnimationDurationMs(prevObservedAt, nextObservedAt) {
  const prev = Number(prevObservedAt);
  const next = Number(nextObservedAt);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || next <= prev) {
    return ANIM_MIN_MS;
  }
  const gap = next - prev;
  return Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, gap));
}

export function easeInOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function interpolateLatLng(from, to, t) {
  const e = easeInOutCubic(t);
  return {
    lat: from.lat + (to.lat - from.lat) * e,
    lng: from.lng + (to.lng - from.lng) * e,
  };
}

function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function shouldSnapMarker(opts) {
  const {
    hasPrevious = false,
    gapMs = 0,
    distanceM = 0,
    previousInvalid = false,
  } = opts || {};
  if (!hasPrevious || previousInvalid) return true;
  if (gapMs > ANIM_SNAP_STALE_MS) return true;
  if (distanceM > ANIM_SNAP_DISTANCE_M) return true;
  return false;
}

export function resolveMarkerRotationDeg({
  headingDeg = null,
  previousFix = null,
  nextFix = null,
  derivedBearingFn = null,
}) {
  if (headingDeg != null && headingDeg !== "") {
    const h = Number(headingDeg);
    if (Number.isFinite(h) && h >= 0 && h <= 360) {
      return { deg: h === 360 ? 0 : h, kind: "gps_heading" };
    }
  }
  if (typeof derivedBearingFn === "function" && previousFix && nextFix) {
    const d = derivedBearingFn(previousFix, nextFix);
    if (Number.isFinite(d)) return { deg: d, kind: "derived_bearing" };
  }
  return { deg: 0, kind: "none" };
}

export function distanceMetres(a, b) {
  if (!a || !b) return 0;
  return haversineM(a, b);
}

export function derivedDisplayBearingDeg(from, to) {
  if (!from || !to) return null;
  if (!isValidLatLng(from.lat, from.lng)) return null;
  if (!isValidLatLng(to.lat, to.lng)) return null;
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) * 1000) / 1000;
}

export const APPROACH_LINE_KIND = "straight_line_estimate";
