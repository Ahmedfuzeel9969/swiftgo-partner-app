/**
 * Phase 12.2 / 44 / 45.2 — map pick, reverse geocode, autocomplete,
 * Google Maps URLs, bare coordinates, and Plus Codes.
 */

import { t, applyTranslations, getLang } from "./i18n.js";
import {
  locateUser,
  getMapCenter,
  flyToLatLng,
  onMapMoveEnd,
  onMapDragStart,
  setMapPickMode,
  resizeMap,
  setLocationCue,
  clearLocationCue,
} from "./map.js";
import {
  setLocationFieldValue,
  getLocationFieldValue,
  collapseSheet,
  expandSheet,
} from "./sheet.js";
import { setRoutePoint, clearRoutePoint, getRouteInfo } from "./routing.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OLC_ALPHABET = "23456789CFGHJMPQRVWX";

let ensureMap = null;
let navigateHome = null;
let activeInputId = null;
let pickPreviousValue = "";
let pickPreviewLabel = "";
let pickCoords = null;
let unsubMoveEnd = () => {};
let unsubDragStart = () => {};
let liveDragPending = false;
let voiceRecognition = null;
let searchTimer = null;
let searchSeq = 0;
let reverseSeq = 0;
let suggestAnchor = null;

const els = {};

function cacheEls() {
  els.pinMode = document.getElementById("mapPinMode");
  els.centerPin = document.getElementById("mapCenterPin");
  els.confirm = document.getElementById("mapPinConfirm");
  els.suggest = document.getElementById("locSuggest");
  els.swapBtn = document.getElementById("swapLocationsBtn");
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

/** Resolve pickup / dropoff / stop (+ stopId) from an input id. */
function resolveLocationMeta(inputId) {
  const id = inputId;
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
  const label = formatPlace(data);
  return {
    lat: parseFloat(data.lat) || lat,
    lng: parseFloat(data.lon) || lng,
    label: label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
  };
}

function hideSuggestions() {
  if (!els.suggest) return;
  els.suggest.hidden = true;
  els.suggest.replaceChildren();
  suggestAnchor = null;
}

function positionSuggestions(anchor) {
  if (!els.suggest || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  els.suggest.style.top = `${rect.bottom + 4}px`;
  els.suggest.style.left = `${rect.left}px`;
  els.suggest.style.width = `${rect.width}px`;
}

function renderSuggestions(items, anchor) {
  if (!els.suggest) return;
  els.suggest.replaceChildren();
  suggestAnchor = anchor;

  if (!items.length) {
    hideSuggestions();
    return;
  }

  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "loc-suggest__item";
    btn.textContent = formatPlace(item);
    btn.addEventListener("click", () => {
      const label = formatPlace(item);
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      setLocationFieldValue(anchor.id, label, { autoExpand: true });
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        placeLocationCue(anchor.id, lat, lng);
        flyToLatLng(lat, lng, 16);
      }
      hideSuggestions();
    });
    els.suggest.appendChild(btn);
  });

  positionSuggestions(anchor);
  els.suggest.hidden = false;
}

async function runSearch(input, query) {
  const seq = ++searchSeq;
  try {
    const data = await nominatimGet("/search", {
      format: "jsonv2",
      q: query,
      limit: 5,
      addressdetails: 0,
    });
    if (seq !== searchSeq || input !== document.activeElement) return;
    renderSuggestions(Array.isArray(data) ? data : [], input);
  } catch (err) {
    console.warn("[SwiftGo] search", err);
    hideSuggestions();
  }
}

function scheduleSearch(input, query) {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runSearch(input, query), 320);
}

