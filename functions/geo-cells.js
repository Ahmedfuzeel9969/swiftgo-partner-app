/**
 * Karachi geo-cells + Golden Hotspots for Phase 3B matching.
 * General grid ≈ 400 m; Golden Hotspot radius ≈ 0.5 km.
 * Pure helpers — safe for Cloud Functions and emulator tests.
 */

"use strict";

const { haversineKm } = require("./matching");

/** ≈400 m at Karachi latitudes (111 km/deg × 0.0036 ≈ 400 m). */
const MATCH_GRID_DEG = 0.0036;
const GOLDEN_HOTSPOT_RADIUS_KM = 0.5;
/** Firestore `in` / `array-contains-any` practical chunk size. */
const GEO_QUERY_CHUNK = 10;
/** Location older than this is ineligible for matching. */
const STALE_LOCATION_MS = 10 * 60 * 1000;

/**
 * Representative Karachi Golden Hotspots (centers).
 * Drivers within 0.5 km get hotspotId for dense-area queries.
 */
const GOLDEN_HOTSPOTS = Object.freeze([
  Object.freeze({ id: "hs_clifton", name: "Clifton", lat: 24.8138, lng: 67.0225 }),
  Object.freeze({ id: "hs_saddar", name: "Saddar", lat: 24.86, lng: 67.0011 }),
  Object.freeze({ id: "hs_gulshan", name: "Gulshan-e-Iqbal", lat: 24.9056, lng: 67.0822 }),
  Object.freeze({ id: "hs_defence", name: "DHA Phase 5", lat: 24.805, lng: 67.065 }),
  Object.freeze({ id: "hs_north_nazimabad", name: "North Nazimabad", lat: 24.935, lng: 67.035 }),
  Object.freeze({ id: "hs_airport", name: "Jinnah Airport", lat: 24.9065, lng: 67.1608 }),
  Object.freeze({ id: "hs_tariq_road", name: "Tariq Road", lat: 24.873, lng: 67.06 }),
  Object.freeze({ id: "hs_bahadurabad", name: "Bahadurabad", lat: 24.882, lng: 67.07 }),
]);

function assertLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function gridCellId(lat, lng) {
  if (!assertLatLng(lat, lng)) return null;
  return `g_${Math.floor(lat / MATCH_GRID_DEG)}_${Math.floor(lng / MATCH_GRID_DEG)}`;
}

function nearestGoldenHotspot(lat, lng) {
  if (!assertLatLng(lat, lng)) return null;
  let best = null;
  let bestKm = Infinity;
  for (const hs of GOLDEN_HOTSPOTS) {
    const d = haversineKm({ lat, lng }, hs);
    if (d != null && d < bestKm) {
      bestKm = d;
      best = hs;
    }
  }
  if (!best || bestKm > GOLDEN_HOTSPOT_RADIUS_KM) return null;
  return { ...best, distanceKm: bestKm };
}

function hotspotIdForLocation(lat, lng) {
  const hs = nearestGoldenHotspot(lat, lng);
  return hs ? hs.id : null;
}

/**
 * Cell ids whose square footprint may intersect a disk of radiusKm around pickup.
 * Includes diagonal padding so boundary drivers are not missed.
 */
function cellsCoveringDisk(lat, lng, radiusKm) {
  if (!assertLatLng(lat, lng) || !Number.isFinite(radiusKm) || radiusKm <= 0) return [];
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const latPad = radiusKm / 111;
  const lngPad = radiusKm / (111 * cosLat);
  const cellDiagKm =
    haversineKm(
      { lat: 0, lng: 0 },
      { lat: MATCH_GRID_DEG, lng: MATCH_GRID_DEG }
    ) || 0.6;
  const padKm = cellDiagKm / 2;
  const minLat = lat - latPad - padKm / 111;
  const maxLat = lat + latPad + padKm / 111;
  const minLng = lng - lngPad - padKm / (111 * cosLat);
  const maxLng = lng + lngPad + padKm / (111 * cosLat);

  const i0 = Math.floor(minLat / MATCH_GRID_DEG);
  const i1 = Math.floor(maxLat / MATCH_GRID_DEG);
  const j0 = Math.floor(minLng / MATCH_GRID_DEG);
  const j1 = Math.floor(maxLng / MATCH_GRID_DEG);

  const cells = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const cellLat = (i + 0.5) * MATCH_GRID_DEG;
      const cellLng = (j + 0.5) * MATCH_GRID_DEG;
      const d = haversineKm({ lat, lng }, { lat: cellLat, lng: cellLng });
      if (d != null && d <= radiusKm + padKm) {
        cells.push(`g_${i}_${j}`);
      }
    }
  }
  return cells;
}

/**
 * Hotspot ids whose 0.5 km disk intersects the search disk (pickup, radiusKm).
 */
function hotspotsIntersectingDisk(lat, lng, radiusKm) {
  const out = [];
  for (const hs of GOLDEN_HOTSPOTS) {
    const d = haversineKm({ lat, lng }, hs);
    if (d != null && d <= radiusKm + GOLDEN_HOTSPOT_RADIUS_KM) {
      out.push(hs.id);
    }
  }
  return out;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fields to write on vehicle location sync (client + tests).
 */
function locationGeoFields(lat, lng) {
  const geoCell = gridCellId(lat, lng);
  const hotspotId = hotspotIdForLocation(lat, lng);
  return {
    geoCell,
    hotspotId: hotspotId || null,
    locationGridCell: geoCell,
  };
}

module.exports = {
  MATCH_GRID_DEG,
  GOLDEN_HOTSPOT_RADIUS_KM,
  GEO_QUERY_CHUNK,
  STALE_LOCATION_MS,
  GOLDEN_HOTSPOTS,
  gridCellId,
  nearestGoldenHotspot,
  hotspotIdForLocation,
  cellsCoveringDisk,
  hotspotsIntersectingDisk,
  chunkArray,
  locationGeoFields,
};
