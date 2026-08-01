/**
 * Live assigned-driver marker, approach line, distance and ETA on the customer map.
 * Phase 1: ride.driverLocation (CF-mirrored) is authoritative; heading never points at target.
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
import { resolveTrackingTarget, clearRouteDisplayState, createRouteDisplayState } from "./tracking-target.mjs";
import {
  APPROACH_LINE_KIND,
  FRESHNESS,
  derivedDisplayBearingDeg,
  isValidLatLng,
  locationAgeMs,
  resolveFreshness,
  resolveMarkerRotationDeg,
  timestampToMs,
} from "./live-location-render.mjs";

const FALLBACK_SPEED_KMH = 24;
const FIT_BOUNDS_MS = 12_000;
const PAN_DRIVER_MS = 14_000;

let els = {};
let lastFitBoundsAt = 0;
let lastPanAt = 0;
/** @type {{ lat: number, lng: number } | null} */
let approachTarget = null;
/** @type {{ lat: number, lng: number } | null} */
let lastAcceptedFix = null;
/** @type {string} */
let lastTrackedDriverId = "";
let routeDisplayState = createRouteDisplayState();
/** When true, skip Phase-1 straight approach line (road layers own the line). */
let roadRouteLineSuppressed = false;

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

function formatDistanceKm(km) {
  const value = Number(km);
  if (!Number.isFinite(value) || value < 0) return "—";
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return (t("routeDistanceKm") || "{n} km").replace("{n}", shown);
}

function computeDistanceEta(ride, target) {
  if (Number.isFinite(ride?.driverDistanceKm)) {
    const km = Number(ride.driverDistanceKm);
    const eta = Number.isFinite(ride?.driverEtaMin)
      ? Number(ride.driverEtaMin)
      : Math.max(1, Math.round((km / FALLBACK_SPEED_KMH) * 60));
    return { km, eta, kind: "straight_line_estimate" };
  }

  const driver = ride?.driverLocation;
  if (!driver?.lat || !driver?.lng || !target) return null;

  const km = haversineKm(driver, target);
  const eta = Math.max(1, Math.round((km / FALLBACK_SPEED_KMH) * 60));
  return { km, eta, kind: "straight_line_estimate" };
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

function fitDriverAndTarget(driver, target) {
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

export function setRoadRouteLineSuppressed(suppressed) {
  roadRouteLineSuppressed = Boolean(suppressed);
  if (roadRouteLineSuppressed) {
    paintApproachLine(null, null);
  }
}

export function stopDriverTrack() {
  lastFitBoundsAt = 0;
  lastPanAt = 0;
  approachTarget = null;
  lastAcceptedFix = null;
  lastTrackedDriverId = "";
  roadRouteLineSuppressed = false;
  routeDisplayState = clearRouteDisplayState(routeDisplayState);
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

  const tracking = resolveTrackingTarget(ride);
  if (!tracking.trackingActive) {
    stopDriverTrack();
    return;
  }

  // Driver reassignment — tear down previous animation/listeners state.
  const driverId = String(ride.driverId || "");
  if (lastTrackedDriverId && driverId && lastTrackedDriverId !== driverId) {
    clearAssignedDriver();
    lastAcceptedFix = null;
  }
  if (driverId) lastTrackedDriverId = driverId;

  setSuppressSimulatedDrivers(true);
  clearLiveDrivers();

  approachTarget = tracking.coordinates;
  routeDisplayState.targetType = tracking.targetType;
  routeDisplayState.unavailable = !roadRouteLineSuppressed;
  routeDisplayState.reason = roadRouteLineSuppressed
    ? "phase4_road_route_layers"
    : "phase1_straight_line_only";

  const loc = ride.driverLocation;
  const ageMs = locationAgeMs(ride);
  const freshness = resolveFreshness(ageMs);
  const allowPredict = freshness === FRESHNESS.FRESH;
  const hasValidLoc = isValidLatLng(loc?.lat, loc?.lng);

  if (hasValidLoc && tracking.showDriverMarker) {
    const rotation = resolveMarkerRotationDeg({
      headingDeg: loc.headingDeg ?? loc.heading ?? null,
      previousFix: lastAcceptedFix,
      nextFix: { lat: loc.lat, lng: loc.lng },
      derivedBearingFn: derivedDisplayBearingDeg,
    });
    const observedFallback = timestampToMs(loc.observedAt);
    setAssignedDriverLocation(loc.lat, loc.lng, rotation.deg, {
      observedAt: observedFallback || Date.now() - (ageMs || 0),
      allowPredict: allowPredict && freshness !== FRESHNESS.UNKNOWN,
    });
    lastAcceptedFix = { lat: loc.lat, lng: loc.lng };

    if (tracking.approachLine && tracking.coordinates && !roadRouteLineSuppressed) {
      paintApproachLine(
        { lat: loc.lat, lng: loc.lng },
        { lat: tracking.coordinates.lat, lng: tracking.coordinates.lng }
      );
      fitDriverAndTarget(loc, tracking.coordinates);
      if (String(ride.status) === "accepted") panTowardDriver(loc.lat, loc.lng);
    } else if (roadRouteLineSuppressed) {
      paintApproachLine(null, null);
    } else {
      paintApproachLine(null, null);
    }
  } else if (!tracking.showDriverMarker) {
    clearAssignedDriver();
    paintApproachLine(null, null);
  }

  if (els.trackRow) els.trackRow.hidden = false;

  // Freshness / status messaging (Urdu via i18n).
  if (freshness === FRESHNESS.UNKNOWN) {
    if (els.distance) els.distance.textContent = t("liveTrackLocationUnknownTime");
    if (els.eta) els.eta.hidden = true;
    return;
  }
  if (freshness === FRESHNESS.STALE) {
    if (els.distance) els.distance.textContent = t("liveTrackLocationStale");
    if (els.eta) els.eta.hidden = true;
    return;
  }
  if (freshness === FRESHNESS.DELAYED) {
    if (els.distance) els.distance.textContent = t("liveTrackLocationDelayed");
    if (els.eta) els.eta.hidden = true;
    return;
  }

  if (tracking.uiMode === "driver_arrived") {
    if (els.distance) els.distance.textContent = t("liveTrackDriverArrived");
    if (els.eta) els.eta.hidden = true;
    return;
  }

  if (tracking.uiMode === "trip_in_progress") {
    if (els.distance) els.distance.textContent = t("liveTrackTripInProgress");
    if (els.eta) {
      els.eta.hidden = false;
      els.eta.textContent = t("liveTrackEstimateNotTraffic");
    }
    return;
  }

  const dist = computeDistanceEta(ride, tracking.coordinates);
  if (!dist) {
    if (els.distance) {
      els.distance.textContent = t(tracking.statusTextKey) || t("activeRideDriverLocationPending");
    }
    if (els.eta) els.eta.hidden = true;
    return;
  }

  if (els.distance) {
    const statusLine = t(tracking.statusTextKey) || "";
    const distLine = (t("activeRideDriverDistance") || "Driver is {distance} away").replace(
      "{distance}",
      formatDistanceKm(dist.km)
    );
    els.distance.textContent = statusLine ? `${statusLine} · ${distLine}` : distLine;
  }
  if (els.eta) {
    els.eta.hidden = false;
    // Honest label: straight-line estimate, not live traffic.
    els.eta.textContent = (t("liveTrackEtaEstimate") || "تخمینہ ~{eta} (سیدھی لکیر)").replace(
      "{eta}",
      (t("etaMin") || "{n} min").replace("{n}", String(dist.eta))
    );
  }

  void APPROACH_LINE_KIND;
}

export { resolveTrackingTarget };
