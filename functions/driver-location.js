/**
 * Authoritative ride-location mirror: vehicles → rides (transactional).
 * Driver clients write only vehicles.location; this CF mirrors to the assigned ride.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { accumulateTraveledSegment } = require("./partial-fare");
const {
  LOCATION_DIAG,
  evaluateFixAgainstPrevious,
  isValidLatLng,
  logLocationDiag,
  timestampToMs,
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
  if (!loc || !isValidLatLng(loc.lat, loc.lng)) return null;
  return {
    lat: loc.lat,
    lng: loc.lng,
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
  if (!loc || !isValidLatLng(loc.lat, loc.lng)) return null;
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
    if (d && isValidLatLng(d.lat, d.lng)) {
      return { type: "dropoff", lat: d.lat, lng: d.lng };
    }
    return null;
  }
  if (status === "accepted" || status === "arrived") {
    const p = ride?.pickupLocation;
    if (p && isValidLatLng(p.lat, p.lng)) {
      return { type: "pickup", lat: p.lat, lng: p.lng };
    }
    return null;
  }
  return null;
}

/**
 * Pure decision helper used inside transactions (and unit tests).
 * @returns {{ skip: true, reason: string } | { skip: false, reason: string, patch: object }}
 */
function buildDriverLocationPatch(vehicle, ride) {
  const loc = vehicle?.location;
  if (!loc || !isValidLatLng(loc.lat, loc.lng)) {
    return { skip: true, reason: LOCATION_DIAG.INVALID };
  }
  if (!ride || !ACTIVE_RIDE_STATUSES.includes(String(ride.status || ""))) {
    return { skip: true, reason: "terminal_or_inactive" };
  }

  const incoming = envelopeFromVehicleLocation(loc);
  if (!incoming) return { skip: true, reason: LOCATION_DIAG.INVALID };

  const previous = previousEnvelopeFromRide(ride);
  const vehicleSessionStartedMs = timestampToMs(vehicle?.trackingSessionStartedAt);
  const previousSessionStartedMs =
    timestampToMs(ride?.driverTrackingSessionStartedAt) ||
    timestampToMs(previous?.sessionStartedAt) ||
    0;

  const gate = evaluateFixAgainstPrevious(previous, incoming, {
    vehicleSessionId: String(vehicle?.trackingSessionId || incoming.sessionId || ""),
    vehicleSessionStartedMs,
    previousSessionStartedMs,
  });
  if (!gate.accept) {
    return { skip: true, reason: gate.reason };
  }

  if (
    previous &&
    Math.abs(previous.lat - incoming.lat) < 1e-7 &&
    Math.abs(previous.lng - incoming.lng) < 1e-7 &&
    Number(previous.sequence) === Number(incoming.sequence) &&
    String(previous.sessionId || "") === String(incoming.sessionId || "") &&
    Number(previous.headingDeg ?? -1) === Number(incoming.headingDeg ?? -1)
  ) {
    return { skip: true, reason: LOCATION_DIAG.NOOP_UNCHANGED };
  }

  const driverLocation = toVehicleLocationField(incoming) || {
    lat: incoming.lat,
    lng: incoming.lng,
  };
  // Server-controlled receive time (nested under driverLocation).
  driverLocation.receivedAt = FieldValue.serverTimestamp();

  const patch = {
    driverLocation,
    driverLocationUpdatedAt: vehicle.locationUpdatedAt || FieldValue.serverTimestamp(),
  };

  if (incoming.sessionId) {
    patch.driverTrackingSessionId = incoming.sessionId;
  }
  // Persist authoritative session start onto the ride for future transitions.
  if (vehicle?.trackingSessionStartedAt) {
    patch.driverTrackingSessionStartedAt = vehicle.trackingSessionStartedAt;
  }

  const target = trackingTargetForRide(ride);
  if (target) {
    const km = haversineKm(
      { lat: incoming.lat, lng: incoming.lng },
      { lat: target.lat, lng: target.lng }
    );
    const roundedKm = Math.round(km * 100) / 100;
    patch.driverDistanceKm = roundedKm;
    patch.driverEtaMin = Math.max(1, Math.round((roundedKm / FALLBACK_SPEED_KMH) * 60));
    patch.driverDistanceKind = "straight_line_estimate";
  }

  if (String(ride?.status || "") === "in_progress") {
    const travel = accumulateTraveledSegment(ride, incoming.lat, incoming.lng);
    patch.traveledDistanceKm = travel.traveledDistanceKm;
    patch.lastTrackedLocation = travel.lastTrackedLocation;
  }

  return { skip: false, reason: LOCATION_DIAG.MIRRORED, patch };
}

/**
 * Shared transactional mirror. All reads precede any write.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} vehicleId
 * @param {object} vehicleAfter committed vehicle snapshot data (location + session fields)
 * @param {{ rideId?: string }} [opts]
 */
async function mirrorRideLocationTransactional(db, vehicleId, vehicleAfter, opts = {}) {
  const rideId = String(opts.rideId || vehicleAfter?.activeRideId || "").trim();
  if (!rideId) return { mirrored: false, reason: "no_active_ride" };
  if (!vehicleId) return { mirrored: false, reason: LOCATION_DIAG.INVALID };

  const rideRef = db.collection("rides").doc(rideId);

  return db.runTransaction(async (tx) => {
    // --- reads only ---
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) {
      return { mirrored: false, reason: "ride_missing" };
    }
    const ride = rideSnap.data() || {};
    if (ride.vehicleId && ride.vehicleId !== vehicleId) {
      return { mirrored: false, reason: "vehicle_mismatch" };
    }

    const decision = buildDriverLocationPatch(vehicleAfter || {}, ride);
    if (decision.skip) {
      logLocationDiag(decision.reason);
      return { mirrored: false, reason: decision.reason };
    }

    // --- writes after all reads ---
    tx.update(rideRef, decision.patch);
    logLocationDiag(LOCATION_DIAG.MIRRORED);
    return { mirrored: true, reason: LOCATION_DIAG.MIRRORED };
  });
}

async function seedDriverLocationFromVehicle(db, rideId, vehicleId) {
  if (!rideId || !vehicleId) return { mirrored: false, reason: "missing_ids" };
  const vehicleSnap = await db.collection("vehicles").doc(vehicleId).get();
  if (!vehicleSnap.exists) return { mirrored: false, reason: "vehicle_missing" };
  return mirrorRideLocationTransactional(db, vehicleId, vehicleSnap.data() || {}, { rideId });
}

async function mirrorDriverLocationToRide(db, vehicleId, vehicle) {
  return mirrorRideLocationTransactional(db, vehicleId, vehicle || {}, {});
}

module.exports = {
  ACTIVE_RIDE_STATUSES,
  buildDriverLocationPatch,
  seedDriverLocationFromVehicle,
  mirrorDriverLocationToRide,
  mirrorRideLocationTransactional,
  trackingTargetForRide,
  previousEnvelopeFromRide,
  envelopeFromVehicleLocation,
};
