/**
 * Phase 14 — Map routing & distance calculation.
 * 14.1: OSRM driving route drawn as a premium Uber-style polyline + auto fitBounds.
 * 14.2: totalDistance (km) & totalTime (min) kept in route state for fare math.
 */

import { getMap } from "./map.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

/** Uber-style route styling (kept in JS so no CSS/UI files change). */
const ROUTE_STYLE = {
  casing: { color: "#0e3d8f", weight: 9, opacity: 0.35, lineCap: "round", lineJoin: "round" },
  line: { color: "#276EF1", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" },
};
const FIT_PADDING = { paddingTopLeft: [48, 72], paddingBottomRight: [48, 96] };
/** Fallback average city speed when OSRM is unreachable. */
const FALLBACK_SPEED_KMH = 24;

/**
 * Route state — single source of truth for Phase 15 fare calculation.
 * totalDistance is in kilometers, totalTime in minutes.
 */
export const routeState = {
  pickup: null, // { lat, lng } | null
  dropoff: null, // { lat, lng } | null
  totalDistance: null, // km (number) | null
  totalTime: null, // min (number) | null
  source: null, // "osrm" | "estimate" | null
};

let routeLine = null;
let routeCasing = null;
let fetchSeq = 0;

function removeLayer(layer) {
  const map = getMap();
  if (layer && map) {
    try {
      map.removeLayer(layer);
    } catch {
      /* already removed */
    }
  }
  return null;
}

function clearRouteLine() {
  routeLine = removeLayer(routeLine);
  routeCasing = removeLayer(routeCasing);
}

function haversineKm(a, b) {
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

function announceRoute() {
  document.dispatchEvent(
    new CustomEvent("swiftgo:route-updated", {
      detail: {
        totalDistance: routeState.totalDistance,
        totalTime: routeState.totalTime,
        pickup: routeState.pickup,
        dropoff: routeState.dropoff,
        source: routeState.source,
      },
    })
  );
}

/**
 * Draw the polyline (with a darker casing underneath for a premium look)
 * and auto-fit the map so pins + route are fully visible.
 * @param {Array<[number, number]>} latlngs
 */
function drawRoute(latlngs) {
  const map = getMap();
  if (!map || typeof L === "undefined" || latlngs.length < 2) return;

  clearRouteLine();
  routeCasing = L.polyline(latlngs, { ...ROUTE_STYLE.casing, interactive: false }).addTo(map);
  routeLine = L.polyline(latlngs, { ...ROUTE_STYLE.line, interactive: false }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { ...FIT_PADDING, animate: true, maxZoom: 16 });
}

async function fetchOsrmRoute(pickup, dropoff) {
  const coords = `${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}`;
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OSRM_${res.status}`);
  const data = await res.json();
  const route = data?.routes?.[0];
  if (data?.code !== "Ok" || !route?.geometry?.coordinates?.length) {
    throw new Error("OSRM_NO_ROUTE");
  }
  return route;
}

/** Fetch + draw the route once both endpoints exist. */
async function refreshRoute() {
  const { pickup, dropoff } = routeState;
  if (!pickup || !dropoff) return;

  const seq = ++fetchSeq;
  try {
    const route = await fetchOsrmRoute(pickup, dropoff);
    if (seq !== fetchSeq) return; // a newer request superseded this one

    // GeoJSON is [lng, lat] — Leaflet wants [lat, lng].
    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeState.totalDistance = Math.round((route.distance / 1000) * 100) / 100;
    routeState.totalTime = Math.max(1, Math.round(route.duration / 60));
    routeState.source = "osrm";
    drawRoute(latlngs);
  } catch (err) {
    console.warn("[SwiftGo] OSRM route", err);
    if (seq !== fetchSeq) return;

    // Offline / rate-limit fallback: straight line + haversine estimate.
    const km = haversineKm(pickup, dropoff);
    routeState.totalDistance = Math.round(km * 100) / 100;
    routeState.totalTime = Math.max(1, Math.round((km / FALLBACK_SPEED_KMH) * 60));
    routeState.source = "estimate";
    drawRoute([
      [pickup.lat, pickup.lng],
      [dropoff.lat, dropoff.lng],
    ]);
  }

  announceRoute();
}

/**
 * Register a routed endpoint. Called wherever pickup/drop-off coords are set
 * (GPS, map pick, autocomplete, pasted maps link). Stops are ignored for now.
 * @param {'pickup'|'dropoff'|string} role
 * @param {number} lat
 * @param {number} lng
 */
export function setRoutePoint(role, lat, lng) {
  if (role !== "pickup" && role !== "dropoff") return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  routeState[role] = { lat, lng };
  refreshRoute();
}

/** Drop an endpoint (e.g. field cleared) and erase the polyline. */
export function clearRoutePoint(role) {
  if (role !== "pickup" && role !== "dropoff") return;
  routeState[role] = null;
  routeState.totalDistance = null;
  routeState.totalTime = null;
  routeState.source = null;
  fetchSeq += 1; // invalidate any in-flight fetch
  clearRouteLine();
  announceRoute();
}

/** Phase 15 will read distance/time from here to price each vehicle type. */
export function getRouteInfo() {
  return {
    totalDistance: routeState.totalDistance,
    totalTime: routeState.totalTime,
    pickup: routeState.pickup,
    dropoff: routeState.dropoff,
    source: routeState.source,
  };
}
