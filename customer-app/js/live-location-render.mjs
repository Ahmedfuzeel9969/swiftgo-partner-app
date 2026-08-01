/**
 * Phase 1 — freshness, timestamp-aware marker interpolation, heading choice.
 * Pure helpers; map.js owns the single RAF loop.
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

export function resolveFreshness(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return FRESHNESS.UNKNOWN;
  if (ageMs <= FRESHNESS_FRESH_MS) return FRESHNESS.FRESH;
  if (ageMs <= FRESHNESS_DELAYED_MS) return FRESHNESS.DELAYED;
  return FRESHNESS.STALE;
}

export function locationAgeMs(ride, nowMs = Date.now()) {
  const received = Number(ride?.driverLocationReceivedAt);
  if (Number.isFinite(received) && received > 0) return Math.max(0, nowMs - received);

  const loc = ride?.driverLocation;
  const observed = Number(loc?.observedAt);
  if (Number.isFinite(observed) && observed > 0) return Math.max(0, nowMs - observed);

  const ts = ride?.driverLocationUpdatedAt;
  if (!ts) return null;
  let ms = 0;
  if (typeof ts.toMillis === "function") ms = ts.toMillis();
  else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
  else if (Number.isFinite(Number(ts))) ms = Number(ts);
  if (!ms) return null;
  return Math.max(0, nowMs - ms);
}

/**
 * Animation duration from interval between accepted fixes.
 */
export function computeAnimationDurationMs(prevObservedAt, nextObservedAt) {
  const prev = Number(prevObservedAt);
  const next = Number(nextObservedAt);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || next <= prev) {
    return ANIM_MIN_MS;
  }
  const gap = next - prev;
  return Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, gap));
}

/**
 * Ease-in-out cubic for marker interpolation.
 */
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

/**
 * Decide snap vs animate.
 */
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

/**
 * Prefer actual GPS heading; else derived display bearing from consecutive fixes.
 * Never points toward pickup/dropoff.
 */
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

/** Derived display bearing from consecutive accepted fixes (not GPS heading). */
export function derivedDisplayBearingDeg(from, to) {
  if (!from || !to) return null;
  const lat1 = Number(from.lat);
  const lng1 = Number(from.lng);
  const lat2 = Number(to.lat);
  const lng2 = Number(to.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) * 1000) / 1000;
}

/** Phase-1 route UI must not claim road routing. */
export const APPROACH_LINE_KIND = "straight_line_estimate";
