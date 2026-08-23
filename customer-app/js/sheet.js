/** Expandable bottom sheet + locations + Phase 6 vehicle selection */

import { t, applyTranslations, formatMoney } from "./i18n.js";
import { clearLocationCue, resizeMap } from "./map.js";
import { isSearchingDriver } from "./ride-flow.js";
import { validatePromoCode } from "./data.js";

const VEHICLE_META = {
  bike: { nameKey: "vehBike", eta: 2, price: 142 },
  go: { nameKey: "vehGo", eta: 4, price: 220 },
  "go-plus": { nameKey: "vehGoPlus", eta: 5, price: 340 },
  business: { nameKey: "vehBusiness", eta: 6, price: 520 },
  "bike-cargo": { nameKey: "vehBikeCargo", eta: 5, price: 180 },
  suzuki: { nameKey: "vehSuzuki", eta: 8, price: 450 },
  truck: { nameKey: "vehTruck", eta: 12, price: 890 },
};

/** Phase 13.2 — Ride/Cargo expand with strict vehicle filters; Rent opens utility drawer. */
const CATEGORY_CONFIG = {
  ride: {
    vehicles: ["bike", "go", "go-plus", "business"],
    labelKey: "chooseVehicleRide",
    defaultVehicle: "bike",
    opensDrawer: false,
  },
  cargo: {
    vehicles: ["bike-cargo", "suzuki", "truck"],
    labelKey: "chooseVehicleCargo",
    defaultVehicle: "bike-cargo",
    opensDrawer: false,
  },
  rent: {
    vehicles: [],
    labelKey: "chooseVehicleRent",
    defaultVehicle: null,
    opensDrawer: true,
  },
};

function computePromoDiscount(price, promo) {
  if (!promo) return 0;
  return promo.type === "percent"
    ? Math.round((price * promo.value) / 100)
    : Math.min(price, promo.value);
}

/**
 * Keep booking/CTA state aligned with Phase 15 prices shown on vehicle cards.
 * @param {Record<string, number>} fares
 * @param {number} eta
 */
export function setDynamicVehicleFares(fares, eta) {
  for (const [id, fare] of Object.entries(fares || {})) {
    if (!VEHICLE_META[id] || !Number.isFinite(fare)) continue;
    VEHICLE_META[id].price = Math.max(0, Math.round(fare));
    if (Number.isFinite(eta)) VEHICLE_META[id].eta = Math.max(0, Math.round(eta));
  }

  if (sheetState.promoCode && sheetState.promoMeta) {
    const meta = VEHICLE_META[sheetState.vehicle] || VEHICLE_META.bike;
    sheetState.discount = computePromoDiscount(meta.price, sheetState.promoMeta);
  }

  updateBookRideCta();
}

/** @type {{ pickup: string, destination: string, stops: string[], service: string | null, category: string | null, vehicle: string, promoCode: string, promoMeta: { type: string, value: number } | null, discount: number, expanded: boolean, rideReady: boolean }} */
const sheetState = {
  pickup: "",
  destination: "",
  stops: [],
  service: "ride",
  category: null,
  vehicle: "bike",
  promoCode: "",
  promoMeta: null,
  discount: 0,
  expanded: false,
  rideReady: false,
};

/** Phase 13.1: one intermediate stop stays inside the header (never over the map). */
const MAX_EXTRA_STOPS = 1;
let stopSeq = 0;

let els = {};

/** @type {null | ((state: ReturnType<typeof getSheetState>) => void)} */
let onBookRide = null;

export function getSheetState() {
  const meta = VEHICLE_META[sheetState.vehicle] || VEHICLE_META.bike;
  const stops = collectStops();
  const price = Math.max(0, meta.price - sheetState.discount);
  return {
    ...sheetState,
    stops,
    destination: buildDestinationChain(sheetState.destination, stops),
    eta: meta.eta,
    price,
    basePrice: meta.price,
  };
}

function collectStops() {
  const root = els.extraStops || document.getElementById("extraStops");
  if (!root) return [];
  return [...root.querySelectorAll(".stop-input")]
    .map((inp) => inp.value.trim())
    .filter(Boolean);
}

function buildDestinationChain(primary, stops) {
  const parts = [primary, ...stops].map((s) => s.trim()).filter(Boolean);
  return parts.join(" → ");
}

