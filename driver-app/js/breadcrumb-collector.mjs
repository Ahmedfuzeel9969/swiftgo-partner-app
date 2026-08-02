/**
 * Phase 6 — in_progress raw-GPS breadcrumb collector.
 * Never accepts display-snapped / animation / P2P display frames.
 */

import {
  BREADCRUMB_DIAG,
  BREADCRUMB_MAX_QUEUE_POINTS,
  assignmentVersionFromRide,
} from "./breadcrumb-schema.mjs";
import { createBreadcrumbQueue } from "./breadcrumb-queue.mjs";
import { createBreadcrumbUploader } from "./breadcrumb-uploader.mjs";

const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "no_drivers",
]);

/**
 * @param {{
 *   nowMs?: () => number,
 *   onDiag?: (code: string) => void,
 *   indexedDB?: IDBFactory,
 *   callSubmit?: (batch: object) => Promise<object>,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [opts]
 */
export function createBreadcrumbCollector(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const diag = opts.onDiag || (() => {});
  const queue = createBreadcrumbQueue({
    indexedDB: opts.indexedDB,
    nowMs,
    onDiag: diag,
  });
  let binding = null;
  let collecting = false;
  let generation = 0;

  // Binding remains readable during bounded final flush after collection stops.
  const getBinding = () => binding;

  const uploader = createBreadcrumbUploader({
    queue,
    getBinding,
    nowMs,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
    onDiag: diag,
    callSubmit: opts.callSubmit,
  });

  const counters = {
    collected: 0,
    skippedStatus: 0,
    skippedAuth: 0,
    skippedSource: 0,
  };

  function buildBinding({
    rideId,
    driverId,
    vehicleId,
    ride,
    trackingSessionId,
    assignmentVersion,
  }) {
    const av =
      assignmentVersion != null
        ? Number(assignmentVersion)
        : assignmentVersionFromRide(ride || { driverId, vehicleId });
    return {
      rideId: String(rideId || ""),
      driverId: String(driverId || ""),
      vehicleId: String(vehicleId || ""),
      assignmentVersion: av,
      trackingSessionId: String(trackingSessionId || ""),
    };
  }

  function canCollect(ctx) {
    if (!ctx?.driverId || !ctx?.rideId || !ctx?.vehicleId) return false;
    if (String(ctx.status || "") !== "in_progress") return false;
    if (!ctx.trackingSessionId) return false;
    if (ctx.assignedDriverId && String(ctx.assignedDriverId) !== String(ctx.driverId)) {
      return false;
    }
    return true;
  }

  async function start(ctx) {
    if (!canCollect(ctx)) {
      await stop({ reason: "invalid_start" });
      return { ok: false, reason: "cannot_collect" };
    }
    const next = buildBinding(ctx);
    if (
      binding &&
      (binding.rideId !== next.rideId ||
        binding.trackingSessionId !== next.trackingSessionId ||
        binding.assignmentVersion !== next.assignmentVersion ||
        binding.vehicleId !== next.vehicleId)
    ) {
      await queue.purgePartition(binding);
    }
    await queue.purgeIfMismatch(next, next);
    binding = next;
    collecting = true;
    generation += 1;
    uploader.start();
    diag(BREADCRUMB_DIAG.COLLECTION_STARTED);
    return { ok: true, binding };
  }

  async function stop({ purge = true, flush = false, reason = "" } = {}) {
    void reason;
    const was = collecting;
    const priorBinding = binding;
    // Keep binding for bounded flush; stop accepting new points immediately.
    collecting = false;
    generation += 1;
    if (flush && priorBinding) {
      binding = priorBinding;
      await uploader.flushBounded();
    }
    uploader.stop();
    if (purge && priorBinding) {
      await queue.purgePartition(priorBinding);
    }
    binding = null;
    if (was) diag(BREADCRUMB_DIAG.COLLECTION_STOPPED);
    return { ok: true };
  }

  /**
   * Ingest a validated raw GPS envelope (post location-envelope accept).
   * Customer hidden / viewer presence must not gate this.
   */
  async function ingestRawFix(envelope, ctx = {}) {
    if (!collecting || !binding) {
      counters.skippedAuth += 1;
      return { ok: false, reason: "not_collecting" };
    }
    const status = String(ctx.status || "in_progress");
    if (status !== "in_progress" || TERMINAL_STATUSES.has(status)) {
      counters.skippedStatus += 1;
      return { ok: false, reason: "status_not_in_progress" };
    }
    if (
      ctx.rideId &&
      String(ctx.rideId) !== binding.rideId
    ) {
      return { ok: false, reason: "ride_mismatch" };
    }
    if (
      ctx.trackingSessionId &&
      String(ctx.trackingSessionId) !== binding.trackingSessionId
    ) {
      return { ok: false, reason: "session_mismatch" };
    }
    if (!envelope || typeof envelope !== "object") {
      return { ok: false, reason: "invalid_envelope" };
    }
    if (
      envelope.source === "display_snap" ||
      envelope.source === "animation" ||
      envelope.displayMode === "snap" ||
      envelope.source === "p2p_display" ||
      envelope.source === "route_projection"
    ) {
      counters.skippedSource += 1;
      diag(BREADCRUMB_DIAG.POINT_REJECTED);
      return { ok: false, reason: "non_authoritative_source" };
    }

    const point = {
      sequence: Number(envelope.sequence),
      observedAt: Number(envelope.observedAt),
      lat: envelope.lat,
      lng: envelope.lng,
      accuracyM: envelope.accuracyM,
      speedMps: envelope.speedMps,
      headingDeg: envelope.headingDeg,
      source: "gps",
    };

    const gen = generation;
    const result = await queue.appendPoint(binding, point);
    if (gen !== generation) return { ok: false, reason: "stale_generation" };
    if (result.ok) {
      counters.collected += 1;
      const count = result.queuePoints || 0;
      if (count >= Math.floor(BREADCRUMB_MAX_QUEUE_POINTS * 0.85)) {
        void uploader.tick({ force: true, reason: "queue_bound" });
      }
    }
    return result;
  }

  async function onNetworkResume() {
    if (!collecting || !binding) return;
    await uploader.tick({ force: true, reason: "network_resume" });
  }

  async function onAppResume() {
    if (!collecting || !binding) return;
    await queue.purgeIfMismatch(binding, binding);
    await uploader.tick({ force: true, reason: "app_resume" });
  }

  return {
    start,
    stop,
    ingestRawFix,
    onNetworkResume,
    onAppResume,
    flushBounded: () => uploader.flushBounded(),
    isCollecting: () => collecting,
    getBinding: () => binding,
    getCounters: () => ({
      ...counters,
      queue: queue.getCounters(),
      uploader: uploader.getCounters(),
    }),
    /** test seams */
    _queue: queue,
    _uploader: uploader,
  };
}

export { TERMINAL_STATUSES };
