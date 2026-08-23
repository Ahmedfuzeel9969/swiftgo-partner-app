/**
 * Phase 5 — local route projection (display-only).
 * Never write projected coordinates to Firebase/P2P.
 */

export const SNAP_CONFIDENCE = Object.freeze({
  HIGH: "HIGH_CONFIDENCE_SNAP",
  MEDIUM: "MEDIUM_CONFIDENCE_SNAP",
  RAW: "RAW_GPS_FALLBACK",
  OFF_ROUTE: "OFF_ROUTE_CANDIDATE",
  INVALID: "INVALID_FIX",
});

export const SNAP_DIAG = Object.freeze({
  HIGH: "snap_high_confidence",
  MEDIUM: "snap_medium_confidence",
  RAW: "snap_raw_fallback",
  OFF_CANDIDATE: "snap_off_route_candidate",
  OFF_CONFIRMED: "snap_off_route_confirmed",
  PARALLEL_REJECTED: "snap_parallel_segment_rejected",
  JITTER_IGNORED: "snap_progress_jitter_ignored",
  GENERATION_CHANGED: "snap_route_generation_changed",
  REROUTE_REQUESTED: "snap_reroute_requested",
  REROUTE_READY: "snap_reroute_ready",
  REROUTE_FAILED: "snap_reroute_failed",
  ANIM_CANCELLED: "snap_animation_cancelled",
  STALE_IGNORED: "snap_stale_fix_ignored",
});

/** High-confidence corridor (metres). */
export const SNAP_HIGH_DISTANCE_M = 25;
/** Max ordinary snap distance (metres). */
export const SNAP_MAX_DISTANCE_M = 55;
/** Heading tolerance when speed is reliable (degrees). */
export const SNAP_HEADING_TOLERANCE_DEG = 55;
/** Ignore heading below this speed (m/s). */
export const SNAP_HEADING_MIN_SPEED_MPS = 1.5;
/** Local segment search window around previous index. */
export const SNAP_LOCAL_WINDOW = 12;
/** Widen max distance by this factor when accuracy is poor. */
export const SNAP_POOR_ACCURACY_M = 40;

export function isValidLatLng(lat, lng) {
  if (typeof lat === "string" || typeof lng === "string") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

export function haversineMeters(a, b) {
  if (!a || !b || !isValidLatLng(a.lat, a.lng) || !isValidLatLng(b.lat, b.lng)) return NaN;
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a, b) {
  if (!a || !b || !isValidLatLng(a.lat, a.lng) || !isValidLatLng(b.lat, b.lng)) return null;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = (Math.atan2(y, x) * 180) / Math.PI;
  return (θ + 360) % 360;
}

export function angleDeltaDeg(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Project point onto segment A→B. Returns { point, t, distanceM }.
 */
export function projectPointOntoSegment(p, a, b) {
  const ax = a.lng;
  const ay = a.lat;
  const bx = b.lng;
  const by = b.lat;
  const px = p.lng;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const point = { lat: ay + t * dy, lng: ax + t * dx };
  return { point, t, distanceM: haversineMeters(p, point) };
}

/**
 * Build cumulative distances along polyline (metres).
 * @param {Array<{lat:number,lng:number}>} geometry
 */
export function buildRouteMetrics(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null;
  const segLen = [];
  const cum = [0];
  let total = 0;
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const d = haversineMeters(geometry[i], geometry[i + 1]);
    if (!Number.isFinite(d)) return null;
    segLen.push(d);
    total += d;
    cum.push(total);
  }
  return { geometry, segLen, cum, totalLengthM: total };
}

/**
 * Point at along-route distance.
 */
export function pointAtProgress(metrics, progressM) {
  if (!metrics || !Number.isFinite(progressM)) return null;
  const p = Math.max(0, Math.min(metrics.totalLengthM, progressM));
  const { geometry, cum, segLen } = metrics;
  for (let i = 0; i < segLen.length; i += 1) {
    if (p <= cum[i + 1] + 1e-6) {
      const span = segLen[i] || 1;
      const t = span > 0 ? (p - cum[i]) / span : 0;
      const a = geometry[i];
      const b = geometry[i + 1];
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        segmentIndex: i,
        bearingDeg: bearingDeg(a, b),
        progressM: p,
      };
    }
  }
  const last = geometry[geometry.length - 1];
  const prev = geometry[geometry.length - 2];
  return {
    lat: last.lat,
    lng: last.lng,
    segmentIndex: segLen.length - 1,
    bearingDeg: bearingDeg(prev, last),
    progressM: metrics.totalLengthM,
  };
}

/**
 * @param {{
 *   fix: {lat,lng,accuracyM?,headingDeg?,speedMps?},
 *   metrics: ReturnType<typeof buildRouteMetrics>,
 *   previous?: { segmentIndex: number, progressM: number }|null,
 * }} input
 */