export function initSheet(handlers = {}) {
  onBookRide = handlers.onBookRide || handlers.onServicePick || null;

  els = {
    sheet: document.getElementById("sheet"),
    handle: document.getElementById("sheetHandle"),
    pickup: document.getElementById("pickupInput"),
    dest: document.getElementById("destInput"),
    shell: document.getElementById("shell"),
    ridePanel: document.getElementById("ridePanel"),
    bookRideBtn: document.getElementById("bookRideBtn"),
    bookRideLabel: document.getElementById("bookRideLabel"),
    vehicleLabel: document.querySelector(".ride-panel__label"),
    vehicleRail: document.getElementById("vehicleRail"),
    extraStops: document.getElementById("extraStops"),
    addStopBtn: document.getElementById("addStopBtn"),
    promoControl: document.getElementById("promoControl"),
    promoTrigger: document.getElementById("promoTrigger"),
    promoForm: document.getElementById("promoForm"),
    promoInput: document.getElementById("promoInput"),
    promoApplyBtn: document.getElementById("promoApplyBtn"),
    promoMessage: document.getElementById("promoMessage"),
    promoStatus: document.getElementById("promoStatus"),
    serviceRail: document.getElementById("serviceRail"),
  };

  if (!els.sheet) return;

  els.handle?.addEventListener("click", toggleSheet);
  // Phase 13.2: bottom-rail categories drive expand + strict vehicle filters.
  document.addEventListener("click", handleLocationQuickAction);

  let startY = 0;
  let dragging = false;
  els.handle?.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    els.handle.setPointerCapture(e.pointerId);
  });
  els.handle?.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (dy > 40) expandSheet();
    if (dy < -40) collapseSheet();
  });
  els.handle?.addEventListener("pointerup", () => {
    dragging = false;
  });

  const onLocInput = () => {
    sheetState.pickup = els.pickup?.value || "";
    sheetState.destination = els.dest?.value || "";
    syncRideReady();
  };

  els.pickup?.addEventListener("input", onLocInput);
  els.dest?.addEventListener("input", onLocInput);

  els.addStopBtn?.addEventListener("click", () => {
    addStopField();
  });

  els.serviceRail?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-category]");
    if (!item) return;
    selectCategory(item.dataset.category);
  });

  document.querySelectorAll(".vehicle-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectVehicle(card.dataset.vehicle);
    });
  });

  els.promoTrigger?.addEventListener("click", togglePromoForm);
  els.promoApplyBtn?.addEventListener("click", applyPromo);
  els.promoInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyPromo();
    }
  });

  els.bookRideBtn?.addEventListener("click", () => {
    if (typeof onBookRide === "function") {
      onBookRide({ ...getSheetState() });
    }
  });

  // Hide every vehicle until a category is chosen; keep CTA label ready.
  selectVehicle(sheetState.vehicle, { silent: true });
  applyCategoryFilter(null);
  syncRideReady({ autoExpand: false });
  updateAddStopBtn();
}

/**
 * Strict category filter:
 * Ride → bike, go, go-plus, business
 * Cargo → bike-cargo, suzuki, truck
 * Rent → hide all vehicles + open side drawer
 * @param {string} category
 */
export function selectCategory(category) {
  const key = CATEGORY_CONFIG[category] ? category : "ride";
  const config = CATEGORY_CONFIG[key];
  sheetState.category = key;
  sheetState.service = key;

  document.querySelectorAll(".service-rail__item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.category === key);
  });

  if (config.opensDrawer) {
    if (els.ridePanel) els.ridePanel.hidden = true;
    if (els.vehicleRail) els.vehicleRail.hidden = true;
    els.sheet?.classList.remove("sheet--ride-ready");
    els.shell?.classList.remove("sheet-ride-ready");
    applyCategoryFilter(key);
    collapseSheet();
    document.dispatchEvent(
      new CustomEvent("swiftgo:open-utility-drawer", {
        detail: { mode: key },
      })
    );
    return;
  }

  if (els.vehicleRail) els.vehicleRail.hidden = false;
  applyCategoryFilter(key);

  const preferred =
    config.vehicles.includes(sheetState.vehicle) ? sheetState.vehicle : config.defaultVehicle;
  if (preferred) selectVehicle(preferred, { silent: true });

  if (els.ridePanel) els.ridePanel.hidden = false;
  els.sheet?.classList.add("sheet--ride-ready");
  expandSheet();
  els.shell?.classList.add("sheet-ride-ready");

  window.setTimeout(() => {
    els.ridePanel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 280);
}

