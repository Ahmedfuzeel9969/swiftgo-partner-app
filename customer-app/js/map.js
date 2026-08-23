/** Leaflet map: location cues, radius zones, live drivers (Phase 7 + 12.4) */

import {
  ANIM_MIN_MS,
  computeAnimationDurationMs,
  distanceMetres,
  interpolateLatLng,
  shouldSnapMarker,
} from "./live-location-render.mjs";

const DEFAULT_CENTER = [24.8607, 67.0011]; // Karachi fallback
const DEFAULT_ZOOM = 15;
/** Activity-zone radius around pickup / drop-off (within the 2–4 km brief). */
const ZONE_RADIUS_M = 3000;
const MAP_STYLE_KEY = "swiftgo_map_style";
const TRAFFIC_KEY = "swiftgo_show_traffic";

let map = null;
let userMarker = null;
let accuracyCircle = null;
/** @type {import('leaflet').TileLayer | null} */
let streetsLayer = null;
/** @type {import('leaflet').TileLayer | null} */
let satelliteLayer = null;
/** @type {import('leaflet').TileLayer | null} */
let satelliteLabelsLayer = null;
/** @type {import('leaflet').LayerGroup | null} */
let trafficLayerGroup = null;
/** @type {"streets" | "satellite"} */
let currentMapStyle = loadMapStyle();
let trafficEnabled = loadTrafficEnabled();
/** @type {import('leaflet').Marker[]} */
let driverMarkers = [];
/** @type {import('leaflet').Marker | null} */
let assignedDriverMarker = null;
/** @type {import('leaflet').Polyline | null} */
let driverApproachLine = null;
let suppressSimulatedDrivers = false;
let assignedDriverPos = null;
let assignedDriverAnimFrame = 0;
let assignedDriverMoveListener = null;
/** @type {{ lat: number, lng: number, observedAt?: number } | null} */
let assignedDriverTargetMeta = null;
/** Last accepted fix used for animation interval (not pickup/dropoff). */
let assignedDriverPrevAccepted = null;
/** When true, map pans to keep assigned driver in view (disabled after user drag). */
let followDriverEnabled = true;
let followDriverListenersAttached = false;
const FOLLOW_DRIVER_MIN_PAN_M = 35;

/** @type {import('leaflet').Marker | null} */
let pickupMarker = null;
/** @type {import('leaflet').Marker | null} */
let dropoffMarker = null;
/** @type {Map<string, import('leaflet').Marker>} */
const stopMarkers = new Map();
/** @type {import('leaflet').Circle | null} */
let pickupCircle = null;
/** @type {import('leaflet').Circle | null} */
let dropoffCircle = null;

const PIN_THEME = {
  pickup: { fill: "#0b7a4b", core: "#14b86a", className: "route-pin--pickup" },
  dropoff: { fill: "#dc2626", core: "#f87171", className: "route-pin--dropoff" },
  stop: { fill: "#64748b", core: "#94a3b8", className: "route-pin--stop" },
  user: { fill: "#0b7a4b", core: "#14b86a", className: "route-pin--user" },
};

function pinHtml(theme, filterId) {
  return `
  <div class="custom-pin route-pin ${theme.className}">
    <svg viewBox="0 0 48 64" width="40" height="54" aria-hidden="true">
      <defs>
        <filter id="${filterId}" x="-30%" y="-10%" width="160%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#062818" flood-opacity="0.35"/>
        </filter>
      </defs>
      <path filter="url(#${filterId})" d="M24 0C12 0 2.5 9.5 2.5 21.5c0 15.5 21.5 40 21.5 40s21.5-24.5 21.5-40C45.5 9.5 36 0 24 0z" fill="${theme.fill}"/>
      <circle cx="24" cy="21" r="8" fill="#fff"/>
      <circle cx="24" cy="21" r="3.5" fill="${theme.core}"/>
    </svg>
  </div>
`;
}

function createPinIcon(role = "user") {
  const theme = PIN_THEME[role] || PIN_THEME.user;
  return L.divIcon({
    className: "custom-pin-wrap",
    html: pinHtml(theme, `pinShadow-${role}`),
    iconSize: [40, 54],
    iconAnchor: [20, 54],
    popupAnchor: [0, -48],
  });
}

function driverIconHtml(rotationDeg, delay) {
  return `
    <div class="live-driver" style="--rot:${rotationDeg}deg;--delay:${delay}s" aria-hidden="true">
      <svg viewBox="0 0 40 40" width="32" height="32">
        <ellipse cx="20" cy="34" rx="10" ry="2.5" fill="#062818" opacity=".2"/>
        <path d="M8 24h24l-2-8a4 4 0 0 0-4-3H14a4 4 0 0 0-4 3L8 24z" fill="#0b7a4b"/>
        <path d="M14 13h12l2 4H12l2-4z" fill="#fff" opacity=".9"/>
        <circle cx="13" cy="26" r="3.5" fill="#065c38"/>
        <circle cx="27" cy="26" r="3.5" fill="#065c38"/>
        <circle cx="13" cy="26" r="1.4" fill="#fff"/>
        <circle cx="27" cy="26" r="1.4" fill="#fff"/>
      </svg>
    </div>
  `;
}

