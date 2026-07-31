/**
 * Customer trip history — three tabs: Active / Completed / Cancelled.
 * Cancelled rows show who cancelled and when.
 */

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";
import { t, applyTranslations, formatMoney } from "./i18n.js";
import { NON_TERMINAL_RIDE_STATUSES, CANCELLABLE_RIDE_STATUSES, isCustomerActiveRideStatus, normalizeCustomerRideStatus } from "./ride-status.js";
import { cancelCustomerBookingClient, previewCancellationFareClient } from "./booking-client.js";
import { askCancelRideReason } from "./cancel-reason-dialog.js";

const ACTIVE_STATUSES = new Set(NON_TERMINAL_RIDE_STATUSES);
const CUSTOMER_CANCEL_STATUSES = new Set([
  "cancelled_by_customer",
  "cancelled_by_user",
]);
const DRIVER_OR_SYSTEM_CANCEL_STATUSES = new Set([
  "cancelled_by_driver",
  "cancelled_by_admin",
  "cancelled_by_system",
  "cancelled",
  "expired",
  "no_driver_found",
  "declined",
  "rejected",
]);
const SEARCH_TIMEOUT_MS = 180_000;

const VEHICLE_NAME_KEYS = {
  bike: "vehBike",
  go: "vehGo",
  "go-plus": "vehGoPlus",
  business: "vehBusiness",
  "bike-cargo": "vehBikeCargo",
  suzuki: "vehSuzuki",
  truck: "vehTruck",
};

