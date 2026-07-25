/**
 * Phase 14 / 45.4 — Map routing, distance, and traffic-aware ETA.
 * Draws pickup→dropoff polyline + updates the on-map route summary chip.
 */

import { getMap, getTrafficEnabled } from "./map.js";
import { t, subscribe } from "./i18n.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

const ROUTE_STYLE = {
  casing: { color: "#064e3b", weight: 10, opacity: 0.35, lineCap: "round", lineJoin: "round" },
  line: { color: "#0b7a4b", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" },
};
const FIT_PADDING = { paddingTopLeft: [48, 100], paddingBottomRight: [48, 140] };
const FALLBACK_SPEED_KMH = 24;
/** Extra travel-time multiplier when traffic overlay is on. */
const TRAFFIC_ETA_FACTOR = 1.35;

export const routeState = {
  pickup: null,
  dropoff: null,
  totalDistance: null,
  totalTime: null,
  totalTimeBase: null,
  trafficAdjusted: false,
  source: null,
};

let routeLine = null;
let routeCasing = null;
let fetchSeq = 0;
/** @type {number | null} */
let lastDurationSec = null;
/** @type {Array<[number, number]> | null} */
let lastLatlngs = null;
let uiBound = false;

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

function rushHourFactor() {
  const h = new Date().getHours();
  if ((h >= 8 && h <= 10) || (h >= 17 && h <= 20)) return 1.12;
  return 1;
}

function computeEtaMinutes(durationSec) {
  const baseMin = Math.max(1, Math.round(durationSec / 60));
  routeState.totalTimeBase = baseMin;
  const trafficOn = getTrafficEnabled();
  const factor = (trafficOn ? TRAFFIC_ETA_FACTOR : 1) * rushHourFactor();
  routeState.trafficAdjusted = trafficOn;
  routeState.totalTime = Math.max(1, Math.round(baseMin * factor));
  return routeState.totalTime;
}

function formatDistance(km) {
  const n = Number(km);
  if (!Number.isFinite(n)) return "—";
  const rounded = n < 10 ? n.toFixed(1) : String(Math.round(n));
  return t("routeDistanceKm").replace("{n}", rounded);
}

function formatEta(min) {
  const n = Math.max(1, Math.round(Number(min) || 0));
  const key = routeState.trafficAdjusted ? "routeEtaTraffic" : "routeEta";
  return t(key).replace("{n}", String(n));
}

function updateRouteSummaryUi() {
  const root = document.getElementById("routeSummary");
  const distEl = document.getElementById("routeSummaryDist");
  const etaEl = document.getElementById("routeSummaryEta");
  if (!root || !distEl || !etaEl) return;

  const hasRoute =
    routeState.pickup &&
    routeState.dropoff &&
    Number.isFinite(routeState.totalDistance) &&
    Number.isFinite(routeState.totalTime);

  root.hidden = !hasRoute;
  root.setAttribute("aria-hidden", hasRoute ? "false" : "true");
  document.body.classList.toggle("has-route-summary", Boolean(hasRoute));

  if (!hasRoute) return;

  distEl.textContent = formatDistance(routeState.totalDistance);
  etaEl.textContent = formatEta(routeState.totalTime);
}

function announceRoute() {
  updateRouteSummaryUi();
  document.dispatchEvent(
    new CustomEvent("swiftgo:route-updated", {
      detail: {
        totalDistance: routeState.totalDistance,
        totalTime: routeState.totalTime,
        totalTimeBase: routeState.totalTimeBase,
        trafficAdjusted: routeState.trafficAdjusted,
        pickup: routeState.pickup,
        dropoff: routeState.dropoff,
        source: routeState.source,
      },
    })
  );
}

function drawRoute(latlngs) {
  const map = getMap();
  if (!map || typeof L === "undefined" || latlngs.length < 2) return;

  clearRouteLine();
  lastLatlngs = latlngs;
  routeCasing = L.polyline(latlngs, { ...ROUTE_STYLE.casing, interactive: false }).addTo(map);
  routeLine = L.polyline(latlngs, { ...ROUTE_STYLE.line, interactive: false }).addTo(map);

  try {
    map.fitBounds(routeLine.getBounds(), { ...FIT_PADDING, animate: true, maxZoom: 16 });
  } catch {
    /* ignore fit errors */
  }
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

async function refreshRoute() {
  const { pickup, dropoff } = routeState;
  if (!pickup || !dropoff) return;

  const seq = ++fetchSeq;
  try {
    const route = await fetchOsrmRoute(pickup, dropoff);
    if (seq !== fetchSeq) return;

    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeState.totalDistance = Math.round((route.distance / 1000) * 100) / 100;
    lastDurationSec = route.duration;
    computeEtaMinutes(route.duration);
    routeState.source = "osrm";
    drawRoute(latlngs);
  } catch (err) {
    console.warn("[SwiftGo] OSRM route", err);
    if (seq !== fetchSeq) return;

    const km = haversineKm(pickup, dropoff);
    routeState.totalDistance = Math.round(km * 100) / 100;
    lastDurationSec = (km / FALLBACK_SPEED_KMH) * 3600;
    computeEtaMinutes(lastDurationSec);
    routeState.source = "estimate";
    drawRoute([
      [pickup.lat, pickup.lng],
      [dropoff.lat, dropoff.lng],
    ]);
  }

  announceRoute();
}

/** Recompute ETA when traffic toggle changes (keep same geometry). */
export function reapplyTrafficEta() {
  if (!routeState.pickup || !routeState.dropoff || lastDurationSec == null) return;
  computeEtaMinutes(lastDurationSec);
  announceRoute();
}

export function setRoutePoint(role, lat, lng) {
  if (role !== "pickup" && role !== "dropoff") return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  routeState[role] = { lat, lng };
  refreshRoute();
}

export function clearRoutePoint(role) {
  if (role !== "pickup" && role !== "dropoff") return;
  routeState[role] = null;
  routeState.totalDistance = null;
  routeState.totalTime = null;
  routeState.totalTimeBase = null;
  routeState.trafficAdjusted = false;
  routeState.source = null;
  lastDurationSec = null;
  lastLatlngs = null;
  fetchSeq += 1;
  clearRouteLine();
  announceRoute();
}

export function getRouteInfo() {
  return {
    totalDistance: routeState.totalDistance,
    totalTime: routeState.totalTime,
    totalTimeBase: routeState.totalTimeBase,
    trafficAdjusted: routeState.trafficAdjusted,
    pickup: routeState.pickup,
    dropoff: routeState.dropoff,
    source: routeState.source,
  };
}

export function initRoutingUi() {
  if (uiBound) return;
  uiBound = true;

  document.addEventListener("swiftgo:traffic-changed", () => {
    reapplyTrafficEta();
  });

  subscribe(() => updateRouteSummaryUi());

  // Hide summary during map-pick mode so the map stays clear.
  document.addEventListener("swiftgo:route-ui-map-pick", (event) => {
    const root = document.getElementById("routeSummary");
    if (!root) return;
    if (event.detail?.active) {
      root.hidden = true;
    } else {
      updateRouteSummaryUi();
    }
  });

  updateRouteSummaryUi();
}
