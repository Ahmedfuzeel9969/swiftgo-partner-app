/**
 * Phase 16–32 — Ride request, live status, active ride, and invoice.
 */

import {
  watchRideRequest,
  submitRideRating,
} from "./data.js";
import { createCustomerBookingClient, cancelCustomerBookingClient } from "./booking-client.js";
import {
  finalizeOfferAsCustomer,
  counterOfferAsCustomer,
  rejectOfferAsCustomer,
  matchCandidatesForRide,
  watchRideOffers,
} from "./offer-client.js";
import { checkCustomerBookingGate } from "./booking-gate.js";
import { getPaymentMethod } from "./dashboard.js";
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

const STATUS_MESSAGE_KEYS = {
  accepted: "rideDriverOnTheWay",
  arrived: "rideDriverArrived",
  in_progress: "rideInProgress",
};

let els = {};
let onToast = null;
let onReset = null;
let activeRide = null;
let requesting = false;
let selectedRating = 0;
let ratingSubmitting = false;
let offerBusy = false;
let unsubscribeRide = () => {};
let unsubscribeOffers = () => {};
let activeOffers = [];
let selectedOfferId = null;
let pendingExtraBookingConfirm = false;

export function initRideFlow(handlers = {}) {
  onToast = handlers.onToast || null;
  onReset = handlers.onReset || null;
  els = {
    ridePanel: document.getElementById("ridePanel"),
    searchingPanel: document.getElementById("searchingPanel"),
    searchingSpinner: document.getElementById("searchingSpinner"),
    searchingPanelText: document.getElementById("searchingPanelText"),
    driverOfferPanel: document.getElementById("driverOfferPanel"),
    driverOfferDriverName: document.getElementById("driverOfferDriverName"),
    driverOfferVehicle: document.getElementById("driverOfferVehicle"),
    driverOfferFare: document.getElementById("driverOfferFare"),
    acceptDriverOfferBtn: document.getElementById("acceptDriverOfferBtn"),
    rejectDriverOfferBtn: document.getElementById("rejectDriverOfferBtn"),
    driverOfferCounterInput: document.getElementById("driverOfferCounterInput"),
    sendCounterOfferBtn: document.getElementById("sendCounterOfferBtn"),
    cancelBtn: document.getElementById("cancelRideBtn"),
    activePanel: document.getElementById("activeRidePanel"),
    activeVehicle: document.getElementById("activeRideVehicle"),
    activeStatusText: document.getElementById("activeRideStatusText"),
    activeDriverName: document.getElementById("activeRideTitle"),
    invoicePanel: document.getElementById("rideInvoicePanel"),
    invoiceFare: document.getElementById("rideInvoiceFare"),
    invoiceDoneBtn: document.getElementById("rideInvoiceDoneBtn"),
    ratingBlock: document.getElementById("rideRatingBlock"),
    ratingStars: document.getElementById("rideRatingStars"),
    ratingThanks: document.getElementById("rideRatingThanks"),
  };
  els.cancelBtn?.addEventListener("click", cancelActiveRide);
  els.acceptDriverOfferBtn?.addEventListener("click", onAcceptDriverOffer);
  els.rejectDriverOfferBtn?.addEventListener("click", onRejectDriverOffer);
  els.sendCounterOfferBtn?.addEventListener("click", onSendCounterOffer);
  els.invoiceDoneBtn?.addEventListener("click", dismissInvoiceAndReset);
  initRatingStars();
}

function initRatingStars() {
  if (!els.ratingStars || els.ratingStars.childElementCount) return;

  for (let value = 1; value <= 5; value += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ride-rating__star";
    btn.dataset.value = String(value);
    btn.setAttribute("aria-label", `${value} star${value === 1 ? "" : "s"}`);
    btn.textContent = "★";
    btn.addEventListener("click", () => setSelectedRating(value));
    els.ratingStars.appendChild(btn);
  }
}

function setSelectedRating(value) {
  if (activeRide?.customerRating) return;
  selectedRating = Math.max(1, Math.min(5, Math.round(Number(value) || 0)));
  updateRatingStarsUi();
}

function updateRatingStarsUi(existingRating = null) {
  if (!els.ratingStars) return;
  const activeValue = existingRating ?? selectedRating;
  [...els.ratingStars.querySelectorAll(".ride-rating__star")].forEach((btn) => {
    const starValue = Number(btn.dataset.value);
    const filled = starValue <= activeValue;
    btn.classList.toggle("is-filled", filled);
    btn.classList.toggle("is-selected", filled && !existingRating);
    btn.disabled = Boolean(existingRating);
    btn.setAttribute("aria-checked", String(starValue === activeValue));
  });
  if (els.ratingStars) {
    els.ratingStars.setAttribute("aria-label", t("rideRatingAria"));
  }
}

