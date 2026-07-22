/** Leaflet map: location cues, radius zones, live drivers (Phase 7 + 12.4) */

const DEFAULT_CENTER = [24.8607, 67.0011]; // Karachi fallback
const DEFAULT_ZOOM = 15;
/** Activity-zone radius around pickup / drop-off (within the 2–4 km brief). */
const ZONE_RADIUS_M = 3000;

let map = null;
let userMarker = null;
let accuracyCircle = null;
/** @type {import('leaflet').Marker[]} */
let driverMarkers = [];

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
    return map;
  }

  map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
  }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  userMarker = L.marker(DEFAULT_CENTER, { icon: createPinIcon("user"), draggable: false }).addTo(map);
  spawnLiveDrivers(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);

  requestAnimationFrame(() => {
    map.invalidateSize();
    locateUser({ fly: true });
  });

  return map;
}

export function resizeMap() {
  if (map) map.invalidateSize();
}

export function setUserPosition(lat, lng, accuracy) {
  if (!map || !userMarker) return;
  const latlng = [lat, lng];
  userMarker.setLatLng(latlng);
  spawnLiveDrivers(lat, lng);

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

export function setMapPickMode(active) {
  const on = Boolean(active);
  document.body.classList.toggle("map-pick-active", on);
  document.getElementById("shell")?.classList.toggle("map-pick-active", on);
  document.getElementById("app")?.classList.toggle("map-pick-active", on);
  if (map) {
    requestAnimationFrame(() => map.invalidateSize());
  }
}
