/**
 * Ride-end location report client — bounded flush via trusted callable.
 * Diagnostic only; failures never block settlement or ride UI.
 */

import { hashAssignmentSessionTokenAsync } from "./ride-location-report-schema.mjs";
import {
  createBrowserLocalStorageAdapter,
  createRideLocationLocalCounterStore,
} from "./ride-location-local-counter-store.mjs";

export const RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS = 4_000;

/**
 * @param {Record<string, unknown>} checkpoint
 * @param {Record<string, unknown>} p2p
 */
export function mapDriverRuntimeCounters(checkpoint = {}, p2p = {}) {
  const rawGps = Number(checkpoint.rawGpsFixes) || 0;
  const rejected =
    (Number(checkpoint.rejectedInterval) || 0) + (Number(checkpoint.rejectedMovementNoop) || 0);
  const attempted = Number(checkpoint.writesAttempted) || 0;
  const committed = Number(checkpoint.writesCommitted) || 0;
  return {
    gpsFixesReceived: rawGps,
    validFixesAccepted: Math.max(0, rawGps - rejected),
    invalidFixesRejected: 0,
    duplicateOrOutOfOrderRejected: rejected,
    vehicleWritesAttempted: attempted,
    vehicleWritesAcknowledged: committed,
    vehicleWritesFailed: Math.max(0, attempted - committed),
    p2pFramesAttempted: Number(p2p.fixesSent) || 0,
    p2pFramesSent: Number(p2p.fixesSent) || 0,
    p2pHealthySessionCount: Number(p2p.sessionsStarted) || 0,
    p2pDegradedOrFallbackTransitions: Number(p2p.fallbackTransitions) || 0,
  };
}

/**
 * @param {Record<string, unknown>} p2p
 * @param {Record<string, unknown>} display
 * @param {Record<string, unknown>} [lifecycle]
 */
export function mapCustomerRuntimeCounters(p2p = {}, display = {}, lifecycle = {}) {
  return {
    firebaseSnapshotsReceived:
      (Number(p2p.firebaseAccepted) || 0) + (Number(lifecycle.snapshotEvents) || 0),
    firebaseValidRendered: Number(display.acceptedProjections) || Number(p2p.firebaseAccepted) || 0,
    p2pFramesReceived: Number(p2p.fixesReceived) || 0,
    p2pValidRendered: Number(p2p.p2pAccepted) || 0,
    staleRejected: Number(p2p.staleRejected) || 0,
    duplicateRejected: Number(display.backwardJitterRejects) || 0,
    rollbackRejected: Number(display.rejectedProjections) || 0,
    sourceSwitchP2pToFirebase: 0,
    sourceSwitchFirebaseToP2p: Number(p2p.sourceSwitches) || 0,
  };
}

/**
 * @param {{
 *   role: "driver" | "customer",
 *   getFirebase: () => { ready?: boolean, functions?: object },
 *   getRuntimeCounters?: () => { checkpoint?: object, p2p?: object, display?: object, lifecycle?: object },
 *   storage?: object,
 *   nowMs?: () => number,
 *   callSubmit?: (payload: object) => Promise<object>,
 * }} opts
 */