function resetRatingUi() {
  selectedRating = 0;
  if (els.ratingThanks) els.ratingThanks.hidden = true;
  if (els.ratingBlock) els.ratingBlock.classList.remove("is-rated");
  updateRatingStarsUi();
  [...(els.ratingStars?.querySelectorAll(".ride-rating__star") || [])].forEach((btn) => {
    btn.disabled = false;
  });
}

export function isSearchingDriver() {
  // Suppress vehicle list for any live trip session (search → invoice).
  return Boolean(activeRide);
}

/** Phase 2E — expose active ride for emulator/browser assertions. */
export function getActiveRide() {
  return activeRide;
}

function rideFareAmount(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function showSearchingState() {
  hideInvoicePanel();
  if (els.ridePanel) els.ridePanel.hidden = true;
  els.activePanel?.classList.remove("is-visible");
  if (els.activePanel) els.activePanel.hidden = true;
  if (!els.searchingPanel) return;
  els.searchingPanel.hidden = false;
  setSearchingOfferVisible(false);
  requestAnimationFrame(() => els.searchingPanel.classList.add("is-visible"));
}

function setSearchingOfferVisible(hasOffer) {
  if (els.searchingSpinner) els.searchingSpinner.hidden = hasOffer;
  if (els.driverOfferPanel) els.driverOfferPanel.hidden = !hasOffer;
  if (els.searchingPanelText) {
    els.searchingPanelText.hidden = hasOffer;
    if (!hasOffer) {
      els.searchingPanelText.textContent = t("searchingDriver");
      els.searchingPanelText.dataset.i18n = "searchingDriver";
    }
  }
}

function updateDriverOfferUi(_ride) {
  const open = (activeOffers || []).filter((o) =>
    ["open", "countered"].includes(o.status)
  );
  if (!open.length) {
    setSearchingOfferVisible(false);
    selectedOfferId = null;
    return;
  }
  const offer = open.find((o) => o.id === selectedOfferId) || open[0];
  selectedOfferId = offer.id;
  setSearchingOfferVisible(true);
  const fare = Math.round(Number(offer.fare) || 0);
  if (els.driverOfferDriverName) {
    els.driverOfferDriverName.textContent = offer.driverName || t("activeRideDriver");
  }
  if (els.driverOfferVehicle) {
    els.driverOfferVehicle.textContent = offer.vehiclePlate || "—";
  }
  if (els.driverOfferFare) {
    els.driverOfferFare.textContent = `Rs. ${fare.toLocaleString("en-PK")}`;
  }
  if (els.driverOfferCounterInput && !els.driverOfferCounterInput.value) {
    els.driverOfferCounterInput.placeholder = String(
      Math.round(Number(offer.customerCounterFare) || fare || 0)
    );
  }
}

async function onAcceptDriverOffer() {
  const ride = activeRide;
  if (!ride?.id || !selectedOfferId || offerBusy) return;
  offerBusy = true;
  if (els.acceptDriverOfferBtn) els.acceptDriverOfferBtn.disabled = true;
  try {
    await finalizeOfferAsCustomer(selectedOfferId);
    onToast?.(t("driverOfferAcceptedToast"));
  } catch (err) {
    console.warn("[SwiftGo] accept offer", err);
    onToast?.(t("driverOfferError"));
  } finally {
    offerBusy = false;
    if (els.acceptDriverOfferBtn) els.acceptDriverOfferBtn.disabled = false;
  }
}

async function onRejectDriverOffer() {
  if (!selectedOfferId || offerBusy) return;
  offerBusy = true;
  try {
    await rejectOfferAsCustomer(selectedOfferId);
    onToast?.(t("driverOfferRejectedToast"));
  } catch (err) {
    console.warn("[SwiftGo] reject offer", err);
    onToast?.(t("driverOfferError"));
  } finally {
    offerBusy = false;
  }
}

async function onSendCounterOffer() {
  if (!selectedOfferId || offerBusy) return;
  const fare = Math.round(Number(els.driverOfferCounterInput?.value) || 0);
  if (fare <= 0) {
    onToast?.(t("driverOfferCounterInvalid"));
    return;
  }
  offerBusy = true;
  if (els.sendCounterOfferBtn) els.sendCounterOfferBtn.disabled = true;
  try {
    await counterOfferAsCustomer(selectedOfferId, fare);
    onToast?.(t("driverOfferCounterSent"));
  } catch (err) {
    console.warn("[SwiftGo] counter offer", err);
    onToast?.(t("driverOfferError"));
  } finally {
    offerBusy = false;
    if (els.sendCounterOfferBtn) els.sendCounterOfferBtn.disabled = false;
  }
}

function restoreVehicleState() {
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  hideInvoicePanel();
  window.setTimeout(() => {
    if (els.searchingPanel) els.searchingPanel.hidden = true;
    if (els.activePanel) els.activePanel.hidden = true;
    if (els.ridePanel) els.ridePanel.hidden = false;
  }, 280);
}

function hideInvoicePanel() {
  els.invoicePanel?.classList.remove("is-visible");
  if (els.invoicePanel) els.invoicePanel.hidden = true;
}

function updateActiveRideStatusUi(status) {
  const key = STATUS_MESSAGE_KEYS[status] || "rideDriverOnTheWay";
  if (els.activeStatusText) {
    els.activeStatusText.textContent = t(key);
    els.activeStatusText.dataset.i18n = key;
  }
}

function showActiveRideState(status = "accepted") {
  // Force-hide searching sheet immediately so Active Ride is not covered.
  els.searchingPanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;
  hideInvoicePanel();

  const plate = activeRide?.vehiclePlate || "—";
  const driverName = activeRide?.driverName || t("activeRideDriver");
  if (els.activeDriverName) els.activeDriverName.textContent = driverName;
  if (els.activeVehicle) {
    els.activeVehicle.textContent = `${activeRide?.vehicleType || t("vehGo")} · ${plate}`;
  }
  updateActiveRideStatusUi(status);

  if (!els.activePanel) return;
  els.activePanel.hidden = false;
  requestAnimationFrame(() => els.activePanel.classList.add("is-visible"));
}

function showInvoicePanel(ride) {
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.activePanel) els.activePanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;

  if (els.invoiceFare) {
    const fare = rideFareAmount(ride);
    const discount = Number(ride?.discountAmount) || 0;
    if (discount > 0 && ride?.originalFare) {
      els.invoiceFare.textContent = `Rs. ${fare} (−${discount})`;
    } else {
      els.invoiceFare.textContent = `Rs. ${fare}`;
    }
  }

  if (ride?.customerRating) {
    selectedRating = ride.customerRating;
    updateRatingStarsUi(ride.customerRating);
    if (els.ratingThanks) els.ratingThanks.hidden = false;
    if (els.ratingBlock) els.ratingBlock.classList.add("is-rated");
  } else {
    resetRatingUi();
  }

  if (!els.invoicePanel) return;
  els.invoicePanel.hidden = false;
  requestAnimationFrame(() => els.invoicePanel.classList.add("is-visible"));
  onToast?.(t("rideCompleted"));
}

