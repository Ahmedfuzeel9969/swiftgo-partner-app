/**
 * Phase 4 — route geometry helpers and validation (provider-neutral).
 * Coordinates must never be logged.
 */

import { attachGeometryQuality } from "./geometry-quality.mjs";

export const ROUTE_MAX_GEOMETRY_POINTS = 2_000;
export const ROUTE_MAX_RENDER_POINTS = 400;
export const ROUTE_MAX_PAYLOAD_CHARS = 500_000;
export const ROUTE_MIN_GEOMETRY_POINTS = 2;
export const ROUTE_MAX_DISTANCE_M = 500_000; // 500 km
export const ROUTE_MAX_DURATION_S = 36_000; // 10 h
export const ROUTE_ENDPOINT_TOLERANCE_M = 750;

export function isValidLatLng(lat, lng) {
  if (typeof lat === "string" || typeof lng === "string") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

export function haversineMeters(a, b) {
  if (!a || !b) return NaN;
  if (!isValidLatLng(a.lat, a.lng) || !isValidLatLng(b.lat, b.lng)) return NaN;
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

/**
 * @param {Array<{lat:number,lng:number}>} points
 * @param {number} maxPoints
 */
export function simplifyGeometry(points, maxPoints = ROUTE_MAX_RENDER_POINTS) {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return Array.isArray(points) ? points.slice() : [];
  }
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(points.length - 1, Math.round(i * step));
    out.push(points[idx]);
  }
  return out;
}

/**
 * Normalize provider geometry to [{lat,lng}, ...].
 * Accepts GeoJSON [lng,lat][] or {lat,lng}[].
 */
export function normalizeGeometry(raw) {
  if (!Array.isArray(raw) || raw.length < ROUTE_MIN_GEOMETRY_POINTS) {
    return { ok: false, reason: "missing_geometry" };
  }
  if (raw.length > ROUTE_MAX_GEOMETRY_POINTS) {
    return { ok: false, reason: "excessive_points" };
  }
  const points = [];
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2) {
      const lng = p[0];
      const lat = p[1];
      if (typeof lat === "string" || typeof lng === "string") {
        return { ok: false, reason: "numeric_string_coords" };
      }
      if (!isValidLatLng(lat, lng)) return { ok: false, reason: "invalid_coords" };
      points.push({ lat, lng });
      continue;
    }
    if (p && typeof p === "object") {
      const lat = p.lat;
      const lng = p.lng;
      if (typeof lat === "string" || typeof lng === "string") {
        return { ok: false, reason: "numeric_string_coords" };
      }
      if (!isValidLatLng(lat, lng)) return { ok: false, reason: "invalid_coords" };
      points.push({ lat, lng });
      continue;
    }
    return { ok: false, reason: "malformed_point" };
  }
  return { ok: true, geometry: points };
}

/**
 * @param {object} result — provider-neutral route result
 * @param {{ origin:{lat,lng}, destination:{lat,lng}, nowMs?: number }} req
 */
export function validateRouteResult(result, req = {}) {
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "not_object" };
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > ROUTE_MAX_PAYLOAD_CHARS) {
    return { ok: false, reason: "oversized_payload" };
  }
  if (result.version != null && Number(result.version) !== 1) {
    return { ok: false, reason: "unknown_version" };
  }

  const geo = normalizeGeometry(result.geometry);
  if (!geo.ok) return geo;

  const distanceMeters = Number(result.distanceMeters);
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || distanceMeters > ROUTE_MAX_DISTANCE_M) {
    return { ok: false, reason: "invalid_distance" };
  }
  const durationSeconds = Number(result.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > ROUTE_MAX_DURATION_S) {
    return { ok: false, reason: "invalid_duration" };
  }

  const origin = req.origin;
  const destination = req.destination;
  if (origin && destination) {
    const start = geo.geometry[0];
    const end = geo.geometry[geo.geometry.length - 1];
    const d0 = haversineMeters(origin, start);
    const d1 = haversineMeters(destination, end);
    if (
      !Number.isFinite(d0) ||
      !Number.isFinite(d1) ||
      d0 > ROUTE_ENDPOINT_TOLERANCE_M ||
      d1 > ROUTE_ENDPOINT_TOLERANCE_M
    ) {
      return { ok: false, reason: "endpoint_mismatch" };
    }
  }

  // Derive geometryKind / snapEligible canonically — ignore inbound self-declarations.
  const qualityAttached = attachGeometryQuality({
    provider: String(result.provider || "unknown").slice(0, 64),
    quality: String(result.quality || "unknown").slice(0, 32),
    fallback: result.fallback === true,
  });

  return {
    ok: true,
    route: {
      provider: qualityAttached.provider,
      providerKind: qualityAttached.providerKind,
      geometry: geo.geometry,
      renderGeometry: simplifyGeometry(geo.geometry),
      distanceMeters,
      durationSeconds,
      generatedAt: Number(result.generatedAt) || req.nowMs || Date.now(),
      attribution: sanitizeAttribution(result.attribution),
      quality: qualityAttached.quality,
      geometryKind: qualityAttached.geometryKind,
      snapEligible: qualityAttached.snapEligible,
      version: 1,
    },
  };
}

export function sanitizeAttribution(raw) {
  if (raw == null) return "";
  const s = String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/[<>&"']/g, "")
    .trim();
  return s.slice(0, 120);
}

/** Straight-line fallback geometry (exactly 2 points). */
export function buildDirectFallback(origin, destination) {
  if (!isValidLatLng(origin?.lat, origin?.lng) || !isValidLatLng(destination?.lat, destination?.lng)) {
    return null;
  }
  const distanceMeters = haversineMeters(origin, destination);
  const durationSeconds = (distanceMeters / 1000 / 24) * 3600;
  return attachGeometryQuality({
    provider: "direct_fallback",
    geometry: [
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    ],
    distanceMeters,
    durationSeconds,
    generatedAt: Date.now(),
    attribution: "",
    quality: "estimate",
    version: 1,
    fallback: true,
  });
}

export { GEOMETRY_KIND, classifyRouteGeometry, isSnapEligibleMeta, attachGeometryQuality } from "./geometry-quality.mjs";
