import { t } from "./i18n.js";
import { locateUser } from "./map.js";
import { getRouteInfo } from "./routing.js";
import { getLocationFieldValue } from "./sheet.js";
import { applyLocationPlace } from "./location.js";

const STORAGE_KEY = "swiftgo_quick_places_v1";
const HOLD_MS = 650;
let onToast = () => {};
let places = loadPlaces();
let lastTarget = "destInput";

function loadPlaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function activeTarget() {
  const focused = document.activeElement?.id;
  if (focused === "pickupInput" || focused === "destInput") lastTarget = focused;
  return lastTarget;
}

function placeName(key) {
  return key === "home" ? t("savedHome") : t("savedWork");
}

function savePlace(key) {
  const target = activeTarget();
  const route = getRouteInfo();
  const point = target === "pickupInput" ? route.pickup : route.dropoff;
  const label = getLocationFieldValue(target).trim();
  if (!point || !label) {
    onToast(t("quickPlaceMissing"));
    return;
  }
  places[key] = { label, lat: Number(point.lat), lng: Number(point.lng) };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(places)); } catch { /* ignore */ }
  refreshQuickPlaces();
  onToast(t("quickPlaceSaved").replace("{place}", placeName(key)));
}

async function usePlace(key) {
  const target = activeTarget();
  if (key === "current") {
    const point = await locateUser({ fly: true });
    if (point && !point.denied) {
      await applyLocationPlace(target, point, { resolveLabel: true });
    }
    return;
  }
  if (!places[key]) {
    onToast(t("quickPlaceMissing"));
    return;
  }
  await applyLocationPlace(target, places[key]);
}

export function refreshQuickPlaces() {
  document.querySelectorAll("[data-quick-place='home'], [data-quick-place='work']").forEach((button) => {
    const key = button.dataset.quickPlace;
    button.classList.toggle("is-empty", !places[key]);
    button.title = places[key]?.label || t("quickPlacesHint");
  });
}

export function initQuickPlaces(options = {}) {
  onToast = options.onToast || onToast;
  document.addEventListener("focusin", (event) => {
    if (event.target?.id === "pickupInput" || event.target?.id === "destInput") {
      lastTarget = event.target.id;
    }
  });
  document.querySelectorAll("[data-quick-place]").forEach((button) => {
    const key = button.dataset.quickPlace;
    let timer = 0;
    let held = false;
    const start = () => {
      if (key === "current") return;
      held = false;
      timer = window.setTimeout(() => { held = true; savePlace(key); }, HOLD_MS);
    };
    const cancel = () => { window.clearTimeout(timer); timer = 0; };
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", cancel);
    button.addEventListener("pointerleave", cancel);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (!held) void usePlace(key);
      held = false;
    });
  });
  refreshQuickPlaces();
}