function createDriverIcon(rotationDeg, delay) {
  return L.divIcon({
    className: "live-driver-wrap",
    html: driverIconHtml(rotationDeg, delay),
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

const MOTORCYCLE_VEHICLE_KEYS = new Set(["bike", "bike-cargo", "bikecargo", "motorcycle", "moto"]);

function resolveAssignedMarkerMode() {
  try {
    const ride =
      (typeof window !== "undefined" && window.__SWIFTGO_ACTIVE_RIDE__) || null;
    if (!ride) return { motorcycle: false, occupied: false };
    const key = String(ride.vehicleTypeKey || ride.vehicleKey || "")
      .trim()
      .toLowerCase();
    const label = String(ride.vehicleType || ride.vehicleCategory || "")
      .trim()
      .toLowerCase();
    const motorcycle =
      MOTORCYCLE_VEHICLE_KEYS.has(key) ||
      label.includes("bike") ||
      label.includes("بائیک") ||
      label.includes("moto");
    const status = String(ride.status || "");
    const occupied = status === "in_progress";
    return { motorcycle, occupied };
  } catch {
    return { motorcycle: false, occupied: false };
  }
}

/** Honda CD 70–style side view (simple cartoon). Solo = helmeted driver only. */
function motorcycleSoloSvg() {
  return `
      <svg viewBox="0 0 104 66" width="86" height="54" aria-hidden="true">
        <ellipse cx="52" cy="61" rx="34" ry="3.5" fill="#0f172a" opacity=".2"/>
        <circle cx="26" cy="46" r="14" fill="#0b1220" stroke="#e2e8f0" stroke-width="2.8"/>
        <circle cx="26" cy="46" r="6.5" fill="#f8fafc"/>
        <circle cx="26" cy="46" r="2.4" fill="#64748b"/>
        <circle cx="80" cy="46" r="14" fill="#0b1220" stroke="#e2e8f0" stroke-width="2.8"/>
        <circle cx="80" cy="46" r="6.5" fill="#f8fafc"/>
        <circle cx="80" cy="46" r="2.4" fill="#64748b"/>
        <path d="M34 44h40" stroke="#334155" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M36 41c11-3 28-3 38 1" fill="none" stroke="#475569" stroke-width="2.6"/>
        <path d="M70 41l18 2.5" stroke="#94a3b8" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M32 42c3-11 11-16 24-16 8 0 14 3 18 8l10 2.5v7.5H36l-4-2z" fill="#e11d48"/>
        <path d="M42 27c6-4 14-5 19-1l2.5 4H44l-2-3z" fill="#be123c"/>
        <path d="M18 40c3-5.5 8-7 12-4.5l2.5 7.5H22l-4-3z" fill="#fb7185"/>
        <path d="M74 37c5.5-2 12 0 14.5 4.5l-1.5 6.5H73l2-11z" fill="#fb7185"/>
        <path d="M46 29h22c2.8 0 4.4 1.5 4.4 3.2S69 36 66 36H48c-2.8 0-4.5-1.6-4.5-3.4S43.2 29 46 29z" fill="#020617"/>
        <circle cx="92" cy="31" r="5.5" fill="#fef08a" stroke="#a16207" stroke-width="1.5"/>
        <path d="M78 31h11M76 27.5v8" stroke="#0f172a" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M48 29c0-10 7-15.5 13.5-15.5S78 18.5 78 26.5c0 9-5.5 14-10 15.5" fill="#1d4ed8"/>
        <circle cx="61.5" cy="10.5" r="8.5" fill="#020617" stroke="#7dd3fc" stroke-width="1.4"/>
        <path d="M54.5 12.5h14c.6 3-2.6 5-7 5s-7.6-2-7-5z" fill="#bae6fd"/>
        <path d="M56 7.5h11" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
        <path d="M55 34h13v6.5H55z" fill="#1e3a8a"/>
      </svg>`;
}

/** After Start Ride: two helmeted riders (driver front, passenger rear). */
function motorcycleDuoSvg() {
  return `
      <svg viewBox="0 0 116 66" width="94" height="54" aria-hidden="true">
        <ellipse cx="58" cy="61" rx="36" ry="3.5" fill="#0f172a" opacity=".2"/>
        <circle cx="26" cy="46" r="14" fill="#0b1220" stroke="#e2e8f0" stroke-width="2.8"/>
        <circle cx="26" cy="46" r="6.5" fill="#f8fafc"/>
        <circle cx="26" cy="46" r="2.4" fill="#64748b"/>
        <circle cx="90" cy="46" r="14" fill="#0b1220" stroke="#e2e8f0" stroke-width="2.8"/>
        <circle cx="90" cy="46" r="6.5" fill="#f8fafc"/>
        <circle cx="90" cy="46" r="2.4" fill="#64748b"/>
        <path d="M34 44h48" stroke="#334155" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M36 41c13-3 32-3 44 1" fill="none" stroke="#475569" stroke-width="2.6"/>
        <path d="M76 41l20 2.5" stroke="#94a3b8" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M32 42c3-11 11-16 26-16 10 0 16 3 20 8l12 2.5v7.5H36l-4-2z" fill="#e11d48"/>
        <path d="M44 27c7-4 16-5 22-1l2.5 4H46l-2-3z" fill="#be123c"/>
        <path d="M18 40c3-5.5 8-7 12-4.5l2.5 7.5H22l-4-3z" fill="#fb7185"/>
        <path d="M84 37c5.5-2 13 0 15.5 4.5l-1.5 6.5H83l2-11z" fill="#fb7185"/>
        <path d="M42 29h38c3.2 0 5.2 1.6 5.2 3.4S81 36 76 36H45c-3.2 0-5.2-1.6-5.2-3.5S38.8 29 42 29z" fill="#020617"/>
        <circle cx="102" cy="31" r="5.5" fill="#fef08a" stroke="#a16207" stroke-width="1.5"/>
        <path d="M88 31h11M86 27.5v8" stroke="#0f172a" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M44 29c0-9 6-14 12-14s10 3.5 10 10c0 8-4.5 13-8.5 14.5" fill="#0f766e"/>
        <circle cx="56" cy="11.5" r="7.6" fill="#134e4a" stroke="#99f6e4" stroke-width="1.4"/>
        <path d="M49.5 13.2h13c.5 2.7-2.2 4.5-6.5 4.5s-7-1.8-6.5-4.5z" fill="#ccfbf1"/>
        <path d="M51 8.5h10" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M50 34h13v6H50z" fill="#115e59"/>
        <path d="M62 29c0-10 7-15.5 13.5-15.5S92 18.5 92 26.5c0 9-5.5 14-10 15.5" fill="#1d4ed8"/>
        <circle cx="75.5" cy="10.5" r="8.5" fill="#020617" stroke="#7dd3fc" stroke-width="1.4"/>
        <path d="M68.5 12.5h14c.6 3-2.6 5-7 5s-7.6-2-7-5z" fill="#bae6fd"/>
        <path d="M70 7.5h11" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
        <path d="M69 34h13v6.5H69z" fill="#1e3a8a"/>
      </svg>`;
}

function carAssignedSvg() {
  return `
      <svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
        <ellipse cx="20" cy="34" rx="10" ry="2.5" fill="#062818" opacity=".25"/>
        <path d="M8 24h24l-2-8a4 4 0 0 0-4-3H14a4 4 0 0 0-4 3L8 24z" fill="#1d4ed8"/>
        <path d="M14 13h12l2 4H12l2-4z" fill="#fff" opacity=".95"/>
        <circle cx="13" cy="26" r="3.5" fill="#1e3a8a"/>
        <circle cx="27" cy="26" r="3.5" fill="#1e3a8a"/>
        <circle cx="13" cy="26" r="1.4" fill="#fff"/>
        <circle cx="27" cy="26" r="1.4" fill="#fff"/>
      </svg>`;
}

function assignedDriverIconHtml(rotationDeg, mode = { motorcycle: false, occupied: false }) {
  const movingClass = mode.motorcycle ? " is-motorcycle-moving" : "";
  const body = mode.motorcycle
    ? mode.occupied
      ? motorcycleDuoSvg()
      : motorcycleSoloSvg()
    : carAssignedSvg();
  return `
    <div class="live-driver assigned-driver-marker${movingClass}" style="--rot:${rotationDeg}deg" aria-hidden="true">
      <span class="assigned-driver-marker__pulse" aria-hidden="true"></span>
      ${body}
    </div>
  `;
}

let lastAssignedIconKey = "";

function createAssignedDriverIcon(rotationDeg) {
  const mode = resolveAssignedMarkerMode();
  const rotKey = Math.round(Number(rotationDeg) || 0);
  const iconKey = `${mode.motorcycle ? "moto" : "car"}:${mode.occupied ? "duo" : "solo"}:${rotKey}`;
  lastAssignedIconKey = iconKey;
  return L.divIcon({
    className: "live-driver-wrap assigned-driver-wrap",
    html: assignedDriverIconHtml(rotationDeg, mode),
    iconSize: mode.motorcycle ? (mode.occupied ? [94, 54] : [86, 54]) : [40, 40],
    iconAnchor: mode.motorcycle ? (mode.occupied ? [47, 27] : [43, 27]) : [20, 20],
  });
}

function maybeRefreshAssignedIcon(rotationDeg) {
  if (!assignedDriverMarker) return;
  const mode = resolveAssignedMarkerMode();
  const rotKey = Math.round(Number(rotationDeg) || 0);
  const iconKey = `${mode.motorcycle ? "moto" : "car"}:${mode.occupied ? "duo" : "solo"}:${rotKey}`;
  if (iconKey === lastAssignedIconKey) return;
  assignedDriverMarker.setIcon(createAssignedDriverIcon(rotationDeg));
}

/** Force icon variant refresh (e.g. Start Ride → duo motorcycle) without moving the marker. */
export function refreshAssignedDriverIcon(rotationDeg = 0) {
  if (!assignedDriverMarker) return;
  lastAssignedIconKey = "";
  maybeRefreshAssignedIcon(rotationDeg);
}

function cancelAssignedDriverAnimation() {
  if (assignedDriverAnimFrame) {
    cancelAnimationFrame(assignedDriverAnimFrame);
    assignedDriverAnimFrame = 0;
  }
}

function emitAssignedDriverPos(lat, lng) {
  if (typeof assignedDriverMoveListener === "function") {
    assignedDriverMoveListener(lat, lng);
  }
  document.dispatchEvent(
    new CustomEvent("swiftgo:assigned-driver-pos", { detail: { lat, lng } })
  );
}

export function onAssignedDriverMove(listener) {
  assignedDriverMoveListener = typeof listener === "function" ? listener : null;
}

/** Offset meters → approx lat/lng deltas near equator-ish for Karachi */
function offsetLatLng(lat, lng, eastM, northM) {
  const dLat = northM / 111320;
  const dLng = eastM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}

/**
 * Place 4 simulated live drivers around a center point.
 */
export function spawnLiveDrivers(lat, lng) {
  if (!map || typeof L === "undefined") return;

  clearLiveDrivers();

  const spots = [
    { e: 120, n: 80, rot: 35, delay: 0 },
    { e: -140, n: 40, rot: -50, delay: 0.4 },
    { e: 60, n: -110, rot: 120, delay: 0.8 },
    { e: -90, n: -70, rot: -15, delay: 1.2 },
  ];

  driverMarkers = spots.map((s) => {
    const ll = offsetLatLng(lat, lng, s.e, s.n);
    return L.marker(ll, {
      icon: createDriverIcon(s.rot, s.delay),
      interactive: false,
      keyboard: false,
      zIndexOffset: 200,
    }).addTo(map);
  });
}

export function clearLiveDrivers() {
  driverMarkers.forEach((m) => {
    try {
      map?.removeLayer(m);
    } catch {
      /* ignore */
    }
  });
  driverMarkers = [];
}

export function setSuppressSimulatedDrivers(suppressed) {
  suppressSimulatedDrivers = Boolean(suppressed);
  if (suppressSimulatedDrivers) clearLiveDrivers();
}

export function setFollowDriverEnabled(enabled) {
  followDriverEnabled = Boolean(enabled);
}

export function isFollowDriverEnabled() {
  return followDriverEnabled;
}

function attachFollowDriverListeners() {
  if (!map || followDriverListenersAttached) return;
  followDriverListenersAttached = true;
  map.on("dragstart", () => {
    followDriverEnabled = false;
  });
}

/**
 * Pan map toward assigned driver when follow mode is enabled.
 * Does not change zoom; no-op when user has panned away manually.
 */
export function followAssignedDriverIfEnabled(lat, lng) {
  if (!map || !followDriverEnabled) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  attachFollowDriverListeners();
  const center = map.getCenter();
  const distM = distanceMetres({ lat: center.lat, lng: center.lng }, { lat, lng });
  const outside =
    typeof map.getBounds === "function" && map.getBounds()
      ? !map.getBounds().contains([lat, lng])
      : distM >= FOLLOW_DRIVER_MIN_PAN_M;
  if (!outside && distM < FOLLOW_DRIVER_MIN_PAN_M) return;
  map.panTo([lat, lng], { animate: true, duration: 0.45 });
}

export function setAssignedDriverLocation(lat, lng, rotationDeg = 0, opts = {}) {
  if (!map || typeof L === "undefined") return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const observedAt = Number(opts.observedAt) || Date.now();
  const allowPredict = opts.allowPredict !== false;
  /** Phase 5 display pipeline owns RAF — place marker without chord interpolation. */
  const skipAnimation = opts.skipAnimation === true;

  if (!assignedDriverMarker) {
    assignedDriverPos = { lat, lng };
    assignedDriverPrevAccepted = { lat, lng, observedAt };
    assignedDriverTargetMeta = { lat, lng, observedAt };
    assignedDriverMarker = L.marker([lat, lng], {
      icon: createAssignedDriverIcon(rotationDeg),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1200,
    }).addTo(map);
    emitAssignedDriverPos(lat, lng);
    return;
  }

  const rendered = assignedDriverPos || {
    lat: assignedDriverMarker.getLatLng().lat,
    lng: assignedDriverMarker.getLatLng().lng,
  };
  const to = { lat, lng };
  const samePlace =
    Math.abs(rendered.lat - to.lat) < 1e-7 && Math.abs(rendered.lng - to.lng) < 1e-7;
  if (samePlace) {
    maybeRefreshAssignedIcon(rotationDeg);
    assignedDriverPrevAccepted = { lat, lng, observedAt };
    return;
  }

  if (skipAnimation) {
    cancelAssignedDriverAnimation();
    assignedDriverPos = to;
    assignedDriverPrevAccepted = { lat, lng, observedAt };
    assignedDriverTargetMeta = { lat, lng, observedAt };
    maybeRefreshAssignedIcon(rotationDeg);
    assignedDriverMarker.setLatLng([lat, lng]);
    emitAssignedDriverPos(lat, lng);
    return;
  }

  const prevObs = Number(assignedDriverPrevAccepted?.observedAt) || 0;
  const gapMs = Math.max(0, observedAt - prevObs);
  const distM = distanceMetres(rendered, to);
  const snap =
    !allowPredict ||
    shouldSnapMarker({
      hasPrevious: Boolean(assignedDriverPrevAccepted),
      gapMs,
      distanceM: distM,
      previousInvalid: !assignedDriverPrevAccepted,
    });

  cancelAssignedDriverAnimation();
  maybeRefreshAssignedIcon(rotationDeg);

  if (snap) {
    assignedDriverPos = to;
    assignedDriverPrevAccepted = { lat, lng, observedAt };
    assignedDriverTargetMeta = { lat, lng, observedAt };
    assignedDriverMarker.setLatLng([lat, lng]);
    emitAssignedDriverPos(lat, lng);
    return;
  }

  // Start from currently rendered position; duration from accepted-fix interval.
  const from = { ...rendered };
  const durationMs = computeAnimationDurationMs(prevObs || observedAt - ANIM_MIN_MS, observedAt);
  assignedDriverTargetMeta = { lat, lng, observedAt };
  const start = performance.now();

  const tick = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const cur = interpolateLatLng(from, to, t);
    assignedDriverPos = cur;
    assignedDriverMarker.setLatLng([cur.lat, cur.lng]);
    emitAssignedDriverPos(cur.lat, cur.lng);
    if (t < 1) {
      assignedDriverAnimFrame = requestAnimationFrame(tick);
    } else {
      assignedDriverPos = to;
      assignedDriverPrevAccepted = { lat, lng, observedAt };
      assignedDriverAnimFrame = 0;
    }
  };
  assignedDriverAnimFrame = requestAnimationFrame(tick);
}

export function clearAssignedDriver() {
  cancelAssignedDriverAnimation();
  assignedDriverPos = null;
  assignedDriverPrevAccepted = null;
  assignedDriverTargetMeta = null;
  lastAssignedIconKey = "";
  if (assignedDriverMarker && map) {
    try {
      map.removeLayer(assignedDriverMarker);
    } catch {
      /* ignore */
    }
  }
  assignedDriverMarker = null;
  if (driverApproachLine && map) {
    try {
      map.removeLayer(driverApproachLine);
    } catch {
      /* ignore */
    }
  }
  driverApproachLine = null;
}

/**
 * Dashed straight-line estimate from assigned driver to tracking target.
 * Phase 1: not a road route.
 */
export function setDriverApproachLine(from, to) {
  if (!map || typeof L === "undefined") return;
  if (driverApproachLine) {
    try {
      map.removeLayer(driverApproachLine);
    } catch {
      /* ignore */
    }
    driverApproachLine = null;
  }
  if (!from || !to) return;
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng)) return;
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lng)) return;
  driverApproachLine = L.polyline(
    [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ],
    {
      color: "#0b7a4b",
      weight: 3,
      opacity: 0.75,
      dashArray: "8 10",
      lineCap: "round",
      interactive: false,
      className: "driver-approach-line",
    }
  ).addTo(map);
}

