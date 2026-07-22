/** Phase 11.1–11.3: driver onboarding UI, OCR sim, dynamic config, Firebase submit. */

import { applyTranslations, t } from "./i18n.js";
import { getDriverFormConfig, submitDriverApplication } from "./data.js";
import { getCurrentUser, openAuthModal } from "./auth.js";
import { isFirebaseConfigured } from "./firebase.js";

let cameraStream = null;
let selfieFile = null;
let previouslyFocused = null;
let ocrTimer = null;
let formConfig = null;
let onToast = null;

/** Mock payload used until real OCR is wired (Phase 11.2 simulation). */
function mockCnicOcr() {
  return {
    fullName: t("demoDriverName"),
    cnic: "42101-1234567-1",
  };
}

const els = {};

function cacheElements() {
  els.overlay = document.getElementById("driverOnboarding");
  els.panel = els.overlay?.querySelector(".driver-onboarding__panel");
  els.close = document.getElementById("driverOnboardingClose");
  els.backdrop = document.getElementById("driverOnboardingBackdrop");
  els.form = document.getElementById("driverApplicationForm");
  els.video = document.getElementById("driverSelfieVideo");
  els.canvas = document.getElementById("driverSelfieCanvas");
  els.preview = document.getElementById("driverSelfiePreview");
  els.empty = document.getElementById("driverSelfieEmpty");
  els.fileInput = document.getElementById("driverSelfieFile");
  els.cameraBtn = document.getElementById("driverCameraBtn");
  els.captureBtn = document.getElementById("driverCaptureBtn");
  els.retakeBtn = document.getElementById("driverRetakeBtn");
  els.status = document.getElementById("driverCameraStatus");
  els.cnicFront = document.getElementById("driverCnicFront");
  els.cnicScan = document.getElementById("driverCnicScan");
  els.fullName = document.getElementById("driverFullName");
  els.cnic = document.getElementById("driverCnic");
  els.license = document.getElementById("driverLicense");
  els.vehicleType = document.getElementById("driverVehicleType");
  els.submitBtn = document.getElementById("driverSubmitBtn");
  els.formMessage = document.getElementById("driverFormMessage");
  els.configSource = document.getElementById("driverConfigSource");
}

function setFormMessage(key, isError = false) {
  if (!els.formMessage) return;
  if (!key) {
    els.formMessage.hidden = true;
    els.formMessage.textContent = "";
    return;
  }
  els.formMessage.hidden = false;
  els.formMessage.textContent = t(key);
  els.formMessage.classList.toggle("is-error", isError);
}

function applyDriverFormConfig(config) {
  formConfig = config;
  const root = els.overlay || document;

  root.querySelectorAll("[data-config-key]").forEach((node) => {
    const key = node.dataset.configKey;
    const required = config[key] !== false;
    const control = node.matches("input, select")
      ? node
      : node.querySelector("input, select");
    if (control) {
      control.required = required;
      // Selfie is not a native required file input in the form flow
      if (control.id === "driverSelfieFile") control.required = false;
    }
    node.classList.toggle("is-optional", !required);
    node.querySelectorAll(".driver-field__optional, .driver-upload__optional").forEach((badge) => {
      badge.hidden = required;
    });
  });

  if (els.configSource) {
    els.configSource.removeAttribute("data-i18n");
    els.configSource.textContent =
      config.source === "firestore" ? t("driverConfigLive") : t("driverConfigFallback");
  }
}

export async function openDriverOnboarding() {
  if (!els.overlay) cacheElements();
  if (!els.overlay) return;

  previouslyFocused = document.activeElement;
  setFormMessage("");
  els.overlay.hidden = false;
  els.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("driver-onboarding-open");

  const config = await getDriverFormConfig();
  applyDriverFormConfig(config);

  requestAnimationFrame(() => {
    els.overlay.classList.add("is-open");
    document.getElementById("driverFullName")?.focus();
  });
}

