/**
 * Customer trip history — chat-style list from rides collection.
 * Also renders live active/pending bookings with countdown timer.
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
import { NON_TERMINAL_RIDE_STATUSES } from "./ride-status.js";

const ACTIVE_STATUSES = new Set(NON_TERMINAL_RIDE_STATUSES);
const SEARCH_TIMEOUT_MS = 180_000;

let unsubRides = () => {};
let ridesCache = [];
let activeTickId = 0;

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

function statusLabel(status) {
  if (status === "searching_driver") return t("activeBookingSearching") || "Searching";
  if (status === "accepted" || status === "arrived" || status === "in_progress") {
    return t("activeBookingAssigned") || "Assigned";
  }
  if (status === "expired" || status === "no_driver_found") {
    return t("noDriverAvailable") || "کوئی ڈرائیور دستیاب نہ ہوا";
  }
  return status || "—";
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

function renderActiveBookings(rides = ridesCache) {
  const section = document.getElementById("activeBookingsSection");
  const list = document.getElementById("activeBookingsList");
  if (!section || !list) return;

  const active = rides.filter((ride) => ACTIVE_STATUSES.has(ride.status));
  if (!active.length) {
    section.hidden = true;
    list.innerHTML = "";
    window.clearInterval(activeTickId);
    activeTickId = 0;
    return;
  }

  section.hidden = false;
  list.innerHTML = active
    .map((ride) => {
      const pickup = escapeHtml(ride.pickupLocation?.address || ride.pickup || "—");
      const dropoff = escapeHtml(ride.dropoffLocation?.address || ride.destination || "—");
      const timer = escapeHtml(searchCountdown(ride));
      return `<article class="active-booking-card" data-ride-id="${escapeHtml(ride.id)}" role="listitem">
        <p class="active-booking-card__status">${escapeHtml(statusLabel(ride.status))}</p>
        <p class="active-booking-card__route">${pickup} → ${dropoff}</p>
        ${timer ? `<p class="active-booking-card__timer" data-active-timer>${timer}</p>` : ""}
      </article>`;
    })
    .join("");

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

export function renderCustomerRideHistory(rides = ridesCache) {
  const list = document.getElementById("historyChatList");
  const empty = document.getElementById("historyEmpty");
  if (!list || !empty) return;

  renderActiveBookings(rides);

  const past = rides.filter((ride) => !ACTIVE_STATUSES.has(ride.status));

  if (!past.length && !rides.some((r) => ACTIVE_STATUSES.has(r.status))) {
    list.hidden = true;
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  if (!past.length) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }

  list.hidden = false;
  list.innerHTML = past
    .map((ride) => {
      const pickup = escapeHtml(
        ride.pickupLocation?.address || ride.pickup || "—"
      );
      const dropoff = escapeHtml(
        ride.dropoffLocation?.address || ride.destination || "—"
      );
      const date = escapeHtml(formatRideDate(ride.createdAt));
      const fare = escapeHtml(formatMoney(fareAmount(ride)));
      return `<article class="history-chat__item">
        <time class="history-chat__time" datetime="">${date}</time>
        <div class="history-chat__bubble">
          <p class="history-chat__row history-chat__row--from">
            <span class="history-chat__dot history-chat__dot--from" aria-hidden="true"></span>
            <span class="history-chat__label">${escapeHtml(t("historyFrom"))}</span>
            <span class="history-chat__text">${pickup}</span>
          </p>
          <p class="history-chat__row history-chat__row--to">
            <span class="history-chat__dot history-chat__dot--to" aria-hidden="true"></span>
            <span class="history-chat__label">${escapeHtml(t("historyTo"))}</span>
            <span class="history-chat__text">${dropoff}</span>
          </p>
          <p class="history-chat__fare">
            <span class="history-chat__label">${escapeHtml(t("historyFare"))}</span>
            <strong>${fare}</strong>
          </p>
        </div>
      </article>`;
    })
    .join("");
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

export function initRideHistory() {
  applyTranslations(document.getElementById("historySection") || document);
  renderCustomerRideHistory([]);
}

export function refreshRideHistory() {
  applyTranslations(document.getElementById("historySection") || document);
  renderCustomerRideHistory(ridesCache);
}