/** @type {"active" | "completed" | "cancelled"} */
let activeTab = "active";
let unsubRides = () => {};
let ridesCache = [];
let activeTickId = 0;
let tabsBound = false;
let cancelBound = false;
/** @type {(msg: string) => void} */
let onToast = () => {};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRideDate(createdAt) {
  if (!createdAt) return "—";
  const date =
    typeof createdAt?.toDate === "function"
      ? createdAt.toDate()
      : createdAt?.seconds
        ? new Date(createdAt.seconds * 1000)
        : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  const locale = document.documentElement.lang === "ur" ? "ur-PK" : "en-PK";
  return date.toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fareAmount(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function createdMs(ride) {
  if (!ride?.createdAt) return 0;
  if (typeof ride.createdAt.toMillis === "function") return ride.createdAt.toMillis();
  if (typeof ride.createdAt.seconds === "number") return ride.createdAt.seconds * 1000;
  return 0;
}

function warnIndexError(error) {
  console.warn("[SwiftGo] Firestore listen retry... customer history", error);
  if (error?.code === "failed-precondition" || /index/i.test(error?.message || "")) {
    console.warn(
      "[SwiftGo] Firestore composite index required for rides (userId + createdAt).",
      error.message
    );
  }
}

function isActiveRide(ride) {
  return isCustomerActiveRideStatus(ride?.status);
}

function isCompletedRide(ride) {
  return String(ride?.status || "") === "completed";
}

function isCancelledRide(ride) {
  const status = String(ride?.status || "");
  return CUSTOMER_CANCEL_STATUSES.has(status) || DRIVER_OR_SYSTEM_CANCEL_STATUSES.has(status);
}

function partitionRides(rides = ridesCache) {
  const active = [];
  const completed = [];
  const cancelled = [];
  for (const ride of rides) {
    if (isActiveRide(ride)) active.push(ride);
    else if (isCompletedRide(ride)) completed.push(ride);
    else if (isCancelledRide(ride)) cancelled.push(ride);
  }
  return { active, completed, cancelled };
}

function statusLabel(status) {
  if (status === "searching_driver") return t("activeBookingSearching") || "Searching";
  if (status === "accepted" || status === "arrived") {
    return t("activeBookingBeforeTrip") || t("activeBookingAssigned") || "Before trip start";
  }
  if (status === "in_progress") {
    return t("rideStatusInProgress") || "Trip in progress";
  }
  if (status === "expired" || status === "no_driver_found") {
    return t("noDriverAvailable") || "کوئی ڈرائیور دستیاب نہ ہوا";
  }
  return status || "—";
}

function isCancellableActiveRide(ride) {
  return CANCELLABLE_RIDE_STATUSES.includes(String(ride?.status || ""));
}

function searchCountdown(ride) {
  if (ride.status !== "searching_driver") return "";
  const start = createdMs(ride);
  if (!start) return "";
  const remaining = Math.max(0, SEARCH_TIMEOUT_MS - (Date.now() - start));
  const totalSec = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${t("searchingTimerLabel") || "Time left"} ${m}:${String(s).padStart(2, "0")}`;
}

function cancelActorLabel(ride) {
  const status = String(ride?.status || "");
  if (CUSTOMER_CANCEL_STATUSES.has(status)) {
    return t("historyCancelByCustomer") || "Cancelled by you";
  }
  if (status === "cancelled_by_driver") {
    return t("historyCancelByDriver") || "Cancelled by driver";
  }
  if (status === "cancelled_by_admin") {
    return t("historyCancelByAdmin") || "Cancelled by admin";
  }
  if (status === "expired" || status === "no_driver_found") {
    return t("historyCancelBySystemTimeout") || "Cancelled by system (no driver found)";
  }
  if (status === "cancelled_by_system" || status === "cancelled") {
    return t("historyCancelBySystem") || "Cancelled by system";
  }
  if (status === "declined" || status === "rejected") {
    return t("historyCancelByDriver") || "Cancelled by driver";
  }
  return t("historyCancelBySystem") || "Cancelled by system";
}

function cancelWhenValue(ride) {
  return ride?.cancelledAt || ride?.expiredAt || ride?.updatedAt || ride?.createdAt;
}

function cancelReasonLabel(ride) {
  const key = String(ride?.cancelReasonKey || "").trim();
  const map = {
    taking_too_long: t("cancelReasonTakingTooLong") || "Taking too long",
    booked_by_mistake: t("cancelReasonBookedByMistake") || "Booked by mistake",
    found_alternative: t("cancelReasonFoundAlternative") || "Found alternative",
    other: t("cancelReasonOther") || "Other",
    admin: t("historyCancelByAdmin") || "Admin",
    bulk_clear_searching: t("historyCancelBulkClear") || "Cleared searching bookings",
    search_timeout_3min: t("historyCancelBySystemTimeout") || "Search timeout",
  };
  if (key && map[key]) return map[key];
  const raw = String(ride?.cancelReason || "").trim();
  if (!raw || raw === key) return "";
  return raw;
}

function setCountBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!count) {
    el.hidden = true;
    el.textContent = "0";
    return;
  }
  el.hidden = false;
  el.textContent = String(count);
}

function setHistoryTab(tab) {
  const next = tab === "completed" || tab === "cancelled" ? tab : "active";
  activeTab = next;
  document.querySelectorAll("[data-history-tab]").forEach((btn) => {
    const on = btn.getAttribute("data-history-tab") === next;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-history-panel]").forEach((panel) => {
    const on = panel.getAttribute("data-history-panel") === next;
    panel.classList.toggle("is-active", on);
    panel.hidden = !on;
  });
}

function bindActiveCancel() {
  if (cancelBound) return;
  const list = document.getElementById("activeBookingsList");
  if (!list) return;
  cancelBound = true;
  list.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-history-cancel]");
    if (!btn || btn.disabled) return;
    const card = btn.closest("[data-ride-id]");
    const rideId = card?.getAttribute("data-ride-id");
    const ride = ridesCache.find((r) => r.id === rideId);
    if (!ride || !isCancellableActiveRide(ride)) {
      onToast(t("cancelRideNotAllowed") || "یہ سواری کینسل نہیں ہو سکتی");
      return;
    }

    let farePreview = null;
    if (String(ride.status || "") === "in_progress") {
      try {
        farePreview = await previewCancellationFareClient(ride.id);
      } catch (err) {
        console.warn("[SwiftGo] history cancel fare preview", err);
        onToast(t("cancelRidePreviewFailed") || "کرایہ دیکھنے میں مسئلہ — دوبارہ کوشش کریں");
        return;
      }
    }

    const reason = await askCancelRideReason(farePreview);
    if (!reason) return;

    btn.disabled = true;
    try {
      const result = await cancelCustomerBookingClient(ride.id, reason);
      if (result?.partialFareApplies && Number(result.cancellationFare) > 0) {
        onToast?.(
          (t("rideCancelledWithFare") || "بکنگ منسوخ — واجب الادا: Rs. {amount}").replace(
            "{amount}",
            Math.round(Number(result.cancellationFare) || 0).toLocaleString("en-PK")
          )
        );
      } else {
        onToast(t("rideCancelled") || "بکنگ منسوخ ہو گئی");
      }
    } catch (err) {
      console.warn("[SwiftGo] history cancel ride", err);
      const code = String(err?.message || err?.code || "");
      onToast(`${t("rideRequestFailed") || "کینسل نہیں ہو سکی"}${code ? ` (${code})` : ""}`);
      btn.disabled = false;
    }
  });
}

function bindHistoryTabs() {
  if (tabsBound) return;
  const root = document.getElementById("historyTabs");
  if (!root) return;
  tabsBound = true;
  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-history-tab]");
    if (!btn || !root.contains(btn)) return;
    setHistoryTab(btn.getAttribute("data-history-tab"));
  });
}

function routeRowHtml(ride) {
  const pickup = escapeHtml(ride.pickupLocation?.address || ride.pickup || "—");
  const dropoff = escapeHtml(ride.dropoffLocation?.address || ride.destination || "—");
  return `
    <p class="history-chat__row history-chat__row--from">
      <span class="history-chat__dot history-chat__dot--from" aria-hidden="true"></span>
      <span class="history-chat__label">${escapeHtml(t("historyFrom"))}</span>
      <span class="history-chat__text">${pickup}</span>
    </p>
    <p class="history-chat__row history-chat__row--to">
      <span class="history-chat__dot history-chat__dot--to" aria-hidden="true"></span>
      <span class="history-chat__label">${escapeHtml(t("historyTo"))}</span>
      <span class="history-chat__text">${dropoff}</span>
    </p>`;
}

function vehicleLabelForRide(ride) {
  const key = String(ride?.vehicleTypeKey || "").trim();
  if (key && VEHICLE_NAME_KEYS[key]) return t(VEHICLE_NAME_KEYS[key]);
  return String(ride?.vehicleType || "").trim();
}

function vehiclePlateText(ride) {
  const plate = String(ride?.vehiclePlate || "").trim();
  if (plate && plate !== "—") return plate;
  const status = String(ride?.status || "");
  if (status === "searching_driver" || !ride?.driverId) {
    return t("historyVehiclePending") || "—";
  }
  return "—";
}

function vehicleSummaryText(ride) {
  const vehicle = vehicleLabelForRide(ride);
  const plate = vehiclePlateText(ride);
  if (vehicle && plate && plate !== (t("historyVehiclePending") || "—")) {
    return `${vehicle} · ${plate}`;
  }
  if (vehicle) return vehicle;
  return plate;
}

function vehicleRowHtml(ride) {
  const summary = escapeHtml(vehicleSummaryText(ride));
  return `
    <p class="history-chat__meta history-chat__meta--vehicle">
      <span class="history-chat__label">${escapeHtml(t("historyVehiclePlate") || "Vehicle plate")}</span>
      <span class="history-chat__text history-chat__text--plate">${summary}</span>
    </p>`;
}

function renderActiveBookings(active = []) {
  const section = document.getElementById("activeBookingsSection");
  const list = document.getElementById("activeBookingsList");
  const empty = document.getElementById("historyEmptyActive");
  if (!section || !list) return;

  if (!active.length) {
    section.hidden = true;
    list.innerHTML = "";
    window.clearInterval(activeTickId);
    activeTickId = 0;
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  section.hidden = false;
  list.innerHTML = active
    .map((ride) => {
      const pickup = escapeHtml(ride.pickupLocation?.address || ride.pickup || "—");
      const dropoff = escapeHtml(ride.dropoffLocation?.address || ride.destination || "—");
      const timer = escapeHtml(searchCountdown(ride));
      const cancellable = isCancellableActiveRide(ride);
      const vehicle = escapeHtml(vehicleSummaryText(ride));
      return `<article class="active-booking-card" data-ride-id="${escapeHtml(ride.id)}" role="listitem">
        <p class="active-booking-card__status">${escapeHtml(statusLabel(ride.status))}</p>
        <p class="active-booking-card__route">${pickup} → ${dropoff}</p>
        <p class="active-booking-card__vehicle">
          <span class="active-booking-card__vehicle-label">${escapeHtml(t("historyVehiclePlate") || "Vehicle plate")}</span>
          <span class="active-booking-card__vehicle-value">${vehicle}</span>
        </p>
        ${timer ? `<p class="active-booking-card__timer" data-active-timer>${timer}</p>` : ""}
        ${
          cancellable
            ? `<div class="active-booking-card__actions">
            <button type="button" class="cancel-ride-btn active-booking-card__cancel" data-history-cancel data-i18n="cancelRide">Cancel</button>
          </div>`
            : ""
        }
      </article>`;
    })
    .join("");

  applyTranslations(list);

  if (!activeTickId) {
    activeTickId = window.setInterval(() => {
      list.querySelectorAll("[data-active-timer]").forEach((el) => {
        const card = el.closest("[data-ride-id]");
        const id = card?.getAttribute("data-ride-id");
        const ride = ridesCache.find((r) => r.id === id);
        if (!ride) return;
        el.textContent = searchCountdown(ride);
      });
    }, 1000);
  }
}

function renderCompletedList(completed = []) {
  const list = document.getElementById("historyChatList");
  const empty = document.getElementById("historyEmptyCompleted");
  if (!list) return;

  if (!completed.length) {
    list.hidden = true;
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  list.hidden = false;
  list.innerHTML = completed
    .map((ride) => {
      const date = escapeHtml(formatRideDate(ride.completedAt || ride.createdAt));
      const fare = escapeHtml(formatMoney(fareAmount(ride)));
      return `<article class="history-chat__item history-chat__item--completed">
        <time class="history-chat__time">${date}</time>
        <div class="history-chat__bubble">
          <p class="history-chat__badge history-chat__badge--completed">${escapeHtml(t("historyTabCompleted") || "Completed")}</p>
          ${routeRowHtml(ride)}
          ${vehicleRowHtml(ride)}
          <p class="history-chat__fare">
            <span class="history-chat__label">${escapeHtml(t("historyFare"))}</span>
            <strong>${fare}</strong>
          </p>
        </div>
      </article>`;
    })
    .join("");
}

function renderCancelledList(cancelled = []) {
  const list = document.getElementById("historyCancelledList");
  const empty = document.getElementById("historyEmptyCancelled");
  if (!list) return;

  if (!cancelled.length) {
    list.hidden = true;
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  list.hidden = false;
  list.innerHTML = cancelled
    .map((ride) => {
      const bookedAt = escapeHtml(formatRideDate(ride.createdAt));
      const when = escapeHtml(formatRideDate(cancelWhenValue(ride)));
      const who = escapeHtml(cancelActorLabel(ride));
      const reason = escapeHtml(cancelReasonLabel(ride));
      const fare = escapeHtml(formatMoney(fareAmount(ride)));
      const customerSide = CUSTOMER_CANCEL_STATUSES.has(String(ride.status || ""));
      const badgeClass = customerSide
        ? "history-chat__badge history-chat__badge--cancel-customer"
        : "history-chat__badge history-chat__badge--cancel-other";
      return `<article class="history-chat__item history-chat__item--cancelled">
        <time class="history-chat__time">${bookedAt}</time>
        <div class="history-chat__bubble">
          <p class="${badgeClass}">${who}</p>
          ${routeRowHtml(ride)}
          ${vehicleRowHtml(ride)}
          <p class="history-chat__meta">
            <span class="history-chat__label">${escapeHtml(t("historyCancelledAt") || "Cancelled at")}</span>
            <span class="history-chat__text">${when}</span>
          </p>
          ${
            reason
              ? `<p class="history-chat__meta">
            <span class="history-chat__label">${escapeHtml(t("historyCancelReason") || "Reason")}</span>
            <span class="history-chat__text">${reason}</span>
          </p>`
              : ""
          }
          <p class="history-chat__fare">
            <span class="history-chat__label">${escapeHtml(t("historyFare"))}</span>
            <strong>${fare}</strong>
          </p>
        </div>
      </article>`;
    })
    .join("");
}

export function renderCustomerRideHistory(rides = ridesCache) {
  const tabs = document.getElementById("historyTabs");
  const panels = document.getElementById("historyTabPanels");
  const emptyAll = document.getElementById("historyEmpty");
  const { active, completed, cancelled } = partitionRides(rides);

  setCountBadge("historyCountActive", active.length);
  setCountBadge("historyCountCompleted", completed.length);
  setCountBadge("historyCountCancelled", cancelled.length);

  renderActiveBookings(active);
  renderCompletedList(completed);
  renderCancelledList(cancelled);
  setHistoryTab(activeTab);

  const any = active.length + completed.length + cancelled.length > 0;
  if (emptyAll) emptyAll.hidden = any;
  if (tabs) tabs.hidden = !any;
  if (panels) panels.hidden = !any;
}

export function stopCustomerRideHistory() {
  unsubRides();
  unsubRides = () => {};
  ridesCache = [];
  window.clearInterval(activeTickId);
  activeTickId = 0;
  renderCustomerRideHistory([]);
}

export function startCustomerRideHistory(uid) {
  stopCustomerRideHistory();
  if (!uid) return;

  const { ready, db } = getFirebase();
  if (!ready || !db) return;

  const emit = (snapshot) => {
    ridesCache = snapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderCustomerRideHistory(ridesCache);
  };

  const ridesQuery = query(
    collection(db, "rides"),
    where("userId", "==", uid),
    orderBy("createdAt", "desc")
  );

  unsubRides = onSnapshot(
    ridesQuery,
    emit,
    (error) => {
      warnIndexError(error);
      unsubRides();
      const fallbackQuery = query(collection(db, "rides"), where("userId", "==", uid));
      unsubRides = onSnapshot(
        fallbackQuery,
        emit,
        (fallbackError) => {
          warnIndexError(fallbackError);
          renderCustomerRideHistory([]);
        }
      );
    }
  );
}

export function initRideHistory(options = {}) {
  if (typeof options.onToast === "function") onToast = options.onToast;
  bindHistoryTabs();
  bindActiveCancel();
  applyTranslations(document.getElementById("historySection") || document);
  setHistoryTab(activeTab);
  renderCustomerRideHistory([]);
}

export function refreshRideHistory() {
  applyTranslations(document.getElementById("historySection") || document);
  renderCustomerRideHistory(ridesCache);
}
