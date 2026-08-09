/**
 * CJS mirror of shared/js/idle-publish-config.mjs for Cloud Functions.
 */
"use strict";

const IDLE_PUBLISH_DEFAULTS = Object.freeze({
  idleLocationIntervalMs: 4_000,
  idleLocationMoveMeters: 10,
});

const IDLE_PUBLISH_BOUNDS = Object.freeze({
  intervalMsMin: 4_000,
  intervalMsMax: 1_800_000,
  moveMetersMin: 10,
  moveMetersMax: 5_000,
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

function normalizeIdlePublishConfig(raw = {}) {
  let intervalMs = IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs;
  let moveMeters = IDLE_PUBLISH_DEFAULTS.idleLocationMoveMeters;

  if (raw.idleLocationIntervalMs != null) {
    if (
      isStrictIntegerInRange(
        raw.idleLocationIntervalMs,
        IDLE_PUBLISH_BOUNDS.intervalMsMin,
        IDLE_PUBLISH_BOUNDS.intervalMsMax
      )
    ) {
      intervalMs = raw.idleLocationIntervalMs;
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
      moveMeters = raw.idleLocationMoveMeters;
    }
  }

  return { idleLocationIntervalMs: intervalMs, idleLocationMoveMeters: moveMeters };
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

module.exports = {
  IDLE_PUBLISH_DEFAULTS,
  IDLE_PUBLISH_BOUNDS,
  normalizeIdlePublishConfig,
  validateIdleIntervalMsForCallable,
  validateIdleMoveMetersForCallable,
};
