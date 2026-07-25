/**
 * Customer trip history — chat-style list from rides collection.
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

let unsubRides = () => {};
let ridesCache = [];

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

function warnIndexError(error) {
  console.warn("[SwiftGo] customer history", error);
  if (error?.code === "failed-precondition" || /index/i.test(error?.message || "")) {
    console.warn(
      "[SwiftGo] Firestore composite index required for rides (userId + createdAt).",
      error.message
    );
  }
}

export function renderCustomerRideHistory(rides = ridesCache) {
  const list = document.getElementById("historyChatList");
  const empty = document.getElementById("historyEmpty");
  if (!list || !empty) return;

  if (!rides.length) {
    list.hidden = true;
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  list.innerHTML = rides
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
