/**
 * Mirror assigned driver GPS from vehicles → rides for customer live tracking.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { accumulateTraveledSegment } = require("./partial-fare");

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

function buildDriverLocationPatch(vehicle, ride) {
  const loc = vehicle?.location;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  if (!ride || !ACTIVE_RIDE_STATUSES.includes(String(ride.status || ""))) return null;

  const patch = {
    driverLocation: { lat: loc.lat, lng: loc.lng },
    driverLocationUpdatedAt: vehicle.locationUpdatedAt || FieldValue.serverTimestamp(),
  };

  const pickup = ride.pickupLocation;
  if (pickup && Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)) {
    const km = haversineKm(
      { lat: loc.lat, lng: loc.lng },
      { lat: pickup.lat, lng: pickup.lng }
    );
    const roundedKm = Math.round(km * 100) / 100;
    patch.driverDistanceKm = roundedKm;
    patch.driverEtaMin = Math.max(1, Math.round((roundedKm / FALLBACK_SPEED_KMH) * 60));
  }

  if (String(ride?.status || "") === "in_progress") {
    const travel = accumulateTraveledSegment(ride, loc.lat, loc.lng);
    patch.traveledDistanceKm = travel.traveledDistanceKm;
    patch.lastTrackedLocation = travel.lastTrackedLocation;
  }

  return patch;
}

/**
 * Copy current vehicle GPS onto the assigned ride document.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} rideId
 * @param {string} vehicleId
 */
async function seedDriverLocationFromVehicle(db, rideId, vehicleId) {
  if (!rideId || !vehicleId) return;
  const [rideSnap, vehicleSnap] = await Promise.all([
    db.collection("rides").doc(rideId).get(),
    db.collection("vehicles").doc(vehicleId).get(),
  ]);
  if (!rideSnap.exists || !vehicleSnap.exists) return;
  const patch = buildDriverLocationPatch(vehicleSnap.data() || {}, rideSnap.data() || {});
  if (!patch) return;
  await rideSnap.ref.update(patch);
}

/**
 * Mirror vehicle GPS to its active ride when location or assignment changes.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} vehicleId
 * @param {object} vehicle
 */
async function mirrorDriverLocationToRide(db, vehicleId, vehicle) {
  const rideId = String(vehicle?.activeRideId || "").trim();
  if (!rideId) return;

  const rideRef = db.collection("rides").doc(rideId);
  const rideSnap = await rideRef.get();
  if (!rideSnap.exists) return;

  const ride = rideSnap.data() || {};
  if (ride.vehicleId && ride.vehicleId !== vehicleId) return;

  const patch = buildDriverLocationPatch(vehicle, ride);
  if (!patch) return;
  await rideRef.update(patch);
}

module.exports = {
  buildDriverLocationPatch,
  seedDriverLocationFromVehicle,
  mirrorDriverLocationToRide,
};