function upsertCircle(existing, latlng, style) {
  if (!map) return existing;
  if (existing) {
    existing.setLatLng(latlng).setRadius(ZONE_RADIUS_M);
    return existing;
  }
  return L.circle(latlng, {
    radius: ZONE_RADIUS_M,
    ...style,
  }).addTo(map);
}

function upsertMarker(existing, latlng, role, zIndex) {
  if (!map) return existing;
  if (existing) {
    existing.setLatLng(latlng);
    existing.setIcon(createPinIcon(role));
    return existing;
  }
  return L.marker(latlng, {
    icon: createPinIcon(role),
    interactive: false,
    keyboard: false,
    zIndexOffset: zIndex,
  }).addTo(map);
}

/**
 * Phase 12.4 — colored route cues + pickup/drop-off activity radius.
 * @param {'pickup'|'dropoff'|'stop'} role
 * @param {number} lat
 * @param {number} lng
 * @param {{ stopId?: string }} [meta]
 */
export function setLocationCue(role, lat, lng, meta = {}) {
  if (!map || typeof L === "undefined") return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const latlng = [lat, lng];

  if (role === "pickup") {
    pickupMarker = upsertMarker(pickupMarker, latlng, "pickup", 620);
    pickupCircle = upsertCircle(pickupCircle, latlng, {
      color: "#16a34a",
      weight: 1,
      opacity: 0.55,
      fillColor: "#86efac",
      fillOpacity: 0.14,
      interactive: false,
      className: "zone-circle zone-circle--pickup",
    });
    return;
  }

  if (role === "dropoff") {
    dropoffMarker = upsertMarker(dropoffMarker, latlng, "dropoff", 610);
    dropoffCircle = upsertCircle(dropoffCircle, latlng, {
      color: "#ef4444",
      weight: 1,
      opacity: 0.5,
      fillColor: "#fecaca",
      fillOpacity: 0.14,
      interactive: false,
      className: "zone-circle zone-circle--dropoff",
    });
    return;
  }

  if (role === "stop") {
    const stopId = meta.stopId || `stop-${stopMarkers.size + 1}`;
    const current = stopMarkers.get(stopId) || null;
    const marker = upsertMarker(current, latlng, "stop", 580);
    stopMarkers.set(stopId, marker);
  }
}

