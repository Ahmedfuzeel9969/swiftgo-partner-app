/**
 * CJS mirror of shared/js/location-reporting-config.mjs for Cloud Functions.
 */
"use strict";

const LOCATION_REPORTING_SCHEMA_VERSION = 1;

const LOCATION_REPORTING_UPLOAD_MODES = Object.freeze([
  "ride_end",
  "periodic_and_ride_end",
  "anomaly_and_ride_end",
  "disabled",
]);

const LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED = Object.freeze(["ride_end", "disabled"]);

const LOCATION_REPORTING_DEFAULTS = Object.freeze({
  enabled: true,
  uploadMode: "ride_end",
  periodicIntervalMinutes: 10,
  uploadOnAnomaly: false,
  finalUploadRequired: true,
  collectDriverMetrics: true,
  collectCustomerMetrics: true,
  collectFirebaseMetrics: true,
  collectP2pMetrics: true,
  retentionDays: 30,
});

const LOCATION_REPORTING_BOUNDS = Object.freeze({
  periodicIntervalMinutesMin: 5,
  periodicIntervalMinutesMax: 60,
  retentionDaysMin: 7,
  retentionDaysMax: 90,
});

const LOCATION_REPORTING_CONFIG_DOC_PATH = "settings/locationReporting";

function isStrictBoolean(value) {
  return value === true || value === false;
}

function isStrictIntegerInRange(value, min, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isValidUploadMode(value) {
  return typeof value === "string" && LOCATION_REPORTING_UPLOAD_MODES.includes(value);
}

function safeDefaults() {
  return {
    enabled: LOCATION_REPORTING_DEFAULTS.enabled,
    uploadMode: LOCATION_REPORTING_DEFAULTS.uploadMode,
    periodicIntervalMinutes: LOCATION_REPORTING_DEFAULTS.periodicIntervalMinutes,
    uploadOnAnomaly: LOCATION_REPORTING_DEFAULTS.uploadOnAnomaly,
    finalUploadRequired: LOCATION_REPORTING_DEFAULTS.finalUploadRequired,
    collectDriverMetrics: LOCATION_REPORTING_DEFAULTS.collectDriverMetrics,
    collectCustomerMetrics: LOCATION_REPORTING_DEFAULTS.collectCustomerMetrics,
    collectFirebaseMetrics: LOCATION_REPORTING_DEFAULTS.collectFirebaseMetrics,
    collectP2pMetrics: LOCATION_REPORTING_DEFAULTS.collectP2pMetrics,
    retentionDays: LOCATION_REPORTING_DEFAULTS.retentionDays,
  };
}

function getSafeLocationReportingConfig() {
  return safeDefaults();
}

function applyBooleanField(base, raw, key) {
  if (raw[key] != null && isStrictBoolean(raw[key])) {
    base[key] = raw[key];
  }
}

function applyUploadMode(base, raw) {
  if (raw.uploadMode != null && isValidUploadMode(raw.uploadMode)) {
    base.uploadMode = raw.uploadMode;
  }
}

function applyPeriodicInterval(base, raw) {
  if (raw.periodicIntervalMinutes != null) {
    if (
      isStrictIntegerInRange(
        raw.periodicIntervalMinutes,
        LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMin,
        LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMax
      )
    ) {
      base.periodicIntervalMinutes = raw.periodicIntervalMinutes;
    }
  }
}

function applyRetentionDays(base, raw) {
  if (raw.retentionDays != null) {
    if (
      isStrictIntegerInRange(
        raw.retentionDays,
        LOCATION_REPORTING_BOUNDS.retentionDaysMin,
        LOCATION_REPORTING_BOUNDS.retentionDaysMax
      )
    ) {
      base.retentionDays = raw.retentionDays;
    }
  }
}

function normalizeLocationReportingConfig(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return safeDefaults();
  }

  const base = safeDefaults();
  applyBooleanField(base, raw, "enabled");
  applyUploadMode(base, raw);
  applyPeriodicInterval(base, raw);
  applyBooleanField(base, raw, "uploadOnAnomaly");
  applyBooleanField(base, raw, "finalUploadRequired");
  applyBooleanField(base, raw, "collectDriverMetrics");
  applyBooleanField(base, raw, "collectCustomerMetrics");
  applyBooleanField(base, raw, "collectFirebaseMetrics");
  applyBooleanField(base, raw, "collectP2pMetrics");
  applyRetentionDays(base, raw);

  if (base.uploadMode === "disabled") {
    base.enabled = false;
  }

  if (
    base.uploadMode === "periodic_and_ride_end" &&
    !isStrictIntegerInRange(
      base.periodicIntervalMinutes,
      LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMin,
      LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMax
    )
  ) {
    return safeDefaults();
  }

  return base;
}

function validateUploadModeForCallable(value) {
  return isValidUploadMode(value);
}

function validatePeriodicIntervalMinutesForCallable(value) {
  return isStrictIntegerInRange(
    value,
    LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMin,
    LOCATION_REPORTING_BOUNDS.periodicIntervalMinutesMax
  );
}

function validateRetentionDaysForCallable(value) {
  return isStrictIntegerInRange(
    value,
    LOCATION_REPORTING_BOUNDS.retentionDaysMin,
    LOCATION_REPORTING_BOUNDS.retentionDaysMax
  );
}