function decodePlusCode(code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean.includes("+")) return null;
  const parts = clean.split("+");
  if (parts.length !== 2) return null;
  const area = parts[0];
  const local = parts[1].replace(/[^23456789CFGHJMPQRVWX]/gi, "");
  if (area.length < 4 || local.length < 2) return null;

  let lat = 0;
  let lng = 0;
  let placeValue = 0;
  for (let i = 0; i < area.length; i += 1) {
    const idx = OLC_ALPHABET.indexOf(area[i]);
    if (idx < 0) return null;
    placeValue = placeValue * 20 + idx;
  }
  lat = Math.floor(placeValue / 20) * 20;
  lng = (placeValue % 20) * 20;

  for (let i = 0; i < local.length; i += 1) {
    const idx = OLC_ALPHABET.indexOf(local[i]);
    if (idx < 0) return null;
    if (i % 2 === 0) lat = lat * 20 + Math.floor(idx / 5);
    else lng = lng * 20 + (idx % 5);
  }

  const precision = Math.pow(20, -Math.floor((area.length + local.length) / 2));
  return { lat: lat * precision - 90, lng: lng * precision - 180 };
}

function extractPlusCode(text) {
  const match = String(text || "").match(/\b[23456789CFGHJMPQRVWX]{4,6}\+[23456789CFGHJMPQRVWX]{2,3}(?:\s[\w.-]+)?\b/i);
  return match ? match[0].split(/\s/)[0].toUpperCase() : null;
}

