/**
 * Server-side fare math — mirrors customer-app/js/data.js (trusted cancel billing).
 */

"use strict";

const FALLBACK_VEHICLE_RATES = Object.freeze({
  go: Object.freeze({ baseFare: 40, perKmRate: 15, commissionPercent: 10 }),
  mini: Object.freeze({ baseFare: 100, perKmRate: 35, commissionPercent: 10 }),
  ac: Object.freeze({ baseFare: 130, perKmRate: 40, commissionPercent: 10 }),
  rickshaw: Object.freeze({ baseFare: 60, perKmRate: 20, commissionPercent: 10 }),
  premium: Object.freeze({ baseFare: 200, perKmRate: 60, commissionPercent: 10 }),
  bike: Object.freeze({ baseFare: 60, perKmRate: 20, commissionPercent: 10 }),
  van: Object.freeze({ baseFare: 250, perKmRate: 50, commissionPercent: 10 }),
  cargo: Object.freeze({ baseFare: 500, perKmRate: 80, commissionPercent: 10 }),
});

const FALLBACK_PRICING = Object.freeze({
  baseFare: FALLBACK_VEHICLE_RATES.go.baseFare,
  perKmRate: FALLBACK_VEHICLE_RATES.go.perKmRate,
  commissionPercent: FALLBACK_VEHICLE_RATES.go.commissionPercent,
});

function normalizeRate(raw, fallback) {
  const baseFare = Number(raw?.baseFare ?? raw?.base);
  const perKmRate = Number(raw?.perKmRate ?? raw?.perKm);
  const commissionPercent = Number(raw?.commissionPercent);
  return {
    baseFare: Number.isFinite(baseFare) && baseFare >= 0 ? baseFare : fallback.baseFare,
    perKmRate: Number.isFinite(perKmRate) && perKmRate >= 0 ? perKmRate : fallback.perKmRate,
    commissionPercent:
      Number.isFinite(commissionPercent) && commissionPercent >= 0
        ? commissionPercent
        : fallback.commissionPercent,
    distanceTiers: Array.isArray(raw?.distanceTiers) ? raw.distanceTiers : [],
    paceTiers: Array.isArray(raw?.paceTiers) ? raw.paceTiers : [],
  };
}

function resolveVehicleRates(pricing, ride) {
  const vehicles = pricing?.vehicles || {};
  const key = String(ride?.vehicleTypeKey || "").trim();
  if (key && vehicles[key]) {
    return normalizeRate(vehicles[key], FALLBACK_VEHICLE_RATES[key] || FALLBACK_VEHICLE_RATES.go);
  }
  const type = String(ride?.vehicleType || "").trim().toLowerCase();
  for (const [k, cfg] of Object.entries(vehicles)) {
    if (k.toLowerCase() === type) {
      return normalizeRate(cfg, FALLBACK_VEHICLE_RATES[k] || FALLBACK_VEHICLE_RATES.go);
    }
  }
  if (Number.isFinite(Number(pricing?.baseFare)) || Number.isFinite(Number(pricing?.perKmRate))) {
    return normalizeRate(pricing, FALLBACK_PRICING);
  }
  return normalizeRate(FALLBACK_VEHICLE_RATES.go, FALLBACK_VEHICLE_RATES.go);
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
  FALLBACK_VEHICLE_RATES,
};
