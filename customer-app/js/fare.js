/**
 * Phase 15 — Dynamic route-based fares.
 *
 * Fare = base fare + (distance in km × per-km rate)
 *                  + (duration in minutes × per-minute rate)
 */

import { getRouteInfo } from "./routing.js";
import { setDynamicVehicleFares } from "./sheet.js";

export const FARE_MATRIX = Object.freeze({
  bike: Object.freeze({ base: 40, perKm: 15, perMin: 2 }),
  go: Object.freeze({ base: 100, perKm: 35, perMin: 4 }),
  "go-plus": Object.freeze({ base: 130, perKm: 40, perMin: 5 }),
  business: Object.freeze({ base: 200, perKm: 60, perMin: 8 }),
  "bike-cargo": Object.freeze({ base: 60, perKm: 20, perMin: 2 }),
  suzuki: Object.freeze({ base: 250, perKm: 50, perMin: 5 }),
  truck: Object.freeze({ base: 500, perKm: 80, perMin: 10 }),
});

const VEHICLE_NAME_TO_KEY = Object.freeze({
  bike: "bike",
  "بائیک": "bike",
  go: "go",
  "گو": "go",
  "go plus": "go-plus",
  "گو پلس": "go-plus",
  business: "business",
  "بزنس": "business",
  "bike cargo": "bike-cargo",
  "بائیک کارگو": "bike-cargo",
  suzuki: "suzuki",
  "سوزوکی": "suzuki",
  truck: "truck",
  "ٹرک": "truck",
});

let initialized = false;

function vehicleKey(card) {
  const stableKey = card.dataset.vehicle;
  if (FARE_MATRIX[stableKey]) return stableKey;

  const name =
    card.querySelector("h4")?.textContent ||
    card.querySelector(".vehicle-card__name")?.textContent ||
    card.querySelector("img[alt]")?.alt ||
    "";

  return VEHICLE_NAME_TO_KEY[name.trim().toLocaleLowerCase()] || null;
}

function calculateFare(rate, distance, time) {
  return Math.round(rate.base + distance * rate.perKm + time * rate.perMin);
}

function formatEta(minutes) {
  return document.documentElement.lang === "ur" ? `${minutes} منٹ` : `${minutes} min`;
}

function updateFares() {
  const routeInfo =
    window.SwiftGo?.getRouteInfo?.() ||
    getRouteInfo();
  const distance = Number(routeInfo?.totalDistance);
  const time = Number(routeInfo?.totalTime);

  if (!Number.isFinite(distance) || !Number.isFinite(time) || distance < 0 || time < 0) {
    return;
  }

  const roundedTime = Math.round(time);
  const fares = {};

  document.querySelectorAll(".vehicle-card").forEach((card) => {
    const key = vehicleKey(card);
    const rate = key ? FARE_MATRIX[key] : null;
    if (!rate) return;

    const fare = calculateFare(rate, distance, time);
    fares[key] = fare;

    const priceEl = card.querySelector(".price, .vehicle-card__price");
    const etaEl = card.querySelector(".eta, .vehicle-card__eta");

    if (priceEl) priceEl.textContent = `Rs. ${fare}`;
    if (etaEl) etaEl.textContent = formatEta(roundedTime);

    card.dataset.price = String(fare);
    card.dataset.eta = String(roundedTime);
  });

  setDynamicVehicleFares(fares, roundedTime);
}

export function initFareCalculation() {
  if (initialized) return;
  initialized = true;
  document.addEventListener("swiftgo:route-updated", updateFares);
}
