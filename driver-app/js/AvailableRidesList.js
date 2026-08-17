/**
 * Screen 1 — Available rides list (رائٹ حاصل کریں).
 */

import {
  enrichRadarList,
  readCachedRadarRides,
  rideSearchDeadlineMs,
  subscribePendingRadarRides,
} from "./ride-radar-service.js";
import { computeOfferDeadlineMs } from "./driver-offer-inbox.js";
import { openRateDetails } from "./rate-details-modal.js";
import { resolveVehicleKeyFromLabel } from "./pricing-client.js";

const money = (n) => `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

function formatOfferCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {HTMLElement | null} root
 * @param {{ getDriverUid: () => string|null, getDriverPosition: () => {lat:number,lng:number}|null, getHasActiveRide?: () => boolean, getCounterRideIds?: () => string[], getOfferForRide?: (rideId: string) => object|null, onSelectRide: (ride: object) => void, onBack: () => void }} opts
 */
export function initAvailableRidesList(root, opts) {
  if (!root) return { show: () => {}, hide: () => {}, destroy: () => {} };

  const getDriverUid = opts.getDriverUid || (() => null);
  const getDriverPosition = opts.getDriverPosition || (() => null);
  const getHasActiveRide = opts.getHasActiveRide || (() => false);
  const getCounterRideIds = opts.getCounterRideIds || (() => []);
  const getOfferForRide = opts.getOfferForRide || (() => null);
  const onSelectRide = opts.onSelectRide || (() => {});
  const onBack = opts.onBack || (() => {});

  let unsub = () => {};
  let subscribed = false;
  let visible = false;
  /** @type {object | null} */
  let lastState = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let listOfferTick = null;

  function stopListOfferTick() {
    if (listOfferTick) {
      clearInterval(listOfferTick);
      listOfferTick = null;
    }
  }

  function updateOfferTimersOnCards() {
    if (!visible || !listEl) return;
    listEl.querySelectorAll("[data-offer-timer-for]").forEach((el) => {
      const rideId = el.getAttribute("data-offer-timer-for");
      const offer = rideId ? getOfferForRide(rideId) : null;
      if (!offer || !["open", "countered"].includes(String(offer.status || ""))) {
        el.hidden = true;
        return;
      }
      const ride = (lastState?.rides || []).find((r) => r.id === rideId);
      const searchDl = ride ? rideSearchDeadlineMs(ride) : null;
      const deadline = computeOfferDeadlineMs(offer, { searchDeadlineMs: searchDl });
      if (deadline == null) {
        el.hidden = true;
        return;
      }
      const remaining = deadline - Date.now();
      el.hidden = false;
      el.textContent =
        remaining > 0 ? `آفر ${formatOfferCountdown(remaining)}` : "آفر ختم";
    });
    listEl.querySelectorAll("[data-search-timer-for]").forEach((el) => {
      const rideId = el.getAttribute("data-search-timer-for");
      const ride = (lastState?.rides || []).find((r) => r.id === rideId);
      if (!ride) {
        el.hidden = true;
        return;
      }
      const deadline = rideSearchDeadlineMs(ride);
      if (!deadline) {
        el.hidden = true;
        return;
      }
      const remaining = deadline - Date.now();
      el.hidden = false;
      el.textContent =
        remaining > 0 ? `بکنگ ${formatOfferCountdown(remaining)}` : "بکنگ ختم";
    });
  }

  root.innerHTML = `
    <section class="radar-list" aria-label="دستیاب رائٹس">
      <header class="radar-list__header">
        <button type="button" class="radar-list__back" data-back aria-label="ڈیش بورڈ پر واپس">←</button>
        <div>
          <h2 class="radar-list__title">رائٹ حاصل کریں</h2>
          <p class="radar-list__sub" data-sync-note>لوڈ ہو رہا ہے…</p>
        </div>
        <button type="button" class="radar-list__rates-btn" data-all-rates-btn aria-label="تمام گاڑیوں کے ریٹ">
          ریٹ کی تفصیل
        </button>
      </header>
      <p class="radar-list__hint" data-list-hint>جب ایک سے زیادہ رائٹ ہوں تو جس کو چاہیں منتخب کریں — تفصیل کے لیے تھپتھپائیں</p>
      <div class="radar-list__body" data-list></div>
      <p class="radar-list__empty" data-empty hidden>ابھی کوئی نئی رائٹ نہیں۔ جیسے ہی کسٹمر سواری مانگے گا یہاں دکھائی دے گی۔</p>
    </section>
  `;

  const listEl = root.querySelector("[data-list]");
  const emptyEl = root.querySelector("[data-empty]");
  const syncEl = root.querySelector("[data-sync-note]");
  const hintEl = root.querySelector("[data-list-hint]");

  root.querySelector("[data-back]")?.addEventListener("click", () => onBack());
  root.querySelector("[data-all-rates-btn]")?.addEventListener("click", () => {
    void openRateDetails({ mode: "all", title: "تمام گاڑیوں کے ریٹ" });
  });

  function renderCard(ride) {
    const counterIds = new Set(getCounterRideIds());
    const hasCounter = counterIds.has(ride.id);
    const offer = getOfferForRide(ride.id);
    const searchDeadline = rideSearchDeadlineMs(ride);
    const offerDeadline =
      offer && ["open", "countered"].includes(String(offer.status || ""))
        ? computeOfferDeadlineMs(offer, { searchDeadlineMs: searchDeadline })
        : null;
    const offerTimerVisible = offerDeadline != null && offerDeadline > Date.now();
    const searchTimerVisible = searchDeadline > Date.now();
    const card = document.createElement("button");
    card.type = "button";
    card.className = "radar-card";
    if (hasCounter) card.classList.add("radar-card--has-counter");
    card.setAttribute("aria-label", `رائٹ: ${ride.pickup?.address || ""} سے ${ride.dropoff?.address || ""}`);
    card.innerHTML = `
      <div class="radar-card__top">
        <span class="radar-card__vehicle" aria-hidden="true">${ride.vehicleIcon || "🚗"}</span>
        <div class="radar-card__meta">
          <strong>${escapeHtml(ride.vehicleType || "Ride")}</strong>
          <span class="radar-card__fare">${money(ride.estimatedFare)}</span>
        </div>
        <button type="button" class="radar-card__rate-btn" data-rate-btn aria-label="ریٹ کی تفصیل">ℹ️ ریٹ</button>
        ${hasCounter ? '<span class="radar-card__counter-badge">مسافر کا جواب</span>' : ""}
        ${offerTimerVisible ? `<span class="radar-card__offer-timer" data-offer-timer-for="${escapeHtml(ride.id)}">آفر ${formatOfferCountdown(offerDeadline - Date.now())}</span>` : ""}
        ${searchTimerVisible ? `<span class="radar-card__search-timer" data-search-timer-for="${escapeHtml(ride.id)}">بکنگ ${formatOfferCountdown(searchDeadline - Date.now())}</span>` : ""}
      </div>
      <div class="radar-card__route">
        <div class="radar-card__point radar-card__point--a">
          <span class="radar-card__dot" aria-hidden="true"></span>
          <div>
            <span class="radar-card__km-label">پک اپ · ${ride.pickupDistanceKm != null ? `${ride.pickupDistanceKm} km` : "—"}</span>
            <p>${escapeHtml(ride.pickup.address)}</p>
          </div>
        </div>
        <div class="radar-card__point radar-card__point--b">
          <span class="radar-card__dot" aria-hidden="true"></span>
          <div>
            <span class="radar-card__km-label">ڈراپ · ${ride.tripDistanceKm != null ? `${ride.tripDistanceKm} km` : "—"}</span>
            <p>${escapeHtml(ride.dropoff.address)}</p>
          </div>
        </div>
      </div>
      <span class="radar-card__cta">تفصیل دیکھیں ←</span>
    `;
    card.addEventListener("click", () => onSelectRide(ride));
    card.querySelector("[data-rate-btn]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      void openRateDetails({
        vehicleTypeKey: ride.vehicleTypeKey || resolveVehicleKeyFromLabel(ride.vehicleType),
        vehicleTypeLabel: ride.vehicleType,
        distanceKm: ride.tripDistanceKm,
        estimatedFare: ride.estimatedFare,
        mode: "ride",
      });
    });
    return card;
  }

  function render(state) {
    lastState = state;
    if (!visible) return;
    if (getHasActiveRide()) {
      if (syncEl) syncEl.textContent = "آپ ایک سواری پر ہیں — نئی رائٹس نہیں دکھائی جائیں گی";
      if (listEl) listEl.replaceChildren();
      if (emptyEl) emptyEl.hidden = true;
      return;
    }
    const rides = state?.rides || [];
    if (syncEl) {
      syncEl.textContent = state?.syncing
        ? "نئی رائٹس لوڈ ہو رہی ہیں…"
        : rides.length
          ? `${rides.length} رائٹ${rides.length > 1 ? "یں" : ""} دستیاب — ایک وقت میں سب دکھائی دے رہی ہیں`
          : "فی الحال کوئی رائٹ نہیں";
    }
    if (hintEl && rides.length > 1) {
      hintEl.textContent = `${rides.length} رائٹیں اس فہرست میں ہیں — جس کو حاصل کرنا چاہیں اس پر تھپتھپائیں`;
    } else if (hintEl) {
      hintEl.textContent =
        "جب ایک سے زیادہ رائٹ ہوں تو سب یہاں دکھیں گی — تفصیل کے لیے تھپتھپائیں";
    }
    if (!listEl || !emptyEl) return;
    if (!rides.length) {
      listEl.replaceChildren();
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.replaceChildren(...rides.map(renderCard));
    updateOfferTimersOnCards();
  }

  function startSubscription() {
    if (subscribed || getHasActiveRide()) return;
    const uid = getDriverUid();
    if (!uid) return;
    subscribed = true;
    unsub = subscribePendingRadarRides(
      uid,
      (state) => {
        render(state);
      },
      getDriverPosition,
      getHasActiveRide
    );
  }

  function stopSubscription() {
    subscribed = false;
    unsub();
    unsub = () => {};
  }

  function show(options = {}) {
    if (getHasActiveRide()) {
      onBack();
      return;
    }
    visible = true;
    root.hidden = false;
    requestAnimationFrame(() => root.querySelector(".radar-list")?.classList.add("is-visible"));
    stopListOfferTick();
    listOfferTick = setInterval(updateOfferTimersOnCards, 1000);

    const uid = getDriverUid();
    if (!options.resume) {
      const cached = uid ? readCachedRadarRides(uid) : null;
      if (cached) {
        render({
          rides: enrichRadarList(cached.rides, getDriverPosition()),
          syncing: true,
        });
      }
    } else if (lastState) {
      render(lastState);
    }

    startSubscription();
  }

  /**
   * @param {{ keepSubscription?: boolean }} [options]
   */
  function hide(options = {}) {
    visible = false;
    stopListOfferTick();
    root.querySelector(".radar-list")?.classList.remove("is-visible");
    root.hidden = true;
    if (!options.keepSubscription) {
      stopSubscription();
    }
  }

  function destroy() {
    stopListOfferTick();
    hide({ keepSubscription: false });
    root.replaceChildren();
    lastState = null;
  }

  return { show, hide, destroy, refresh: () => lastState && render(lastState) };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
