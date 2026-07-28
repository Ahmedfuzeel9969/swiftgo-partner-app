/** Phase 4C — accessible confirmation dialog (replaces window.confirm for extra bookings). */

import { t, applyTranslations } from "./i18n.js";
import { trapFocus } from "./a11y.js";

/** @type {null | (() => void)} */
let releaseTrap = null;

/**
 * @returns {Promise<"confirm" | "cancel" | "view">}
 */
export function askExtraBookingConfirm() {
  const root = document.getElementById("extraBookingDialog");
  const panel = root?.querySelector(".confirm-dialog__panel");
  const confirmBtn = document.getElementById("extraBookingConfirmBtn");
  const cancelBtn = document.getElementById("extraBookingCancelBtn");
  const viewBtn = document.getElementById("extraBookingViewBtn");
  const backdrop = document.getElementById("extraBookingBackdrop");
  if (!root || !panel || !confirmBtn || !cancelBtn) {
    return Promise.resolve(
      window.confirm(`${t("bookingExtraConfirm")}\n\n${t("bookingExtraConfirmViewHint")}`)
        ? "confirm"
        : "cancel"
    );
  }

  applyTranslations(root);

  return new Promise((resolve) => {
    const finish = (result) => {
      releaseTrap?.();
      releaseTrap = null;
      root.classList.remove("is-open");
      root.hidden = true;
      root.setAttribute("aria-hidden", "true");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      viewBtn?.removeEventListener("click", onView);
      backdrop?.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onConfirm = () => finish("confirm");
    const onCancel = () => finish("cancel");
    const onView = () => finish("view");

    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => root.classList.add("is-open"));
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    viewBtn?.addEventListener("click", onView);
    backdrop?.addEventListener("click", onCancel);
    releaseTrap = trapFocus(panel, {
      dismissible: true,
      onDismiss: onCancel,
      initialFocus: cancelBtn,
    });
  });
}
