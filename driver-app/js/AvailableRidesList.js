/**
 * Screen 1 — Available rides list (رائٹ حاصل کریں).
 */

import {
  enrichRadarList,
  readCachedRadarRides,
  subscribePendingRadarRides,
} from "./ride-radar-service.js";
import { openRateDetails } from "./rate-details-modal.js";
import { resolveVehicleKeyFromLabel } from "./pricing-client.js";

const money = (n) => `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

/**
 * @param {HTMLElement | null} root
 * @param {{ getDriverUid: () => string|null, getDriverPosition: () => {lat:number,lng:number}|null, getHasActiveRide?: () => boolean, getCounterRideIds?: () => string[], onSelectRide: (ride: object) => void, onBack: () => void }} opts
 */
export function initAvailableRidesList(root, opts) {
  if (!root) return { show: () => {}, hide: () => {}, destroy: () => {} };

  const getDriverUid = opts.getDriverUid || (() => null);
  const getDriverPosition = opts.getDriverPosition || (() => null);
  const getHasActiveRide = opts.getHasActiveRide || (() => false);
  const getCounterRideIds = opts.getCounterRideIds || (() => []);
  const onSelectRide = opts.onSelectRide || (() => {});
  const onBack = opts.onBack || (() => {});

  let unsub = () => {};
  let subscribed = false;
  let visible = false;
  /** @type {object | null} */
  let lastState = null;

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
    root.querySelector(".radar-list")?.classList.remove("is-visible");
    root.hidden = true;
    if (!options.keepSubscription) {
      stopSubscription();
    }
  }

  function destroy() {
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
