/**
 * Canonical idle Firebase checkpoint cost controls (Super Admin → settings/dispatch).
 * Synced to app js/ folders via build-hosting; mirrored in functions/idle-publish-config.js.
 */

/** Mirror of functions/matching.js STALE_LOCATION_MS — driver must heartbeat before this. */
export const MATCHING_STALE_LOCATION_MS = 600_000;

export const IDLE_PUBLISH_DEFAULTS = Object.freeze({
  idleLocationIntervalMs: 4_000,
  idleLocationMoveMeters: 10,
  idleMovementTriggerDisabled: false,
});

/** Minimums match production default — controls may only reduce cost, not increase write rate. */
export const IDLE_PUBLISH_BOUNDS = Object.freeze({
  intervalMsMin: 4_000,
  intervalMsMax: 300_000,
  moveMetersMin: 10,
  moveMetersMax: 5_000,
  highMoveWarningMeters: 100,
  diagnosticDurationMinutesMin: 1,
  diagnosticDurationMinutesMax: 30,
});

/** Recommended Super Admin UI presets (normal mode). */
export const IDLE_PUBLISH_PRESETS = Object.freeze({
  intervalSeconds: Object.freeze([4, 10, 30, 60]),
  moveMeters: Object.freeze([10, 25, 50, 100]),
});

export const MAX_IDLE_INTERVAL_MS = IDLE_PUBLISH_BOUNDS.intervalMsMax;
export const IDLE_DIAGNOSTIC_MAX_DURATION_MS = 30 * 60_000;

if (!(MAX_IDLE_INTERVAL_MS < MATCHING_STALE_LOCATION_MS)) {
  throw new Error("MAX_IDLE_INTERVAL_MS must stay below MATCHING_STALE_LOCATION_MS");
}

export const IDLE_PUBLISH_CONFIG_KEYS = Object.freeze({
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

/**
 * Parse Firestore Timestamp / Date / epoch ms without Number() coercion on strings.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseFirestoreTimestampMs(value) {
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

/** Canonical fail-closed runtime config (4000 ms / 10 m / movement enabled). */
export function getSafeIdlePublishConfig() {
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

/**
 * Runtime consumer normalization: missing or invalid → canonical defaults (4000 ms / 10 m / movement enabled).
 * Expired or malformed diagnostic state fails closed to full safe defaults (interval/move reset too).
 * Does not coerce strings or clamp out-of-range values to boundaries.
 * @param {Record<string, unknown>} [raw]
 * @param {{ nowMs?: number }} [opts]
 */
export function normalizeIdlePublishConfig(raw = {}, { nowMs = Date.now() } = {}) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return safeDefaults();

  if (isDiagnosticStateInvalid(raw, now)) {
    return safeDefaults();
  }

  const base = safeDefaults();
  applyValidIntervalAndMove(base, raw);

  if (raw.idleMovementTriggerDisabled === true) {
    const expiresMs = parseFirestoreTimestampMs(raw.idleDiagnosticExpiresAt);
    base.idleMovementTriggerDisabled = true;
    base.idleDiagnosticExpiresAtMs = expiresMs;
  }

  return base;
}

/** Runtime policy resolver: strict idle interval only — no Number() coercion. */
export function resolveIdleIntervalMsForPolicy(value) {
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

/** Runtime policy resolver: strict idle move threshold only — no Number() coercion. */
export function resolveIdleMoveMetersForPolicy(value) {
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

/** Callable validation when idleLocationIntervalMs is explicitly provided. */
export function validateIdleIntervalMsForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.intervalMsMin,
    IDLE_PUBLISH_BOUNDS.intervalMsMax
  );
}

/** Callable validation when idleLocationMoveMeters is explicitly provided. */
export function validateIdleMoveMetersForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.moveMetersMin,
    IDLE_PUBLISH_BOUNDS.moveMetersMax
  );
}

export function validateIdleMovementTriggerDisabledForCallable(value) {
  return isStrictBoolean(value);
}

export function validateDiagnosticDurationMinutesForCallable(value) {
  return isStrictIntegerInRange(
    value,
    IDLE_PUBLISH_BOUNDS.diagnosticDurationMinutesMin,
    IDLE_PUBLISH_BOUNDS.diagnosticDurationMinutesMax
  );
}

/** Reject client-supplied expiry timestamps — server computes expiry only. */
export function rejectClientDiagnosticExpiry(value) {
  return value != null;
}

/**
 * Sanitize bounded diagnostic reason note (no PII; max 80 chars).
 * @param {unknown} value
 */
export function sanitizeDiagnosticReason(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 80);
  return trimmed || null;
}

/** Whether movement alone may trigger an idle publish. */
export function isIdleMovementPublishEnabled(config = {}) {
  return config.idleMovementTriggerDisabled !== true;
}

/** Location remains matchable if last write age stays below stale threshold. */
export function isLocationFreshForMatching(lastWriteMs, nowMs = Date.now(), staleMs = MATCHING_STALE_LOCATION_MS) {
  if (!Number.isFinite(lastWriteMs) || lastWriteMs <= 0) return false;
  return nowMs - lastWriteMs < staleMs;
}

/** Next mandatory heartbeat must occur before matching stale cutoff. */
export function maxSafeIdleIntervalMs(staleMs = MATCHING_STALE_LOCATION_MS) {
  return MAX_IDLE_INTERVAL_MS < staleMs;
}
