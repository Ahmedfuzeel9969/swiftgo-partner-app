/** Cancel-ride reason selector modal for searching bookings. */

import { t, applyTranslations } from "./i18n.js";
import { trapFocus, setOverlayInert } from "./a11y.js";

/** @type {null | (() => void)} */
let releaseTrap = null;

const REASONS = [
  { key: "taking_too_long", ur: "دیر ہو رہی ہے", en: "Taking too long" },
  { key: "booked_by_mistake", ur: "غلطی سے بک ہو گیا", en: "Booked by mistake" },
  { key: "found_alternative", ur: "دوسرا سواری کا ذریعہ مل گیا", en: "Found alternative transport" },
  { key: "other", ur: "دیگر", en: "Other" },
];

function formatFarePkr(amount) {
  return `Rs. ${Math.round(Number(amount) || 0).toLocaleString("en-PK")}`;
}

/**
 * @param {{
 *   partialFareApplies?: boolean,
 *   traveledDistanceKm?: number,
 *   baseFare?: number,
 *   perKmRate?: number,
 *   cancellationFare?: number,
 * } | null} [farePreview]
 * @returns {Promise<null | { cancelReasonKey: string, cancelReason: string }>}
 */
export function askCancelRideReason(farePreview = null) {
  const root = document.getElementById("cancelRideDialog");
  const panel = root?.querySelector(".confirm-dialog__panel");
  const list = document.getElementById("cancelReasonList");
  const submitBtn = document.getElementById("cancelRideSubmitBtn");
  const dismissBtn = document.getElementById("cancelRideDismissBtn");
  const backdrop = document.getElementById("cancelRideBackdrop");
  const farePreviewEl = document.getElementById("cancelRideFarePreview");

  if (!root || !panel || !list || !submitBtn || !dismissBtn) {
    const picked = window.prompt(
      t("cancelRideReasonPrompt") || "Cancel reason (taking_too_long / booked_by_mistake / found_alternative / other)",
      "taking_too_long"
    );
    if (!picked) return Promise.resolve(null);
    const key = REASONS.some((r) => r.key === picked) ? picked : "other";
    const row = REASONS.find((r) => r.key === key) || REASONS[3];
    return Promise.resolve({ cancelReasonKey: key, cancelReason: row.ur });
  }

  applyTranslations(root);
  if (farePreviewEl) {
    if (farePreview?.partialFareApplies || Number(farePreview?.cancellationFare) > 0) {
      const traveled = Number(farePreview.traveledDistanceKm) || 0;
      const total = Number(farePreview.cancellationFare) || 0;
      const base = Number(farePreview.baseFare) || 0;
      const isEn = document.documentElement.lang === "en";
      farePreviewEl.hidden = false;
      farePreviewEl.textContent = isEn
        ? `You will be charged ${formatFarePkr(total)} (base ${formatFarePkr(base)} + ${traveled.toFixed(1)} km traveled).`
        : `آپ سے ${formatFarePkr(total)} وصول ہوں گے (بیس ${formatFarePkr(base)} + ${traveled.toFixed(1)} km سفر)`;
    } else {
      farePreviewEl.hidden = true;
      farePreviewEl.textContent = "";
    }
  }
  list.replaceChildren();
  let selectedKey = "taking_too_long";

  REASONS.forEach((reason) => {
    const label = document.createElement("label");
    label.className = "cancel-reason-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "cancelRideReason";
    input.value = reason.key;
    input.checked = reason.key === selectedKey;
    input.addEventListener("change", () => {
      if (input.checked) selectedKey = reason.key;
    });
    const text = document.createElement("span");
    text.textContent = document.documentElement.lang === "en" ? reason.en : reason.ur;
    label.append(input, text);
    list.appendChild(label);
  });

  return new Promise((resolve) => {
    const finish = (result) => {
      releaseTrap?.();
      releaseTrap = null;
      root.classList.remove("is-open");
      root.hidden = true;
      setOverlayInert(root, true);
      submitBtn.removeEventListener("click", onSubmit);
      dismissBtn.removeEventListener("click", onDismiss);
      backdrop?.removeEventListener("click", onDismiss);
      resolve(result);
    };
    const onSubmit = () => {
      const row = REASONS.find((r) => r.key === selectedKey) || REASONS[3];
      finish({
        cancelReasonKey: row.key,
        cancelReason: document.documentElement.lang === "en" ? row.en : row.ur,
      });
    };
    const onDismiss = () => finish(null);

    root.hidden = false;
    setOverlayInert(root, false);
    requestAnimationFrame(() => root.classList.add("is-open"));
    submitBtn.addEventListener("click", onSubmit);
    dismissBtn.addEventListener("click", onDismiss);
    backdrop?.addEventListener("click", onDismiss);
    releaseTrap = trapFocus(panel, {
      dismissible: true,
      onDismiss,
      initialFocus: submitBtn,
    });
  });
}

/**
 * No-driver timeout dialog. Resolves "retry" | "dismiss".
 * @returns {Promise<"retry" | "dismiss">}
 */
export function askNoDriverAvailable() {
  const root = document.getElementById("noDriverDialog");
  const panel = root?.querySelector(".confirm-dialog__panel");
  const retryBtn = document.getElementById("noDriverRetryBtn");
  const dismissBtn = document.getElementById("noDriverDismissBtn");
  const backdrop = document.getElementById("noDriverBackdrop");

  if (!root || !panel || !retryBtn) {
    window.alert(t("noDriverAvailable") || "کوئی ڈرائیور اس وقت میسر نہیں ہے");
    return Promise.resolve("retry");
  }

  applyTranslations(root);

  return new Promise((resolve) => {
    const finish = (result) => {
      releaseTrap?.();
      releaseTrap = null;
      root.classList.remove("is-open");
      root.hidden = true;
      setOverlayInert(root, true);
      retryBtn.removeEventListener("click", onRetry);
      dismissBtn?.removeEventListener("click", onDismiss);
      backdrop?.removeEventListener("click", onDismiss);
      resolve(result);
    };
    const onRetry = () => finish("retry");
    const onDismiss = () => finish("dismiss");

    root.hidden = false;
    setOverlayInert(root, false);
    requestAnimationFrame(() => root.classList.add("is-open"));
    retryBtn.addEventListener("click", onRetry);
    dismissBtn?.addEventListener("click", onDismiss);
    backdrop?.addEventListener("click", onDismiss);
    releaseTrap = trapFocus(panel, {
      dismissible: true,
      onDismiss,
      initialFocus: retryBtn,
    });
  });
}
