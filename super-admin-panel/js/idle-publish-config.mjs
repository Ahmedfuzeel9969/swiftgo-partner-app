/**
 * Canonical idle Firebase checkpoint cost controls (Super Admin → settings/dispatch).
 * Synced to app js/ folders via build-hosting; mirrored in functions/idle-publish-config.js.
 */

export const IDLE_PUBLISH_DEFAULTS = Object.freeze({
  idleLocationIntervalMs: 4_000,
  idleLocationMoveMeters: 10,
});

/** Minimums match production default — controls may only reduce cost, not increase write rate. */
export const IDLE_PUBLISH_BOUNDS = Object.freeze({
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

/**
 * Runtime consumer normalization: missing or invalid → canonical defaults (4000 ms / 10 m).
 * Does not coerce strings or clamp out-of-range values to boundaries.
 */
export function normalizeIdlePublishConfig(raw = {}) {
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
