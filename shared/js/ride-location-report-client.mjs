/**
 * Ride-end location report client — bounded flush via trusted callable.
 * Diagnostic only; failures never block settlement or ride UI.
 */

import { hashAssignmentSessionTokenAsync } from "./ride-location-report-schema.mjs";
import {
  createBrowserLocalStorageAdapter,
  createRideLocationLocalCounterStore,
} from "./ride-location-local-counter-store.mjs";
import {
  enqueuePendingReport,
  removePendingReport,
  bumpPendingAttempt,
  readPendingQueue,
} from "./ride-location-report-pending-queue.mjs";
import {
  isReportingActive,
  readCachedLocationReportingConfig,
  refreshLocationReportingConfigFromFirestore,
  shouldCollectDriverMetrics,
  shouldCollectCustomerMetrics,
  shouldCollectFirebaseMetrics,
  shouldCollectP2pMetrics,
} from "./location-reporting-config-cache.mjs";

export const RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS = 4_000;

/**
 * @param {Record<string, unknown>} checkpoint
 * @param {Record<string, unknown>} p2p
 * @param {Record<string, unknown>} [nativeDiag] native background-upload counters
 */
export function mapDriverRuntimeCounters(checkpoint = {}, p2p = {}, nativeDiag = {}) {
  const rawGps = Number(checkpoint.rawGpsFixes) || 0;
  const rejected =
    (Number(checkpoint.rejectedInterval) || 0) + (Number(checkpoint.rejectedMovementNoop) || 0);
  const attempted = Number(checkpoint.writesAttempted) || 0;
  const committed = Number(checkpoint.writesCommitted) || 0;
  const nativeUploaded = Number(nativeDiag.uploaded) || 0;
  const nativeRejected = Number(nativeDiag.rejected) || 0;
  const nativeFixCount = Number(nativeDiag.fixCount) || 0;
  return {
    gpsFixesReceived: rawGps + nativeFixCount,
    validFixesAccepted: Math.max(0, rawGps - rejected) + nativeFixCount,
    duplicateOrOutOfOrderRejected: rejected + nativeRejected,
    vehicleWritesAttempted: attempted + nativeUploaded + nativeRejected,
    vehicleWritesAcknowledged: committed + nativeUploaded,
    vehicleWritesFailed: Math.max(0, attempted - committed),
    p2pSessionsStarted: Number(p2p.sessionsStarted) || 0,
    p2pChannelsOpened: Number(p2p.channelsOpened) || 0,
    p2pFramesAttempted: Number(p2p.fixesAttempted) || 0,
    p2pFramesSent: Number(p2p.fixesSent) || 0,
    p2pFramesAcknowledged: Number(p2p.acknowledgementsReceived) || 0,
    p2pFramesRejected: Number(p2p.invalidMessages) || 0,
    p2pSendFailures: Number(p2p.sendFailures) || 0,
    p2pHealthySessionCount: Number(p2p.healthySessions) || 0,
    p2pDegradedOrFallbackTransitions: Number(p2p.fallbackTransitions) || 0,
  };
}

/**
 * @param {Record<string, unknown>} arbiter Counters from live-location-source-arbiter (+ optional p2p session)
 * @param {Record<string, unknown>} display display-location-pipeline counters (rejections only)
 */
export function mapCustomerRuntimeCounters(p2p = {}, display = {}) {
  return {
    firebaseSnapshotsReceived: Number(p2p.firebaseAccepted) || 0,
    firebaseValidRendered: Number(p2p.firebaseRendered) || 0,
    p2pSessionsStarted: Number(p2p.sessionsStarted) || 0,
    p2pChannelsOpened: Number(p2p.channelsOpened) || 0,
    p2pHealthySessionCount: Number(p2p.healthySessions) || 0,
    p2pFramesReceived: Number(p2p.p2pAccepted) || Number(p2p.fixesReceived) || 0,
    p2pValidRendered: Number(p2p.p2pRendered) || 0,
    staleRejected: Number(p2p.staleRejected) || 0,
    duplicateRejected: Number(display.backwardJitterRejects) || 0,
    rollbackRejected: Number(display.rejectedProjections) || 0,
    sourceSwitchP2pToFirebase: Number(p2p.sourceSwitchP2pToFirebase) || 0,
    sourceSwitchFirebaseToP2p: Number(p2p.sourceSwitchFirebaseToP2p) || 0,
  };
}

