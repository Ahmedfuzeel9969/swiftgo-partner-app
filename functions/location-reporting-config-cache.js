/**
 * In-memory cache for settings/locationReporting — avoids per-fix config reads.
 */
"use strict";

const {
  LOCATION_REPORTING_CONFIG_DOC_PATH,
  normalizeLocationReportingConfig,
} = require("./location-reporting-config.js");

const CACHE_TTL_MS = 60_000;

/** @type {{ config: object, fetchedAtMs: number } | null} */
let cache = null;

function isReportingActive(config) {
  const c = normalizeLocationReportingConfig(config);
  return c.enabled === true && c.uploadMode !== "disabled";
}

function shouldAggregateServerMirror(config) {
  const c = normalizeLocationReportingConfig(config);
  return isReportingActive(c) && c.collectFirebaseMetrics !== false;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 */
async function getCachedLocationReportingConfig(db) {
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) {
    return cache.config;
  }
  const snap = await db.doc(LOCATION_REPORTING_CONFIG_DOC_PATH).get();
  const config = normalizeLocationReportingConfig(snap.exists ? snap.data() : {});
  cache = { config, fetchedAtMs: now };
  return config;
}

function invalidateLocationReportingConfigCache() {
  cache = null;
}

module.exports = {
  CACHE_TTL_MS,
  getCachedLocationReportingConfig,
  invalidateLocationReportingConfigCache,
  isReportingActive,
  shouldAggregateServerMirror,
};
