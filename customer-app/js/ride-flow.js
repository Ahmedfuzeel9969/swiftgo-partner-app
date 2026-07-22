/**
 * Phase 16–17 — Ride request, live status, and active-ride sheet states.
 */

import {
  createRideRequest,
  cancelRideRequest,
  completeRideRequest,
  watchRideRequest,
} from "./data.js";
import { getRouteInfo, clearRoutePoint } from "./routing.js";
import { clearLocationCue } from "./map.js";
import { t } from "./i18n.js";

const VEHICLE_NAME_KEYS = {
  bike: "vehBike",
  go: "vehGo",
  "go-plus": "vehGoPlus",
  business: "vehBusiness",
  "bike-cargo": "vehBikeCargo",
  suzuki: "vehSuzuki",
  truck: "vehTruck",
};

let els = {};
let onToast = null;
let onReset = null;
let activeRide = null;
let requesting = false;
let unsubscribeRide = () => {};

export function initRideFlow(handlers = {}) {
  onToast = handlers.onToast || null;
  onReset = handlers.onReset || null;
  els = {
    ridePanel: document.getElementById("ridePanel"),
    searchingPanel: document.getElementById("searchingPanel"),
    cancelBtn: document.getElementById("cancelRideBtn"),
    activePanel: document.getElementById("activeRidePanel"),
    activeVehicle: document.getElementById("activeRideVehicle"),
    completeBtn: document.getElementById("completeRideBtn"),
  };
  els.cancelBtn?.addEventListener("click", cancelActiveRide);
  els.completeBtn?.addEventListener("click", completeActiveRide);
}

export function isSearchingDriver() {
  return Boolean(activeRide) && activeRide.status !== "accepted" && activeRide.status !== "completed";
}

function showSearchingState() {
  if (els.ridePanel) els.ridePanel.hidden = true;
  els.activePanel?.classList.remove("is-visible");
  if (els.activePanel) els.activePanel.hidden = true;
  if (!els.searchingPanel) return;
  els.searchingPanel.hidden = false;
  requestAnimationFrame(() => els.searchingPanel.classList.add("is-visible"));
}

function restoreVehicleState() {
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  window.setTimeout(() => {
    if (els.searchingPanel) els.searchingPanel.hidden = true;
    if (els.activePanel) els.activePanel.hidden = true;
    if (els.ridePanel) els.ridePanel.hidden = false;
  }, 280);
}

function showActiveRideState() {
  // Force-hide searching sheet immediately so Active Ride is not covered.
  els.searchingPanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;

  if (els.activeVehicle) {
    els.activeVehicle.textContent = `${activeRide?.vehicleType || t("vehGo")} · KHI-1234`;
  }
  if (!els.activePanel) return;
  els.activePanel.hidden = false;
  requestAnimationFrame(() => els.activePanel.classList.add("is-visible"));
  onToast?.(t("rideAccepted"));
}

function stopRideWatch() {
  unsubscribeRide();
  unsubscribeRide = () => {};
}

function resetToVehicleSelection(messageKey) {
  stopRideWatch();
  activeRide = null;
  restoreVehicleState();
  if (messageKey) onToast?.(t(messageKey));
}

function resetCompletedRide(messageKey = "rideCompleted") {
  stopRideWatch();
  activeRide = null;
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.activePanel) els.activePanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;

  clearRoutePoint("pickup");
  clearRoutePoint("dropoff");
  clearLocationCue("pickup");
  clearLocationCue("dropoff");
  onReset?.();
  onToast?.(t(messageKey));
}

function handleRideSnapshot(ride) {
  if (!ride) return;
  const previousStatus = activeRide?.status;
  activeRide = { ...activeRide, ...ride };

  if (ride.status === "accepted") {
    // Avoid duplicate toasts if Firestore emits multiple snapshots.
    if (previousStatus !== "accepted") showActiveRideState();
  } else if (ride.status === "declined") {
    if (previousStatus !== "declined") resetToVehicleSelection("driverDeclined");
  } else if (ride.status === "completed") {
    if (previousStatus !== "completed") resetCompletedRide();
  } else if (ride.status === "cancelled_by_user") {
    resetToVehicleSelection();
  }
}

/**
 * Save the ride to Firestore, then flip the sheet into the searching state.
 * Caller (app.js) has already verified sign-in and pickup/destination.
 * @param {ReturnType<import('./sheet.js').getSheetState>} state
 */
export async function startRideRequest(state) {
  if (requesting || activeRide) return null;
  requesting = true;

  const route = getRouteInfo();
  try {
    const ride = await createRideRequest({
      pickupLocation: {
        lat: route.pickup?.lat,
        lng: route.pickup?.lng,
        address: state.pickup || "",
      },
      dropoffLocation: {
        lat: route.dropoff?.lat,
        lng: route.dropoff?.lng,
        address: state.destination || "",
      },
      vehicleType: t(VEHICLE_NAME_KEYS[state.vehicle] || "vehBike"),
      distanceKm: route.totalDistance ?? 0,
      timeMins: route.totalTime ?? state.eta ?? 0,
      farePkr: state.price ?? 0,
    });

    activeRide = ride;
    showSearchingState();
    stopRideWatch();
    unsubscribeRide = watchRideRequest(
      ride.id,
      handleRideSnapshot,
      (err) => console.warn("[SwiftGo] ride watch", err)
    );
    return ride;
  } finally {
    requesting = false;
  }
}

async function cancelActiveRide() {
  const ride = activeRide;
  stopRideWatch();
  activeRide = null;
  restoreVehicleState();

  if (!ride?.id) return;
  try {
    await cancelRideRequest(ride.id);
    onToast?.(t("rideCancelled"));
  } catch (err) {
    console.warn("[SwiftGo] cancel ride", err);
  }
}

async function completeActiveRide() {
  const ride = activeRide;
  if (!ride?.id) return;

  stopRideWatch();
  try {
    await completeRideRequest(ride.id);
    resetCompletedRide();
  } catch (err) {
    console.warn("[SwiftGo] complete ride", err);
    unsubscribeRide = watchRideRequest(
      ride.id,
      handleRideSnapshot,
      (watchErr) => console.warn("[SwiftGo] ride watch", watchErr)
    );
    onToast?.(t("rideRequestFailed"));
  }
}