export function clearLocationCue(role, stopId) {
  if (role === "pickup") {
    if (pickupMarker) {
      map?.removeLayer(pickupMarker);
      pickupMarker = null;
    }
    if (pickupCircle) {
      map?.removeLayer(pickupCircle);
      pickupCircle = null;
    }
    return;
  }
  if (role === "dropoff") {
    if (dropoffMarker) {
      map?.removeLayer(dropoffMarker);
      dropoffMarker = null;
    }
    if (dropoffCircle) {
      map?.removeLayer(dropoffCircle);
      dropoffCircle = null;
    }
    return;
  }
  if (role === "stop" && stopId) {
    const marker = stopMarkers.get(stopId);
    if (marker) {
      map?.removeLayer(marker);
      stopMarkers.delete(stopId);
    }
  }
}

export function initMap(containerId = "map") {
  const el = document.getElementById(containerId);
  if (!el || typeof L === "undefined") {
    console.warn("[SwiftGo] Leaflet not available");
    return null;
  }

  if (map) {
    resizeMap();
    initMapLayersControls();
    return map;
  }

  map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
  }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  streetsLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  });

  // Esri World Imagery — satellite/aerial view (Maps-style)
  satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    }
  );

  satelliteLabelsLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      opacity: 0.9,
      pane: "overlayPane",
    }
  );

  applyMapStyle(currentMapStyle, { persist: false, syncUi: false });
  setTrafficEnabled(trafficEnabled, { persist: false, syncUi: true });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  userMarker = L.marker(DEFAULT_CENTER, { icon: createPinIcon("user"), draggable: false }).addTo(map);
  spawnLiveDrivers(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);

  initMapLayersControls();

  requestAnimationFrame(() => {
    map.invalidateSize();
    locateUser({ fly: true });
  });

  return map;
}

