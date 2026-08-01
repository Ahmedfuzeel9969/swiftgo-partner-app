/**
 * Phase 5 — display-location pipeline.
 * Raw GPS → (already validated) → project → progress → motion.
 * Never mutates authoritative raw location documents.
 */

import {
  SNAP_CONFIDENCE,
  SNAP_DIAG,
  buildRouteMetrics,
  projectFixOntoRoute,
} from "./route-projection.mjs";
import { createRouteProgressTracker } from "./route-progress.mjs";
import { createRouteMotionController } from "./route-motion-controller.mjs";
import { createOffRouteDetector } from "./off-route-detector.mjs";

/**
 * @param {{
 *   onDisplayFrame?: (pos: object) => void,
 *   onRawFallback?: (fix: object) => void,
 *   onDiag?: (code: string) => void,
 *   onRerouteNeeded?: (info: {leg: string, origin: object, destination: object}) => void,
 *   nowMs?: () => number,
 *   raf?: Function,
 *   caf?: Function,
 * }} [opts]
 */
export function createDisplayLocationPipeline(opts = {}) {
  const diag = opts.onDiag || (() => {});
  const onDisplay = opts.onDisplayFrame || (() => {});
  const onRaw = opts.onRawFallback || onDisplay;
  const nowMs = opts.nowMs || (() => Date.now());

  const progress = createRouteProgressTracker();
  const offRoute = createOffRouteDetector({ nowMs, onDiag: diag });
  const motion = createRouteMotionController({
    nowMs,
    raf: opts.raf,
    caf: opts.caf,
    onDiag: diag,
    onFrame: onDisplay,
  });

  let routeGeneration = 0;
  let metrics = null;
  let leg = "none"; // approach | trip | none
  let pickup = null;
  let dropoff = null;
  let previousProj = null;
  let lastFixAt = 0;
  let closed = false;

  const counters = {
    rawFixes: 0,
    acceptedProjections: 0,
    rejectedProjections: 0,
    rawFallbacks: 0,
    segmentCandidatesChecked: 0,
    backwardJitterRejects: 0,
    generationResets: 0,
  };

  function setActiveRoute({ geometry, generation, activeLeg, pickupLoc, dropoffLoc }) {
    const nextGen = Number(generation) || routeGeneration + 1;
    const nextLeg = activeLeg || "none";
    const legChanged = nextLeg !== leg && nextLeg !== "none" && leg !== "none";
    if (nextGen !== routeGeneration || legChanged) {
      counters.generationResets += 1;
      diag(SNAP_DIAG.GENERATION_CHANGED);
      progress.reset(nextGen);
      previousProj = null;
      offRoute.resetCandidate();
      motion.cancel("generation");
    }
    routeGeneration = nextGen;
    metrics = geometry?.length >= 2 ? buildRouteMetrics(geometry) : null;
    leg = nextLeg;
    pickup = pickupLoc || null;
    dropoff = dropoffLoc || null;
    if (!metrics) {
      counters.rawFallbacks += 1;
      diag(SNAP_DIAG.RAW);
    }
  }

  function clearRoute() {
    routeGeneration += 1;
    metrics = null;
    leg = "none";
    previousProj = null;
    progress.reset(routeGeneration);
    offRoute.resetCandidate();
    motion.cancel("clear");
  }

  function ingestValidatedFix(fix) {
    if (closed || !fix) return { mode: "ignore" };
    counters.rawFixes += 1;
    const observedAt = Number(fix.observedAt) || nowMs();
    const gap = lastFixAt ? observedAt - lastFixAt : null;
    lastFixAt = observedAt;

    if (!metrics || leg === "none") {
      counters.rawFallbacks += 1;
      diag(SNAP_DIAG.RAW);
      motion.cancel("raw");
      onRaw({ ...fix, source: "display_raw" });
      return { mode: "raw", reason: "no_route" };
    }

    const projected = projectFixOntoRoute({
      fix,
      metrics,
      previous: previousProj
        ? { segmentIndex: previousProj.segmentIndex, progressM: previousProj.progressM }
        : null,
    });

    if (projected.parallelRejected) diag(SNAP_DIAG.PARALLEL_REJECTED);

    if (!projected.ok) {
      counters.rejectedProjections += 1;
      const off = offRoute.noteProjection(projected);
      if (off.confirmed) {
        maybeRequestReroute(fix);
      }
      counters.rawFallbacks += 1;
      diag(SNAP_DIAG.RAW);
      motion.cancel("low_confidence");
      onRaw({ ...fix, source: "display_raw" });
      return { mode: "raw", reason: projected.reason, off };
    }

    offRoute.resetCandidate();
    const prog = progress.apply(projected.progressM, routeGeneration);
    if (!prog.accept) {
      counters.backwardJitterRejects += 1;
      if (prog.diag) diag(prog.diag);
      // Hold display; do not animate backward
      return { mode: "hold", reason: prog.reason };
    }

    previousProj = {
      segmentIndex: projected.segmentIndex,
      progressM: prog.progressM,
    };
    counters.acceptedProjections += 1;
    if (projected.diag) diag(projected.diag);

    motion.animateTo({
      metrics,
      progressM: prog.progressM,
      observedGapMs: gap,
    });
    return {
      mode: "snap",
      confidence: projected.confidence,
      progressM: prog.progressM,
      display: projected.display,
    };
  }

  function maybeRequestReroute(fix) {
    const gate = offRoute.beginReroute();
    if (!gate.ok) return;
    const destination = leg === "trip" ? dropoff : pickup;
    if (!destination || !fix) {
      offRoute.completeReroute(false);
      return;
    }
    opts.onRerouteNeeded?.({
      leg,
      origin: { lat: fix.lat, lng: fix.lng },
      destination,
      generation: routeGeneration,
    });
  }

  function noteRerouteResult(success, newGeometry, newGeneration) {
    offRoute.completeReroute(Boolean(success));
    if (success && newGeometry) {
      setActiveRoute({
        geometry: newGeometry,
        generation: newGeneration ?? routeGeneration + 1,
        activeLeg: leg,
        pickupLoc: pickup,
        dropoffLoc: dropoff,
      });
    }
  }

  function destroy() {
    closed = true;
    clearRoute();
  }

  return {
    setActiveRoute,
    clearRoute,
    ingestValidatedFix,
    noteRerouteResult,
    destroy,
    getCounters: () => ({
      ...counters,
      ...offRoute.getCounters(),
      ...motion.getCounters(),
    }),
    getOffRoute: () => offRoute,
    getMotion: () => motion,
    getRouteGeneration: () => routeGeneration,
    SNAP_CONFIDENCE,
  };
}