export function parseGoogleMapsCoords(text, { allowBare = false } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const atMatch = raw.match(/@(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (atMatch) return { lat: parseFloat(atMatch[1]), lng: parseFloat(atMatch[2]) };

  const bangMatch = raw.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (bangMatch) return { lat: parseFloat(bangMatch[1]), lng: parseFloat(bangMatch[2]) };

  // Embedded JSON-ish center from Maps HTML / share payloads
  const centerMatch = raw.match(/"center"\s*:\s*\{\s*"lat"\s*:\s*(-?\d+\.?\d*)\s*,\s*"lng"\s*:\s*(-?\d+\.?\d*)/);
  if (centerMatch) return { lat: parseFloat(centerMatch[1]), lng: parseFloat(centerMatch[2]) };

  const qMatch = raw.match(/[?&](?:q|query|ll)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/i);
  if (qMatch) return { lat: parseFloat(qMatch[1]), lng: parseFloat(qMatch[2]) };

  const placeMatch = raw.match(/place\/[^/]+\/@(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (placeMatch) return { lat: parseFloat(placeMatch[1]), lng: parseFloat(placeMatch[2]) };

  const searchMatch = raw.match(/\/maps\/search\/\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (searchMatch) return { lat: parseFloat(searchMatch[1]), lng: parseFloat(searchMatch[2]) };

  const dirMatch = raw.match(/\/maps\/dir\/[^/]*\/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (dirMatch) return { lat: parseFloat(dirMatch[1]), lng: parseFloat(dirMatch[2]) };

  // data=!...!3dLAT!4dLNG anywhere
  const dataBang = raw.match(/data=.*?!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/i);
  if (dataBang) return { lat: parseFloat(dataBang[1]), lng: parseFloat(dataBang[2]) };

  if (allowBare) {
    const bare = raw.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (bare) {
      const lat = parseFloat(bare[1]);
      const lng = parseFloat(bare[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }

  const plus = extractPlusCode(raw);
  if (plus) return decodePlusCode(plus);

  return null;
}

function isMapsUrl(text) {
  return /(?:maps\.app\.goo\.gl|goo\.gl\/maps|google\.[^/\s]+\/maps|maps\.google\.|googleusercontent\.com\/maps)/i.test(
    String(text || "")
  );
}

function isMapsOrCoordPaste(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (parseGoogleMapsCoords(raw, { allowBare: true })) return true;
  if (extractPlusCode(raw)) return true;
  if (isMapsUrl(raw)) return true;
  return false;
}

function looksLikeAddressPaste(text) {
  const raw = String(text || "").trim();
  if (raw.length < 6) return false;
  if (/^https?:\/\//i.test(raw)) return isMapsUrl(raw);
  // Copied place text from Google Maps / maps apps
  return /[\p{L}\p{N}]/u.test(raw) && (/,/.test(raw) || /\s/.test(raw));
}

/** Pull a human place query out of a Maps URL when coords are missing. */
function extractPlaceQueryFromMapsUrl(text) {
  const raw = String(text || "").trim();
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const q = url.searchParams.get("q") || url.searchParams.get("query");
    if (q && !/^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/.test(q)) {
      return decodeURIComponent(q.replace(/\+/g, " ")).trim();
    }
  } catch {
    /* not a URL */
  }

  const placePath = raw.match(/\/maps\/place\/([^/@]+)/i);
  if (placePath?.[1]) {
    try {
      return decodeURIComponent(placePath[1].replace(/\+/g, " ")).trim();
    } catch {
      return placePath[1].replace(/\+/g, " ").trim();
    }
  }

  const searchPath = raw.match(/\/maps\/search\/([^/@]+)/i);
  if (searchPath?.[1] && !/^-?\d/.test(searchPath[1])) {
    try {
      return decodeURIComponent(searchPath[1].replace(/\+/g, " ")).trim();
    } catch {
      return searchPath[1].replace(/\+/g, " ").trim();
    }
  }

  return "";
}

async function forwardGeocode(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return null;
  try {
    const data = await nominatimGet("/search", {
      format: "jsonv2",
      q,
      limit: 1,
      addressdetails: 0,
    });
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) return null;
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, label: formatPlace(hit) };
  } catch (err) {
    console.warn("[SwiftGo] forward geocode", err);
    return null;
  }
}

/** Expand short Maps links via CORS-friendly proxies and scrape coords from HTML/URL. */
async function expandMapsUrlForCoords(url) {
  const targets = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  for (const endpoint of targets) {
    try {
      const res = await fetch(endpoint, { method: "GET" });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") || "";
      let blob = "";
      let finalUrl = url;

      if (contentType.includes("application/json")) {
        const json = await res.json();
        blob = String(json?.contents || json?.body || "");
        finalUrl = json?.status?.url || json?.url || url;
      } else {
        blob = await res.text();
      }

      const fromUrl = parseGoogleMapsCoords(finalUrl, { allowBare: true });
      if (fromUrl) return fromUrl;

      const fromBody = parseGoogleMapsCoords(blob, { allowBare: false });
      if (fromBody) return fromBody;

      // Absolute Google redirect URL buried in HTML
      const hrefMatch = blob.match(
        /https?:\/\/(?:www\.)?google\.[^"'\\\s]+\/maps[^"'\\\s]*/i
      );
      if (hrefMatch) {
        const fromHref = parseGoogleMapsCoords(hrefMatch[0], { allowBare: true });
        if (fromHref) return fromHref;
        const place = extractPlaceQueryFromMapsUrl(hrefMatch[0]);
        if (place) {
          const geo = await forwardGeocode(place);
          if (geo) return geo;
        }
      }
    } catch (err) {
      console.warn("[SwiftGo] expand maps url", err);
    }
  }
  return null;
}

/**
 * Resolve pasted Maps link / coords / address → { lat, lng, label? }.
 * Always returns coordinates when possible so the route polyline can draw.
 */
async function resolvePasteToCoords(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = parseGoogleMapsCoords(raw, { allowBare: true });
  if (direct) return direct;

  const plus = extractPlusCode(raw);
  if (plus) {
    const decoded = decodePlusCode(plus);
    if (decoded) return decoded;
  }

  if (isMapsUrl(raw)) {
    const expanded = await expandMapsUrlForCoords(raw);
    if (expanded) return expanded;

    const placeQuery = extractPlaceQueryFromMapsUrl(raw);
    if (placeQuery) {
      const geo = await forwardGeocode(placeQuery);
      if (geo) return geo;
    }
  }

  // Plain address text copied from Google Maps / elsewhere
  if (looksLikeAddressPaste(raw) && !/^https?:\/\//i.test(raw)) {
    return forwardGeocode(raw);
  }

  return null;
}

async function applyCoordsToInput(input, coords) {
  if (!input || !coords) return false;
  const lat = Number(coords.lat);
  const lng = Number(coords.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  // Pin + route point FIRST so polyline can build as soon as both ends exist.
  placeLocationCue(input.id, lat, lng);
  flyToLatLng(lat, lng, 16);

  if (coords.label) {
    setLocationFieldValue(input.id, coords.label, { autoExpand: true });
  } else {
    const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setLocationFieldValue(input.id, fallback, { autoExpand: true });
  }

  try {
    const place = await reverseGeocode(lat, lng);
    setLocationFieldValue(input.id, place.label, { autoExpand: true });
    placeLocationCue(input.id, place.lat, place.lng);
  } catch (err) {
    console.warn("[SwiftGo] paste reverse geocode", err);
  }
  return true;
}

function bindSmartLinkPaste() {
  document.addEventListener("paste", async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches("#pickupInput, #destInput, .stop-input")) return;

    const text = event.clipboardData?.getData("text") || "";
    if (!isMapsOrCoordPaste(text) && !looksLikeAddressPaste(text)) return;

    event.preventDefault();
    event.stopPropagation();

    const previous = input.value;
    input.value = t("mapPickSearching");
    input.classList.add("is-resolving");
    hideSuggestions();

    try {
      const coords = await resolvePasteToCoords(text);
      if (coords) {
        const ok = await applyCoordsToInput(input, coords);
        if (!ok) setLocationFieldValue(input.id, text.trim(), { autoExpand: false });
      } else {
        // Last resort: still try geocoding the raw paste so a route can form
        const geo = await forwardGeocode(text.trim());
        if (geo) {
          await applyCoordsToInput(input, geo);
        } else {
          setLocationFieldValue(input.id, text.trim(), { autoExpand: false });
        }
      }
    } catch (err) {
      console.warn("[SwiftGo] smart paste", err);
      input.value = previous;
    } finally {
      input.classList.remove("is-resolving");
    }
  });
}

/**
 * Phase 45.3 — swap pickup ↔ dropoff text and lat/lng state + map pins.
 */
export function swapPickupDropoff() {
  const pickupText = getLocationFieldValue("pickupInput");
  const dropoffText = getLocationFieldValue("destInput");
  const route = getRouteInfo();
  const pickupCoords = route.pickup ? { lat: route.pickup.lat, lng: route.pickup.lng } : null;
  const dropoffCoords = route.dropoff ? { lat: route.dropoff.lat, lng: route.dropoff.lng } : null;

  setLocationFieldValue("pickupInput", dropoffText, { autoExpand: false });
  setLocationFieldValue("destInput", pickupText, { autoExpand: false });

  if (dropoffCoords) {
    placeLocationCue("pickupInput", dropoffCoords.lat, dropoffCoords.lng);
  } else {
    clearLocationCue("pickup");
    clearRoutePoint("pickup");
  }

  if (pickupCoords) {
    placeLocationCue("destInput", pickupCoords.lat, pickupCoords.lng);
  } else {
    clearLocationCue("dropoff");
    clearRoutePoint("dropoff");
  }

  const focusId = dropoffText.trim() && !pickupText.trim() ? "pickupInput" : "destInput";
  document.getElementById(focusId)?.focus({ preventScroll: true });

  els.swapBtn?.classList.add("is-swapped");
  window.setTimeout(() => els.swapBtn?.classList.remove("is-swapped"), 280);
}

function bindSwapButton() {
  els.swapBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    swapPickupDropoff();
  });
}

function bindAutocomplete() {
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches("#pickupInput, #destInput, .stop-input")) return;

    hideSuggestions();
    if (parseGoogleMapsCoords(input.value, { allowBare: true }) || extractPlusCode(input.value)) {
      return;
    }
    if (input.value.trim().length >= 2) scheduleSearch(input, input.value.trim());
  });

  document.addEventListener("focusin", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches("#pickupInput, #destInput, .stop-input")) return;
    activeInputId = input.id;
    highlightActiveRow(input.id);
  });

  document.addEventListener("click", (event) => {
    if (
      event.target.closest("#locSuggest") ||
      event.target.closest("#pickupInput, #destInput, .stop-input")
    ) {
      return;
    }
    if (event.target.closest("#map, .map-pin-mode, .fab-locate, .map-layers, .map-layers-fab, .route-search, .route-trigger")) {
      return;
    }
    hideSuggestions();
  });

  window.addEventListener("resize", () => {
    if (suggestAnchor && !els.suggest?.hidden) positionSuggestions(suggestAnchor);
  });
}

function highlightActiveRow(inputId) {
  document.querySelectorAll(".route-search__row.is-active, .route-search__stop.is-active").forEach((el) => {
    el.classList.remove("is-active");
  });
  const input = document.getElementById(inputId);
  const row = input?.closest(".route-search__row, .route-search__stop");
  row?.classList.add("is-active");
}

function showPinMode(visible, { confirm = true } = {}) {
  if (els.pinMode) {
    els.pinMode.hidden = !visible;
    els.pinMode.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  if (els.centerPin) {
    els.centerPin.hidden = !visible;
    els.centerPin.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  if (els.confirm) {
    els.confirm.hidden = !visible || !confirm;
  }
}

function isLiveDragEnabled() {
  return (
    document.body.classList.contains("route-ui-search") &&
    !document.body.classList.contains("map-pick-active")
  );
}

function syncLiveDragPin() {
  const live = isLiveDragEnabled();
  document.body.classList.toggle("map-live-drag", live);
  if (live) {
    ensureMap?.();
    ensureMapPickListeners();
  }
  if (document.body.classList.contains("map-pick-active")) return;
  showPinMode(live, { confirm: false });
}

async function applyCenterToActiveInput(center) {
  if (!center) return;
  const inputId = activeInputId || "destInput";
  const seq = ++reverseSeq;
  try {
    const place = await reverseGeocode(center.lat, center.lng);
    if (seq !== reverseSeq) return;
    setLocationFieldValue(inputId, place.label, { autoExpand: false });
    placeLocationCue(inputId, place.lat, place.lng);
  } catch (err) {
    console.warn("[SwiftGo] live drag reverse geocode", err);
    if (seq !== reverseSeq) return;
    const fallback = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
    setLocationFieldValue(inputId, fallback, { autoExpand: false });
    placeLocationCue(inputId, center.lat, center.lng);
  }
}

function ensureMapPickListeners() {
  ensureMap?.();
  unsubMoveEnd();
  unsubDragStart();

  unsubDragStart = onMapDragStart(() => {
    if (!isLiveDragEnabled()) return;
    liveDragPending = true;
    hideSuggestions();
  });

  unsubMoveEnd = onMapMoveEnd((center) => {
    if (document.body.classList.contains("map-pick-active")) {
      updatePickPreview(center);
      return;
    }
    if (!liveDragPending || !isLiveDragEnabled()) return;
    liveDragPending = false;
    applyCenterToActiveInput(center);
  });
}

async function updatePickPreview(center) {
  if (!center) return;
  const seq = ++reverseSeq;
  try {
    const place = await reverseGeocode(center.lat, center.lng);
    if (seq !== reverseSeq) return;
    pickPreviewLabel = place.label;
    pickCoords = { lat: place.lat, lng: place.lng };
  } catch (err) {
    console.warn("[SwiftGo] reverse geocode", err);
    if (seq !== reverseSeq) return;
    pickPreviewLabel = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
    pickCoords = center;
  }
}

function notifyMapPick(active) {
  document.dispatchEvent(
    new CustomEvent("swiftgo:route-ui-map-pick", { detail: { active } })
  );
}

function exitMapPickMode({ restore = false } = {}) {
  setMapPickMode(false);
  document.body.classList.remove("map-live-drag");
  showPinMode(false);

  if (restore && activeInputId) {
    setLocationFieldValue(activeInputId, pickPreviousValue, { autoExpand: false });
  }

  pickPreviousValue = "";
  pickPreviewLabel = "";
  pickCoords = null;

  notifyMapPick(false);
  expandSheet();
  syncLiveDragPin();
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
  highlightActiveRow(inputId);
  setMapPickMode(true);
  ensureMapPickListeners();

  showPinMode(true, { confirm: true });
  notifyMapPick(true);

  const center = getMapCenter();
  if (center) updatePickPreview(center);
  resizeMap();
}

function startVoiceInput({ inputId }) {
  if (!inputId) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    window.alert(t("voiceUnsupported"));
    return;
  }

  const input = document.getElementById(inputId);
  const button = document.querySelector(
    `[data-location-action="voice"][data-location-target="${inputId}"]`
  );

  try {
    voiceRecognition?.abort?.();
  } catch {
    /* ignore */
  }

  const recognition = new SpeechRecognition();
  voiceRecognition = recognition;
  recognition.lang = getLang() === "ur" ? "ur-PK" : "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  button?.classList.add("is-listening");
  input?.classList.add("is-listening");

  recognition.onresult = async (event) => {
    const transcript = String(event.results?.[0]?.[0]?.transcript || "").trim();
    if (!transcript || !input) return;

    setLocationFieldValue(inputId, transcript, { autoExpand: false });
    input.classList.add("is-resolving");
    try {
      const geo = await forwardGeocode(transcript);
      if (geo) {
        await applyCoordsToInput(input, geo);
      } else {
        scheduleSearch(input, transcript);
      }
    } catch (err) {
      console.warn("[SwiftGo] voice geocode", err);
      scheduleSearch(input, transcript);
    } finally {
      input.classList.remove("is-resolving");
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") {
      console.warn("[SwiftGo] voice", event.error);
    }
  };

  recognition.onend = () => {
    button?.classList.remove("is-listening");
    input?.classList.remove("is-listening");
    if (voiceRecognition === recognition) voiceRecognition = null;
  };

  try {
    recognition.start();
  } catch (err) {
    console.warn("[SwiftGo] voice start", err);
    button?.classList.remove("is-listening");
    input?.classList.remove("is-listening");
  }
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
    setLocationFieldValue(
      inputId,
      `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`,
      { autoExpand: true }
    );
  }
}

function onLocationAction(event) {
  const { action, inputId } = event.detail || {};
  if (!inputId) return;

  if (action === "gps") {
    useLiveGps({ inputId });
    return;
  }

  if (action === "voice") {
    startVoiceInput({ inputId });
    return;
  }

  if (action === "map") {
    enterMapPickMode({ inputId });
  }
}

export function refreshLocationLabels() {
  applyTranslations(document.getElementById("mapPinMode") || document);
}

export function initLocationModule(handlers = {}) {
  cacheEls();
  ensureMap = handlers.ensureMap || null;
  navigateHome = handlers.navigateHome || null;

  bindAutocomplete();
  bindSmartLinkPaste();
  bindSwapButton();
  ensureMapPickListeners();
  document.addEventListener("swiftgo:location-action", onLocationAction);
  document.addEventListener("swiftgo:route-ui-state", () => {
    liveDragPending = false;
    syncLiveDragPin();
  });
  syncLiveDragPin();

  els.confirm?.addEventListener("click", async () => {
    const center = getMapCenter();
    if (activeInputId && center) {
      try {
        const place = await reverseGeocode(center.lat, center.lng);
        setLocationFieldValue(activeInputId, place.label, { autoExpand: true });
        placeLocationCue(activeInputId, place.lat, place.lng);
        flyToLatLng(place.lat, place.lng, 16);
      } catch {
        const fallback = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
        setLocationFieldValue(activeInputId, fallback, { autoExpand: true });
        placeLocationCue(activeInputId, center.lat, center.lng);
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
