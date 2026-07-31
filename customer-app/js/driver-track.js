/**
 * Live assigned-driver marker, approach line, distance and ETA on the customer map.
 */

import {
  clearLiveDrivers,
  setAssignedDriverLocation,
  clearAssignedDriver,
  setDriverApproachLine,
  setSuppressSimulatedDrivers,
  getMap,
  onAssignedDriverMove,
} from "./map.js";
import { t } from "./i18n.js";

const FALLBACK_SPEED_KMH = 24;
const STALE_MS = 10 * 60 * 1000;
const FIT_BOUNDS_MS = 12_000;
const PAN_DRIVER_MS = 14_000;

let els = {};
let lastFitBoundsAt = 0;
let lastPanAt = 0;
/** @type {{ lat: number, lng: number } | null} */
let approachTarget = null;

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

function bearingDeg(lat1, lng1, lat2, lng2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function pickupTarget(ride) {
  const pickup = ride?.pickupLocation;
  if (pickup && Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)) {
    return { lat: pickup.lat, lng: pickup.lng };
  }
  return null;
}

function locationUpdatedMs(ride) {
  if (Number.isFinite(ride?.driverLocationReceivedAt)) {
    return Number(ride.driverLocationReceivedAt);
  }
  const ts = ride?.driverLocationUpdatedAt;
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function isLocationStale(ride) {
  const ms = locationUpdatedMs(ride);
  return !ms || Date.now() - ms > STALE_MS;
}

function formatDistanceKm(km) {
  const value = Number(km);
  if (!Number.isFinite(value) || value < 0) return "—";
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return (t("routeDistanceKm") || "{n} km").replace("{n}", shown);
}

function computeDistanceEta(ride) {
  if (Number.isFinite(ride?.driverDistanceKm)) {
    const km = Number(ride.driverDistanceKm);
    const eta = Number.isFinite(ride?.driverEtaMin)
      ? Number(ride.driverEtaMin)
      : Math.max(1, Math.round((km / FALLBACK_SPEED_KMH) * 60));
    return { km, eta };
  }

  const driver = ride?.driverLocation;
  const target = pickupTarget(ride);
  if (!driver?.lat || !driver?.lng || !target) return null;

  const km = haversineKm(driver, target);
  const eta = Math.max(1, Math.round((km / FALLBACK_SPEED_KMH) * 60));
  return { km, eta };
}

function panTowardDriver(lat, lng) {
  const map = getMap();
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const now = Date.now();
  if (now - lastPanAt < PAN_DRIVER_MS) return;
  lastPanAt = now;
  try {
    map.panTo([lat, lng], { animate: true, duration: 1.1 });
  } catch {
    /* ignore */
  }
}

function paintApproachLine(from, to) {
  if (!from || !to) {
    setDriverApproachLine(null, null);
    return;
  }
  setDriverApproachLine(from, to);
}

function fitDriverAndPickup(driver, target) {
  const map = getMap();
  if (!map || typeof L === "undefined" || !target) return;
  const now = Date.now();
  if (now - lastFitBoundsAt < FIT_BOUNDS_MS) return;
  lastFitBoundsAt = now;
  try {
    const bounds = L.latLngBounds([
      [driver.lat, driver.lng],
      [target.lat, target.lng],
    ]);
    map.fitBounds(bounds, {
      paddingTopLeft: [48, 110],
      paddingBottomRight: [48, 300],
      maxZoom: 16,
    });
  } catch {
    /* ignore fit errors */
  }
}

export function initDriverTrack() {
  els = {
    trackRow: document.getElementById("activeRideDriverTrack"),
    distance: document.getElementById("activeRideDriverDistance"),
    eta: document.getElementById("activeRideDriverEta"),
  };
  onAssignedDriverMove((lat, lng) => {
    if (!approachTarget) return;
    paintApproachLine({ lat, lng }, approachTarget);
  });
}

export function stopDriverTrack() {
  lastFitBoundsAt = 0;
  lastPanAt = 0;
  approachTarget = null;
  setSuppressSimulatedDrivers(false);
  clearAssignedDriver();
  if (els.trackRow) els.trackRow.hidden = true;
  if (els.distance) els.distance.textContent = "";
  if (els.eta) {
    els.eta.textContent = "";
    els.eta.hidden = true;
  }
}

/**
 * @param {object | null} ride
 */
export function updateDriverTrack(ride) {
  if (!ride) {
    stopDriverTrack();
    return;
  }

  const status = String(ride.status || "");
  if (!["accepted", "arrived", "in_progress"].includes(status)) {
    stopDriverTrack();
    return;
  }

  setSuppressSimulatedDrivers(true);
  clearLiveDrivers();

  const target = pickupTarget(ride);
  approachTarget = target;
  const loc = ride.driverLocation;

  if (loc?.lat && loc?.lng) {
    let heading = 0;
    if (target) heading = bearingDeg(loc.lat, loc.lng, target.lat, target.lng);
    setAssignedDriverLocation(loc.lat, loc.lng, heading);
    if (target) {
      paintApproachLine({ lat: loc.lat, lng: loc.lng }, { lat: target.lat, lng: target.lng });
      fitDriverAndPickup(loc, target);
      if (status === "accepted") panTowardDriver(loc.lat, loc.lng);
    }
  } else {
    clearAssignedDriver();
    paintApproachLine(null, null);
  }

  if (els.trackRow) els.trackRow.hidden = false;

  if (status === "arrived") {
    if (els.distance) els.distance.textContent = t("rideDriverArrived");
    if (els.eta) els.eta.hidden = true;
    return;
  }

  if (status === "in_progress") {
    if (els.distance) els.distance.textContent = t("rideInProgress");
    if (els.eta) els.eta.hidden = true;
    return;
  }

  const stale = isLocationStale(ride);
  const dist = computeDistanceEta(ride);

  if (stale || !dist) {
    if (els.distance) els.distance.textContent = t("activeRideDriverLocationPending");
    if (els.eta) els.eta.hidden = true;
    return;
  }

  if (els.distance) {
    els.distance.textContent = (t("activeRideDriverDistance") || "Driver is {distance} away").replace(
      "{distance}",
      formatDistanceKm(dist.km)
    );
  }
  if (els.eta) {
    els.eta.hidden = false;
    els.eta.textContent = (t("activeRideDriverEta") || "Arriving in ~{eta} min").replace(
      "{eta}",
      (t("etaMin") || "{n} min").replace("{n}", String(dist.eta))
    );
  }
}