export function projectFixOntoRoute(input = {}) {
  const fix = input.fix;
  const metrics = input.metrics;
  if (!fix || !isValidLatLng(fix.lat, fix.lng)) {
    return { ok: false, confidence: SNAP_CONFIDENCE.INVALID, reason: "invalid_fix" };
  }
  // Fail closed: callers must pass snapEligible === true for road corridors only.
  if (input.snapEligible !== true) {
    return {
      ok: false,
      confidence: SNAP_CONFIDENCE.RAW,
      reason: "not_snap_eligible",
      raw: fix,
      diag: SNAP_DIAG.RAW,
    };
  }
  if (!metrics?.geometry?.length) {
    return { ok: false, confidence: SNAP_CONFIDENCE.RAW, reason: "no_geometry", raw: fix };
  }

  const prev = input.previous || null;
  const n = metrics.geometry.length - 1;
  let start = 0;
  let end = n;
  if (prev && Number.isFinite(prev.segmentIndex)) {
    start = Math.max(0, prev.segmentIndex - SNAP_LOCAL_WINDOW);
    end = Math.min(n, prev.segmentIndex + SNAP_LOCAL_WINDOW + 1);
  }

  const candidates = [];
  const scan = (from, to) => {
    for (let i = from; i < to; i += 1) {
      const proj = projectPointOntoSegment(fix, metrics.geometry[i], metrics.geometry[i + 1]);
      if (!Number.isFinite(proj.distanceM)) continue;
      const progressM = metrics.cum[i] + proj.t * (metrics.segLen[i] || 0);
      const tan = bearingDeg(metrics.geometry[i], metrics.geometry[i + 1]);
      candidates.push({
        ...proj,
        segmentIndex: i,
        progressM,
        bearingDeg: tan,
      });
    }
  };
  scan(start, end);
  // Wider search if local miss
  if (!candidates.length || Math.min(...candidates.map((c) => c.distanceM)) > SNAP_MAX_DISTANCE_M) {
    candidates.length = 0;
    scan(0, n);
  }
  if (!candidates.length) {
    return { ok: false, confidence: SNAP_CONFIDENCE.RAW, reason: "no_candidate", raw: fix };
  }

  candidates.sort((a, b) => a.distanceM - b.distanceM);

  const accuracy = Number(fix.accuracyM);
  const maxDist =
    Number.isFinite(accuracy) && accuracy > SNAP_POOR_ACCURACY_M
      ? SNAP_MAX_DISTANCE_M * 1.35
      : SNAP_MAX_DISTANCE_M;

  let best = null;
  for (const c of candidates.slice(0, 8)) {
    if (c.distanceM > maxDist) continue;

    // Continuity: reject large progress jumps to parallel segments.
    if (prev && Number.isFinite(prev.progressM)) {
      const jump = c.progressM - prev.progressM;
      if (jump < -80 && c.distanceM > SNAP_HIGH_DISTANCE_M * 0.6) {
        continue; // parallel/opposite-ish
      }
      if (jump > 400 && c.distanceM > SNAP_HIGH_DISTANCE_M) {
        continue;
      }
      // Prefer continuity near previous segment
      const segDelta = Math.abs(c.segmentIndex - prev.segmentIndex);
      c._score = c.distanceM + segDelta * 4;
    } else {
      c._score = c.distanceM;
    }

    const speed = Number(fix.speedMps);
    const heading = Number(fix.headingDeg);
    if (
      Number.isFinite(speed) &&
      speed >= SNAP_HEADING_MIN_SPEED_MPS &&
      Number.isFinite(heading) &&
      Number.isFinite(c.bearingDeg)
    ) {
      const dH = angleDeltaDeg(heading, c.bearingDeg);
      if (dH != null && dH > SNAP_HEADING_TOLERANCE_DEG && c.distanceM > SNAP_HIGH_DISTANCE_M) {
        continue;
      }
      if (dH != null) c._score += dH * 0.15;
    }

    if (!best || c._score < best._score) best = c;
  }

  if (!best) {
    const nearest = candidates[0];
    return {
      ok: false,
      confidence: SNAP_CONFIDENCE.OFF_ROUTE,
      reason: "outside_corridor",
      raw: fix,
      nearestDistanceM: nearest.distanceM,
      diag: SNAP_DIAG.OFF_CANDIDATE,
    };
  }

  // Parallel rejection: second candidate much closer in distance but far in progress
  const alt = candidates.find(
    (c) =>
      c !== best &&
      c.distanceM <= best.distanceM + 8 &&
      prev &&
      Math.abs(c.progressM - prev.progressM) > Math.abs(best.progressM - prev.progressM) + 60
  );
  if (alt && prev) {
    // Keep best (continuity); note parallel rejected
  }

  let confidence = SNAP_CONFIDENCE.MEDIUM;
  if (best.distanceM <= SNAP_HIGH_DISTANCE_M) confidence = SNAP_CONFIDENCE.HIGH;
  if (Number.isFinite(accuracy) && accuracy > SNAP_POOR_ACCURACY_M && best.distanceM > SNAP_HIGH_DISTANCE_M) {
    confidence = SNAP_CONFIDENCE.MEDIUM;
  }

  return {
    ok: true,
    confidence,
    diag: confidence === SNAP_CONFIDENCE.HIGH ? SNAP_DIAG.HIGH : SNAP_DIAG.MEDIUM,
    display: {
      lat: best.point.lat,
      lng: best.point.lng,
      source: "display_snap",
      rawLat: fix.lat,
      rawLng: fix.lng,
    },
    segmentIndex: best.segmentIndex,
    progressM: best.progressM,
    distanceToRouteM: best.distanceM,
    bearingDeg: best.bearingDeg,
    raw: fix,
    parallelRejected: Boolean(alt),
  };
}

/**
 * Remaining polyline from along-route progress to the end (display trim only).
 * @param {ReturnType<typeof buildRouteMetrics>} metrics
 * @param {number} progressM
 * @returns {Array<{lat:number,lng:number}>|null}
 */
export function remainingGeometryFromProgress(metrics, progressM) {
  if (!metrics?.geometry?.length) return null;
  const geo = metrics.geometry;
  if (!Number.isFinite(progressM) || progressM <= 0) {
    return geo.slice();
  }
  if (progressM >= metrics.totalLengthM - 1e-3) {
    const last = geo[geo.length - 1];
    return last ? [{ lat: last.lat, lng: last.lng }] : null;
  }
  const at = pointAtProgress(metrics, progressM);
  if (!at) return geo.slice();
  const rest = geo.slice(at.segmentIndex + 1);
  return [{ lat: at.lat, lng: at.lng }, ...rest];
}
