/** Phase 8: payment method sheet + sidebar dashboard helpers */

import { t, applyTranslations, setLang, getLang, syncLangButtons } from "./i18n.js";

const PAY_KEY = "swiftgo_pay_method";
const TRAFFIC_KEY = "swiftgo_show_traffic";

let selectedPay = loadPay();
let onNavigate = null;
let onCloseDrawer = null;
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

function applyTraffic(on) {
  document.documentElement.classList.toggle("show-traffic", on);
  try {
    localStorage.setItem(TRAFFIC_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function syncLangToggleUi() {
  const toggle = document.getElementById("langToggle");
  if (toggle) toggle.checked = getLang() === "ur";
}

export function initDashboard(handlers = {}) {
  onNavigate = handlers.onNavigate || null;
  onCloseDrawer = handlers.onCloseDrawer || null;
  onToast = handlers.onToast || null;

  // Restore traffic
  let trafficOn = false;
  try {
    trafficOn = localStorage.getItem(TRAFFIC_KEY) === "1";
  } catch {
    /* ignore */
  }
  const trafficToggle = document.getElementById("trafficToggle");
  if (trafficToggle) trafficToggle.checked = trafficOn;
  applyTraffic(trafficOn);
  syncLangToggleUi();

  // Payment UI
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

  // Quick actions
  document.querySelectorAll("[data-quick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.quick;
      handleQuick(action);
    });
  });

  trafficToggle?.addEventListener("change", () => {
    applyTraffic(Boolean(trafficToggle.checked));
  });

  document.getElementById("langToggle")?.addEventListener("change", (e) => {
    const urdu = e.target.checked;
    setLang(urdu ? "ur" : "en");
    syncLangButtons();
    applyTranslations();
    syncLangToggleUi();
  });

  applyTranslations(document.getElementById("paySheet") || document);
}

function handleQuick(action) {
  const settings = document.getElementById("sidebarSettings");

  if (action === "settings") {
    if (settings) {
      settings.hidden = !settings.hidden;
    }
    return;
  }

  if (settings) settings.hidden = true;

  if (action === "support") {
    if (typeof onNavigate === "function") onNavigate("contact");
    return;
  }

  if (action === "history") {
    if (typeof onNavigate === "function") onNavigate("bookings");
    return;
  }

  if (action === "addresses") {
    if (typeof onCloseDrawer === "function") onCloseDrawer();
    if (typeof onToast === "function") onToast(t("addressesSoon"));
  }
}

export function refreshDashboardLabels() {
  applyTranslations(document.getElementById("sidebar") || document);
  applyTranslations(document.getElementById("paySheet") || document);
  syncLangToggleUi();
}
