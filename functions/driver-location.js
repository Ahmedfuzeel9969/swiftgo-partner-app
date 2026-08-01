/**
 * Authoritative ride-location mirror: vehicles → rides.
 * Driver clients write only vehicles.location; this CF mirrors to the assigned ride.
 * Phase 1: ordering, duplicate/noop, distance/ETA to tracking target, traveled km.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { accumulateTraveledSegment } = require("./partial-fare");
const {
  LOCATION_DIAG,
  evaluateFixAgainstPrevious,
  isValidLatLng,
  logLocationDiag,
  toVehicleLocationField,
} = require("./live-location-envelope");

const ACTIVE_RIDE_STATUSES = Object.freeze(["accepted", "arrived", "in_progress"]);
const FALLBACK_SPEED_KMH = 24;

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

function envelopeFromVehicleLocation(loc) {
  if (!loc || !isValidLatLng(Number(loc.lat), Number(loc.lng))) return null;
  return {
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    observedAt: Number(loc.observedAt) || 0,
    sequence: Number(loc.sequence) || 0,
    sessionId: String(loc.sessionId || ""),
    accuracyM: loc.accuracyM != null ? Number(loc.accuracyM) : null,
    headingDeg: loc.headingDeg != null ? Number(loc.headingDeg) : null,
    speedMps: loc.speedMps != null ? Number(loc.speedMps) : null,
    source: String(loc.source || "gps"),
  };
}

function previousEnvelopeFromRide(ride) {
  const loc = ride?.driverLocation;
  if (!loc) return null;
  return envelopeFromVehicleLocation({
    ...loc,
    observedAt: loc.observedAt || 0,
    sequence: loc.sequence || 0,
    sessionId: loc.sessionId || "",
  });
}

function trackingTargetForRide(ride) {
  const status = String(ride?.status || "");
  if (status === "in_progress") {
    const d = ride?.dropoffLocation;
    if (d && isValidLatLng(Number(d.lat), Number(d.lng))) {
      return { type: "dropoff", lat: Number(d.lat), lng: Number(d.lng) };
    }
    return null;
  }
  if (status === "accepted" || status === "arrived") {
    const p = ride?.pickupLocation;
    if (p && isValidLatLng(Number(p.lat), Number(p.lng))) {
      return { type: "pickup", lat: Number(p.lat), lng: Number(p.lng) };
    }
    return null;
  }
  return null;
}

/**
 * Build ride patch from vehicle location. Returns null when no write needed.
 * Ordering: same-session lower sequence / older observedAt is rejected.
 * Material-change noop: identical lat/lng/sequence/session/heading skip write.
 */
function buildDriverLocationPatch(vehicle, ride) {
  const loc = vehicle?.location;
  if (!loc || !isValidLatLng(Number(loc.lat), Number(loc.lng))) return null;
  if (!ride || !ACTIVE_RIDE_STATUSES.includes(String(ride.status || ""))) return null;

  const incoming = envelopeFromVehicleLocation(loc);
  if (!incoming) return null;

  // Legacy vehicle fixes without session/sequence: still mirror once (first-fix path).
  const previous = previousEnvelopeFromRide(ride);
  if (incoming.sessionId && previous) {
    const gate = evaluateFixAgainstPrevious(previous, incoming);
    if (!gate.accept) {
      logLocationDiag(gate.reason);
      return { __diag: gate.reason, __skip: true };
    }
  } else if (previous && incoming.observedAt && previous.observedAt) {
    if (incoming.observedAt < previous.observedAt) {
      logLocationDiag(LOCATION_DIAG.OUT_OF_ORDER);
      return { __diag: LOCATION_DIAG.OUT_OF_ORDER, __skip: true };
    }
  }

  const driverLocation = toVehicleLocationField(incoming) || {
    lat: incoming.lat,
    lng: incoming.lng,
  };
  // receivedAt is server-controlled on the ride document.
  driverLocation.receivedAt = FieldValue.serverTimestamp();

  if (
    previous &&
    Math.abs(previous.lat - incoming.lat) < 1e-7 &&
    Math.abs(previous.lng - incoming.lng) < 1e-7 &&
    Number(previous.sequence) === Number(incoming.sequence) &&
    String(previous.sessionId || "") === String(incoming.sessionId || "") &&
    Number(previous.headingDeg ?? -1) === Number(incoming.headingDeg ?? -1)
  ) {
    logLocationDiag(LOCATION_DIAG.NOOP_UNCHANGED);
    return { __diag: LOCATION_DIAG.NOOP_UNCHANGED, __skip: true };
  }

  const patch = {
    driverLocation,
    driverLocationUpdatedAt: vehicle.locationUpdatedAt || FieldValue.serverTimestamp(),
  };

  const target = trackingTargetForRide(ride);
  if (target) {
    const km = haversineKm(
      { lat: incoming.lat, lng: incoming.lng },
      { lat: target.lat, lng: target.lng }
    );
    const roundedKm = Math.round(km * 100) / 100;
    patch.driverDistanceKm = roundedKm;
    // Straight-line fixed-speed estimate — not live traffic.
    patch.driverEtaMin = Math.max(1, Math.round((roundedKm / FALLBACK_SPEED_KMH) * 60));
    patch.driverDistanceKind = "straight_line_estimate";
  }

  if (String(ride?.status || "") === "in_progress") {
    const travel = accumulateTraveledSegment(ride, incoming.lat, incoming.lng);
    patch.traveledDistanceKm = travel.traveledDistanceKm;
    patch.lastTrackedLocation = travel.lastTrackedLocation;
  }

  return patch;
}

async function seedDriverLocationFromVehicle(db, rideId, vehicleId) {
  if (!rideId || !vehicleId) return;
  const [rideSnap, vehicleSnap] = await Promise.all([
    db.collection("rides").doc(rideId).get(),
    db.collection("vehicles").doc(vehicleId).get(),
  ]);
  if (!rideSnap.exists || !vehicleSnap.exists) return;
  const patch = buildDriverLocationPatch(vehicleSnap.data() || {}, rideSnap.data() || {});
  if (!patch || patch.__skip) return;
  delete patch.__diag;
  await rideSnap.ref.update(patch);
  logLocationDiag(LOCATION_DIAG.MIRRORED);
}

async function mirrorDriverLocationToRide(db, vehicleId, vehicle) {
  const rideId = String(vehicle?.activeRideId || "").trim();
  if (!rideId) return { mirrored: false, reason: "no_active_ride" };

  const rideRef = db.collection("rides").doc(rideId);
  const rideSnap = await rideRef.get();
  if (!rideSnap.exists) return { mirrored: false, reason: "ride_missing" };

  const ride = rideSnap.data() || {};
  if (ride.vehicleId && ride.vehicleId !== vehicleId) {
    return { mirrored: false, reason: "vehicle_mismatch" };
  }

  const patch = buildDriverLocationPatch(vehicle, ride);
  if (!patch) return { mirrored: false, reason: LOCATION_DIAG.INVALID };
  if (patch.__skip) return { mirrored: false, reason: patch.__diag };

  delete patch.__diag;
  await rideRef.update(patch);
  logLocationDiag(LOCATION_DIAG.MIRRORED);
  return { mirrored: true, reason: LOCATION_DIAG.MIRRORED };
}

module.exports = {
  ACTIVE_RIDE_STATUSES,
  buildDriverLocationPatch,
  seedDriverLocationFromVehicle,
  mirrorDriverLocationToRide,
  trackingTargetForRide,
};
