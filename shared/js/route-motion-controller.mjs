/**
 * Phase 5 — along-route display motion (RAF). Display-only; one loop.
 */

import { pointAtProgress } from "./route-projection.mjs";
import { SNAP_DIAG } from "./route-projection.mjs";

export const MOTION_MIN_MS = 400;
export const MOTION_MAX_MS = 8_000;

/**
 * @param {{
 *   onFrame?: (pos: {lat:number,lng:number,headingDeg:number|null,progressM:number}) => void,
 *   onDiag?: (code: string) => void,
 *   nowMs?: () => number,
 *   raf?: typeof requestAnimationFrame,
 *   caf?: typeof cancelAnimationFrame,
 * }} [opts]
 */
export function createRouteMotionController(opts = {}) {
  const onFrame = opts.onFrame || (() => {});
  const diag = opts.onDiag || (() => {});
  const nowMs = opts.nowMs || (() => Date.now());
  const raf =
    opts.raf ||
    (typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame.bind(globalThis)
      : (fn) => setTimeout(() => fn(nowMs()), 16));
  const caf =
    opts.caf ||
    (typeof cancelAnimationFrame !== "undefined"
      ? cancelAnimationFrame.bind(globalThis)
      : (id) => clearTimeout(id));

  let frameId = 0;
  let generation = 0;
  let fromProgress = 0;
  let toProgress = 0;
  let metrics = null;
  let startMs = 0;
  let durationMs = MOTION_MIN_MS;
  let lastHeading = null;

  const counters = {
    animationStarts: 0,
    animationCancels: 0,
    animationCompletions: 0,
  };

  function cancel(reason = "") {
    void reason;
    if (frameId) {
      caf(frameId);
      frameId = 0;
      counters.animationCancels += 1;
      diag(SNAP_DIAG.ANIM_CANCELLED);
    }
    generation += 1;
  }

  function animateTo({ metrics: nextMetrics, progressM, observedGapMs }) {
    if (!nextMetrics) {
      cancel("no_metrics");
      return;
    }
    cancel("new_target");
    const gen = generation;
    metrics = nextMetrics;
    fromProgress = Number.isFinite(toProgress) ? toProgress : progressM;
    // If first frame, start at target
    if (!Number.isFinite(fromProgress)) fromProgress = progressM;
    toProgress = progressM;
    const gap = Number(observedGapMs);
    durationMs = Number.isFinite(gap)
      ? Math.max(MOTION_MIN_MS, Math.min(MOTION_MAX_MS, gap))
      : MOTION_MIN_MS * 2;
    // Large gap: bounded snap rather than endless fabricate
    if (Number.isFinite(gap) && gap > MOTION_MAX_MS * 1.5) {
      const end = pointAtProgress(metrics, toProgress);
      if (end) {
        lastHeading = end.bearingDeg;
        onFrame({
          lat: end.lat,
          lng: end.lng,
          headingDeg: end.bearingDeg,
          progressM: toProgress,
        });
      }
      counters.animationCompletions += 1;
      return;
    }

    startMs = nowMs();
    counters.animationStarts += 1;

    const tick = () => {
      if (gen !== generation) return;
      const t = Math.min(1, (nowMs() - startMs) / durationMs);
      const p = fromProgress + (toProgress - fromProgress) * t;
      const pos = pointAtProgress(metrics, p);
      if (pos) {
        lastHeading = pos.bearingDeg;
        onFrame({
          lat: pos.lat,
          lng: pos.lng,
          headingDeg: pos.bearingDeg,
          progressM: p,
        });
      }
      if (t < 1) {
        frameId = raf(tick);
      } else {
        frameId = 0;
        counters.animationCompletions += 1;
      }
    };
    frameId = raf(tick);
  }

  function setImmediate(metricsIn, progressM) {
    cancel("immediate");
    metrics = metricsIn;
    toProgress = progressM;
    fromProgress = progressM;
    const pos = pointAtProgress(metrics, progressM);
    if (pos) {
      lastHeading = pos.bearingDeg;
      onFrame({
        lat: pos.lat,
        lng: pos.lng,
        headingDeg: pos.bearingDeg,
        progressM,
      });
    }
  }

  return {
    animateTo,
    setImmediate,
    cancel,
    getLastHeading: () => lastHeading,
    getCounters: () => ({ ...counters }),
    isAnimating: () => Boolean(frameId),
  };
}

/** Smooth heading across 0/360. */
export function lerpHeadingDeg(from, to, t) {
  if (!Number.isFinite(from)) return to;
  if (!Number.isFinite(to)) return from;
  let d = ((to - from + 540) % 360) - 180;
  return (from + d * Math.max(0, Math.min(1, t)) + 360) % 360;
}