export function createRideLocationReportClient(opts) {
  const role = opts.role;
  if (role !== "driver" && role !== "customer") {
    throw new Error("createRideLocationReportClient requires role driver or customer");
  }
  const getFirebase = opts.getFirebase;
  const getRuntimeCounters = opts.getRuntimeCounters || (() => ({}));
  const nowMs = opts.nowMs || (() => Date.now());
  const store = createRideLocationLocalCounterStore({
    role,
    storage: opts.storage || createBrowserLocalStorageAdapter(),
    nowMs,
  });

  let boundRideId = "";
  let flushInFlight = false;

  async function defaultCallSubmit(payload) {
    const { httpsCallable } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js"
    );
    const { ready, functions } = getFirebase?.() || {};
    if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
    const res = await httpsCallable(functions, "submitRideLocationReportSection")(payload);
    return res?.data || res;
  }

  const callSubmit = opts.callSubmit || defaultCallSubmit;

  async function bindForRide({ rideId, assignmentSessionToken }) {
    const id = String(rideId || "").trim();
    const token = String(assignmentSessionToken || "").trim();
    if (!id || !token) {
      boundRideId = "";
      return { ok: false, reason: "missing_binding" };
    }
    const hash = await hashAssignmentSessionTokenAsync(token);
    if (!hash) return { ok: false, reason: "invalid_token" };
    const result = store.bind({ rideId: id, assignmentSessionTokenHash: hash });
    if (result.ok) boundRideId = id;
    return result;
  }

  function syncCountersFromRuntime() {
    const runtime = getRuntimeCounters() || {};
    const counters =
      role === "driver"
        ? mapDriverRuntimeCounters(runtime.checkpoint || {}, runtime.p2p || {})
        : mapCustomerRuntimeCounters(runtime.p2p || {}, runtime.display || {}, runtime.lifecycle || {});
    store.applyCounterSnapshot(counters);
  }

  function noteGpsFix(atMs = nowMs()) {
    if (!store.isBound()) return;
    store.incrementCounter("gpsFixesReceived", 1);
    store.recordEventAtMs(atMs);
  }

  function noteVehicleWriteAttempted() {
    if (!store.isBound()) return;
    store.incrementCounter("vehicleWritesAttempted", 1);
  }

  function noteVehicleWriteAcknowledged(atMs = nowMs()) {
    if (!store.isBound()) return;
    store.incrementCounter("vehicleWritesAcknowledged", 1);
    store.recordEventAtMs(atMs);
  }

  function noteVehicleWriteFailed() {
    if (!store.isBound()) return;
    store.incrementCounter("vehicleWritesFailed", 1);
  }

  function noteFirebaseReceive(atMs = nowMs()) {
    if (!store.isBound()) return;
    store.incrementCounter("firebaseSnapshotsReceived", 1);
    store.recordEventAtMs(atMs);
  }

  function noteRendered(atMs = nowMs()) {
    if (!store.isBound()) return;
    store.incrementCounter("firebaseValidRendered", 1);
    store.recordEventAtMs(atMs);
  }

  function addVisibleMs(ms) {
    if (role !== "customer") return;
    store.addVisibleDurationMs(ms);
  }

  function addBackgroundMs(ms) {
    if (role !== "customer") return;
    store.addBackgroundDurationMs(ms);
  }

  async function flushFinal({ finalSubmit = true, timeoutMs = RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS } = {}) {
    if (!store.isBound()) return { ok: false, reason: "not_bound" };
    if (flushInFlight) return { ok: false, reason: "in_flight" };
    flushInFlight = true;
    try {
      syncCountersFromRuntime();
      store.bumpSubmitSequence();
      const section = store.snapshotSection();
      const binding = store.getBinding();
      if (!section || !binding) return { ok: false, reason: "empty_section" };

      const submitPromise = callSubmit({
        rideId: binding.rideId,
        role,
        assignmentSessionTokenHash: binding.assignmentSessionTokenHash,
        section,
        submitSequence: section.submitSequence,
        finalSubmit: finalSubmit === true,
      });

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("FLUSH_TIMEOUT")),
          Math.max(500, Number(timeoutMs) || RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS)
        );
      });
      const result = await Promise.race([submitPromise, timeoutPromise]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      if (result?.ok && !result?.skipped) {
        store.clear();
        boundRideId = "";
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error).slice(0, 120) };
    } finally {
      flushInFlight = false;
    }
  }

  function clearBinding() {
    boundRideId = "";
    store.clear();
  }

  return {
    bindForRide,
    syncCountersFromRuntime,
    noteGpsFix,
    noteVehicleWriteAttempted,
    noteVehicleWriteAcknowledged,
    noteVehicleWriteFailed,
    noteFirebaseReceive,
    noteRendered,
    addVisibleMs,
    addBackgroundMs,
    flushFinal,
    clearBinding,
    isBound: () => store.isBound(),
    getBinding: () => store.getBinding(),
    getBoundRideId: () => boundRideId,
    snapshotSection: () => store.snapshotSection(),
  };
}
