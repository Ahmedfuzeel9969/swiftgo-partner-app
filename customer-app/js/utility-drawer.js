/**
 * Phase 13.3 — universal utility drawer for Rent/Cargo forms and active ride info.
 */

import { t, applyTranslations } from "./i18n.js";
import { phoneHref, SUPPORT } from "./support.js";

function demoDriver() {
  return {
    name: t("demoDriverName"),
    vehicle: t("demoDriverVehicle"),
    plate: t("demoDriverPlate"),
    phone: SUPPORT.phoneE164,
  };
}

let open = false;
let mode = null;
let onToast = null;
let onNavClose = null;

const state = {
  rentDuration: "1h",
  rentVehicle: "sedan",
  cargoSize: "medium",
  cargoFragile: false,
  cargoNotes: "",
  activeRide: null,
};

const els = {};

function cacheEls() {
  els.drawer = document.getElementById("utilityDrawer");
  els.overlay = document.getElementById("drawerOverlay");
  els.title = document.getElementById("utilityDrawerTitle");
  els.close = document.getElementById("utilityDrawerClose");
  els.panelRent = document.getElementById("utilityPanelRent");
  els.panelCargo = document.getElementById("utilityPanelCargo");
  els.panelRide = document.getElementById("utilityPanelRide");
  els.rentConfirm = document.getElementById("rentConfirmBtn");
  els.cargoConfirm = document.getElementById("cargoConfirmBtn");
  els.cargoSize = document.getElementById("cargoPackageSize");
  els.cargoFragile = document.getElementById("cargoFragile");
  els.cargoNotes = document.getElementById("cargoNotes");
  els.driverName = document.getElementById("activeDriverName");
  els.driverVehicle = document.getElementById("activeDriverVehicle");
  els.driverPlate = document.getElementById("activeDriverPlate");
  els.rideDriver = document.getElementById("activeRideDriverLabel");
  els.rideModel = document.getElementById("activeRideModelLabel");
  els.ridePlate = document.getElementById("activeRidePlateLabel");
  els.callBtn = document.getElementById("activeRideCallBtn");
}

function setTitle(key) {
  if (!els.title) return;
  els.title.dataset.i18n = key;
  els.title.textContent = t(key);
}

function showOnlyPanel(panel) {
  [els.panelRent, els.panelCargo, els.panelRide].forEach((node) => {
    if (node) node.hidden = node !== panel;
  });
}

function syncOverlay() {
  if (!els.overlay) return;
  const navOpen = document.getElementById("sidebar")?.classList.contains("is-open");
  if (open || navOpen) {
    els.overlay.hidden = false;
    requestAnimationFrame(() => els.overlay.classList.add("is-visible"));
  } else {
    els.overlay.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!open && !document.getElementById("sidebar")?.classList.contains("is-open")) {
        els.overlay.hidden = true;
      }
    }, 280);
  }
}

export function openUtilityDrawer(nextMode = "rent", payload = {}) {
  if (!els.drawer) cacheEls();
  mode = nextMode;
  onNavClose?.();

  if (nextMode === "rent") {
    setTitle("rentDrawerTitle");
    showOnlyPanel(els.panelRent);
  } else if (nextMode === "cargo") {
    setTitle("cargoDrawerTitle");
    showOnlyPanel(els.panelCargo);
  } else if (nextMode === "active-ride") {
    setTitle("activeRideTitle");
    showOnlyPanel(els.panelRide);
    fillActiveRide(payload.driver || state.activeRide || demoDriver());
  } else {
    setTitle("utilityDrawerTitle");
    showOnlyPanel(null);
  }

  open = true;
  els.drawer?.classList.add("is-open");
  els.drawer?.setAttribute("aria-hidden", "false");
  document.body.classList.add("utility-drawer-open");
  syncOverlay();
  applyTranslations(els.drawer || document);
}

export function closeUtilityDrawer() {
  if (!els.drawer) return;
  open = false;
  mode = null;
  els.drawer.classList.remove("is-open");
  els.drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("utility-drawer-open");
  syncOverlay();
}

export function isUtilityDrawerOpen() {
  return open;
}

export function getUtilityFormState() {
  return { ...state, mode };
}

function fillActiveRide(driver) {
  state.activeRide = driver;
  const name = driver?.name || "—";
  const vehicle = driver?.vehicle || "—";
  const plate = driver?.plate || "—";
  if (els.driverName) els.driverName.textContent = name;
  if (els.driverVehicle) els.driverVehicle.textContent = vehicle;
  if (els.driverPlate) els.driverPlate.textContent = plate;
  if (els.rideDriver) els.rideDriver.textContent = name;
  if (els.rideModel) els.rideModel.textContent = vehicle;
  if (els.ridePlate) els.ridePlate.textContent = plate;
  if (els.callBtn) {
    els.callBtn.href = driver?.phone ? `tel:${driver.phone}` : phoneHref();
  }
}

/**
 * Show live ride drawer after a booking is created.
 * @param {{ vehicleLabel?: string }} [meta]
 */
export function showActiveRideDrawer(meta = {}) {
  const base = demoDriver();
  const driver = {
    ...base,
    vehicle: meta.vehicleLabel || base.vehicle,
  };
  openUtilityDrawer("active-ride", { driver });
}

/** Keep drawer state in sync with live ride doc (does not open the drawer). */
export function syncActiveRideDrawer(ride) {
  if (!ride?.driverName && !ride?.driverId) return;
  fillActiveRide({
    name: ride.driverName || t("activeRideDriver"),
    vehicle: ride.vehicleType || ride.vehicleTypeKey || "—",
    plate: ride.vehiclePlate || "—",
  });
}

function readRentForm() {
  state.rentDuration =
    document.querySelector('input[name="rentDuration"]:checked')?.value || "1h";
  state.rentVehicle =
    document.querySelector('input[name="rentVehicle"]:checked')?.value || "sedan";
}

function readCargoForm() {
  state.cargoSize = els.cargoSize?.value || "medium";
  state.cargoFragile = Boolean(els.cargoFragile?.checked);
  state.cargoNotes = (els.cargoNotes?.value || "").trim();
}

function onRentConfirm() {
  readRentForm();
  onToast?.(t("rentSaved"));
  closeUtilityDrawer();
}

function onCargoConfirm() {
  readCargoForm();
  onToast?.(t("cargoSaved"));
  closeUtilityDrawer();
}

export function refreshUtilityDrawerLabels() {
  if (!els.drawer) return;
  applyTranslations(els.drawer);
  if (mode === "rent") setTitle("rentDrawerTitle");
  else if (mode === "cargo") setTitle("cargoDrawerTitle");
  else if (mode === "active-ride") setTitle("activeRideTitle");
}

export function initUtilityDrawer(handlers = {}) {
  cacheEls();
  onToast = handlers.onToast || null;
  onNavClose = handlers.onNavClose || null;

  els.close?.addEventListener("click", closeUtilityDrawer);
  els.rentConfirm?.addEventListener("click", onRentConfirm);
  els.cargoConfirm?.addEventListener("click", onCargoConfirm);

  document.addEventListener("swiftgo:open-utility-drawer", (event) => {
    const next = event.detail?.mode || "rent";
    openUtilityDrawer(next, event.detail || {});
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) closeUtilityDrawer();
  });

  // Shared overlay: if utility is open, tapping overlay closes it.
  els.overlay?.addEventListener("click", () => {
    if (open) closeUtilityDrawer();
  });
}