/** Strictly show only cards whose HTML data-category matches the active category. */
function applyCategoryFilter(category) {
  const config = CATEGORY_CONFIG[category] || null;
  const visibleCategory = config?.opensDrawer ? null : category;

  els.vehicleRail?.querySelectorAll(".vehicle-card").forEach((card) => {
    const visible = Boolean(visibleCategory) && card.dataset.category === visibleCategory;
    card.hidden = !visible;
    card.style.display = visible ? "flex" : "none";
  });

  if (els.vehicleLabel) {
    if (config) {
      els.vehicleLabel.dataset.i18n = config.labelKey;
      els.vehicleLabel.textContent = t(config.labelKey);
    } else {
      els.vehicleLabel.dataset.i18n = "chooseVehicle";
      els.vehicleLabel.textContent = t("chooseVehicle");
    }
  }
}

function togglePromoForm() {
  if (!els.promoForm || !els.promoTrigger) return;
  const open = els.promoForm.hidden;
  els.promoForm.hidden = !open;
  els.promoTrigger.setAttribute("aria-expanded", String(open));
  if (open) els.promoInput?.focus();
}

function setPromoMessage(key, isError = false) {
  if (!els.promoMessage) return;
  els.promoMessage.hidden = false;
  els.promoMessage.classList.toggle("is-error", isError);
  els.promoMessage.textContent = t(key);
}

async function applyPromo() {
  const code = (els.promoInput?.value || "").trim().toUpperCase();
  const meta = VEHICLE_META[sheetState.vehicle] || VEHICLE_META.bike;

  if (!code) {
    sheetState.promoCode = "";
    sheetState.promoMeta = null;
    sheetState.discount = 0;
    els.promoControl?.classList.remove("is-applied");
    if (els.promoStatus) els.promoStatus.textContent = "";
    setPromoMessage("promoInvalid", true);
    updateBookRideCta();
    return;
  }

  if (els.promoApplyBtn) els.promoApplyBtn.disabled = true;
  setPromoMessage("promoChecking");

  try {
    const promo = await validatePromoCode(code);

    if (!promo) {
      sheetState.promoCode = "";
      sheetState.promoMeta = null;
      sheetState.discount = 0;
      els.promoControl?.classList.remove("is-applied");
      if (els.promoStatus) els.promoStatus.textContent = "";
      setPromoMessage("promoInvalid", true);
      updateBookRideCta();
      return;
    }

    sheetState.promoCode = promo.code;
    sheetState.promoMeta = { type: promo.type, value: promo.value };
    sheetState.discount = computePromoDiscount(meta.price, sheetState.promoMeta);
    els.promoControl?.classList.add("is-applied");
    if (els.promoStatus) els.promoStatus.textContent = promo.code;
    setPromoMessage("promoApplied");
    updateBookRideCta();
  } finally {
    if (els.promoApplyBtn) els.promoApplyBtn.disabled = false;
  }
}

function stopCount() {
  return els.extraStops?.querySelectorAll(".route-search__stop").length || 0;
}

function updateAddStopBtn() {
  if (!els.addStopBtn) return;
  const full = stopCount() >= MAX_EXTRA_STOPS;
  els.addStopBtn.disabled = full;
  els.addStopBtn.classList.toggle("is-disabled", full);
}

export function addStopField() {
  if (!els.extraStops) return;
  if (stopCount() >= MAX_EXTRA_STOPS) return;

  stopSeq += 1;
  const id = `stopInput-${stopSeq}`;
  const row = document.createElement("div");
  row.className = "route-search__stop";
  row.dataset.stopId = String(stopSeq);
  row.dataset.locationRole = "stop";
  row.innerHTML = `
    <input
      id="${id}"
      class="route-search__input stop-input"
      type="text"
      autocomplete="off"
      enterkeyhint="next"
      data-i18n-placeholder="stopPlaceholder"
      placeholder="${t("stopPlaceholder")}"
    />
    <button
      type="button"
      class="route-search__voice-btn"
      data-location-action="voice"
      data-location-target="${id}"
      aria-label="${t("voiceInput")}"
      data-i18n-aria="voiceInput"
      title="${t("voiceInput")}"
    >🎤</button>
    <button type="button" class="route-search__remove remove-stop-btn" aria-label="${t("removeStop")}" data-i18n-aria="removeStop">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18"/>
      </svg>
    </button>
  `;

  const input = row.querySelector(".stop-input");
  input?.addEventListener("input", () => {
    sheetState.stops = collectStops();
    document.dispatchEvent(
      new CustomEvent("swiftgo:locations-changed", {
        detail: { inputId: id, pickup: sheetState.pickup, destination: sheetState.destination },
      })
    );
  });

  row.querySelector(".remove-stop-btn")?.addEventListener("click", () => {
    const stopKey = row.dataset.stopId;
    if (stopKey) clearLocationCue("stop", `stop-${stopKey}`);
    row.remove();
    sheetState.stops = collectStops();
    updateAddStopBtn();
    document.dispatchEvent(
      new CustomEvent("swiftgo:locations-changed", {
        detail: { inputId: id, pickup: sheetState.pickup, destination: sheetState.destination },
      })
    );
  });

  els.extraStops.appendChild(row);
  updateAddStopBtn();
  input?.focus();
}

