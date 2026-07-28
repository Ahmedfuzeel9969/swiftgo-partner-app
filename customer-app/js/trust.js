/**
 * Phase 4E — trust helpers: legal URLs, permission consent, deletion + support report clients.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";
import { t, applyTranslations } from "./i18n.js";
import { trapFocus } from "./a11y.js";
import { whatsappHref } from "./support.js";

export const LEGAL = {
  privacy: "/legal/privacy.html",
  terms: "/legal/terms.html",
  dataUse: "/legal/data-use.html",
};

const LOCATION_CONSENT_KEY = "swiftgo_location_consent_v1";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

export async function requestAccountDeletionClient({ reason = "", roleHint = "customer", appId = "customer" } = {}) {
  return call("requestAccountDeletion", { reason, roleHint, appId });
}

export async function submitSupportReportClient({
  message,
  category = "complaint",
  rideId = null,
  appId = "customer",
} = {}) {
  return call("submitSupportReport", { message, category, rideId, appId });
}

/**
 * Generic confirm dialog using #trustConfirmDialog (falls back to window.confirm).
 * @returns {Promise<boolean>}
 */
export function askTrustConfirm({ titleKey, bodyKey, confirmKey = "trustConfirmContinue", cancelKey = "trustConfirmCancel" }) {
  const root = document.getElementById("trustConfirmDialog");
  const titleEl = document.getElementById("trustConfirmTitle");
  const bodyEl = document.getElementById("trustConfirmBody");
  const confirmBtn = document.getElementById("trustConfirmOk");
  const cancelBtn = document.getElementById("trustConfirmCancel");
  const backdrop = document.getElementById("trustConfirmBackdrop");

  if (!root || !confirmBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(`${t(titleKey)}\n\n${t(bodyKey)}`));
  }

  if (titleEl) {
    titleEl.setAttribute("data-i18n", titleKey);
    titleEl.textContent = t(titleKey);
  }
  if (bodyEl) {
    bodyEl.setAttribute("data-i18n", bodyKey);
    bodyEl.textContent = t(bodyKey);
  }
  confirmBtn.setAttribute("data-i18n", confirmKey);
  confirmBtn.textContent = t(confirmKey);
  cancelBtn.setAttribute("data-i18n", cancelKey);
  cancelBtn.textContent = t(cancelKey);
  applyTranslations(root);

  return new Promise((resolve) => {
    let release = null;
    const finish = (ok) => {
      release?.();
      root.classList.remove("is-open");
      root.hidden = true;
      root.setAttribute("aria-hidden", "true");
      confirmBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop?.removeEventListener("click", onCancel);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => root.classList.add("is-open"));
    confirmBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop?.addEventListener("click", onCancel);
    release = trapFocus(root.querySelector(".confirm-dialog__panel") || root, {
      dismissible: true,
      onDismiss: onCancel,
      initialFocus: confirmBtn,
    });
  });
}

export async function ensureLocationPermissionExplained() {
  if (typeof window !== "undefined" && window.__SWIFTGO_E2E__) return true;
  try {
    if (localStorage.getItem(LOCATION_CONSENT_KEY) === "1") return true;
  } catch {
    /* ignore */
  }
  const ok = await askTrustConfirm({
    titleKey: "permLocationTitle",
    bodyKey: "permLocationBody",
    confirmKey: "permAllow",
    cancelKey: "permNotNow",
  });
  if (ok) {
    try {
      localStorage.setItem(LOCATION_CONSENT_KEY, "1");
    } catch {
      /* ignore */
    }
  }
  return ok;
}

export async function ensureCameraPermissionExplained() {
  if (typeof window !== "undefined" && window.__SWIFTGO_E2E__) return true;
  return askTrustConfirm({
    titleKey: "permCameraTitle",
    bodyKey: "permCameraBody",
    confirmKey: "permAllow",
    cancelKey: "permNotNow",
  });
}

export function complaintWhatsAppHref(message) {
  return whatsappHref(message || t("complaintPrefill"), 0);
}

export function wireLegalLinks(root = document) {
  root.querySelectorAll("[data-legal]").forEach((el) => {
    const key = el.getAttribute("data-legal");
    if (key && LEGAL[key]) el.setAttribute("href", LEGAL[key]);
  });
}