function loadMapStyle() {
  try {
    const saved = localStorage.getItem(MAP_STYLE_KEY);
    if (saved === "satellite" || saved === "streets") return saved;
  } catch {
    /* ignore */
  }
  return "streets";
}

function loadTrafficEnabled() {
  try {
    const saved = localStorage.getItem(TRAFFIC_KEY);
    if (saved === null) return false;
    return saved === "1";
  } catch {
    return false;
  }
}

function persistMapStyle(style) {
  try {
    localStorage.setItem(MAP_STYLE_KEY, style);
  } catch {
    /* ignore */
  }
}

function persistTraffic(on) {
  try {
    localStorage.setItem(TRAFFIC_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Major Karachi corridors — simulated congestion colours (NOT live traffic). */
function buildTrafficSegments(centerLat = DEFAULT_CENTER[0], centerLng = DEFAULT_CENTER[1]) {
  const c = { lat: centerLat, lng: centerLng };
  return [
    {
      color: "#ea4335",
      weight: 6,
      coords: [
        [c.lat + 0.012, c.lng - 0.02],
        [c.lat + 0.006, c.lng - 0.004],
        [c.lat - 0.002, c.lng + 0.01],
      ],
    },
    {
      color: "#fbbc04",
      weight: 5,
      coords: [
        [c.lat - 0.015, c.lng - 0.012],
        [c.lat - 0.004, c.lng - 0.002],
        [c.lat + 0.008, c.lng + 0.014],
      ],
    },
    {
      color: "#34a853",
      weight: 5,
      coords: [
        [c.lat + 0.018, c.lng + 0.002],
        [c.lat + 0.004, c.lng + 0.008],
        [c.lat - 0.01, c.lng + 0.018],
      ],
    },
    {
      color: "#ea4335",
      weight: 5,
      coords: [
        [c.lat - 0.008, c.lng + 0.02],
        [c.lat + 0.002, c.lng + 0.006],
        [c.lat + 0.014, c.lng - 0.008],
      ],
    },
    {
      color: "#fbbc04",
      weight: 4,
      coords: [
        [c.lat + 0.002, c.lng - 0.022],
        [c.lat - 0.006, c.lng - 0.01],
        [c.lat - 0.016, c.lng + 0.004],
      ],
    },
  ];
}

function ensureTrafficLayer() {
  if (!map || typeof L === "undefined") return;
  if (trafficLayerGroup) {
    trafficLayerGroup.clearLayers();
  } else {
    trafficLayerGroup = L.layerGroup();
  }

  const center = map.getCenter();
  buildTrafficSegments(center.lat, center.lng).forEach((seg) => {
    L.polyline(seg.coords, {
      color: seg.color,
      weight: seg.weight,
      opacity: 0.88,
      lineCap: "round",
      lineJoin: "round",
      className: "leaflet-traffic-line",
      interactive: false,
    }).addTo(trafficLayerGroup);
  });
}

function syncLayersUi() {
  const streetsBtn = document.getElementById("btnLayerStreets");
  const satBtn = document.getElementById("btnLayerSatellite");
  const trafficBtn = document.getElementById("btnLayerTraffic");
  const isSat = currentMapStyle === "satellite";

  if (streetsBtn) {
    streetsBtn.classList.toggle("is-active", !isSat);
    streetsBtn.setAttribute("aria-pressed", !isSat ? "true" : "false");
  }
  if (satBtn) {
    satBtn.classList.toggle("is-active", isSat);
    satBtn.setAttribute("aria-pressed", isSat ? "true" : "false");
  }
  if (trafficBtn) {
    trafficBtn.classList.toggle("is-active", trafficEnabled);
    trafficBtn.setAttribute("aria-pressed", trafficEnabled ? "true" : "false");
    // Never present sample overlay as live traffic.
    trafficBtn.title = "نمونہ ٹریفک — حقیقی ٹریفک نہیں";
    trafficBtn.setAttribute("data-traffic-kind", "sample_not_live");
  }
}

/**
 * @param {"streets" | "satellite"} style
 * @param {{ persist?: boolean, syncUi?: boolean }} [opts]
 */
export function applyMapStyle(style, opts = {}) {
  const next = style === "satellite" ? "satellite" : "streets";
  currentMapStyle = next;
  if (!map) {
    if (opts.syncUi !== false) syncLayersUi();
    return next;
  }

  if (next === "satellite") {
    if (streetsLayer && map.hasLayer(streetsLayer)) map.removeLayer(streetsLayer);
    if (satelliteLayer && !map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
    if (satelliteLabelsLayer && !map.hasLayer(satelliteLabelsLayer)) {
      satelliteLabelsLayer.addTo(map);
    }
  } else {
    if (satelliteLabelsLayer && map.hasLayer(satelliteLabelsLayer)) {
      map.removeLayer(satelliteLabelsLayer);
    }
    if (satelliteLayer && map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    if (streetsLayer && !map.hasLayer(streetsLayer)) streetsLayer.addTo(map);
  }

  if (opts.persist !== false) persistMapStyle(next);
  if (opts.syncUi !== false) syncLayersUi();
  const mapEl = document.getElementById("map");
  mapEl?.classList.toggle("map--satellite", next === "satellite");
  mapEl?.classList.toggle("map--streets", next === "streets");
  return next;
}

export function getMapStyle() {
  return currentMapStyle;
}

/** Toggle between street map and satellite imagery. */
export function toggleMapStyle() {
  return applyMapStyle(currentMapStyle === "satellite" ? "streets" : "satellite");
}

/**
 * @param {boolean} on
 * @param {{ persist?: boolean, syncUi?: boolean }} [opts]
 */
export function setTrafficEnabled(on, opts = {}) {
  trafficEnabled = Boolean(on);
  document.documentElement.classList.toggle("show-traffic", trafficEnabled);

  if (map) {
    if (trafficEnabled) {
      ensureTrafficLayer();
      if (trafficLayerGroup && !map.hasLayer(trafficLayerGroup)) {
        trafficLayerGroup.addTo(map);
      }
    } else if (trafficLayerGroup && map.hasLayer(trafficLayerGroup)) {
      map.removeLayer(trafficLayerGroup);
    }
  }

  if (opts.persist !== false) persistTraffic(trafficEnabled);
  if (opts.syncUi !== false) syncLayersUi();
  document.dispatchEvent(
    new CustomEvent("swiftgo:traffic-changed", { detail: { enabled: trafficEnabled } })
  );
  return trafficEnabled;
}

export function getTrafficEnabled() {
  return trafficEnabled;
}

export function toggleTraffic() {
  return setTrafficEnabled(!trafficEnabled);
}

export function initMapLayersControls() {
  const root = document.getElementById("mapLayers");
  if (!root || root.dataset.bound === "1") {
    syncLayersUi();
    return;
  }
  root.dataset.bound = "1";

  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-map-layer]");
    if (!btn) return;
    const layer = btn.dataset.mapLayer;
    if (layer === "streets") {
      applyMapStyle("streets");
      return;
    }
    if (layer === "satellite") {
      applyMapStyle("satellite");
      return;
    }
    if (layer === "traffic") {
      toggleTraffic();
    }
  });

  syncLayersUi();
}

export function resizeMap() {
  if (map) map.invalidateSize();
}

export function setUserPosition(lat, lng, accuracy) {
  if (!map || !userMarker) return;
  const latlng = [lat, lng];
  userMarker.setLatLng(latlng);
  if (!suppressSimulatedDrivers) spawnLiveDrivers(lat, lng);

  if (typeof accuracy === "number" && accuracy > 0) {
    if (accuracyCircle) {
      accuracyCircle.setLatLng(latlng).setRadius(accuracy);
    } else {
      accuracyCircle = L.circle(latlng, {
        radius: accuracy,
        color: "#0b7a4b",
        weight: 1,
        fillColor: "#14b86a",
        fillOpacity: 0.12,
      }).addTo(map);
    }
  }
}

export function flyToUser(lat, lng, zoom = DEFAULT_ZOOM) {
  if (!map) return;
  map.flyTo([lat, lng], zoom, { duration: 1.1 });
}

/**
 * @param {{ fly?: boolean }} opts
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
export function locateUser(opts = { fly: true }) {
  return (async () => {
    try {
      const { ensureLocationPermissionExplained } = await import("./trust.js");
      const allowed = await ensureLocationPermissionExplained();
      if (!allowed) {
        setUserPosition(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
        if (opts.fly !== false) flyToUser(DEFAULT_CENTER[0], DEFAULT_CENTER[1], 13);
        return { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1], fallback: true, denied: true };
      }
    } catch {
      /* proceed without blocking if trust module fails */
    }

    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setUserPosition(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
        resolve({ lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1], fallback: true });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          setUserPosition(lat, lng, accuracy);
          if (opts.fly !== false) flyToUser(lat, lng);
          resolve({ lat, lng, accuracy });
        },
        () => {
          setUserPosition(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
          if (opts.fly !== false) flyToUser(DEFAULT_CENTER[0], DEFAULT_CENTER[1], 13);
          resolve({ lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1], fallback: true });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  })();
}

