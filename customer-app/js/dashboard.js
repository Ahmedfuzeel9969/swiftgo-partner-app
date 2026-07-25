/** Phase 8: payment method sheet + sidebar dashboard helpers */

import { t, applyTranslations } from "./i18n.js";

const PAY_KEY = "swiftgo_pay_method";

let selectedPay = loadPay();
let onToast = null;

function loadPay() {
  try {
    const v = localStorage.getItem(PAY_KEY);
    if (v === "easypaisa" || v === "jazzcash" || v === "cash" || v === "business") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "cash";
}

export function getPaymentMethod() {
  return selectedPay;
}

export function openPaySheet() {
  const sheet = document.getElementById("paySheet");
  if (!sheet) return;
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  const radio = sheet.querySelector(`input[name="payMethod"][value="${selectedPay}"]`);
  if (radio) radio.checked = true;
}

export function closePaySheet() {
  const sheet = document.getElementById("paySheet");
  if (!sheet) return;
  sheet.classList.remove("is-open");
  sheet.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (!sheet.classList.contains("is-open")) sheet.hidden = true;
  }, 280);
}

export function initDashboard(handlers = {}) {
  onToast = handlers.onToast || null;

  document.getElementById("payMethodBtn")?.addEventListener("click", openPaySheet);
  document.getElementById("paySheetBackdrop")?.addEventListener("click", closePaySheet);
  document.getElementById("paySheetHandle")?.addEventListener("click", closePaySheet);
  document.getElementById("payConfirmBtn")?.addEventListener("click", () => {
    const checked = document.querySelector('input[name="payMethod"]:checked');
    selectedPay = checked?.value || "cash";
    try {
      localStorage.setItem(PAY_KEY, selectedPay);
    } catch {
      /* ignore */
    }
    closePaySheet();
    if (typeof onToast === "function") {
      const labels = {
        easypaisa: t("payEasypaisa"),
        jazzcash: t("payJazzCash"),
        cash: t("payCash"),
        business: t("payBusiness"),
      };
      onToast(t("paySelected").replace("{method}", labels[selectedPay] || selectedPay));
    }
  });

  applyTranslations(document.getElementById("paySheet") || document);
}

export function refreshDashboardLabels() {
  applyTranslations(document.getElementById("sidebar") || document);
  applyTranslations(document.getElementById("paySheet") || document);
}