/**
 * Phase 12.1–12.2: GPS / Choose-on-Map buttons emit a shared event.
 */
function handleLocationQuickAction(event) {
  const button = event.target.closest("[data-location-action]");
  const routeRoot = document.getElementById("routeSearchCard");
  if (!button || !routeRoot?.contains(button)) return;

  const input = document.getElementById(button.dataset.locationTarget || "");
  const field = button.closest("[data-location-role]");
  const action = button.dataset.locationAction || "";
  if (action !== "map") {
    button.classList.add("is-pressed");
    window.setTimeout(() => button.classList.remove("is-pressed"), 180);
    input?.focus();
  }

  document.dispatchEvent(
    new CustomEvent("swiftgo:location-action", {
      detail: {
        action,
        role: field?.dataset.locationRole || "stop",
        inputId: input?.id || "",
      },
    })
  );
}

function hasBothLocations() {
  return Boolean(sheetState.pickup?.trim() && sheetState.destination?.trim());
}

/**
 * Phase 13.3: vehicle panel appears after a bottom-rail category tap.
 * Locations still gate booking, but no longer auto-expand the sheet.
 */
export function syncRideReady(opts = { autoExpand: false }) {
  const ready = hasBothLocations();
  sheetState.rideReady = ready;

  const config = sheetState.category ? CATEGORY_CONFIG[sheetState.category] : null;
  const showPanel = Boolean(config) && !config.opensDrawer && !isSearchingDriver();
  if (els.ridePanel) {
    els.ridePanel.hidden = !showPanel;
  }
  els.sheet?.classList.toggle("sheet--ride-ready", showPanel);
  els.shell?.classList.toggle("sheet-ride-ready", showPanel && sheetState.expanded);

  if (showPanel && opts.autoExpand === true) {
    expandSheet();
    window.setTimeout(() => {
      els.ridePanel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 380);
  } else if (!showPanel) {
    els.shell?.classList.remove("sheet-ride-ready");
  }

  updateBookRideCta();
}

export function selectVehicle(id, opts = {}) {
  const key = VEHICLE_META[id] ? id : "bike";
  sheetState.vehicle = key;

  if (sheetState.promoCode && sheetState.promoMeta) {
    const meta = VEHICLE_META[key] || VEHICLE_META.bike;
    sheetState.discount = computePromoDiscount(meta.price, sheetState.promoMeta);
  } else if (!sheetState.promoMeta) {
    sheetState.discount = 0;
  }

  document.querySelectorAll(".vehicle-card").forEach((card) => {
    const active = card.dataset.vehicle === key;
    card.classList.toggle("is-active", active);
    card.setAttribute("aria-pressed", String(active));
  });

  updateBookRideCta();
  if (!opts.silent) expandSheet();

  window.SwiftGo = window.SwiftGo || {};
  window.SwiftGo.selectedVehicleKey = key;
  document.dispatchEvent(
    new CustomEvent("swiftgo:vehicle-selected", { detail: { vehicle: key } })
  );
}

export function updateBookRideCta() {
  const label = els.bookRideLabel || document.getElementById("bookRideLabel");
  if (!label) return;
  const meta = VEHICLE_META[sheetState.vehicle] || VEHICLE_META.bike;
  const name = t(meta.nameKey);
  const price = formatMoney(Math.max(0, meta.price - sheetState.discount));
  // "Book Bike · Rs. 142" / "بائیک بک کریں · ١٤٢ روپے"
  label.textContent = t("bookRideCta")
    .replace("{vehicle}", name)
    .replace("{price}", price);
}

function scheduleMapResize() {
  requestAnimationFrame(() => {
    resizeMap();
    window.setTimeout(() => resizeMap(), 280);
  });
}

export function expandSheet() {
  if (!els.sheet) return;
  sheetState.expanded = true;
  els.sheet.dataset.state = "expanded";
  els.sheet.setAttribute("aria-expanded", "true");
  els.shell?.classList.add("sheet-expanded");
  if (sheetState.rideReady || sheetState.category) els.shell?.classList.add("sheet-ride-ready");
  els.handle?.setAttribute("aria-label", t("collapseSheet"));
  scheduleMapResize();
}

export function collapseSheet() {
  if (!els.sheet) return;
  sheetState.expanded = false;
  els.sheet.dataset.state = "collapsed";
  els.sheet.setAttribute("aria-expanded", "false");
  els.shell?.classList.remove("sheet-expanded");
  els.shell?.classList.remove("sheet-ride-ready");
  els.handle?.setAttribute("aria-label", t("expandSheet"));
  scheduleMapResize();
}

export function toggleSheet() {
  if (sheetState.expanded) collapseSheet();
  else expandSheet();
}

export function setSheetVisible(visible) {
  if (!els.sheet) return;
  els.sheet.hidden = !visible;
  if (!visible) collapseSheet();
}

/** Phase 17.3 — restore the bottom sheet to its initial location-entry state. */
export function resetSheetForNewRide() {
  els.extraStops?.querySelectorAll("[data-stop-id]").forEach((row) => {
    clearLocationCue("stop", `stop-${row.dataset.stopId}`);
  });
  if (els.extraStops) els.extraStops.replaceChildren();

  sheetState.pickup = "";
  sheetState.destination = "";
  sheetState.stops = [];
  sheetState.service = "ride";
  sheetState.category = null;
  sheetState.vehicle = "bike";
  sheetState.promoCode = "";
  sheetState.discount = 0;
  sheetState.rideReady = false;

  if (els.pickup) els.pickup.value = "";
  if (els.dest) els.dest.value = "";
  if (els.promoInput) els.promoInput.value = "";
  if (els.promoForm) els.promoForm.hidden = true;
  if (els.promoMessage) els.promoMessage.hidden = true;
  if (els.promoStatus) els.promoStatus.textContent = "";
  els.promoControl?.classList.remove("is-applied");

  document.querySelectorAll(".service-rail__item").forEach((item) => {
    item.classList.remove("is-active");
  });
  selectVehicle("bike", { silent: true });
  applyCategoryFilter(null);
  syncRideReady({ autoExpand: false });
  updateAddStopBtn();
  collapseSheet();
  document.dispatchEvent(new CustomEvent("swiftgo:reset-route-ui"));
}

export function setPickupLabel(text) {
  setLocationFieldValue("pickupInput", text, { autoExpand: false });
}

/**
 * Write a human-readable place into Pickup, Drop-off, or a Stop field.
 * @param {string} inputId
 * @param {string} text
 * @param {{ autoExpand?: boolean }} [opts]
 */
export function setLocationFieldValue(inputId, text, opts = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const value = String(text || "").trim();
  input.value = value;

  if (inputId === "pickupInput") {
    sheetState.pickup = value;
  } else if (inputId === "destInput") {
    sheetState.destination = value;
  } else if (input.classList.contains("stop-input")) {
    sheetState.stops = collectStops();
  }

  syncRideReady({ autoExpand: opts.autoExpand === true });
  input.dispatchEvent(new Event("input", { bubbles: true }));
  document.dispatchEvent(
    new CustomEvent("swiftgo:locations-changed", {
      detail: {
        pickup: sheetState.pickup,
        destination: sheetState.destination,
        ready: hasBothLocations(),
        inputId,
      },
    })
  );
}

export function getLocationFieldValue(inputId) {
  return document.getElementById(inputId)?.value || "";
}

export function refreshSheetLabels() {
  applyTranslations(els.sheet || document);
  document.querySelectorAll(".vehicle-card").forEach((card) => {
    const id = card.dataset.vehicle;
    const meta = VEHICLE_META[id];
    if (!meta) return;
    const etaEl = card.querySelector(".vehicle-card__eta");
    const priceEl = card.querySelector(".vehicle-card__price");
    if (etaEl) etaEl.textContent = t("etaMin").replace("{n}", String(meta.eta));
    if (priceEl) priceEl.textContent = formatMoney(meta.price);
  });
  if (els.promoMessage && !els.promoMessage.hidden) {
    setPromoMessage(sheetState.promoCode ? "promoApplied" : "promoInvalid", !sheetState.promoCode);
  }
  applyCategoryFilter(sheetState.category);
  document.querySelectorAll(".stop-input").forEach((inp) => {
    inp.setAttribute("placeholder", t("stopPlaceholder"));
  });
  document.querySelectorAll(".remove-stop-btn").forEach((btn) => {
    btn.setAttribute("aria-label", t("removeStop"));
  });
  updateBookRideCta();
  if (els.handle) {
    els.handle.setAttribute(
      "aria-label",
      sheetState.expanded ? t("collapseSheet") : t("expandSheet")
    );
  }
}
