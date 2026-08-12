/**
 * Phase 45.2 — Uber/Careem 3-state location UI:
 *   idle (Where to? pill) → search (card) → map-pick (pin mode)
 *   + collapsed route pill when route is complete.
 */

import { t, subscribe } from "./i18n.js";
import { getSheetState } from "./sheet.js";

/** @typedef {'idle' | 'search' | 'collapsed' | 'map-pick'} RouteUiState */

/** @type {RouteUiState} */
let uiState = "idle";

/** Skip autofocus once when returning from map-pick (avoids keyboard). */
let skipNextSearchFocus = false;

/** @type {HTMLElement | null} */
let pillHomeParent = null;

const els = {
  topbar: null,
  trigger: null,
  card: null,
  pill: null,
  pillTrack: null,
  headerCenter: null,
  headerBrand: null,
  layersFab: null,
  layersBtn: null,
  layersMenu: null,
};

function cacheEls() {
  els.topbar = document.getElementById("topbar");
  els.trigger = document.getElementById("whereToTrigger");
  els.card = document.getElementById("routeSearchCard");
  els.pill = document.getElementById("routePill");
  els.pillTrack = document.getElementById("routePillTrack");
  els.headerCenter = document.querySelector(".ep-header__center");
  els.headerBrand = document.getElementById("epHeaderBrand");
  els.layersFab = document.getElementById("mapLayersFab");
  els.layersBtn = document.getElementById("btnLayersFab");
  els.layersMenu = document.getElementById("mapLayers");
}

function truncate(text, max = 18) {
  const s = String(text || "").trim() || "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hasEmptyStopInputs() {
  return [...document.querySelectorAll(".stop-input")].some((input) => !input.value.trim());
}

function canCollapse() {
  const state = getSheetState();
  return Boolean(state.pickup?.trim() && state.destination?.trim() && !hasEmptyStopInputs());
}

function buildPillSegment(kind, text) {
  const seg = document.createElement("span");
  seg.className = "route-pill__seg";
  seg.innerHTML = `
    <span class="route-pill__dot route-pill__dot--${kind}" aria-hidden="true"></span>
    <span class="route-pill__text">${truncate(text)}</span>
  `;
  return seg;
}

function buildPillArrow() {
  const arrow = document.createElement("span");
  arrow.className = "route-pill__arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  return arrow;
}

function refreshTriggerLabel() {
  if (!els.trigger) return;
  // Keep data-i18n in sync so applyTranslations and lang listeners agree (Phase 4D / B13).
  els.trigger.setAttribute("data-i18n", "whereToTrigger");
  els.trigger.textContent = t("whereToTrigger");
}

function refreshPill() {
  const state = getSheetState();
  if (!els.pillTrack) return;

  els.pillTrack.replaceChildren();

  const pickupText = state.pickup?.trim() || t("pickupPlaceholder");
  els.pillTrack.appendChild(buildPillSegment("pickup", pickupText));

  const stops = (state.stops || []).map((s) => s.trim()).filter(Boolean);
  stops.forEach((stop) => {
    els.pillTrack.appendChild(buildPillArrow());
    els.pillTrack.appendChild(buildPillSegment("stop", stop));
  });

  els.pillTrack.appendChild(buildPillArrow());
  els.pillTrack.appendChild(
    buildPillSegment("dropoff", state.destination?.trim() || t("destPlaceholder"))
  );
}

function syncPillPlacement(showPill) {
  if (!els.pill) return;
  const onBookScreen = document.getElementById("shell")?.classList.contains("on-home");

  if (showPill && onBookScreen && els.headerCenter) {
    if (!pillHomeParent) pillHomeParent = els.pill.parentElement;
    if (els.pill.parentElement !== els.headerCenter) {
      els.headerCenter.appendChild(els.pill);
    }
    els.pill.classList.add("route-pill--header");
    els.headerBrand?.setAttribute("hidden", "");
  } else {
    if (pillHomeParent && els.pill.parentElement !== pillHomeParent) {
      pillHomeParent.appendChild(els.pill);
    }
    els.pill.classList.remove("route-pill--header");
    if (onBookScreen) els.headerBrand?.removeAttribute("hidden");
  }
}