function validateEnabledForCallable(value) {
  return isStrictBoolean(value);
}

function validateFinalUploadRequiredForCallable(value) {
  return isStrictBoolean(value);
}

function validateCollectMetricsFlagForCallable(value) {
  return isStrictBoolean(value);
}

function validateUploadOnAnomalyForCallable(value) {
  return isStrictBoolean(value);
}

function requiresPeriodicInterval(uploadMode) {
  return uploadMode === "periodic_and_ride_end";
}

function isUploadModeImplemented(mode) {
  return LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED.includes(mode);
}

function isReportingActive(config) {
  const normalized = normalizeLocationReportingConfig(config);
  return (
    normalized.enabled === true &&
    normalized.uploadMode !== "disabled" &&
    isUploadModeImplemented(normalized.uploadMode)
  );
}

function buildLocationReportingConfigSnapshot(config = {}) {
  const normalized = normalizeLocationReportingConfig(config);
  return {
    enabled: normalized.enabled,
    uploadMode: normalized.uploadMode,
    retentionDays: normalized.retentionDays,
    collectDriverMetrics: normalized.collectDriverMetrics,
    collectCustomerMetrics: normalized.collectCustomerMetrics,
    collectFirebaseMetrics: normalized.collectFirebaseMetrics,
    collectP2pMetrics: normalized.collectP2pMetrics,
  };
}

function buildValidatedLocationReportingSettings(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("INVALID_PAYLOAD");
  }
  if (!validateEnabledForCallable(raw.enabled)) throw new Error("INVALID_ENABLED");
  if (!validateUploadModeForCallable(raw.uploadMode)) throw new Error("INVALID_UPLOAD_MODE");
  if (!isUploadModeImplemented(raw.uploadMode)) throw new Error("INVALID_UPLOAD_MODE_NOT_IMPLEMENTED");
  if (!validateUploadOnAnomalyForCallable(raw.uploadOnAnomaly)) {
    throw new Error("INVALID_UPLOAD_ON_ANOMALY");
  }
  if (!validateFinalUploadRequiredForCallable(raw.finalUploadRequired)) {
    throw new Error("INVALID_FINAL_UPLOAD_REQUIRED");
  }
  if (!validateCollectMetricsFlagForCallable(raw.collectDriverMetrics)) {
    throw new Error("INVALID_COLLECT_DRIVER_METRICS");
  }
  if (!validateCollectMetricsFlagForCallable(raw.collectCustomerMetrics)) {
    throw new Error("INVALID_COLLECT_CUSTOMER_METRICS");
  }
  if (!validateCollectMetricsFlagForCallable(raw.collectFirebaseMetrics)) {
    throw new Error("INVALID_COLLECT_FIREBASE_METRICS");
  }
  if (!validateCollectMetricsFlagForCallable(raw.collectP2pMetrics)) {
    throw new Error("INVALID_COLLECT_P2P_METRICS");
  }
  if (!validateRetentionDaysForCallable(raw.retentionDays)) throw new Error("INVALID_RETENTION_DAYS");

  if (requiresPeriodicInterval(raw.uploadMode)) {
    if (!validatePeriodicIntervalMinutesForCallable(raw.periodicIntervalMinutes)) {
      throw new Error("INVALID_PERIODIC_INTERVAL");
    }
  } else if (
    raw.periodicIntervalMinutes != null &&
    !validatePeriodicIntervalMinutesForCallable(raw.periodicIntervalMinutes)
  ) {
    throw new Error("INVALID_PERIODIC_INTERVAL");
  }

  return normalizeLocationReportingConfig({
    enabled: raw.enabled,
    uploadMode: raw.uploadMode,
    periodicIntervalMinutes:
      raw.periodicIntervalMinutes ?? LOCATION_REPORTING_DEFAULTS.periodicIntervalMinutes,
    uploadOnAnomaly: raw.uploadOnAnomaly,
    finalUploadRequired: raw.finalUploadRequired,
    collectDriverMetrics: raw.collectDriverMetrics,
    collectCustomerMetrics: raw.collectCustomerMetrics,
    collectFirebaseMetrics: raw.collectFirebaseMetrics,
    collectP2pMetrics: raw.collectP2pMetrics,
    retentionDays: raw.retentionDays,
  });
}

module.exports = {
  LOCATION_REPORTING_SCHEMA_VERSION,
  LOCATION_REPORTING_UPLOAD_MODES,
  LOCATION_REPORTING_UPLOAD_MODES_IMPLEMENTED,
  LOCATION_REPORTING_DEFAULTS,
  LOCATION_REPORTING_BOUNDS,
  LOCATION_REPORTING_CONFIG_DOC_PATH,
  getSafeLocationReportingConfig,
  normalizeLocationReportingConfig,
  validateUploadModeForCallable,
  validatePeriodicIntervalMinutesForCallable,
  validateRetentionDaysForCallable,
  validateEnabledForCallable,
  validateFinalUploadRequiredForCallable,
  validateCollectMetricsFlagForCallable,
  validateUploadOnAnomalyForCallable,
  requiresPeriodicInterval,
  isUploadModeImplemented,
  isReportingActive,
  buildLocationReportingConfigSnapshot,
  buildValidatedLocationReportingSettings,
};