export function closeDriverOnboarding() {
  if (!els.overlay) return;

  cancelCnicOcr();
  stopCamera();
  els.overlay.classList.remove("is-open");
  els.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("driver-onboarding-open");
  window.setTimeout(() => {
    if (!els.overlay.classList.contains("is-open")) els.overlay.hidden = true;
  }, 280);
  previouslyFocused?.focus?.();
}

function setCameraStatus(key, isError = false) {
  if (!els.status) return;
  els.status.textContent = key ? t(key) : "";
  els.status.classList.toggle("is-error", isError);
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  if (els.video) {
    els.video.pause();
    els.video.srcObject = null;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("driverCameraUnsupported", true);
    return;
  }

  stopCamera();
  setCameraStatus("driverCameraStarting");
  if (els.cameraBtn) els.cameraBtn.disabled = true;

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    });

    els.video.srcObject = cameraStream;
    await els.video.play();
    els.video.hidden = false;
    els.preview.hidden = true;
    els.empty.hidden = true;
    els.cameraBtn.hidden = true;
    els.captureBtn.hidden = false;
    els.retakeBtn.hidden = true;
    setCameraStatus("driverCameraReady");
  } catch (error) {
    console.warn("[SwiftGo] camera access", error);
    const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    setCameraStatus(denied ? "driverCameraDenied" : "driverCameraUnavailable", true);
  } finally {
    if (els.cameraBtn) els.cameraBtn.disabled = false;
  }
}

