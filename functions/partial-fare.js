/**
 * Partial fare when customer cancels an in-progress ride.
 * Formula: baseFare + traveledKm × perKmRate (capped at original estimate).
 */

"use strict";

const { haversineKm } = require("./matching");
const { resolveVehicleRates, resolveEffectiveRates } = require("./pricing-fare");

const MIN_GPS_SEGMENT_KM = 0.01;

function resolveTraveledDistanceKm(ride) {
  const stored = Number(ride?.traveledDistanceKm);
  if (Number.isFinite(stored) && stored >= 0) {
    return Math.round(stored * 100) / 100;
  }

  const pickup = ride?.pickupLocation;
  const driver = ride?.driverLocation;
  if (
    pickup &&
    driver &&
    Number.isFinite(pickup.lat) &&
    Number.isFinite(pickup.lng) &&
    Number.isFinite(driver.lat) &&
    Number.isFinite(driver.lng)
  ) {
    const km = haversineKm(
      { lat: pickup.lat, lng: pickup.lng },
      { lat: driver.lat, lng: driver.lng }
    );
    return km != null ? Math.round(Math.max(0, km) * 100) / 100 : 0;
  }
  return 0;
}

function resolveFareCap(ride) {
  const cap = Number(ride?.farePkr ?? ride?.estimatedFare ?? ride?.driverBidFare);
  return Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
}

/**
 * @param {object} pricing settings/pricing doc
 * @param {object} ride ride document
 * @param {number} [traveledKmOverride]
 */
function computeCancellationFare(pricing, ride, traveledKmOverride) {
  const traveledKm =
    traveledKmOverride != null
      ? Math.max(0, Number(traveledKmOverride) || 0)
      : resolveTraveledDistanceKm(ride);
  const rates = resolveVehicleRates(pricing, ride);
  const plannedDistance = Number(ride?.distanceKm);
  const plannedTime = Number(ride?.timeMins);
  const { baseFare, perKmRate } = resolveEffectiveRates(
    rates,
    Number.isFinite(plannedDistance) ? plannedDistance : traveledKm,
    plannedTime
  );
  let cancellationFare = Math.round(baseFare + traveledKm * perKmRate);
  const cap = resolveFareCap(ride);
  if (cap != null) cancellationFare = Math.min(cancellationFare, cap);

  return {
    cancellationFare,
    traveledDistanceKm: Math.round(traveledKm * 100) / 100,
    baseFare,
    perKmRate,
    fareCap: cap,
  };
}

function accumulateTraveledSegment(ride, nextLat, nextLng) {
  const prev = ride?.lastTrackedLocation;
  let traveled = Number(ride?.traveledDistanceKm);
  if (!Number.isFinite(traveled) || traveled < 0) traveled = 0;

  if (
    prev &&
    Number.isFinite(prev.lat) &&
    Number.isFinite(prev.lng) &&
    Number.isFinite(nextLat) &&
    Number.isFinite(nextLng)
  ) {
    const delta = haversineKm({ lat: prev.lat, lng: prev.lng }, { lat: nextLat, lng: nextLng });
    if (delta != null && delta >= MIN_GPS_SEGMENT_KM) {
      traveled += delta;
    }
  } else if (
    traveled <= 0 &&
    ride?.pickupLocation &&
    Number.isFinite(ride.pickupLocation.lat) &&
    Number.isFinite(ride.pickupLocation.lng) &&
    Number.isFinite(nextLat) &&
    Number.isFinite(nextLng)
  ) {
    const fromPickup = haversineKm(
      { lat: ride.pickupLocation.lat, lng: ride.pickupLocation.lng },
      { lat: nextLat, lng: nextLng }
    );
    if (fromPickup != null && fromPickup >= MIN_GPS_SEGMENT_KM) {
      traveled = fromPickup;
    }
  }

  return {
    traveledDistanceKm: Math.round(traveled * 100) / 100,
    lastTrackedLocation: { lat: nextLat, lng: nextLng },
  };
}

module.exports = {
  resolveTraveledDistanceKm,
  computeCancellationFare,
  accumulateTraveledSegment,
  MIN_GPS_SEGMENT_KM,
};