function stopRideWatch() {
  unsubscribeRide();
  unsubscribeRide = () => {};
  unsubscribeOffers();
  unsubscribeOffers = () => {};
  activeOffers = [];
  selectedOfferId = null;
}

function clearMapRouteState() {
  clearRoutePoint("pickup");
  clearRoutePoint("dropoff");
  clearLocationCue("pickup");
  clearLocationCue("dropoff");
}

function resetToVehicleSelection(messageKey) {
  stopRideWatch();
  activeRide = null;
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
  restoreVehicleState();
  if (messageKey) onToast?.(t(messageKey));
}

function dismissInvoiceAndReset() {
  if (ratingSubmitting) return;

  const ride = activeRide;
  const submitRating = selectedRating >= 1 && !ride?.customerRating;

  const finish = () => {
    stopRideWatch();
    activeRide = null;
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
    resetRatingUi();
    hideInvoicePanel();
    clearMapRouteState();
    if (els.ridePanel) els.ridePanel.hidden = false;
    onReset?.();
  };

  if (!submitRating || !ride?.id) {
    finish();
    return;
  }

  ratingSubmitting = true;
  if (els.invoiceDoneBtn) els.invoiceDoneBtn.disabled = true;

  submitRideRating(ride.id, selectedRating, ride.driverId)
    .then(() => {
      if (els.ratingThanks) els.ratingThanks.hidden = false;
      if (els.ratingBlock) els.ratingBlock.classList.add("is-rated");
      updateRatingStarsUi(selectedRating);
      onToast?.(t("rideRatingThanks"));
    })
    .catch((err) => {
      console.warn("[SwiftGo] ride rating", err);
      onToast?.(t("rideRatingError"));
    })
    .finally(() => {
      ratingSubmitting = false;
      if (els.invoiceDoneBtn) els.invoiceDoneBtn.disabled = false;
      finish();
    });
}

