/**
 * CJS mirror of shared/js/idle-publish-config.mjs for Cloud Functions.
 * Branch production defaults preserved (5 min / 200 m).
 */
"use strict";

const MATCHING_STALE_LOCATION_MS = 600_000;

const IDLE_PUBLISH_DEFAULTS = Object.freeze({
  idleLocationIntervalMs: 5 * 60_000,
  idleLocationMoveMeters: 200,
  idleMovementTriggerDisabled: false,
});

const IDLE_PUBLISH_BOUNDS = Object.freeze({
  intervalMsMin: 60_000,
  intervalMsMax: 300_000,
  moveMetersMin: 50,
  moveMetersMax: 5_000,
  highMoveWarningMeters: 500,
  diagnosticDurationMinutesMin: 1,
  diagnosticDurationMinutesMax: 30,
});

const IDLE_PUBLISH_PRESETS = Object.freeze({
  intervalSeconds: Object.freeze([60, 120, 180, 300]),
  moveMeters: Object.freeze([50, 100, 200, 500]),
});

const MAX_IDLE_INTERVAL_MS = IDLE_PUBLISH_BOUNDS.intervalMsMax;
const IDLE_DIAGNOSTIC_MAX_DURATION_MS = 30 * 60_000;

if (!(MAX_IDLE_INTERVAL_MS < MATCHING_STALE_LOCATION_MS)) {
  throw new Error("MAX_IDLE_INTERVAL_MS must stay below MATCHING_STALE_LOCATION_MS");
}

const IDLE_PUBLISH_CONFIG_KEYS = Object.freeze({
  intervalMs: "idleLocationIntervalMs",
  moveMeters: "idleLocationMoveMeters",
  movementTriggerDisabled: "idleMovementTriggerDisabled",
  diagnosticExpiresAt: "idleDiagnosticExpiresAt",
  diagnosticEnabledBy: "idleDiagnosticEnabledBy",
  diagnosticEnabledAt: "idleDiagnosticEnabledAt",
  diagnosticReason: "idleDiagnosticReason",
});

function isStrictIntegerInRange(value, min, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isStrictBoolean(value) {
  return value === true || value === false;
}

function parseFirestoreTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value.toDate === "function") {
      try {
        const ms = value.toDate().getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
      return value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
    }
    if (Number.isInteger(value._seconds) && Number.isInteger(value._nanoseconds)) {
      return value._seconds * 1000 + Math.floor(value._nanoseconds / 1_000_000);
    }
  }
  return null;
}

function safeDefaults() {
  return {
    idleLocationIntervalMs: IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs,
    idleLocationMoveMeters: IDLE_PUBLISH_DEFAULTS.idleLocationMoveMeters,
    idleMovementTriggerDisabled: false,
    idleDiagnosticExpiresAtMs: null,
  };
}

function getSafeIdlePublishConfig() {
  return safeDefaults();
}

function applyValidIntervalAndMove(base, raw) {
  if (raw.idleLocationIntervalMs != null) {
    if (
      isStrictIntegerInRange(
        raw.idleLocationIntervalMs,
        IDLE_PUBLISH_BOUNDS.intervalMsMin,
        IDLE_PUBLISH_BOUNDS.intervalMsMax
      )
    ) {
      base.idleLocationIntervalMs = raw.idleLocationIntervalMs;
    }
  }
  if (raw.idleLocationMoveMeters != null) {
    if (
      isStrictIntegerInRange(
        raw.idleLocationMoveMeters,
        IDLE_PUBLISH_BOUNDS.moveMetersMin,
        IDLE_PUBLISH_BOUNDS.moveMetersMax
      )
    ) {
      base.idleLocationMoveMeters = raw.idleLocationMoveMeters;
    }
  }
  return base;
}

function isDiagnosticStateInvalid(raw, nowMs) {
  if (raw.idleMovementTriggerDisabled !== true) return false;
  const expiresMs = parseFirestoreTimestampMs(raw.idleDiagnosticExpiresAt);
  return expiresMs == null || expiresMs <= nowMs;
}

function normalizeIdlePublishConfig(raw = {}, { nowMs = Date.now() } = {}) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return safeDefaults();
  if (isDiagnosticStateInvalid(raw, now)) return safeDefaults();
  const base = safeDefaults();
  applyValidIntervalAndMove(base, raw);
  if (raw.idleMovementTriggerDisabled === true) {
    const expiresMs = parseFirestoreTimestampMs(raw.idleDiagnosticExpiresAt);
    base.idleMovementTriggerDisabled = true;
    base.idleDiagnosticExpiresAtMs = expiresMs;
  }
  return base;
}

function resolveIdleIntervalMsForPolicy(value) {
  if (
    isStrictIntegerInRange(
      value,
      IDLE_PUBLISH_BOUNDS.intervalMsMin,
      IDLE_PUBLISH_BOUNDS.intervalMsMax
    )
  ) {
    return value;
  }
  return IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs;
}

function resolveIdleMoveMetersForPolicy(value) {
  if (
    isStrictIntegerInRange(
      value,
      IDLE_PUBLISH_BOUNDS.moveMetersMin,
      IDLE_PUBLISH_BOUNDS.moveMetersMax
    )
  ) {
    return value;
  }
  return IDLE_PUBLISH_DEFAULTS.idleLocationMoveMeters;
}

function validateIdleIntervalMsForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.intervalMsMin,
    IDLE_PUBLISH_BOUNDS.intervalMsMax
  );
}

function validateIdleMoveMetersForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.moveMetersMin,
    IDLE_PUBLISH_BOUNDS.moveMetersMax
  );
}

function validateIdleMovementTriggerDisabledForCallable(value) {
  return isStrictBoolean(value);
}

function validateDiagnosticDurationMinutesForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.diagnosticDurationMinutesMin,
    IDLE_PUBLISH_BOUNDS.diagnosticDurationMinutesMax
  );
}

function rejectClientDiagnosticExpiry(value) {
  return value != null;
}

function sanitizeDiagnosticReason(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 80);
  return trimmed || null;
}

function isIdleMovementPublishEnabled(config = {}) {
  return config.idleMovementTriggerDisabled !== true;
}

function isLocationFreshForMatching(lastWriteMs, nowMs = Date.now(), staleMs = MATCHING_STALE_LOCATION_MS) {
  if (!Number.isFinite(lastWriteMs) || lastWriteMs <= 0) return false;
  return nowMs - lastWriteMs < staleMs;
}

function maxSafeIdleIntervalMs(staleMs = MATCHING_STALE_LOCATION_MS) {
  return MAX_IDLE_INTERVAL_MS < staleMs;
}

module.exports = {
  MATCHING_STALE_LOCATION_MS,
  IDLE_PUBLISH_DEFAULTS,
  IDLE_PUBLISH_BOUNDS,
  IDLE_PUBLISH_PRESETS,
  MAX_IDLE_INTERVAL_MS,
  IDLE_DIAGNOSTIC_MAX_DURATION_MS,
  IDLE_PUBLISH_CONFIG_KEYS,
  parseFirestoreTimestampMs,
  getSafeIdlePublishConfig,
  normalizeIdlePublishConfig,
  resolveIdleIntervalMsForPolicy,
  resolveIdleMoveMetersForPolicy,
  validateIdleIntervalMsForCallable,
  validateIdleMoveMetersForCallable,
  validateIdleMovementTriggerDisabledForCallable,
  validateDiagnosticDurationMinutesForCallable,
  rejectClientDiagnosticExpiry,
  sanitizeDiagnosticReason,
  isIdleMovementPublishEnabled,
  isLocationFreshForMatching,
  maxSafeIdleIntervalMs,
};