function attachSelfieFile(blob) {
  selfieFile = new File([blob], `swiftgo-selfie-${Date.now()}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });

  try {
    const transfer = new DataTransfer();
    transfer.items.add(selfieFile);
    els.fileInput.files = transfer.files;
  } catch {
    // Some browsers prevent programmatic FileList assignment.
    // selfieFile remains available through getDriverOnboardingFiles().
  }
}

function captureSelfie() {
  if (!cameraStream || !els.video?.videoWidth || !els.canvas) return;

  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  els.canvas.width = width;
  els.canvas.height = height;

  const context = els.canvas.getContext("2d");
  context.save();
  context.translate(width, 0);
  context.scale(-1, 1);
  context.drawImage(els.video, 0, 0, width, height);
  context.restore();

  els.canvas.toBlob(
    (blob) => {
      if (!blob) {
        setCameraStatus("driverCaptureFailed", true);
        return;
      }

      attachSelfieFile(blob);
      const oldUrl = els.preview.dataset.objectUrl;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const objectUrl = URL.createObjectURL(blob);
      els.preview.dataset.objectUrl = objectUrl;
      els.preview.src = objectUrl;
      els.preview.alt = t("driverSelfiePreviewAlt");
      els.preview.hidden = false;
      els.video.hidden = true;
      els.empty.hidden = true;
      els.captureBtn.hidden = true;
      els.retakeBtn.hidden = false;
      els.cameraBtn.hidden = true;
      stopCamera();
      setCameraStatus("driverSelfieCaptured");
    },
    "image/jpeg",
    0.9
  );
}

function resetSelfie() {
  selfieFile = null;
  if (els.fileInput) els.fileInput.value = "";
  if (els.preview) {
    const oldUrl = els.preview.dataset.objectUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    els.preview.removeAttribute("src");
    delete els.preview.dataset.objectUrl;
    els.preview.hidden = true;
  }
  startCamera();
}

function setUploadFile(input, file) {
  if (!file?.type?.startsWith("image/")) return;

  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  } catch {
    return;
  }
  updateUploadZone(input);
}

function updateUploadZone(input) {
  const zone = input.closest(".driver-upload");
  const label = zone?.querySelector(".driver-upload__file");
  const file = input.files?.[0];
  zone?.classList.toggle("has-file", Boolean(file));
  if (label) label.textContent = file?.name || "";

  // Phase 11.2: CNIC Front triggers OCR auto-fill simulation
  if (input.id === "driverCnicFront") {
    if (file) {
      runCnicOcrSimulation(file);
    } else {
      cancelCnicOcr();
    }
  }
}

function setCnicScanVisible(visible) {
  const zone = els.cnicFront?.closest(".driver-upload");
  zone?.classList.toggle("is-scanning", visible);
  if (els.cnicScan) els.cnicScan.hidden = !visible;
}

function cancelCnicOcr() {
  if (ocrTimer) {
    window.clearTimeout(ocrTimer);
    ocrTimer = null;
  }
  setCnicScanVisible(false);
}

function applyOcrFields({ fullName, cnic }) {
  if (els.fullName) {
    els.fullName.value = fullName;
    els.fullName.closest(".driver-field")?.classList.add("is-ocr-filled");
  }
  if (els.cnic) {
    els.cnic.value = cnic;
    els.cnic.closest(".driver-field")?.classList.add("is-ocr-filled");
  }
  window.setTimeout(() => {
    els.fullName?.closest(".driver-field")?.classList.remove("is-ocr-filled");
    els.cnic?.closest(".driver-field")?.classList.remove("is-ocr-filled");
  }, 900);
}

/**
 * Phase 11.2 — Simulated CNIC OCR auto-fill.
 *
 * Shows a 2s "Scanning Card" state, then fills Full Name + CNIC Number
 * with mock data so the UX can be demoed before a real OCR backend exists.
 *
 * ---------------------------------------------------------------------------
 * 🔮 FUTURE: Google Cloud Vision / real OCR backend insert point
 * ---------------------------------------------------------------------------
 * Replace the mock delay + MOCK_CNIC_OCR below with a real call, e.g.:
 *
 *   // const formData = new FormData();
 *   // formData.append("image", file);
 *   // const res = await fetch("/api/ocr/cnic", { method: "POST", body: formData });
 *   // const { fullName, cnic } = await res.json();
 *   // applyOcrFields({ fullName, cnic });
 *
 * Or Cloud Vision (client → Cloud Function recommended, never expose API keys):
 *
 *   // const result = await extractCnicFieldsViaVision(file);
 *   // applyOcrFields(result);
 * ---------------------------------------------------------------------------
 *
 * @param {File} file CNIC Front image file
 */
async function runCnicOcrSimulation(file) {
  if (!file) return;

  cancelCnicOcr();
  setCnicScanVisible(true);

  // -------------------------------------------------------------------------
  // >>> INSERT REAL OCR / Google Cloud Vision API CALL HERE (replace mock) <<<
  // Keep the scan UI visible while awaiting the backend response.
  // On success: applyOcrFields({ fullName, cnic }); setCnicScanVisible(false);
  // On failure: setCnicScanVisible(false); show a toast / field error.
  // -------------------------------------------------------------------------

  ocrTimer = window.setTimeout(() => {
    ocrTimer = null;
    // MOCK ONLY — remove when real OCR returns structured fields
    applyOcrFields(mockCnicOcr());
    setCnicScanVisible(false);
  }, 2000);
}

function bindUploadZones() {
  document.querySelectorAll(".driver-upload input[type='file']").forEach((input) => {
    const zone = input.closest(".driver-upload");
    input.addEventListener("change", () => updateUploadZone(input));

    ["dragenter", "dragover"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.add("is-dragging");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.remove("is-dragging");
      });
    });
    zone.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) setUploadFile(input, file);
    });
  });
}

function keepFocusInside(event) {
  if (event.key !== "Tab" || !els.overlay?.classList.contains("is-open")) return;
  const focusable = [
    ...els.panel.querySelectorAll(
      'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((node) => !node.hidden);
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function validateAgainstConfig(files) {
  const cfg = formConfig || {};
  const checks = [
    [cfg.requireFullName !== false, Boolean(els.fullName?.value.trim()), "driverNeedFullName"],
    [cfg.requireCnic !== false, Boolean(els.cnic?.value.trim()), "driverNeedCnic"],
    [cfg.requireLicense !== false, Boolean(els.license?.value.trim()), "driverNeedLicense"],
    [cfg.requireVehicleType !== false, Boolean(els.vehicleType?.value), "driverNeedVehicle"],
    [cfg.requireCnicFront !== false, Boolean(files.cnicFront), "driverNeedCnicFront"],
    [cfg.requireCnicBack !== false, Boolean(files.cnicBack), "driverNeedCnicBack"],
    [cfg.requireLicenseImage !== false, Boolean(files.license), "driverNeedLicenseImage"],
    [cfg.requireSelfie !== false, Boolean(files.selfie), "driverNeedSelfie"],
  ];

  for (const [needed, ok, key] of checks) {
    if (needed && !ok) return key;
  }
  return null;
}

async function handleDriverSubmit(event) {
  event.preventDefault();
  setFormMessage("");

  if (!isFirebaseConfigured()) {
    setFormMessage("errFirebaseConfig", true);
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    setFormMessage("driverNeedSignIn", true);
    openAuthModal("signin");
    return;
  }

  const files = getDriverOnboardingFiles();
  const missingKey = validateAgainstConfig(files);
  if (missingKey) {
    setFormMessage(missingKey, true);
    return;
  }

  if (els.submitBtn) els.submitBtn.disabled = true;
  setFormMessage("driverSubmitting");

  try {
    await submitDriverApplication({
      fullName: els.fullName?.value || "",
      cnic: els.cnic?.value || "",
      licenseNumber: els.license?.value || "",
      vehicleType: els.vehicleType?.value || "",
      files,
    });
    if (typeof onToast === "function") onToast(t("driverSubmitSuccess"));
    setFormMessage("driverSubmitSuccess");
    closeDriverOnboarding();
    els.form?.reset();
    selfieFile = null;
    document.querySelectorAll(".driver-upload").forEach((zone) => {
      zone.classList.remove("has-file");
      const label = zone.querySelector(".driver-upload__file");
      if (label) label.textContent = "";
    });
    if (els.preview) {
      const oldUrl = els.preview.dataset.objectUrl;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      els.preview.removeAttribute("src");
      els.preview.hidden = true;
      delete els.preview.dataset.objectUrl;
    }
    if (els.empty) els.empty.hidden = false;
  } catch (err) {
    console.warn("[SwiftGo] driver application", err);
    if (err?.message === "NOT_SIGNED_IN") {
      setFormMessage("driverNeedSignIn", true);
      openAuthModal("signin");
    } else {
      setFormMessage("driverSubmitFailed", true);
    }
  } finally {
    if (els.submitBtn) els.submitBtn.disabled = false;
  }
}

export function getDriverOnboardingFiles() {
  return {
    cnicFront: document.getElementById("driverCnicFront")?.files?.[0] || null,
    cnicBack: document.getElementById("driverCnicBack")?.files?.[0] || null,
    license: document.getElementById("driverLicenseFile")?.files?.[0] || null,
    selfie: selfieFile,
  };
}

export function refreshDriverOnboardingLabels() {
  applyTranslations(els.overlay || document.getElementById("driverOnboarding") || document);
  if (els.preview && !els.preview.hidden) {
    els.preview.alt = t("driverSelfiePreviewAlt");
  }
  if (formConfig) applyDriverFormConfig(formConfig);
}

export function initDriverOnboarding(handlers = {}) {
  cacheElements();
  if (!els.overlay) return;
  onToast = handlers.onToast || null;

  document.getElementById("earnDriverBtn")?.addEventListener("click", () => {
    openDriverOnboarding();
  });
  els.close?.addEventListener("click", closeDriverOnboarding);
  els.backdrop?.addEventListener("click", closeDriverOnboarding);
  els.cameraBtn?.addEventListener("click", startCamera);
  els.captureBtn?.addEventListener("click", captureSelfie);
  els.retakeBtn?.addEventListener("click", resetSelfie);
  els.form?.addEventListener("submit", handleDriverSubmit);
  bindUploadZones();
  refreshDriverOnboardingLabels();

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (event.key === "Escape") closeDriverOnboarding();
    keepFocusInside(event);
  });
}
