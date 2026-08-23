/**
 * Server-side fare math — uses canonical vehicle catalog for rate resolution.
 */

"use strict";

const {
  DEFAULT_VEHICLE_RATES,
  DEFAULT_PRICING,
  resolveVehicleTypeKeyForRead,
  lookupPricingVehicleEntry,
  getDefaultVehicleRate,
} = require("./vehicle-catalog");

function normalizeRate(raw, fallback) {
  const baseFare = Number(raw?.baseFare ?? raw?.base);
  const perKmRate = Number(raw?.perKmRate ?? raw?.perKm);
  const commissionPercent = Number(raw?.commissionPercent);
  return {
    baseFare: Number.isFinite(baseFare) && baseFare >= 0 ? baseFare : fallback.baseFare,
    perKmRate: Number.isFinite(perKmRate) && perKmRate >= 0 ? perKmRate : fallback.perKmRate,
    commissionPercent:
      Number.isFinite(commissionPercent) &&
      commissionPercent >= 0 &&
      commissionPercent <= 100
        ? commissionPercent
        : fallback.commissionPercent,
    distanceTiers: Array.isArray(raw?.distanceTiers) ? raw.distanceTiers : [],
    paceTiers: Array.isArray(raw?.paceTiers) ? raw.paceTiers : [],
  };
}

function resolveVehicleRates(pricing, ride) {
  const rawKey = ride?.vehicleTypeKey || ride?.vehicleType || "";
  const resolution = resolveVehicleTypeKeyForRead(rawKey);
  if (!resolution.ok) {
    const err = new Error(`${resolution.code}:${resolution.input}`);
    err.code = resolution.code;
    err.diagnostic = resolution;
    throw err;
  }

  const defaults = getDefaultVehicleRate(resolution.canonicalId);
  const vehicles = pricing?.vehicles || {};
  const entry = lookupPricingVehicleEntry(vehicles, resolution);
  if (entry) {
    return normalizeRate(entry, defaults);
  }

  if (Number.isFinite(Number(pricing?.baseFare)) || Number.isFinite(Number(pricing?.perKmRate))) {
    return normalizeRate(pricing, defaults);
  }

  return normalizeRate(defaults, defaults);
}

function resolveEffectiveRates(rates, distanceKm, timeMins) {
  const distance = Number(distanceKm);
  const time = Number(timeMins);
  let baseFare = Number(rates?.baseFare) || 0;
  let perKmRate = Number(rates?.perKmRate) || 0;

  const distanceTiers = Array.isArray(rates?.distanceTiers) ? rates.distanceTiers : [];
  if (distanceTiers.length && Number.isFinite(distance) && distance >= 0) {
    const match = distanceTiers.find((tier) => tier.upToKm == null || distance <= tier.upToKm);
    if (match) {
      baseFare = Number(match.baseFare) || baseFare;
      perKmRate = Number(match.perKmRate) || perKmRate;
    }
  }

  const paceTiers = Array.isArray(rates?.paceTiers) ? rates.paceTiers : [];
  if (
    paceTiers.length &&
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(time) &&
    time >= 0
  ) {
    const minPerKm = time / distance;
    const match = paceTiers.find((tier) => tier.maxMinPerKm == null || minPerKm <= tier.maxMinPerKm);
    if (match) {
      baseFare = Number(match.baseFare) || baseFare;
      perKmRate = Number(match.perKmRate) || perKmRate;
    }
  }

  return { baseFare, perKmRate };
}

function calculateVehicleFare(rates, distanceKm, timeMins) {
  const { baseFare, perKmRate } = resolveEffectiveRates(rates, distanceKm, timeMins);
  const distance = Number(distanceKm);
  if (![baseFare, perKmRate, distance].every((n) => Number.isFinite(n) && n >= 0)) {
    return 0;
  }
  return Math.round(baseFare + distance * perKmRate);
}

module.exports = {
  resolveVehicleRates,
  resolveEffectiveRates,
  calculateVehicleFare,
  FALLBACK_VEHICLE_RATES: DEFAULT_VEHICLE_RATES,
  DEFAULT_PRICING,
};
