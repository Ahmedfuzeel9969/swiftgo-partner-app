/**
 * Phase 5 — along-route progress with jitter rejection (display-only).
 */

import { SNAP_DIAG } from "./route-projection.mjs";

/** Ignore minor backward jitter (metres). */
export const PROGRESS_JITTER_M = 12;
/** Reject absurd forward jump without route change (metres). */
export const PROGRESS_MAX_FORWARD_JUMP_M = 350;

/**
 * @param {{
 *   previousProgressM: number|null,
 *   nextProgressM: number,
 *   routeGeneration: number,
 *   previousGeneration: number|null,
 * }} input
 */
export function resolveRouteProgress(input = {}) {
  const next = Number(input.nextProgressM);
  if (!Number.isFinite(next) || next < 0) {
    return { accept: false, reason: "invalid_progress" };
  }
  const gen = Number(input.routeGeneration) || 0;
  const prevGen = input.previousGeneration;
  if (prevGen != null && gen !== prevGen) {
    return {
      accept: true,
      progressM: next,
      reset: true,
      reason: "generation_changed",
      diag: SNAP_DIAG.GENERATION_CHANGED,
    };
  }
  const prev = input.previousProgressM;
  if (prev == null || !Number.isFinite(prev)) {
    return { accept: true, progressM: next, reset: false, reason: "first" };
  }
  const delta = next - prev;
  if (delta >= -PROGRESS_JITTER_M) {
    // Allow small backward jitter by holding previous.
    if (delta < 0) {
      return {
        accept: true,
        progressM: prev,
        reset: false,
        reason: "jitter_hold",
        diag: SNAP_DIAG.JITTER_IGNORED,
      };
    }
    if (delta > PROGRESS_MAX_FORWARD_JUMP_M) {
      return { accept: false, reason: "implausible_forward_jump" };
    }
    return { accept: true, progressM: next, reset: false, reason: "forward" };
  }
  // Large backward — reject for display continuity (off-route/reroute handles genuines).
  return {
    accept: false,
    reason: "backward_rejected",
    diag: SNAP_DIAG.JITTER_IGNORED,
  };
}

/**
 * Mutable progress tracker.
 */
export function createRouteProgressTracker() {
  let progressM = null;
  let generation = null;

  return {
    reset(gen = null) {
      progressM = null;
      generation = gen;
    },
    apply(nextProgressM, routeGeneration) {
      const resolved = resolveRouteProgress({
        previousProgressM: progressM,
        nextProgressM,
        routeGeneration,
        previousGeneration: generation,
      });
      if (resolved.accept) {
        progressM = resolved.progressM;
        generation = routeGeneration;
      }
      return { ...resolved, progressM, generation };
    },
    getProgressM: () => progressM,
    getGeneration: () => generation,
  };
}
