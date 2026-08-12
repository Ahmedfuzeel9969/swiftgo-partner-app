/**
 * Driver — rate transparency modal (base fare, per-km, time tiers).
 */

import { trapFocus } from "./a11y.js";
import { buildRateDetailsHtml, loadDriverPricing } from "./pricing-client.js";

let modalEl = null;
let backdropEl = null;
let closeBtn = null;
let bodyEl = null;
let titleEl = null;
let releaseFocus = null;
let initialized = false;

function setOpen(open) {
  if (!modalEl) return;
  modalEl.hidden = !open;
  modalEl.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("rate-details-open", open);
  if (open) {
    releaseFocus = trapFocus(modalEl.querySelector(".rate-details-modal__panel"));
  } else {
    releaseFocus?.();
    releaseFocus = null;
  }
}

export function initRateDetailsModal() {
  if (initialized) return;
  modalEl = document.getElementById("rateDetailsModal");
  backdropEl = document.getElementById("rateDetailsBackdrop");
  closeBtn = document.getElementById("rateDetailsCloseBtn");
  bodyEl = document.getElementById("rateDetailsBody");
  titleEl = document.getElementById("rateDetailsTitle");
  if (!modalEl || !bodyEl) return;

  const close = () => setOpen(false);
  backdropEl?.addEventListener("click", close);
  closeBtn?.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modalEl.hidden) close();
  });

  initialized = true;
}

/**
 * @param {{
 *   vehicleTypeKey?: string,
 *   vehicleTypeLabel?: string,
 *   distanceKm?: number|null,
 *   durationMin?: number|null,
 *   estimatedFare?: number|null,
 *   mode?: 'ride'|'all',
 *   title?: string,
 * }} context
 */
async function paintRateDetailsBody(targetEl, context = {}) {
  if (!targetEl) return;

  const mode = context.mode || (context.vehicleTypeKey || context.vehicleTypeLabel ? "ride" : "all");
  targetEl.innerHTML = `<p class="rate-details__loading">ریٹ لوڈ ہو رہے ہیں…</p>`;

  try {
    const pricing = await loadDriverPricing();
    targetEl.innerHTML = buildRateDetailsHtml(pricing, { ...context, mode });
  } catch (err) {
    console.warn("[SwiftGo Partner] rate details", err);
    targetEl.innerHTML = `<p class="rate-details__error">ریٹ لوڈ نہیں ہو سکے۔ دوبارہ کوشش کریں۔</p>`;
  }
}

/**
 * Full-page rate details (home grid navigation).
 * @param {Parameters<typeof openRateDetails>[0]} context
 */
export async function renderRateDetailsPage(context = {}) {
  const pageBody = document.getElementById("rateDetailsPageBody");
  if (!pageBody) return;
  await paintRateDetailsBody(pageBody, {
    mode: "all",
    title: "تمام گاڑیوں کے ریٹ",
    ...context,
  });
}

export async function openRateDetails(context = {}) {
  initRateDetailsModal();
  if (!modalEl || !bodyEl) return;

  const mode = context.mode || (context.vehicleTypeKey || context.vehicleTypeLabel ? "ride" : "all");
  if (titleEl) {
    titleEl.textContent =
      context.title ||
      (mode === "all" ? "تمام گاڑیوں کے ریٹ" : "ریٹ کی مکمل تفصیل");
  }

  bodyEl.innerHTML = `<p class="rate-details__loading">ریٹ لوڈ ہو رہے ہیں…</p>`;
  setOpen(true);
  await paintRateDetailsBody(bodyEl, { ...context, mode });
}

export function closeRateDetails() {
  setOpen(false);
}
