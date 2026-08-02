/**
 * Phase 6 hardening — in_progress raw-GPS breadcrumb collector.
 * Samples ~1 telemetry point / 4s; display GPS may remain higher-rate for map/P2P.
 */

import {
  BREADCRUMB_DIAG,
  BREADCRUMB_MAX_QUEUE_POINTS,
  BREADCRUMB_SAMPLE_INTERVAL_MS,
  assignmentVersionFromRide,
  assignmentVersionFromToken,
  isValidAssignmentSessionToken,
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

function bindingsEqual(a, b) {
  if (!a || !b) return false;
  return (
    String(a.rideId) === String(b.rideId) &&
    String(a.driverId) === String(b.driverId) &&
    String(a.vehicleId) === String(b.vehicleId) &&
    String(a.assignmentSessionToken) === String(b.assignmentSessionToken) &&
    String(a.trackingSessionId) === String(b.trackingSessionId)
  );
}

/**
 * @param {{
 *   nowMs?: () => number,
 *   onDiag?: (code: string) => void,
 *   indexedDB?: IDBFactory,
 *   callSubmit?: (batch: object) => Promise<object>,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   sampleIntervalMs?: number,
 *   allowMemoryFallback?: boolean,
 * }} [opts]
 */
export function createBreadcrumbCollector(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const diag = opts.onDiag || (() => {});
  const sampleIntervalMs = Number(opts.sampleIntervalMs) || BREADCRUMB_SAMPLE_INTERVAL_MS;
  const queue = createBreadcrumbQueue({
    indexedDB: opts.indexedDB,
    nowMs,
    onDiag: diag,
    allowMemoryFallback: opts.allowMemoryFallback,
  });
  let binding = null;
  let collecting = false;
  let generation = 0;
  let lastSampledObservedAt = 0;
  let flushingForTerminal = false;

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
    sampledOut: 0,
    alreadyActiveStarts: 0,
  };

  function buildBinding({
    rideId,
    driverId,
    vehicleId,
    ride,
    trackingSessionId,
    assignmentSessionToken,
    assignmentVersion,
  }) {
    const token = String(
      assignmentSessionToken || ride?.assignmentSessionToken || ""
    ).trim();
    const av =
      assignmentVersion != null
        ? Number(assignmentVersion)
        : token
          ? assignmentVersionFromToken(token)
          : assignmentVersionFromRide(ride || { driverId, vehicleId });
    return {
      rideId: String(rideId || ""),
      driverId: String(driverId || ""),
      vehicleId: String(vehicleId || ""),
      assignmentSessionToken: token,
      assignmentVersion: av,
      trackingSessionId: String(trackingSessionId || ""),
    };
  }

  function canCollect(ctx) {
    if (!ctx?.driverId || !ctx?.rideId || !ctx?.vehicleId) return false;
    if (String(ctx.status || "") !== "in_progress") return false;
    if (!ctx.trackingSessionId) return false;
    if (!isValidAssignmentSessionToken(ctx.assignmentSessionToken || ctx.ride?.assignmentSessionToken)) {
      return false;
    }
    if (ctx.assignedDriverId && String(ctx.assignedDriverId) !== String(ctx.driverId)) {
      return false;
    }
    return true;
  }

  async function start(ctx) {
    if (!canCollect(ctx)) {
      if (collecting) await stop({ reason: "invalid_start", purge: true, flush: false });
      return { ok: false, reason: "cannot_collect" };
    }
    const next = buildBinding(ctx);
    if (collecting && bindingsEqual(binding, next)) {
      counters.alreadyActiveStarts += 1;
      diag(BREADCRUMB_DIAG.ALREADY_ACTIVE);
      return { ok: true, reason: "already_active", binding };
    }
    if (binding && !bindingsEqual(binding, next)) {
      await queue.purgePartition(binding);
    }
    await queue.purgeIfMismatch(next, next);
    binding = next;
    collecting = true;
    flushingForTerminal = false;
    generation += 1;
    lastSampledObservedAt = 0;
    uploader.start();
    diag(BREADCRUMB_DIAG.COLLECTION_STARTED);
    return { ok: true, binding };
  }

  /**
   * Stop accepting points and attempt bounded flush while ride is still in_progress.
   * Does not purge — call stop({ purge: true, flush: false }) after settlement.
   */
  async function flushBeforeSettlement() {
    if (!binding) return { ok: false, reason: "no_binding" };
    collecting = false;
    flushingForTerminal = true;
    generation += 1;
    const result = await uploader.flushBounded();
    uploader.stop();
    return result;
  }

  async function stop({ purge = true, flush = false, reason = "" } = {}) {
    void reason;
    const was = collecting || flushingForTerminal || Boolean(binding);
    const priorBinding = binding;
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
    flushingForTerminal = false;
    lastSampledObservedAt = 0;
    if (was) diag(BREADCRUMB_DIAG.COLLECTION_STOPPED);
    return { ok: true };
  }

  async function ingestRawFix(envelope, ctx = {}) {
    if (!collecting || !binding || flushingForTerminal) {
      counters.skippedAuth += 1;
      return { ok: false, reason: "not_collecting" };
    }
    const status = String(ctx.status || "in_progress");
    if (status !== "in_progress" || TERMINAL_STATUSES.has(status)) {
      counters.skippedStatus += 1;
      return { ok: false, reason: "status_not_in_progress" };
    }
    if (ctx.rideId && String(ctx.rideId) !== binding.rideId) {
      return { ok: false, reason: "ride_mismatch" };
    }
    if (ctx.trackingSessionId && String(ctx.trackingSessionId) !== binding.trackingSessionId) {
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

    const observedAt = Number(envelope.observedAt);
    if (Number.isFinite(observedAt) && lastSampledObservedAt > 0) {
      const dt = observedAt - lastSampledObservedAt;
      if (dt < sampleIntervalMs) {
        counters.sampledOut += 1;
        diag(BREADCRUMB_DIAG.POINT_SAMPLED_OUT);
        return { ok: false, reason: "sampled_out" };
      }
    }

    const point = {
      sequence: Number(envelope.sequence),
      observedAt,
      lat: envelope.lat,
      lng: envelope.lng,
      accuracyM: envelope.accuracyM,
      speedMps: envelope.speedMps,
      headingDeg: envelope.headingDeg,
      source: "gps",
    };

    const forceGapBefore =
      lastSampledObservedAt > 0 &&
      Number.isFinite(observedAt) &&
      observedAt - lastSampledObservedAt > sampleIntervalMs * 2.5;

    const gen = generation;
    const result = await queue.appendPoint(binding, point, { forceGapBefore });
    if (gen !== generation) return { ok: false, reason: "stale_generation" };
    if (result.ok) {
      lastSampledObservedAt = observedAt;
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
    await uploader.tick({ force: true, reason: "network_resume", wake: true });
  }

  async function onAppResume() {
    if (!collecting || !binding) return;
    await queue.purgeIfMismatch(binding, binding);
    await uploader.tick({ force: true, reason: "app_resume", wake: true });
  }

  return {
    start,
    stop,
    flushBeforeSettlement,
    ingestRawFix,
    onNetworkResume,
    onAppResume,
    flushBounded: () => uploader.flushBounded(),
    isCollecting: () => collecting,
    getBinding: () => binding,
    getGeneration: () => generation,
    getCounters: () => ({
      ...counters,
      queue: queue.getCounters(),
      uploader: uploader.getCounters(),
    }),
    _queue: queue,
    _uploader: uploader,
  };
}

export { TERMINAL_STATUSES, bindingsEqual };
