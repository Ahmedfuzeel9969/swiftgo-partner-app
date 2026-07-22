/**
 * Phase 12.2 — map pick mode, reverse geocode, and location autocomplete.
 * Uses OpenStreetMap Nominatim (same ecosystem as the Leaflet tiles).
 */

import { t, applyTranslations } from "./i18n.js";
import {
  locateUser,
  getMapCenter,
  flyToLatLng,
  onMapMoveEnd,
  setMapPickMode,
  resizeMap,
  setLocationCue,
} from "./map.js";
import {
  setLocationFieldValue,
  getLocationFieldValue,
  collapseSheet,
  expandSheet,
} from "./sheet.js";
import { setRoutePoint } from "./routing.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";

let ensureMap = null;
let navigateHome = null;
let activeInputId = null;
let pickPreviousValue = "";
let pickPreviewLabel = "";
let pickCoords = null;
let unsubMoveEnd = () => {};
let searchTimer = null;
let searchSeq = 0;
let reverseSeq = 0;
let suggestAnchor = null;

const els = {};

function cacheEls() {
  els.overlay = document.getElementById("mapPickOverlay");
  els.eyebrow = document.getElementById("mapPickEyebrow");
  els.address = document.getElementById("mapPickAddress");
  els.cancel = document.getElementById("mapPickCancel");
  els.confirm = document.getElementById("mapPickConfirm");
  els.suggest = document.getElementById("locSuggest");
}

function formatPlace(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  const name = item.display_name || "";
  return name
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
}

function roleLabel(role) {
  if (role === "pickup") return t("mapPickPickup");
  if (role === "dropoff") return t("mapPickDropoff");
  return t("mapPickStop");
}

/** Resolve pickup / dropoff / stop (+ stopId) from an input id. */
function resolveLocationMeta(inputId) {
  const id = inputId === "searchInput" ? "destInput" : inputId;
  if (id === "pickupInput") return { role: "pickup", inputId: id };
  if (id === "destInput") return { role: "dropoff", inputId: id };

  const input = document.getElementById(id);
  const field = input?.closest("[data-location-role]");
  const role = field?.dataset.locationRole || "stop";
  const stopKey = field?.dataset.stopId || id;
  return {
    role,
    inputId: id,
    stopId: role === "stop" ? `stop-${stopKey}` : undefined,
  };
}

function placeLocationCue(inputId, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const meta = resolveLocationMeta(inputId);
  setLocationCue(meta.role, lat, lng, { stopId: meta.stopId });
  // Phase 14: every confirmed coordinate feeds the routing engine.
  setRoutePoint(meta.role, lat, lng);
}

async function nominatimGet(path, params) {
  const url = new URL(path, NOMINATIM);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  });

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Language": document.documentElement.lang || "en",
    },
  });
  if (!res.ok) throw new Error(`NOMINATIM_${res.status}`);
  return res.json();
}

export async function reverseGeocode(lat, lng) {
  const data = await nominatimGet("/reverse", {
    format: "jsonv2",
    lat,
    lon: lng,
    zoom: 18,
    addressdetails: 1,
  });
  return {
    label: formatPlace(data) || `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`,
    lat: Number(data.lat || lat),
    lng: Number(data.lon || lng),
    raw: data,
  };
}

export async function searchPlaces(query, limit = 5) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const rows = await nominatimGet("/search", {
    format: "jsonv2",
    q,
    limit,
    addressdetails: 1,
    countrycodes: "pk",
  });
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    label: formatPlace(row),
    lat: Number(row.lat),
    lng: Number(row.lon),
    raw: row,
  }));
}

function hideSuggestions() {
  if (!els.suggest) return;
  els.suggest.hidden = true;
  els.suggest.innerHTML = "";
  suggestAnchor = null;
}

function positionSuggestions(anchor) {
  if (!els.suggest || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const app = document.getElementById("app");
  const appRect = app?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth };
  const width = Math.min(Math.max(rect.width, 220), appRect.width - 16);
  let left = rect.left - appRect.left;
  left = Math.max(8, Math.min(left, appRect.width - width - 8));
  els.suggest.style.width = `${width}px`;
  els.suggest.style.left = `${left}px`;
  els.suggest.style.top = `${rect.bottom - appRect.top + 6}px`;
}

