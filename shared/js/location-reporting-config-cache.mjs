/**
 * Client-side cache for settings/locationReporting (no per-fix Firestore reads).
 */

import {
  LOCATION_REPORTING_CONFIG_DOC_PATH,
  LOCATION_REPORTING_DEFAULTS,
  normalizeLocationReportingConfig,
} from "./location-reporting-config.mjs";

export const LOCATION_REPORTING_CLIENT_CACHE_TTL_MS = 5 * 60_000;
const CACHE_KEY = "swiftgo_location_reporting_cfg:v1";

/** Upload modes implemented in client/server for Task 7A. */
export const LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED = Object.freeze(["ride_end", "disabled"]);

let memoryCache = null;

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isUploadModeImplemented(mode) {
  return LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED.includes(mode);
}

export function isReportingActive(config) {
  const c = normalizeLocationReportingConfig(config);
  return c.enabled === true && c.uploadMode !== "disabled" && isUploadModeImplemented(c.uploadMode);
}

export function shouldCollectDriverMetrics(config) {
  return isReportingActive(config) && normalizeLocationReportingConfig(config).collectDriverMetrics !== false;
}

export function shouldCollectCustomerMetrics(config) {
  return isReportingActive(config) && normalizeLocationReportingConfig(config).collectCustomerMetrics !== false;
}

export function shouldCollectFirebaseMetrics(config) {
  return isReportingActive(config) && normalizeLocationReportingConfig(config).collectFirebaseMetrics !== false;
}

export function shouldCollectP2pMetrics(config) {
  return isReportingActive(config) && normalizeLocationReportingConfig(config).collectP2pMetrics !== false;
}

/**
 * @param {object} [storage]
 * @param {number} [nowMs]
 */
export function readCachedLocationReportingConfig(storage, nowMs = Date.now()) {
  if (memoryCache && nowMs - memoryCache.fetchedAtMs < LOCATION_REPORTING_CLIENT_CACHE_TTL_MS) {
    return memoryCache.config;
  }
  const parsed = safeParse(storage?.getItem?.(CACHE_KEY));
  if (
    parsed?.config &&
    typeof parsed.fetchedAtMs === "number" &&
    nowMs - parsed.fetchedAtMs < LOCATION_REPORTING_CLIENT_CACHE_TTL_MS
  ) {
    memoryCache = { config: normalizeLocationReportingConfig(parsed.config), fetchedAtMs: parsed.fetchedAtMs };
    return memoryCache.config;
  }
  return normalizeLocationReportingConfig(LOCATION_REPORTING_DEFAULTS);
}

/**
 * @param {object} config
 * @param {object} [storage]
 * @param {number} [nowMs]
 */
export function writeCachedLocationReportingConfig(config, storage, nowMs = Date.now()) {
  const normalized = normalizeLocationReportingConfig(config);
  memoryCache = { config: normalized, fetchedAtMs: nowMs };
  storage?.setItem?.(CACHE_KEY, JSON.stringify({ config: normalized, fetchedAtMs: nowMs }));
  return normalized;
}

/**
 * Fetch config once from Firestore and cache it.
 * @param {() => { ready?: boolean, db?: object }} getFirebase
 * @param {object} [storage]
 */
export async function refreshLocationReportingConfigFromFirestore(getFirebase, storage) {
  const { ready, db } = getFirebase?.() || {};
  if (!ready || !db) {
    return readCachedLocationReportingConfig(storage);
  }
  try {
    const { doc, getDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
    );
    const snap = await getDoc(doc(db, LOCATION_REPORTING_CONFIG_DOC_PATH));
    const raw = snap.exists() ? snap.data() : {};
    return writeCachedLocationReportingConfig(raw, storage);
  } catch {
    return readCachedLocationReportingConfig(storage);
  }
}

export function invalidateLocationReportingConfigCache(storage) {
  memoryCache = null;
  storage?.removeItem?.(CACHE_KEY);
}