export function getMap() {
  return map;
}

export function getMapCenter() {
  if (!map) return null;
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

export function flyToLatLng(lat, lng, zoom = DEFAULT_ZOOM) {
  if (!map) return;
  map.flyTo([lat, lng], zoom, { duration: 0.85 });
}

export function panToLatLng(lat, lng) {
  if (!map) return;
  map.panTo([lat, lng], { animate: true, duration: 0.4 });
}

/**
 * @param {(center: { lat: number, lng: number }) => void} handler
 * @returns {() => void}
 */
export function onMapMoveEnd(handler) {
  if (!map || typeof handler !== "function") return () => {};
  const wrapped = () => {
    const center = getMapCenter();
    if (center) handler(center);
  };
  map.on("moveend", wrapped);
  return () => map.off("moveend", wrapped);
}

/** Phase 44: detect user-initiated map pans for drag-to-select. */
export function onMapDragStart(handler) {
  if (!map || typeof handler !== "function") return () => {};
  map.on("dragstart", handler);
  return () => map.off("dragstart", handler);
}

export function setMapPickMode(active) {
  const on = Boolean(active);
  document.body.classList.toggle("map-pick-active", on);
  document.getElementById("shell")?.classList.toggle("map-pick-active", on);
  document.getElementById("app")?.classList.toggle("map-pick-active", on);
  if (map) {
    requestAnimationFrame(() => map.invalidateSize());
  }
}