function showSuggestions(anchor, places) {
  if (!els.suggest) return;
  suggestAnchor = anchor;
  if (!places.length) {
    hideSuggestions();
    return;
  }

  els.suggest.innerHTML = places
    .map(
      (place, index) => `
      <button type="button" class="loc-suggest__item" role="option" data-suggest-index="${index}">
        <span class="loc-suggest__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 21s7-6.1 7-12A7 7 0 1 0 5 9c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/>
          </svg>
        </span>
        <span class="loc-suggest__text">${escapeHtml(place.label)}</span>
      </button>`
    )
    .join("");

  els.suggest.hidden = false;
  positionSuggestions(anchor);

  els.suggest.querySelectorAll("[data-suggest-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const place = places[Number(btn.dataset.suggestIndex)];
      if (!place || !suggestAnchor) return;
      const inputId = suggestAnchor.id === "searchInput" ? "destInput" : suggestAnchor.id;
      setLocationFieldValue(inputId, place.label, { autoExpand: true });
      if (suggestAnchor.id === "searchInput") suggestAnchor.value = place.label;
      hideSuggestions();
      if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
        ensureMap?.();
        placeLocationCue(inputId, place.lat, place.lng);
        flyToLatLng(place.lat, place.lng, 16);
      }
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scheduleSearch(anchor, query) {
  window.clearTimeout(searchTimer);
  const seq = ++searchSeq;
  searchTimer = window.setTimeout(async () => {
    try {
      const places = await searchPlaces(query, 5);
      if (seq !== searchSeq) return;
      showSuggestions(anchor, places);
    } catch (err) {
      console.warn("[SwiftGo] place search", err);
      if (seq === searchSeq) hideSuggestions();
    }
  }, 380);
}

function isLocationSearchInput(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  return (
    el.id === "pickupInput" ||
    el.id === "destInput" ||
    el.id === "searchInput" ||
    el.classList.contains("stop-input")
  );
}

/**
 * Phase 12.3 — extract lat/lng from common Google Maps share/search URLs.
 * Supports:
 *  - .../maps?q=24.86,67.00
 *  - .../maps/@24.86,67.00,15z
 *  - .../maps/place/.../@24.86,67.00,17z
 *  - .../maps/search/?api=1&query=24.86%2C67.00
 *  - ...!3d24.86!4d67.00
 * Short goo.gl / maps.app.goo.gl links cannot yield coords client-side without a redirect fetch.
 *
 * @param {string} text
 * @param {{ allowBare?: boolean }} [opts]
 * @returns {{ lat: number, lng: number } | null}
 */
export function parseGoogleMapsCoords(text, opts = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const looksLikeMaps =
    /(?:google\.com\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(raw) ||
    (/^https?:\/\//i.test(raw) && /[?&](?:q|query)=/i.test(raw));

  if (!looksLikeMaps) {
    if (opts.allowBare) {
      const bare = raw.match(
        /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
      );
      if (bare) {
        const lat = Number(bare[1]);
        const lng = Number(bare[2]);
        if (isValidLatLng(lat, lng)) return { lat, lng };
      }
    }
    return null;
  }

  const patterns = [
    /[?&](?:q|query)=(-?\d{1,2}(?:\.\d+)?)%2C(-?\d{1,3}(?:\.\d+)?)/i,
    /[?&](?:q|query)=(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i,
    /@(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)(?:,\d+(?:\.\d+)?z)?/i,
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    /\/maps\/(?:place|dir|search)\/[^@]*?(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
  ];

  for (const re of patterns) {
    const match = raw.match(re);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

let applyingMapsLink = false;

async function applyCoordsToInput(input, coords) {
  if (applyingMapsLink) return;
  applyingMapsLink = true;
  try {
    const inputId = input.id === "searchInput" ? "destInput" : input.id;
    ensureMap?.();
    navigateHome?.();
    hideSuggestions();
    placeLocationCue(inputId, coords.lat, coords.lng);
    flyToLatLng(coords.lat, coords.lng, 17);

    const fallback = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
    setLocationFieldValue(inputId, fallback, { autoExpand: true });
    if (input.id === "searchInput") input.value = fallback;

    try {
      const place = await reverseGeocode(coords.lat, coords.lng);
      setLocationFieldValue(inputId, place.label, { autoExpand: true });
      if (input.id === "searchInput") input.value = place.label;
    } catch (err) {
      console.warn("[SwiftGo] maps-link reverse geocode", err);
    }
  } finally {
    applyingMapsLink = false;
  }
}

function bindSmartLinkPaste() {
  document.addEventListener("paste", (event) => {
    const input = event.target;
    if (!isLocationSearchInput(input)) return;

    const pasted =
      event.clipboardData?.getData("text") ||
      event.clipboardData?.getData("text/plain") ||
      "";
    const coords = parseGoogleMapsCoords(pasted, { allowBare: true });
    if (!coords) return;

    event.preventDefault();
    applyCoordsToInput(input, coords);
  });

  // Fallback when paste is not interceptable but the field ends up with a Maps URL
  document.addEventListener("input", (event) => {
    if (applyingMapsLink) return;
    const input = event.target;
    if (!isLocationSearchInput(input)) return;
    const coords = parseGoogleMapsCoords(input.value, { allowBare: false });
    if (!coords) return;
    applyCoordsToInput(input, coords);
  });
}

function bindAutocomplete() {
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!isLocationSearchInput(input)) return;
    if (document.body.classList.contains("map-pick-active")) return;
    if (applyingMapsLink) return;
    // Skip autocomplete while a maps URL is being resolved
    if (parseGoogleMapsCoords(input.value, { allowBare: false })) return;
    const q = input.value.trim();
    if (q.length < 2) {
      hideSuggestions();
      return;
    }
    scheduleSearch(input, q);
  });

  document.addEventListener("focusin", (event) => {
    const input = event.target;
    if (!isLocationSearchInput(input)) return;
    if (parseGoogleMapsCoords(input.value, { allowBare: false })) return;
    if (input.value.trim().length >= 2) scheduleSearch(input, input.value.trim());
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("#locSuggest") || event.target.closest(".loc-field__input, #searchInput")) {
      return;
    }
    hideSuggestions();
  });

  window.addEventListener("resize", () => {
    if (suggestAnchor && !els.suggest?.hidden) positionSuggestions(suggestAnchor);
  });
}

async function updatePickPreview(center) {
  if (!center || !els.address) return;
  const seq = ++reverseSeq;
  els.address.textContent = t("mapPickSearching");
  try {
    const place = await reverseGeocode(center.lat, center.lng);
    if (seq !== reverseSeq) return;
    pickPreviewLabel = place.label;
    pickCoords = { lat: place.lat, lng: place.lng };
    els.address.textContent = place.label;
    if (activeInputId) {
      setLocationFieldValue(activeInputId, place.label, { autoExpand: false });
    }
  } catch (err) {
    console.warn("[SwiftGo] reverse geocode", err);
    if (seq !== reverseSeq) return;
    pickPreviewLabel = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
    pickCoords = center;
    els.address.textContent = pickPreviewLabel;
  }
}

function exitMapPickMode({ restore = false } = {}) {
  unsubMoveEnd();
  unsubMoveEnd = () => {};
  setMapPickMode(false);
  if (els.overlay) {
    els.overlay.hidden = true;
    els.overlay.setAttribute("aria-hidden", "true");
  }

  if (restore && activeInputId) {
    setLocationFieldValue(activeInputId, pickPreviousValue, { autoExpand: false });
  }

  activeInputId = null;
  pickPreviousValue = "";
  pickPreviewLabel = "";
  pickCoords = null;
  expandSheet();
  resizeMap();
}

function enterMapPickMode({ inputId, role }) {
  if (!inputId) return;
  ensureMap?.();
  navigateHome?.();
  hideSuggestions();
  collapseSheet();

  activeInputId = inputId;
  pickPreviousValue = getLocationFieldValue(inputId);
  pickPreviewLabel = pickPreviousValue;
  setMapPickMode(true);

  if (els.overlay) {
    els.overlay.hidden = false;
    els.overlay.setAttribute("aria-hidden", "false");
  }
  if (els.eyebrow) els.eyebrow.textContent = roleLabel(role);
  if (els.address) {
    els.address.textContent = pickPreviousValue || t("mapPickSearching");
  }

  applyTranslations(els.overlay || document);
  if (els.eyebrow) els.eyebrow.textContent = roleLabel(role);

  unsubMoveEnd();
  unsubMoveEnd = onMapMoveEnd((center) => {
    updatePickPreview(center);
  });

  const center = getMapCenter();
  if (center) updatePickPreview(center);
  resizeMap();
}

async function useLiveGps({ inputId }) {
  if (!inputId) return;
  ensureMap?.();
  navigateHome?.();
  hideSuggestions();

  const pos = await locateUser({ fly: true });
  if (!pos) return;

  placeLocationCue(inputId, pos.lat, pos.lng);

  try {
    const place = await reverseGeocode(pos.lat, pos.lng);
    setLocationFieldValue(inputId, place.label, { autoExpand: true });
  } catch (err) {
    console.warn("[SwiftGo] gps reverse geocode", err);
    setLocationFieldValue(inputId, t("currentLocation"), { autoExpand: true });
  }
}

function onLocationAction(event) {
  const { action, role, inputId } = event.detail || {};
  if (!inputId) return;

  if (action === "gps") {
    useLiveGps({ inputId, role });
    return;
  }

  if (action === "map") {
    enterMapPickMode({ inputId, role });
  }
}

export function refreshLocationLabels() {
  applyTranslations(els.overlay || document.getElementById("mapPickOverlay") || document);
  if (activeInputId && els.eyebrow) {
    const field = document.querySelector(`[data-location-target="${activeInputId}"]`)?.closest("[data-location-role]");
    els.eyebrow.textContent = roleLabel(field?.dataset.locationRole || "stop");
  }
}

export function initLocationModule(handlers = {}) {
  cacheEls();
  ensureMap = handlers.ensureMap || null;
  navigateHome = handlers.navigateHome || null;

  bindAutocomplete();
  bindSmartLinkPaste();
  document.addEventListener("swiftgo:location-action", onLocationAction);

  els.cancel?.addEventListener("click", () => exitMapPickMode({ restore: true }));
  els.confirm?.addEventListener("click", () => {
    if (activeInputId && pickPreviewLabel) {
      setLocationFieldValue(activeInputId, pickPreviewLabel, { autoExpand: true });
      if (pickCoords) {
        placeLocationCue(activeInputId, pickCoords.lat, pickCoords.lng);
        flyToLatLng(pickCoords.lat, pickCoords.lng, 16);
      }
    }
    exitMapPickMode({ restore: false });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("map-pick-active")) {
      exitMapPickMode({ restore: true });
    }
  });
}
