/**
 * Phase 5 — display-location pipeline.
 * Raw GPS → (already validated) → project → progress → motion.
 * Never mutates authoritative raw location documents.
 * Direct/dashed fallback geometry is never snappable.
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
import { isSnapEligibleMeta, GEOMETRY_KIND } from "./geometry-quality.mjs";
import { resolveDisplayHeading } from "./marker-heading.mjs";

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
    onFrame: (pos) => {
      const heading = resolveDisplayHeading({
        mode: "snap",
        routeBearingDeg: pos.headingDeg,
        previousHeadingDeg: lastHeading,
        speedMps: lastSpeedMps,
        accuracyM: lastAccuracyM,
      });
      if (heading.headingDeg != null) lastHeading = heading.headingDeg;
      onDisplay({
        ...pos,
        headingDeg: heading.headingDeg,
        headingSource: heading.reason,
        displayMode: "snap",
      });
    },
  });

  let routeGeneration = 0;
  let metrics = null;
  let snapMeta = null;
  let leg = "none"; // approach | trip | none
  let pickup = null;
  let dropoff = null;
  let previousProj = null;
  let lastFixAt = 0;
  let lastHeading = null;
  let lastSpeedMps = null;
  let lastAccuracyM = null;
  let closed = false;
  let awaitFreshAfterRouteChange = false;

  const counters = {
    rawFixes: 0,
    acceptedProjections: 0,
    rejectedProjections: 0,
    rawFallbacks: 0,
    segmentCandidatesChecked: 0,
    backwardJitterRejects: 0,
    generationResets: 0,
    fallbackGeometryRejected: 0,
  };

  function emitRaw(fix, reason) {
    counters.rawFallbacks += 1;
    diag(SNAP_DIAG.RAW);
    motion.cancel("raw");
    const heading = resolveDisplayHeading({
      mode: "raw",
      gpsHeadingDeg: fix?.headingDeg,
      speedMps: fix?.speedMps,
      accuracyM: fix?.accuracyM,
      previousHeadingDeg: lastHeading,
    });
    if (heading.headingDeg != null) lastHeading = heading.headingDeg;
    onRaw({
      ...fix,
      source: "display_raw",
      headingDeg: heading.headingDeg,
      headingSource: heading.reason,
      displayMode: "raw",
      reason,
    });
  }

  /**
   * @param {{
   *   geometry?: Array,
   *   generation?: number,
   *   activeLeg?: string,
   *   pickupLoc?: object,
   *   dropoffLoc?: object,
   *   geometryKind?: string,
   *   snapEligible?: boolean,
   *   providerKind?: string,
   *   generatedAt?: number,
   * }} input
   */
  function setActiveRoute(input = {}) {
    const nextGen = Number(input.generation) || routeGeneration + 1;
    const nextLeg = input.activeLeg || "none";
    const legChanged = nextLeg !== leg && nextLeg !== "none" && leg !== "none";
    if (nextGen !== routeGeneration || legChanged) {
      counters.generationResets += 1;
      diag(SNAP_DIAG.GENERATION_CHANGED);
      progress.reset(nextGen);
      previousProj = null;
      offRoute.resetCandidate();
      motion.cancel("generation");
      lastHeading = null;
      awaitFreshAfterRouteChange = true;
    }
    routeGeneration = nextGen;
    leg = nextLeg;
    pickup = input.pickupLoc || null;
    dropoff = input.dropoffLoc || null;

    const meta = {
      geometryKind: input.geometryKind,
      snapEligible: input.snapEligible,
      providerKind: input.providerKind,
      generatedAt: input.generatedAt,
      routeGeneration: nextGen,
    };

    // Fail closed: missing/unknown/fallback → no metrics, no snap, no off-route corridor.
    if (!isSnapEligibleMeta(meta) || !Array.isArray(input.geometry) || input.geometry.length < 2) {
      if (
        input.geometryKind === GEOMETRY_KIND.DIRECT_ESTIMATE_FALLBACK ||
        input.snapEligible === false ||
        input.geometryKind == null
      ) {
        counters.fallbackGeometryRejected += 1;
      }
      metrics = null;
      snapMeta = null;
      diag(SNAP_DIAG.RAW);
      return { ok: false, reason: "not_snap_eligible", meta };
    }

    metrics = buildRouteMetrics(input.geometry);
    snapMeta = { ...meta, snapEligible: true };
    if (!metrics) {
      snapMeta = null;
      diag(SNAP_DIAG.RAW);
      return { ok: false, reason: "invalid_metrics" };
    }
    return { ok: true, meta: snapMeta };
  }

  function clearRoute() {
    routeGeneration += 1;
    metrics = null;
    snapMeta = null;
    leg = "none";
    previousProj = null;
    awaitFreshAfterRouteChange = false;
    progress.reset(routeGeneration);
    offRoute.resetCandidate();
    motion.cancel("clear");
    lastHeading = null;
  }

  function ingestValidatedFix(fix) {
    if (closed || !fix) return { mode: "ignore" };
    counters.rawFixes += 1;
    lastSpeedMps = Number.isFinite(fix.speedMps) ? fix.speedMps : null;
    lastAccuracyM = Number.isFinite(fix.accuracyM) ? fix.accuracyM : null;
    const observedAt = Number(fix.observedAt) || nowMs();
    const gap = lastFixAt ? observedAt - lastFixAt : null;
    lastFixAt = observedAt;

    if (!metrics || !snapMeta || !isSnapEligibleMeta(snapMeta) || leg === "none") {
      emitRaw(fix, "no_snap_eligible_route");
      return { mode: "raw", reason: "no_snap_eligible_route" };
    }

    const projected = projectFixOntoRoute({
      fix,
      metrics,
      previous: previousProj
        ? { segmentIndex: previousProj.segmentIndex, progressM: previousProj.progressM }
        : null,
      snapEligible: true,
      geometryKind: snapMeta.geometryKind,
    });

    if (projected.parallelRejected) diag(SNAP_DIAG.PARALLEL_REJECTED);

    if (!projected.ok) {
      counters.rejectedProjections += 1;
      // Off-route only against verified/fixture corridor (already gated by snapMeta).
      const off = offRoute.noteProjection(projected);
      if (off.confirmed) {
        maybeRequestReroute(fix);
      }
      emitRaw(fix, projected.reason);
      return { mode: "raw", reason: projected.reason, off };
    }

    offRoute.resetCandidate();

    // After route/leg change, accept first projection as fresh domain (no unsafe jump animate).
    if (awaitFreshAfterRouteChange) {
      awaitFreshAfterRouteChange = false;
      progress.reset(routeGeneration);
      const prog = progress.apply(projected.progressM, routeGeneration);
      previousProj = {
        segmentIndex: projected.segmentIndex,
        progressM: prog.progressM,
      };
      counters.acceptedProjections += 1;
      if (projected.diag) diag(projected.diag);
      motion.setImmediate(metrics, prog.progressM);
      return {
        mode: "snap",
        confidence: projected.confidence,
        progressM: prog.progressM,
        display: projected.display,
        freshRoute: true,
      };
    }

    const prog = progress.apply(projected.progressM, routeGeneration);
    if (!prog.accept) {
      counters.backwardJitterRejects += 1;
      if (prog.diag) diag(prog.diag);
      // Never silent-freeze the marker: paint raw GPS when snap progress rejects.
      emitRaw(fix, prog.reason || "progress_hold");
      return { mode: "raw", reason: prog.reason || "progress_hold", held: true };
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
    if (!snapMeta || !isSnapEligibleMeta(snapMeta)) return;
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

  function noteRerouteResult(success, routePayload, newGeneration) {
    offRoute.completeReroute(Boolean(success));
    if (!success) {
      // Keep last verified geometry if still snap-eligible; otherwise raw.
      if (!snapMeta || !isSnapEligibleMeta(snapMeta)) {
        metrics = null;
        diag(SNAP_DIAG.RAW);
      }
      return;
    }
    const geometry = routePayload?.geometry || routePayload;
    const meta = {
      geometry,
      generation: newGeneration ?? routeGeneration + 1,
      activeLeg: leg,
      pickupLoc: pickup,
      dropoffLoc: dropoff,
      geometryKind: routePayload?.geometryKind,
      snapEligible: routePayload?.snapEligible,
      providerKind: routePayload?.providerKind,
      generatedAt: routePayload?.generatedAt,
    };
    const applied = setActiveRoute(meta);
    if (!applied.ok) {
      metrics = null;
      snapMeta = null;
      diag(SNAP_DIAG.RAW);
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
    getSnapMeta: () => snapMeta,
    isSnapActive: () => Boolean(metrics && isSnapEligibleMeta(snapMeta)),
    SNAP_CONFIDENCE,
    GEOMETRY_KIND,
  };
}