function applyConfigToCounters(role, counters, config) {
  const out = { ...counters };
  if (role === "driver") {
    if (!shouldCollectP2pMetrics(config)) {
      for (const key of Object.keys(out)) {
        if (key.startsWith("p2p")) out[key] = 0;
      }
    }
  } else if (role === "customer") {
    if (!shouldCollectFirebaseMetrics(config)) {
      out.firebaseSnapshotsReceived = 0;
      out.firebaseValidRendered = 0;
      out.sourceSwitchP2pToFirebase = 0;
      out.sourceSwitchFirebaseToP2p = 0;
    }
    if (!shouldCollectP2pMetrics(config)) {
      out.p2pFramesReceived = 0;
      out.p2pValidRendered = 0;
      out.sourceSwitchP2pToFirebase = 0;
      out.sourceSwitchFirebaseToP2p = 0;
    }
  }
  return out;
}

function roleMetricsEnabled(role, config) {
  if (!isReportingActive(config)) return false;
  if (role === "driver") return shouldCollectDriverMetrics(config);
  return shouldCollectCustomerMetrics(config);
}

/**
 * @param {{
 *   role: "driver" | "customer",
 *   getFirebase: () => { ready?: boolean, functions?: object, db?: object },
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
  const storage = opts.storage || createBrowserLocalStorageAdapter();
  const store = createRideLocationLocalCounterStore({
    role,
    storage,
    nowMs,
  });

  let boundRideId = "";
  let flushInFlight = false;
  let configRefreshPromise = null;

  async function ensureConfig() {
    if (!configRefreshPromise) {
      configRefreshPromise = refreshLocationReportingConfigFromFirestore(getFirebase, storage).finally(
        () => {
          configRefreshPromise = null;
        }
      );
    }
    return configRefreshPromise;
  }

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
    await ensureConfig();
    const config = readCachedLocationReportingConfig(storage, nowMs());
    if (!roleMetricsEnabled(role, config)) {
      boundRideId = "";
      return { ok: false, reason: "reporting_disabled" };
    }

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
    const config = readCachedLocationReportingConfig(storage, nowMs());
    const runtime = getRuntimeCounters() || {};
    let counters =
      role === "driver"
        ? mapDriverRuntimeCounters(
            runtime.checkpoint || {},
            runtime.p2p || {},
            runtime.native || {}
          )
        : mapCustomerRuntimeCounters(runtime.p2p || {}, runtime.display || {});
    counters = applyConfigToCounters(role, counters, config);
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
    if (!store.isBound() || !shouldCollectFirebaseMetrics(readCachedLocationReportingConfig(storage, nowMs()))) {
      return;
    }
    store.incrementCounter("firebaseSnapshotsReceived", 1);
    store.recordFirebaseReceiveAtMs(atMs);
    store.recordEventAtMs(atMs);
  }

  function noteP2pReceive(atMs = nowMs()) {
    if (!store.isBound() || !shouldCollectP2pMetrics(readCachedLocationReportingConfig(storage, nowMs()))) {
      return;
    }
    store.incrementCounter("p2pFramesReceived", 1);
    store.recordP2pReceiveAtMs(atMs);
    store.recordEventAtMs(atMs);
  }

  function noteFirebaseRendered(atMs = nowMs()) {
    if (!store.isBound() || !shouldCollectFirebaseMetrics(readCachedLocationReportingConfig(storage, nowMs()))) {
      return;
    }
    store.incrementCounter("firebaseValidRendered", 1);
    store.recordFirebaseRenderedAtMs(atMs);
    store.recordEventAtMs(atMs);
  }

  function noteP2pRendered(atMs = nowMs()) {
    if (!store.isBound() || !shouldCollectP2pMetrics(readCachedLocationReportingConfig(storage, nowMs()))) {
      return;
    }
    store.incrementCounter("p2pValidRendered", 1);
    store.recordP2pRenderedAtMs(atMs);
    store.recordEventAtMs(atMs);
  }

  /** @deprecated use noteFirebaseRendered */
  function noteRendered(atMs = nowMs()) {
    noteFirebaseRendered(atMs);
  }

  function addVisibleMs(ms) {
    if (role !== "customer") return;
    store.addVisibleDurationMs(ms);
  }

  function addBackgroundMs(ms) {
    if (role !== "customer") return;
    store.addBackgroundDurationMs(ms);
  }

  function enqueueCurrentSection(finalSubmit = true) {
    const binding = store.getBinding();
    const section = store.snapshotSection();
    if (!binding || !section || (section.submitSequence || 0) < 1) return { ok: false };
    return enqueuePendingReport(storage, {
      rideId: binding.rideId,
      role,
      assignmentSessionTokenHash: binding.assignmentSessionTokenHash,
      section,
      finalSubmit: finalSubmit === true,
    });
  }

  async function submitSectionPayload({ section, binding, finalSubmit }) {
    return callSubmit({
      rideId: binding.rideId,
      role,
      assignmentSessionTokenHash: binding.assignmentSessionTokenHash,
      section,
      submitSequence: section.submitSequence,
      finalSubmit: finalSubmit === true,
    });
  }

  async function flushFinal({ finalSubmit = true, timeoutMs = RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS } = {}) {
    await ensureConfig();
    const config = readCachedLocationReportingConfig(storage, nowMs());
    if (!roleMetricsEnabled(role, config)) return { ok: true, skipped: true, reason: "reporting_disabled" };
    if (!store.isBound()) return { ok: false, reason: "not_bound" };
    if (flushInFlight) return { ok: false, reason: "in_flight" };
    flushInFlight = true;
    try {
      syncCountersFromRuntime();
      store.bumpSubmitSequence();
      const section = store.snapshotSection();
      const binding = store.getBinding();
      if (!section || !binding) return { ok: false, reason: "empty_section" };

      const submitPromise = submitSectionPayload({ section, binding, finalSubmit });

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
        removePendingReport(storage, binding);
        store.clear();
        boundRideId = "";
      }
      return { ok: true, result };
    } catch (error) {
      enqueueCurrentSection(finalSubmit);
      return { ok: false, reason: String(error?.message || error).slice(0, 120) };
    } finally {
      flushInFlight = false;
    }
  }

  async function retryPendingReports() {
    await ensureConfig();
    const config = readCachedLocationReportingConfig(storage, nowMs());
    if (!roleMetricsEnabled(role, config)) return { ok: true, retried: 0 };

    const pending = readPendingQueue(storage).filter((row) => row.role === role);
    let acked = 0;
    for (const row of pending) {
      bumpPendingAttempt(storage, row);
      try {
        const result = await submitSectionPayload({
          section: row.section,
          binding: {
            rideId: row.rideId,
            assignmentSessionTokenHash: row.assignmentSessionTokenHash,
          },
          finalSubmit: row.finalSubmit,
        });
        if (result?.ok && !result?.skipped) {
          removePendingReport(storage, row);
          const current = store.getBinding();
          if (
            current &&
            current.rideId === row.rideId &&
            current.assignmentSessionTokenHash === row.assignmentSessionTokenHash
          ) {
            store.clear();
            boundRideId = "";
          }
          acked += 1;
        }
      } catch {
        /* keep in queue */
      }
    }
    return { ok: true, retried: pending.length, acked };
  }

  async function clearBinding({ flushFirst = true } = {}) {
    if (flushFirst && store.isBound()) {
      await flushFinal({ finalSubmit: true, timeoutMs: RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS });
    } else if (store.isBound() && (store.snapshotSection()?.submitSequence || 0) >= 1) {
      enqueueCurrentSection(true);
    }
    boundRideId = "";
    if (store.isBound()) {
      /* keep localStorage counters until server ack via pending retry */
      store.clearBindingOnly();
    }
  }

  return {
    bindForRide,
    syncCountersFromRuntime,
    noteGpsFix,
    noteVehicleWriteAttempted,
    noteVehicleWriteAcknowledged,
    noteVehicleWriteFailed,
    noteFirebaseReceive,
    noteP2pReceive,
    noteFirebaseRendered,
    noteP2pRendered,
    noteRendered,
    addVisibleMs,
    addBackgroundMs,
    flushFinal,
    retryPendingReports,
    clearBinding,
    isBound: () => store.isBound(),
    getBinding: () => store.getBinding(),
    getBoundRideId: () => boundRideId,
    snapshotSection: () => store.snapshotSection(),
    readPendingQueue: () => readPendingQueue(storage).filter((row) => row.role === role),
  };
}
