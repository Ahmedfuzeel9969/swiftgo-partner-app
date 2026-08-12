/**
 * Customer — fare rate details modal (sidebar menu entry).
 */

import { trapFocus } from "./a11y.js";
import { t } from "./i18n.js";
import { buildCustomerRateDetailsHtml, loadCustomerPricing } from "./rate-details-view.js";

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
 *   distanceKm?: number|null,
 *   durationMin?: number|null,
 *   estimatedFare?: number|null,
 *   mode?: 'ride'|'all',
 *   title?: string,
 * }} context
 */
async function paintRateDetailsBody(targetEl, context = {}) {
  if (!targetEl) return;

  const mode = context.mode || (context.vehicleTypeKey ? "ride" : "all");
  targetEl.innerHTML = `<p class="rate-details__loading">${t("fareLoading")}</p>`;

  try {
    const pricing = await loadCustomerPricing();
    targetEl.innerHTML = buildCustomerRateDetailsHtml(pricing, { ...context, mode });
  } catch (err) {
    console.warn("[SwiftGo Customer] rate details", err);
    targetEl.innerHTML = `<p class="rate-details__error">${t("fareLoadError")}</p>`;
  }
}

export async function renderRateDetailsPage(context = {}) {
  const pageBody = document.getElementById("rateDetailsPageBody");
  if (!pageBody) return;
  await paintRateDetailsBody(pageBody, {
    mode: "all",
    ...context,
  });
}

export async function openRateDetails(context = {}) {
  initRateDetailsModal();
  if (!modalEl || !bodyEl) return;

  const mode = context.mode || (context.vehicleTypeKey ? "ride" : "all");
  if (titleEl) {
    titleEl.textContent =
      context.title || (mode === "all" ? t("navFareRates") : t("fareDetailsTitle"));
  }

  bodyEl.innerHTML = `<p class="rate-details__loading">${t("fareLoading")}</p>`;
  setOpen(true);
  await paintRateDetailsBody(bodyEl, { ...context, mode });
}

export function closeRateDetails() {
  setOpen(false);
}
