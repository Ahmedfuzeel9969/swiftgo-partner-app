/**
 * Phase 15–47 — Dynamic route-based fares from Super Admin per-vehicle rates.
 *
 * Uses default base/perKm, optional distanceTiers, then optional paceTiers (min/km).
 * Fare = Math.round(baseFare + distanceKm × perKmRate)
 */

import { getRouteInfo } from "./routing.js";
import { setDynamicVehicleFares } from "./sheet.js";
import {
  FALLBACK_PRICING,
  FALLBACK_VEHICLE_RATES,
  calculateVehicleFare,
  getPricingSettings,
  getVehicleRates,
} from "./data.js";
import {
  CANONICAL_VEHICLE_IDS,
  resolveVehicleTypeKeyFromLabel,
} from "./vehicle-catalog.mjs";

/** Kept for vehicle-key resolution / legacy card mapping (perMin unused in fare calc). */
export const FARE_MATRIX = Object.freeze(
  Object.fromEntries(
    CANONICAL_VEHICLE_IDS.map((id) => [
      id,
      Object.freeze({
        base: FALLBACK_VEHICLE_RATES[id].baseFare,
        perKm: FALLBACK_VEHICLE_RATES[id].perKmRate,
        perMin: 0,
      }),
    ])
  )
);

let initialized = false;
let fareUpdateSeq = 0;
/** @type {ReturnType<typeof getPricingSettings> extends Promise<infer T> ? T : never | null} */
let cachedPricing = null;
/** @type {Record<string, number>} */
let lastFaresByVehicle = {};

function vehicleKey(card) {
  const stableKey = card.dataset.vehicle;
  if (FARE_MATRIX[stableKey] || FALLBACK_VEHICLE_RATES[stableKey]) return stableKey;

  const name =
    card.querySelector("h4")?.textContent ||
    card.querySelector(".vehicle-card__name")?.textContent ||
    card.querySelector("img[alt]")?.alt ||
    "";

  return resolveVehicleTypeKeyFromLabel(name.trim().toLocaleLowerCase()) || null;
}

/** Legacy helper — flat base + per-km (no tiers). */
export function calculateEstimatedFare(baseFare, perKmRate, distanceInKm) {
  const base = Number(baseFare);
  const perKm = Number(perKmRate);
  const distance = Number(distanceInKm);
  if (![base, perKm, distance].every((n) => Number.isFinite(n) && n >= 0)) {
    return 0;
  }
  return Math.round(base + distance * perKm);
}

function formatEta(minutes) {
  return document.documentElement.lang === "ur" ? `${minutes} منٹ` : `${minutes} min`;
}

function formatEstimateLabel(fare) {
  const amount = `Rs. ${fare}`;
  return document.documentElement.lang === "ur"
    ? `تخمینہ کرایہ: ${amount}`
    : `Estimated fare: ${amount}`;
}

function updateEstimateBanner(fare) {
  let banner = document.getElementById("dynamicFareEstimate");
  if (!banner) {
    const sheet = document.getElementById("bookingSheet") || document.querySelector(".sheet");
    if (!sheet) return;
    banner = document.createElement("p");
    banner.id = "dynamicFareEstimate";
    banner.className = "dynamic-fare-estimate";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    const vehicles = sheet.querySelector(".vehicle-list, .vehicles, #vehicleList");
    if (vehicles?.parentNode) {
      vehicles.parentNode.insertBefore(banner, vehicles);
    } else {
      sheet.prepend(banner);
    }
  }
  banner.hidden = !Number.isFinite(fare) || fare < 0;
  if (!banner.hidden) banner.textContent = formatEstimateLabel(fare);
}

async function loadLivePricing() {
  try {
    cachedPricing = await getPricingSettings();
  } catch (error) {
    console.warn("[SwiftGo] live pricing fetch", error);
    cachedPricing = { ...FALLBACK_PRICING, source: "fallback" };
  }
  return cachedPricing;
}

async function updateFares() {
  const seq = ++fareUpdateSeq;
  const routeInfo = window.SwiftGo?.getRouteInfo?.() || getRouteInfo();
  const distance = Number(routeInfo?.totalDistance);
  const time = Number(routeInfo?.totalTime);

  if (!Number.isFinite(distance) || !Number.isFinite(time) || distance < 0 || time < 0) {
    return;
  }

  const pricing = await loadLivePricing();
  if (seq !== fareUpdateSeq) return;

  const roundedTime = Math.round(time);
  /** @type {Record<string, number>} */
  const fares = {};
  let selectedFare = null;

  document.querySelectorAll(".vehicle-card").forEach((card) => {
    const key = vehicleKey(card);
    if (!key) return;

    const rates = getVehicleRates(pricing, key);
    const estimatedFare = calculateVehicleFare(rates, distance, time);
    fares[key] = estimatedFare;

    const priceEl = card.querySelector(".price, .vehicle-card__price");
    const etaEl = card.querySelector(".eta, .vehicle-card__eta");

    if (priceEl) priceEl.textContent = `Rs. ${estimatedFare}`;
    if (etaEl) etaEl.textContent = formatEta(roundedTime);

    card.dataset.price = String(estimatedFare);
    card.dataset.eta = String(roundedTime);
    card.dataset.estimatedFare = String(estimatedFare);

    if (card.classList.contains("is-active") || card.getAttribute("aria-pressed") === "true") {
      selectedFare = estimatedFare;
    }
  });

  lastFaresByVehicle = fares;
  setDynamicVehicleFares(fares, roundedTime);

  const bannerFare =
    selectedFare != null
      ? selectedFare
      : fares.go ?? fares.bike ?? Object.values(fares)[0] ?? 0;
  updateEstimateBanner(bannerFare);

  window.SwiftGo = window.SwiftGo || {};
  window.SwiftGo.lastEstimatedFare = bannerFare;
  window.SwiftGo.lastFaresByVehicle = { ...fares };
  window.SwiftGo.lastPricing = pricing;
}

export function getFareForVehicle(vehicleKey) {
  if (vehicleKey && Number.isFinite(lastFaresByVehicle[vehicleKey])) {
    return lastFaresByVehicle[vehicleKey];
  }
  return Number(window.SwiftGo?.lastEstimatedFare) || 0;
}

export function initFareCalculation() {
  if (initialized) return;
  initialized = true;
  document.addEventListener("swiftgo:route-updated", () => {
    updateFares().catch((err) => console.warn("[SwiftGo] updateFares", err));
  });
  document.addEventListener("swiftgo:vehicle-selected", () => {
    const key =
      window.SwiftGo?.selectedVehicleKey ||
      document.querySelector(".vehicle-card.is-selected")?.dataset?.vehicle;
    const fare = getFareForVehicle(key);
    if (Number.isFinite(fare) && fare >= 0) {
      updateEstimateBanner(fare);
      window.SwiftGo = window.SwiftGo || {};
      window.SwiftGo.lastEstimatedFare = fare;
    }
  });
  loadLivePricing().catch(() => {});
}

export function getCachedPricing() {
  return cachedPricing || { ...FALLBACK_PRICING, source: "fallback" };
}
