/** Bookings tabs, Wallet, Contact & Missed Call helpers */

import { t, applyTranslations, formatMoney } from "./i18n.js";
import { phoneHref, whatsappHref } from "./support.js";

let onBookNow = null;
/** @type {Array<Record<string, unknown>>} */
let bookingsCache = [];

export function initScreens(handlers = {}) {
  onBookNow = handlers.onBookNow || null;

  document.querySelectorAll("[data-booking-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.bookingTab;
      if (name) setBookingTab(name);
    });
  });

  document.querySelectorAll('[data-action="book-now"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (typeof onBookNow === "function") onBookNow();
    });
  });

  const receiptBtn = document.getElementById("receiptBtn");
  receiptBtn?.addEventListener("click", () => {
    window.alert(t("receiptEmpty"));
  });

  bindSupportLinks();
  setBookingTab("scheduled");
}

function bindSupportLinks() {
  const tel = phoneHref();
  const wa = whatsappHref();

  const missed = document.getElementById("missedCallBtn");
  const call = document.getElementById("contactCallBtn");
  const waBtn = document.getElementById("contactWaBtn");

  if (missed) missed.setAttribute("href", tel);
  if (call) call.setAttribute("href", tel);
  if (waBtn) waBtn.setAttribute("href", wa);
}

export function setBookingTab(name) {
  document.querySelectorAll("[data-booking-tab]").forEach((tab) => {
    const active = tab.dataset.bookingTab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll("[data-booking-panel]").forEach((panel) => {
    const match = panel.dataset.bookingPanel === name;
    panel.classList.toggle("is-active", match);
    if (match) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  });

  renderBookingsList(name);
}

export function setBookingsData(rows) {
  bookingsCache = Array.isArray(rows) ? rows : [];
  const active = document.querySelector(".tab.is-active")?.dataset.bookingTab || "scheduled";
  renderBookingsList(active);
}

export function setWalletBalanceUi(amount) {
  const el = document.getElementById("walletBalance");
  if (!el) return;
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  el.textContent = formatMoney(value);
}

function serviceLabel(service) {
  const map = {
    delivery: t("svcDelivery"),
    ride: t("svcRide"),
    shops: t("svcShops"),
    rentals: t("svcRentals"),
  };
  return map[service] || service || t("svcRide");
}

function renderBookingsList(status) {
  const panel = document.querySelector(`[data-booking-panel="${status}"]`);
  if (!panel) return;

  const listHost = panel.querySelector("[data-booking-list]");
  const empty = panel.querySelector(".empty-state");
  if (!listHost || !empty) return;

  const filtered = bookingsCache.filter((b) => (b.status || "scheduled") === status);

  if (!filtered.length) {
    listHost.hidden = true;
    listHost.innerHTML = "";
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  listHost.hidden = false;
  listHost.innerHTML = filtered
    .map((b) => {
      const pickup = escapeHtml(String(b.pickup || "—"));
      const dest = escapeHtml(String(b.destination || "—"));
      const svc = escapeHtml(serviceLabel(b.service));
      return `<article class="booking-card glass">
        <div class="booking-card__top">
          <span class="booking-card__svc">${svc}</span>
          <span class="booking-card__status">${escapeHtml(t("tab" + capitalize(status)))}</span>
        </div>
        <p class="booking-card__route"><span>${pickup}</span> → <span>${dest}</span></p>
      </article>`;
    })
    .join("");
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function refreshScreens() {
  ["screen-bookings", "screen-wallet", "screen-contact", "screen-missed-call", "authModal"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) applyTranslations(el);
    }
  );
  const active = document.querySelector(".tab.is-active")?.dataset.bookingTab || "scheduled";
  renderBookingsList(active);
}
