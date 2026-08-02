/**
 * Phase 5 hardening — display marker heading (display-only).
 * Prefer route tangent after confident snap; never aim at pickup/dropoff.
 */

import { angleDeltaDeg } from "./route-projection.mjs";
import { lerpHeadingDeg } from "./route-motion-controller.mjs";

export const HEADING_MIN_SPEED_MPS = 1.5;
export const HEADING_MAX_ACCURACY_M = 45;
export const HEADING_STATIONARY_DELTA_DEG = 8;

/**
 * @param {{
 *   mode: "snap"|"raw",
 *   routeBearingDeg?: number|null,
 *   gpsHeadingDeg?: number|null,
 *   speedMps?: number|null,
 *   accuracyM?: number|null,
 *   previousHeadingDeg?: number|null,
 * }} input
 * @returns {{ headingDeg: number|null, reason: string }}
 */
export function resolveDisplayHeading(input = {}) {
  const prev = Number.isFinite(input.previousHeadingDeg) ? input.previousHeadingDeg : null;
  const mode = input.mode === "snap" ? "snap" : "raw";

  if (mode === "snap") {
    const route = Number(input.routeBearingDeg);
    if (Number.isFinite(route)) {
      return { headingDeg: ((route % 360) + 360) % 360, reason: "route_tangent" };
    }
    return { headingDeg: prev, reason: "preserve_previous" };
  }

  const speed = Number(input.speedMps);
  const gps = Number(input.gpsHeadingDeg);
  const accuracy = Number(input.accuracyM);
  const speedOk = Number.isFinite(speed) && speed >= HEADING_MIN_SPEED_MPS;
  const accuracyOk = !Number.isFinite(accuracy) || accuracy <= HEADING_MAX_ACCURACY_M;
  if (speedOk && accuracyOk && Number.isFinite(gps)) {
    const next = ((gps % 360) + 360) % 360;
    if (prev != null) {
      const d = angleDeltaDeg(prev, next);
      if (d != null && d < HEADING_STATIONARY_DELTA_DEG && speed < HEADING_MIN_SPEED_MPS * 1.2) {
        return { headingDeg: prev, reason: "hold_near_stationary" };
      }
    }
    return { headingDeg: next, reason: "gps_heading" };
  }

  return { headingDeg: prev, reason: "preserve_previous" };
}

/**
 * Smooth shortest-path rotation for marker CSS/icon updates.
 */
export function smoothHeadingToward(fromDeg, toDeg, t = 1) {
  if (!Number.isFinite(toDeg)) return Number.isFinite(fromDeg) ? fromDeg : null;
  if (!Number.isFinite(fromDeg)) return toDeg;
  return lerpHeadingDeg(fromDeg, toDeg, Math.max(0, Math.min(1, t)));
}

export { lerpHeadingDeg, angleDeltaDeg };