function handleRideSnapshot(ride) {
  if (!ride) return;
  const previousStatus = activeRide?.status;
  activeRide = { ...activeRide, ...ride };
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = activeRide;

  if (ride.status === "accepted" || ride.status === "arrived" || ride.status === "in_progress") {
    const firstActive =
      previousStatus !== "accepted" &&
      previousStatus !== "arrived" &&
      previousStatus !== "in_progress";
    if (firstActive) {
      showActiveRideState(ride.status);
      if (ride.status === "accepted") onToast?.(t("rideAccepted"));
    } else if (previousStatus !== ride.status) {
      updateActiveRideStatusUi(ride.status);
      if (ride.status === "arrived") onToast?.(t("rideDriverArrived"));
      if (ride.status === "in_progress") onToast?.(t("rideInProgress"));
    } else {
      updateActiveRideStatusUi(ride.status);
    }
  } else if (ride.status === "declined") {
    if (previousStatus !== "declined") resetToVehicleSelection("driverDeclined");
  } else if (ride.status === "completed") {
    if (previousStatus !== "completed") {
      stopRideWatch();
      showInvoicePanel(ride);
    }
  } else if (ride.status === "cancelled_by_user") {
    resetToVehicleSelection();
  } else if (ride.status === "searching_driver") {
    if (previousStatus !== "searching_driver") showSearchingState();
    updateDriverOfferUi(ride);
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
  const vehicleKey = state.vehicle || "";
  const faresByVehicle = window.SwiftGo?.lastFaresByVehicle || {};
  const liveByVehicle = Number(faresByVehicle[vehicleKey]);
  const liveEstimate = Number(window.SwiftGo?.lastEstimatedFare);
  const estimatedFare =
    Number.isFinite(liveByVehicle) && liveByVehicle >= 0
      ? liveByVehicle
      : Number.isFinite(liveEstimate) && liveEstimate >= 0
        ? liveEstimate
        : state.basePrice ?? state.price ?? 0;

  try {
    const gate = await checkCustomerBookingGate({
      confirmedExtraBooking: pendingExtraBookingConfirm,
    });
    if (!gate.allowed) {
      if (gate.reason === "MAX_ACTIVE_BOOKINGS") {
        onToast?.(t("bookingMaxActive"));
        return null;
      }
      if (gate.needsConfirmation || gate.reason === "CONFIRM_EXTRA_BOOKING") {
        const ok = window.confirm(
          `${t("bookingExtraConfirm")}\n\n${t("bookingExtraConfirmViewHint")}`
        );
        if (!ok) {
          onToast?.(t("bookingExtraCancelled"));
          try {
            window.SwiftGo?.navigate?.("history");
          } catch {
            /* ignore */
          }
          return null;
        }
        pendingExtraBookingConfirm = true;
        const gate2 = await checkCustomerBookingGate({ confirmedExtraBooking: true });
        if (!gate2.allowed) {
          onToast?.(t("bookingMaxActive"));
          return null;
        }
      } else {
        onToast?.(t("rideRequestFailed"));
        return null;
      }
    }
    pendingExtraBookingConfirm = false;

    const created = await createCustomerBookingClient({
      confirmedExtraBooking: true,
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
      vehicleType: t(VEHICLE_NAME_KEYS[vehicleKey] || "vehBike"),
      vehicleTypeKey: vehicleKey,
      distanceKm: route.totalDistance ?? 0,
      timeMins: route.totalTime ?? state.eta ?? 0,
      farePkr: estimatedFare,
      estimatedFare,
      promoCode: state.promoCode || "",
      discountAmount: state.discount || 0,
      paymentMethod: getPaymentMethod(),
    });

    const ride = {
      id: created.id,
      status: "searching_driver",
      farePkr: estimatedFare,
      estimatedFare,
      vehicleTypeKey: vehicleKey,
      promoCode: state.promoCode || "",
      paymentMethod: getPaymentMethod(),
    };

    activeRide = ride;
    if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = activeRide;
    showSearchingState();
    stopRideWatch();
    unsubscribeRide = watchRideRequest(
      ride.id,
      handleRideSnapshot,
      (err) => console.warn("[SwiftGo] ride watch", err)
    );
    unsubscribeOffers = watchRideOffers(
      ride.id,
      (offers) => {
        activeOffers = offers || [];
        updateDriverOfferUi(activeRide);
      },
      (err) => console.warn("[SwiftGo] offers watch", err)
    );
    matchCandidatesForRide(ride.id);
    return ride;
  } finally {
    requesting = false;
  }
}

async function cancelActiveRide() {
  const ride = activeRide;
  stopRideWatch();
  activeRide = null;
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
  restoreVehicleState();

  if (!ride?.id) return;
  try {
    await cancelCustomerBookingClient(ride.id);
    onToast?.(t("rideCancelled"));
  } catch (err) {
    console.warn("[SwiftGo] cancel ride", err);
  }
}
