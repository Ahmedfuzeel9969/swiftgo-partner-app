/**
 * Phase 38 / 46 — Super Admin live fleet map (Leaflet + OSM).
 * Replaces Google Maps so the map works without a separate Maps JS API key.
 */

import { getFirebase } from "./firebase.js";
import {
  collection,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const KARACHI = [24.8607, 67.0011];
const DEFAULT_ZOOM = 12;

const VEHICLE_STATUS_URDU = {
  online: "آن لائن",
  in_ride: "سواری میں",
  offline: "آف لائن",
};

/** @type {import('leaflet').Map | null} */
let fleetMap = null;
/** @type {Record<string, import('leaflet').Marker>} */
let fleetMarkers = {};
/** @type {(() => void) | null} */
let unsubscribeVehicles = null;
let mapInitialized = false;
/** @type {(driverId: string) => string} */
let resolveDriverName = () => "ڈرائیور";
/** @type {Record<string, Record<string, unknown>>} */
let latestVehiclesById = {};

const els = {
  section: null,
  mapHost: null,
  liveNote: null,
  activeCount: null,
};

function setLiveNote(message = "") {
  if (els.liveNote) els.liveNote.textContent = message;
}

function leafletReady() {
  return typeof window.L !== "undefined" && window.L?.map;
}

function vehicleFleetStatus(vehicle) {
  if (vehicle?.activeRideId || vehicle?.status === "in_ride") return "in_ride";
  if (vehicle?.status === "online" || vehicle?.status === "available") return "online";
  if (vehicle?.status === "offline" || !vehicle?.status) return "offline";
  return String(vehicle?.status || "offline");
}

function vehicleStatusLabel(status) {
  return VEHICLE_STATUS_URDU[status] || status || "نامعلوم";
}

/**
 * Accept common location shapes written by partner / admin clients.
 * @returns {{ lat: number, lng: number } | null}
 */
function vehicleCoords(vehicle) {
  const candidates = [
    vehicle?.location,
    vehicle?.lastLocation,
    vehicle?.gps,
    vehicle?.coords,
    vehicle,
  ];

  for (const source of candidates) {
    if (!source || typeof source !== "object") continue;

    // Firestore GeoPoint
    if (typeof source.latitude === "number" && typeof source.longitude === "number") {
      const lat = Number(source.latitude);
      const lng = Number(source.longitude);
      if (isValidLatLng(lat, lng)) return { lat, lng };
    }

    const lat = Number(source.lat ?? source._lat);
    const lng = Number(source.lng ?? source.lon ?? source._long);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function driverLabel(vehicle) {
  if (vehicle?.driverName) return String(vehicle.driverName);
  if (vehicle?.driverId) return resolveDriverName(String(vehicle.driverId));
  return "—";
}

function shouldTrackVehicle(vehicle) {
  const status = vehicleFleetStatus(vehicle);
  return (status === "online" || status === "in_ride") && Boolean(vehicleCoords(vehicle));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPopupHtml(vehicle) {
  const status = vehicleFleetStatus(vehicle);
  const driver = driverLabel(vehicle);
  const plate = vehicle?.plate || vehicle?.model || "—";
  return `
    <div class="fleet-map-info" dir="rtl" lang="ur">
      <p><strong>ڈرائیور:</strong> ${escapeHtml(driver)}</p>
      <p><strong>گاڑی:</strong> ${escapeHtml(plate)}</p>
      <p><strong>اسٹیٹس:</strong> ${escapeHtml(vehicleStatusLabel(status))}</p>
    </div>`;
}

function markerIcon(status) {
  const tone = status === "in_ride" ? "in-ride" : "online";
  return L.divIcon({
    className: "fleet-marker-wrap",
    html: `<span class="fleet-marker fleet-marker--${tone}" aria-hidden="true"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12],
  });
}

function removeFleetMarker(vehicleId) {
  const marker = fleetMarkers[vehicleId];
  if (marker) {
    try {
      fleetMap?.removeLayer(marker);
    } catch {
      /* ignore */
    }
    delete fleetMarkers[vehicleId];
  }
}

function upsertFleetMarker(vehicleId, vehicle) {
  if (!fleetMap || !leafletReady()) return;
  const coords = vehicleCoords(vehicle);
  if (!coords) return;

  const status = vehicleFleetStatus(vehicle);
  const latlng = [coords.lat, coords.lng];
  let marker = fleetMarkers[vehicleId];

  if (!marker) {
    marker = L.marker(latlng, {
      icon: markerIcon(status),
      title: driverLabel(vehicle),
      keyboard: false,
    }).addTo(fleetMap);
    marker.bindPopup(buildPopupHtml(vehicle));
    fleetMarkers[vehicleId] = marker;
  } else {
    marker.setLatLng(latlng);
    marker.setIcon(markerIcon(status));
    marker.setPopupContent(buildPopupHtml(vehicle));
  }
}

function syncVisibleMarkers(vehiclesById) {
  const visibleIds = new Set();

  Object.entries(vehiclesById).forEach(([vehicleId, vehicle]) => {
    if (!shouldTrackVehicle(vehicle)) {
      removeFleetMarker(vehicleId);
      return;
    }
    visibleIds.add(vehicleId);
    upsertFleetMarker(vehicleId, vehicle);
  });

  Object.keys(fleetMarkers).forEach((vehicleId) => {
    if (!visibleIds.has(vehicleId)) removeFleetMarker(vehicleId);
  });

  if (els.activeCount) {
    els.activeCount.textContent = `${visibleIds.size} live vehicles`;
  }

  fitMapToMarkers();
}

function fitMapToMarkers() {
  if (!fleetMap) return;
  const markers = Object.values(fleetMarkers);
  if (!markers.length) {
    fleetMap.setView(KARACHI, DEFAULT_ZOOM);
    return;
  }
  try {
    const group = L.featureGroup(markers);
    fleetMap.fitBounds(group.getBounds().pad(0.25), { maxZoom: 15 });
  } catch {
    fleetMap.setView(KARACHI, DEFAULT_ZOOM);
  }
}

function handleVehicleSnapshot(snapshot) {
  /** @type {Record<string, Record<string, unknown>>} */
  const vehiclesById = {};
  snapshot.docs.forEach((docSnap) => {
    vehiclesById[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
  });
  latestVehiclesById = vehiclesById;
  syncVisibleMarkers(vehiclesById);

  const liveCount = Object.keys(fleetMarkers).length;
  const withCoords = Object.values(vehiclesById).filter((v) => vehicleCoords(v)).length;
  if (liveCount === 0) {
    setLiveNote(
      withCoords > 0
        ? `${withCoords} گاڑیوں کی لوکیشن ہے مگر کوئی آن لائن / سواری میں نہیں۔`
        : "ابھی کوئی لائیو گاڑی نہیں — ڈرائیور آن لائن ہو تو یہاں نظر آئے گی۔"
    );
  } else {
    setLiveNote(`${liveCount} گاڑیاں نقشے پر · لائیو ٹریکنگ`);
  }
}

function warnFleetMapError(error) {
  console.warn("[SwiftGo Admin] fleet map vehicles", error);
  if (error?.code === "permission-denied") {
    setLiveNote("Firestore permission denied — گاڑیاں نہیں پڑھ سکتے۔");
  } else {
    setLiveNote(error?.message || "Fleet map data unavailable.");
  }
}

function startFleetVehicleListener() {
  stopFleetVehicleListener();

  const { db } = getFirebase();
  if (!db) {
    setLiveNote("Firestore is not configured.");
    return;
  }

  unsubscribeVehicles = onSnapshot(
    collection(db, "vehicles"),
    handleVehicleSnapshot,
    warnFleetMapError
  );
}

function stopFleetVehicleListener() {
  if (unsubscribeVehicles) {
    unsubscribeVehicles();
    unsubscribeVehicles = null;
  }
}

export function resizeFleetMap() {
  if (!fleetMap) return;
  requestAnimationFrame(() => {
    fleetMap.invalidateSize(true);
    if (Object.keys(fleetMarkers).length) fitMapToMarkers();
    else fleetMap.setView(KARACHI, DEFAULT_ZOOM);
  });
}

function ensureFleetMapReady() {
  if (!leafletReady()) {
    throw new Error("Leaflet map library failed to load.");
  }
  if (!els.mapHost) {
    throw new Error("Fleet map container not found.");
  }

  // Hidden panels start at 0×0 — force visible dimensions before init.
  els.mapHost.style.display = "block";
  els.mapHost.style.width = "100%";
  if (!els.mapHost.style.minHeight) {
    els.mapHost.style.minHeight = "320px";
  }

  if (!mapInitialized || !fleetMap) {
    if (fleetMap) {
      try {
        fleetMap.remove();
      } catch {
        /* ignore */
      }
      fleetMap = null;
    }

    fleetMap = L.map(els.mapHost, {
      zoomControl: true,
      attributionControl: true,
    }).setView(KARACHI, DEFAULT_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }).addTo(fleetMap);

    mapInitialized = true;
    startFleetVehicleListener();
  }

  // Multiple passes — mobile drawer / hidden→shown transitions need delayed invalidate.
  resizeFleetMap();
  window.setTimeout(() => resizeFleetMap(), 120);
  window.setTimeout(() => resizeFleetMap(), 400);

  if (Object.keys(latestVehiclesById).length) {
    syncVisibleMarkers(latestVehiclesById);
  }

  return fleetMap;
}

export function initFleetMapModule(options = {}) {
  resolveDriverName = options.resolveDriverName || resolveDriverName;
  els.section = document.getElementById("liveMapSection");
  els.mapHost = document.getElementById("fleetMap");
  els.liveNote = document.getElementById("fleetMapLiveNote");
  els.activeCount = document.getElementById("fleetMapActiveCount");
}

export async function showLiveFleetMap() {
  if (!els.mapHost) {
    els.mapHost = document.getElementById("fleetMap");
  }
  if (!els.mapHost) return;

  setLiveNote("نقشہ لوڈ ہو رہا ہے…");
  try {
    // Wait a frame so [hidden] removal has applied layout.
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    ensureFleetMapReady();
    const liveCount = Object.keys(fleetMarkers).length;
    setLiveNote(
      liveCount
        ? `${liveCount} گاڑیاں نقشے پر · لائیو ٹریکنگ`
        : "نقشہ تیار ہے — آن لائن گاڑیاں یہاں نظر آئیں گی۔"
    );
  } catch (error) {
    console.warn("[SwiftGo Admin] showLiveFleetMap", error);
    setLiveNote(error?.message || "Could not initialize fleet map.");
  }
}

export function stopFleetMap() {
  stopFleetVehicleListener();
  Object.keys(fleetMarkers).forEach((vehicleId) => removeFleetMarker(vehicleId));
  if (fleetMap) {
    try {
      fleetMap.remove();
    } catch {
      /* ignore */
    }
  }
  fleetMap = null;
  mapInitialized = false;
  latestVehiclesById = {};
  setLiveNote("");
  if (els.activeCount) els.activeCount.textContent = "0 live vehicles";
}