/** @param {RouteUiState} next */
export function setRouteUiState(next) {
  const state = next === "map-pick" ? "map-pick" : next === "search" ? "search" : next === "collapsed" ? "collapsed" : "idle";
  uiState = state;

  els.topbar?.setAttribute("data-ui", state);

  const showTrigger = state === "idle";
  const showCard = state === "search";
  const showPill = state === "collapsed";

  if (els.trigger) els.trigger.hidden = !showTrigger;
  if (els.card) els.card.hidden = !showCard;
  if (els.pill) els.pill.hidden = !showPill;

  syncPillPlacement(showPill);

  document.body.classList.toggle("route-ui-idle", state === "idle");
  document.body.classList.toggle("route-ui-search", state === "search");
  document.body.classList.toggle("route-ui-collapsed", state === "collapsed");
  document.body.classList.toggle("route-ui-map-pick", state === "map-pick");

  document.dispatchEvent(
    new CustomEvent("swiftgo:route-ui-state", { detail: { state } })
  );

  if (showCard && !skipNextSearchFocus) {
    window.requestAnimationFrame(() => {
      const pickup = document.getElementById("pickupInput");
      const dest = document.getElementById("destInput");
      const sheet = getSheetState();
      if (!sheet.pickup?.trim()) pickup?.focus({ preventScroll: true });
      else if (!sheet.destination?.trim()) dest?.focus({ preventScroll: true });
    });
  }
  skipNextSearchFocus = false;
}

export function openSearchCard() {
  setRouteUiState("search");
}

export function tryCollapseRoute() {
  if (!canCollapse()) return false;
  refreshPill();
  setRouteUiState("collapsed");
  return true;
}

function onLocationsChanged(detail = {}) {
  refreshPill();

  if (uiState === "map-pick") return;

  if (!canCollapse()) return;

  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement &&
    (active.id === "pickupInput" ||
      active.id === "destInput" ||
      active.classList.contains("stop-input"))
  ) {
    return;
  }

  tryCollapseRoute();
}

function bindInputCollapse() {
  ["pickupInput", "destInput"].forEach((id) => {
    document.getElementById(id)?.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (uiState === "search" && canCollapse()) tryCollapseRoute();
      }, 120);
    });
  });
}

function tryAdvanceOnEnter(event) {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (
    target.id !== "pickupInput" &&
    target.id !== "destInput" &&
    !target.classList.contains("stop-input")
  ) {
    return;
  }

  event.preventDefault();
  const value = target.value.trim();
  if (!value) return;

  target.dispatchEvent(new Event("input", { bubbles: true }));
  refreshPill();

  if (canCollapse()) tryCollapseRoute();
  else if (target.id === "pickupInput") {
    document.getElementById("destInput")?.focus({ preventScroll: true });
  }
}

function setLayersMenuOpen(open) {
  if (!els.layersMenu || !els.layersBtn) return;
  els.layersMenu.hidden = !open;
  els.layersBtn.setAttribute("aria-expanded", String(open));
  els.layersFab?.classList.toggle("is-open", open);
}

function bindLayersFab() {
  els.layersBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    setLayersMenuOpen(els.layersMenu?.hidden !== false);
  });

  els.layersMenu?.addEventListener("click", () => {
    window.setTimeout(() => setLayersMenuOpen(false), 160);
  });

  document.addEventListener("click", (event) => {
    if (!els.layersFab?.contains(event.target)) setLayersMenuOpen(false);
  });
}

function bindRouteUi() {
  els.trigger?.addEventListener("click", () => openSearchCard());

  els.pill?.addEventListener("click", () => openSearchCard());

  bindInputCollapse();

  document.addEventListener("keydown", tryAdvanceOnEnter);

  document.addEventListener("swiftgo:locations-changed", (event) => {
    onLocationsChanged(event.detail || {});
  });

  document.addEventListener("swiftgo:route-ui-map-pick", (event) => {
    if (event.detail?.active) setRouteUiState("map-pick");
    else if (canCollapse()) {
      refreshPill();
      setRouteUiState("collapsed");
    } else {
      skipNextSearchFocus = true;
      setRouteUiState("search");
    }
  });

  document.addEventListener("swiftgo:reset-route-ui", () => {
    refreshPill();
    setRouteUiState("idle");
  });

  subscribe(() => {
    refreshTriggerLabel();
    refreshPill();
  });
}

export function initStepUi() {
  cacheEls();
  if (!els.trigger || !els.card) return;

  refreshTriggerLabel();
  refreshPill();
  setRouteUiState("idle");
  bindRouteUi();
  bindLayersFab();
  setLayersMenuOpen(false);
}

export function refreshStepUiLabels() {
  refreshTriggerLabel();
  refreshPill();
}
