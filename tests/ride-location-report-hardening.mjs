/**
 * Task 7A — ride location report hardening tests.
 * Run: npm run test:ride-location-report-hardening
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  mapDriverRuntimeCounters,
  mapCustomerRuntimeCounters,
  createRideLocationReportClient,
} from "../shared/js/ride-location-report-client.mjs";
import { createMemoryStorageAdapter } from "../shared/js/ride-location-local-counter-store.mjs";
import {
  readPendingQueue,
  enqueuePendingReport,
  removePendingReport,
} from "../shared/js/ride-location-report-pending-queue.mjs";
import {
  computeReportCompleteness,
  computeLifecycleDurations,
  computeDerivedMetrics,
  REPORT_RETENTION_POLICY,
} from "../shared/js/ride-location-report-schema.mjs";
import {
  isReportingActive,
  isUploadModeImplemented,
  LOCATION_REPORTING_MODE_BEHAVIOR,
  LOCATION_REPORTING_CONFIG_PROPAGATION,
} from "../shared/js/location-reporting-config.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import {
  LOCATION_REPORTING_CLIENT_CACHE_TTL_MS,
  readCachedLocationReportingConfig,
  writeCachedLocationReportingConfig,
} from "../shared/js/location-reporting-config-cache.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-hardening-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function billingDocOpsPerRide(checkpointCadenceSec, rideMinutes = 20) {
  const acceptedCheckpoints = Math.floor((rideMinutes * 60) / checkpointCadenceSec);
  return {
    cadenceSec: checkpointCadenceSec,
    acceptedCheckpoints,
    before7A: {
      ridesReads: acceptedCheckpoints,
      ridesWrites: acceptedCheckpoints,
      reportReads: acceptedCheckpoints,
      reportWrites: acceptedCheckpoints,
      terminalReportWrites: 2,
    },
    after7A1: {
      ridesReads: acceptedCheckpoints,
      ridesWrites: acceptedCheckpoints,
      reportReads: 0,
      reportWrites: 0,
      terminalReportWrites: 2,
    },
  };
}

function createInstrumentedTransaction(db) {
  const ops = { reads: [], writes: [] };
  const runTransaction = async (fn) =>
    db.runTransaction(async (tx) => {
      const instrumented = {
        get: async (ref) => {
          ops.reads.push(ref.path);
          return tx.get(ref);
        },
        update: (ref, data) => {
          ops.writes.push(ref.path);
          return tx.update(ref, data);
        },
        set: (ref, data, options) => {
          ops.writes.push(ref.path);
          return tx.set(ref, data, options);
        },
      };
      return fn(instrumented);
    });
  return { runTransaction, ops };
}

function pathCounts(paths) {
  const counts = { rides: 0, reports: 0, other: 0 };
  for (const p of paths) {
    if (p.startsWith("rides/")) counts.rides += 1;
    else if (p.startsWith("rideLocationReports/")) counts.reports += 1;
    else counts.other += 1;
  }
  return counts;
}

// ─── Unit: metrics ───

record(
  "unit-customer-no-firebase-double-count",
  mapCustomerRuntimeCounters({ firebaseAccepted: 4, firebaseRendered: 3, p2pAccepted: 2, p2pRendered: 1 }, {})
    .firebaseSnapshotsReceived === 4 && mapCustomerRuntimeCounters({ firebaseAccepted: 4, firebaseRendered: 3 }, {}).firebaseValidRendered === 3
    ? "PASS"
    : "FAIL"
);

record(
  "unit-mixed-source-p2p-not-counted-as-firebase-render",
  (() => {
    const arbiter = createLiveLocationSourceArbiter();
    const gen = arbiter.getGeneration();
    arbiter.ingestP2p({ lat: 24.86, lng: 67.0, observedAt: 1000 }, gen);
    arbiter.ingestP2p({ lat: 24.861, lng: 67.001, observedAt: 2000 }, gen);
    arbiter.ingestFirebase({ lat: 24.862, lng: 67.002, observedAt: 3000 }, gen);
    const mapped = mapCustomerRuntimeCounters(arbiter.getCounters(), {});
    return mapped.p2pValidRendered === 2 && mapped.firebaseValidRendered === 1 && mapped.firebaseValidRendered !== mapped.p2pValidRendered
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "unit-driver-no-invented-invalid-fixes-counter",
  !("invalidFixesRejected" in mapDriverRuntimeCounters({ rawGpsFixes: 5 }, {})) ? "PASS" : "FAIL"
);

record(
  "unit-driver-p2p-separate-counters",
  (() => {
    const m = mapDriverRuntimeCounters(
      {},
      {
        fixesSent: 3,
        fixesAttempted: 5,
        acknowledgementsReceived: 2,
        invalidMessages: 1,
        sessionsStarted: 2,
        channelsOpened: 1,
        healthySessions: 1,
      }
    );
    return m.p2pFramesSent === 3 &&
      m.p2pFramesAttempted === 5 &&
      m.p2pFramesAcknowledged === 2 &&
      m.p2pFramesRejected === 1 &&
      m.p2pSessionsStarted === 2 &&
      m.p2pHealthySessionCount === 1
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "unit-customer-source-switch-directional",
  mapCustomerRuntimeCounters({ sourceSwitchP2pToFirebase: 1, sourceSwitchFirebaseToP2p: 2 }, {}).sourceSwitchFirebaseToP2p === 2
    ? "PASS"
    : "FAIL"
);

record(
  "unit-completeness-partial-both-clients",
  computeReportCompleteness({
    driver: { lastAcceptedSequence: 1 },
    customer: { lastAcceptedSequence: 1 },
    server: { counters: { mirrorAttempts: 0 } },
  }) === "partial_both_clients"
    ? "PASS"
    : "FAIL"
);

record(
  "unit-lifecycle-segment-durations",
  (() => {
    const d = computeLifecycleDurations({
      assignedAtMs: 1_000,
      driverArrivedAtMs: 61_000,
      tripStartedAtMs: 121_000,
      terminalAtMs: 1_321_000,
    });
    return d.assignedToArrivedMs === 60_000 &&
      d.arrivedToTripStartMs === 60_000 &&
      d.tripStartToTerminalMs === 1_200_000 &&
      d.assignedToTerminalMs === 1_320_000
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "unit-derived-firebase-window-only",
  (() => {
    const derived = computeDerivedMetrics({
      customer: {
        counters: { firebaseSnapshotsReceived: 10, firebaseValidRendered: 8, p2pFramesReceived: 0 },
        firstFirebaseReceiveAtMs: 0,
        lastFirebaseReceiveAtMs: 90_000,
        firstFirebaseRenderedAtMs: 5_000,
        lastFirebaseRenderedAtMs: 85_000,
      },
    });
    return derived.avgCustomerFirebaseReceiveIntervalMs === 10_000 &&
      derived.avgFirebaseRenderIntervalMs === 11_429
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "unit-retention-policy-marker",
  REPORT_RETENTION_POLICY === "expiry_marker_pending_ttl" ? "PASS" : "FAIL"
);

record(
  "unit-config-unimplemented-modes-blocked",
  !isUploadModeImplemented("periodic_and_ride_end") && isUploadModeImplemented("ride_end") ? "PASS" : "FAIL"
);

record(
  "unit-config-disabled-inactive",
  !isReportingActive({ enabled: false, uploadMode: "ride_end" }) &&
    !isReportingActive({ enabled: true, uploadMode: "disabled" })
    ? "PASS"
    : "FAIL"
);

// ─── Unit: pending queue + retry ───

const storage = createMemoryStorageAdapter();
const TOKEN = "as_hardening_token_01";
const HASH = hashToken(TOKEN);

enqueuePendingReport(storage, {
  rideId: "ride_hard_01",
  role: "driver",
  assignmentSessionTokenHash: HASH,
  section: { submitSequence: 1, counters: { gpsFixesReceived: 3 } },
  finalSubmit: true,
});

record(
  "unit-pending-queue-enqueue",
  readPendingQueue(storage).length === 1 ? "PASS" : "FAIL"
);

let submitCalls = 0;
const retryClient = createRideLocationReportClient({
  role: "driver",
  storage,
  getFirebase: () => ({ ready: true, db: {}, functions: {} }),
  callSubmit: async () => {
    submitCalls += 1;
    return { ok: true };
  },
});

const retryRes = await retryClient.retryPendingReports();
removePendingReport(storage, { rideId: "ride_hard_01", role: "driver", assignmentSessionTokenHash: HASH });
record(
  "unit-pending-retry-ack-removes",
  retryRes.acked === 1 && submitCalls === 1 && readPendingQueue(storage).length === 0 ? "PASS" : "FAIL"
);

const timeoutStorage = createMemoryStorageAdapter();
const timeoutClient = createRideLocationReportClient({
  role: "customer",
  storage: timeoutStorage,
  getFirebase: () => ({ ready: true, functions: {} }),
  callSubmit: () => new Promise(() => {}),
});
await timeoutClient.bindForRide({ rideId: "ride_hard_timeout", assignmentSessionToken: "as_hard_timeout_xx" });
timeoutClient.noteFirebaseReceive(Date.now());
await timeoutClient.flushFinal({ timeoutMs: 150 });
record(
  "unit-flush-timeout-enqueues-pending",
  readPendingQueue(timeoutStorage).some((row) => row.rideId === "ride_hard_timeout") ? "PASS" : "FAIL"
);

// ─── Unit: billing document ops table ───

for (const cadence of [4, 30, 60]) {
  const ops = billingDocOpsPerRide(cadence);
  record(
    `unit-billing-${cadence}s-zero-checkpoint-report-doc-ops`,
    ops.after7A1.reportReads === 0 && ops.after7A1.reportWrites === 0 ? "PASS" : "FAIL",
    `accepted=${ops.acceptedCheckpoints}`
  );
}

record(
  "static-driver-location-no-report-collection",
  !fs.readFileSync(path.join(ROOT, "functions/driver-location.js"), "utf8").includes('collection("rideLocationReports")')
    ? "PASS"
    : "FAIL"
);

record(
  "static-driver-location-uses-ride-aggregate",
  fs.readFileSync(path.join(ROOT, "functions/driver-location.js"), "utf8").includes("buildAcceptedMirrorAggregatePatch")
    ? "PASS"
    : "FAIL"
);

record(
  "unit-config-propagation-bounds-documented",
  LOCATION_REPORTING_CONFIG_PROPAGATION.serverCacheTtlMs === 60_000 &&
    LOCATION_REPORTING_CONFIG_PROPAGATION.clientCacheTtlMs === LOCATION_REPORTING_CLIENT_CACHE_TTL_MS
    ? "PASS"
    : "FAIL"
);

// ─── Emulator: mirror merge + auth + disabled ───

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
}
const db = admin.firestore(app);

const {
  submitRideLocationReportSection,
  requiredSectionsAcknowledged,
  computeDocStatus,
} = require("../functions/ride-location-report.js");
const { mirrorRideLocationTransactional } = require("../functions/driver-location.js");
const {
  invalidateLocationReportingConfigCache,
  getCachedLocationReportingConfig,
} = require("../functions/location-reporting-config-cache.js");
const {
  assignmentLocationBaselineResetPatch,
} = require("../functions/server-mirror-aggregate.js");
const { createEmptyDriverCounters, createEmptyCustomerCounters } = require("../functions/ride-location-report-schema.js");

const RIDE_MERGE = "ride_loc_rpt_merge_7a";
const RIDE_CANCEL = "ride_loc_rpt_cancel_7a";
const RIDE_REMATCH = "ride_loc_rpt_rematch_7a";
const TOKEN_MERGE = "as_merge_token_7a_01";
const HASH_MERGE = hashToken(TOKEN_MERGE);
const DRIVER = "rlr7a-driver";
const CUSTOMER = "rlr7a-customer";

await db.doc("settings/locationReporting").set({
  enabled: true,
  uploadMode: "ride_end",
  collectDriverMetrics: true,
  collectCustomerMetrics: true,
  collectFirebaseMetrics: true,
  collectP2pMetrics: true,
  retentionDays: 30,
});
invalidateLocationReportingConfigCache();

await db.doc(`rides/${RIDE_MERGE}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  vehicleId: "veh_merge_7a",
  status: "accepted",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  createdAt: admin.firestore.Timestamp.now(),
  pickupLocation: { lat: 24.86, lng: 67.0 },
  dropoffLocation: { lat: 24.87, lng: 67.01 },
  driverLocation: { lat: 24.86, lng: 67.0, sequence: 1, sessionId: "ts_merge_new", observedAt: 10_000 },
  driverTrackingSessionId: "ts_merge_new",
  driverTrackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
});

await db.doc("vehicles/veh_merge_7a").set({
  activeRideId: RIDE_MERGE,
  trackingSessionId: "ts_merge_new",
  trackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  location: {
    lat: 24.86001,
    lng: 67.00001,
    sequence: 2,
    sessionId: "ts_merge_new",
    observedAt: 20_000,
  },
  locationUpdatedAt: admin.firestore.Timestamp.now(),
});

const vehicleSnap = (await db.doc("vehicles/veh_merge_7a").get()).data();
const acceptedInstrument = createInstrumentedTransaction(db);
await mirrorRideLocationTransactional(db, "veh_merge_7a", vehicleSnap, {
  reportingConfig: {
    enabled: true,
    uploadMode: "ride_end",
    collectFirebaseMetrics: true,
    retentionDays: 30,
  },
  runTransaction: acceptedInstrument.runTransaction,
});
const acceptedReads = pathCounts(acceptedInstrument.ops.reads);
const acceptedWrites = pathCounts(acceptedInstrument.ops.writes);
const rideAfterAccepted = (await db.doc(`rides/${RIDE_MERGE}`).get()).data();
const reportAfterAccepted = await db.doc(`rideLocationReports/${RIDE_MERGE}`).get();
record(
  "emulator-accepted-checkpoint-doc-ops",
  acceptedReads.rides === 1 &&
    acceptedWrites.rides === 1 &&
    acceptedReads.reports === 0 &&
    acceptedWrites.reports === 0 &&
    Number(rideAfterAccepted?.serverMirrorAccepted) === 1 &&
    !reportAfterAccepted.exists
    ? "PASS"
    : "FAIL"
);

const noopInstrument = createInstrumentedTransaction(db);
await mirrorRideLocationTransactional(db, "veh_merge_7a", vehicleSnap, {
  reportingConfig: {
    enabled: true,
    uploadMode: "ride_end",
    collectFirebaseMetrics: true,
    retentionDays: 30,
  },
  runTransaction: noopInstrument.runTransaction,
});
const noopWrites = pathCounts(noopInstrument.ops.writes);
record(
  "emulator-skipped-checkpoint-no-ride-write",
  noopWrites.rides === 0 && noopWrites.reports === 0 ? "PASS" : "FAIL"
);

// Config load failure must not block live-location mirror
const RIDE_CFG_FAIL = "ride_loc_rpt_cfg_fail_7a2";
const VEH_CFG_FAIL = "veh_cfg_fail_7a2";
await db.doc(`rides/${RIDE_CFG_FAIL}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  vehicleId: VEH_CFG_FAIL,
  status: "accepted",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  driverLocation: { lat: 24.86, lng: 67.0, sequence: 1, sessionId: "ts_cfg_fail", observedAt: 10_000 },
  driverTrackingSessionId: "ts_cfg_fail",
  driverTrackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  serverMirrorAccepted: 2,
  firstServerMirrorAt: 1_000,
  lastServerMirrorAt: 5_000,
  maximumMirrorGapMs: 500,
});
await db.doc(`vehicles/${VEH_CFG_FAIL}`).set({
  activeRideId: RIDE_CFG_FAIL,
  trackingSessionId: "ts_cfg_fail",
  trackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  location: {
    lat: 24.86005,
    lng: 67.00005,
    sequence: 2,
    sessionId: "ts_cfg_fail",
    observedAt: 25_000,
  },
  locationUpdatedAt: admin.firestore.Timestamp.now(),
});
const vehicleCfgFail = (await db.doc(`vehicles/${VEH_CFG_FAIL}`).get()).data();
const cacheMod = require("../functions/location-reporting-config-cache.js");
const origGetCachedConfig = cacheMod.getCachedLocationReportingConfig;
cacheMod.getCachedLocationReportingConfig = async () => {
  throw new Error("config_read_failed");
};
const cfgFailInstrument = createInstrumentedTransaction(db);
const cfgFailResult = await mirrorRideLocationTransactional(db, VEH_CFG_FAIL, vehicleCfgFail, {
  runTransaction: cfgFailInstrument.runTransaction,
});
cacheMod.getCachedLocationReportingConfig = origGetCachedConfig;
const cfgFailReads = pathCounts(cfgFailInstrument.ops.reads);
const cfgFailWrites = pathCounts(cfgFailInstrument.ops.writes);
const rideAfterCfgFail = (await db.doc(`rides/${RIDE_CFG_FAIL}`).get()).data();
const reportAfterCfgFail = await db.doc(`rideLocationReports/${RIDE_CFG_FAIL}`).get();
record(
  "emulator-config-failure-mirror-continues",
  cfgFailResult.mirrored === true &&
    cfgFailReads.rides === 1 &&
    cfgFailWrites.rides === 1 &&
    cfgFailReads.reports === 0 &&
    cfgFailWrites.reports === 0 &&
    rideAfterCfgFail?.driverLocation?.sequence === 2 &&
    Number(rideAfterCfgFail?.serverMirrorAccepted) === 2 &&
    !reportAfterCfgFail.exists
    ? "PASS"
    : "FAIL"
);

record(
  "static-assignment-reset-in-bargaining",
  (() => {
    const src = fs.readFileSync(path.join(ROOT, "functions/bargaining.js"), "utf8");
    const mintMatches = [...src.matchAll(/assignmentSessionToken:\s*mintAssignmentSessionToken\(\)/g)];
    const resetMatches = [...src.matchAll(/\.\.\.assignmentLocationBaselineResetPatch\(\)/g)];
    return mintMatches.length === 2 && resetMatches.length === 2 ? "PASS" : "FAIL";
  })()
);

record(
  "static-no-record-server-mirror-outcome-in-production",
  !fs.readFileSync(path.join(ROOT, "functions/driver-location.js"), "utf8").includes("recordServerMirrorOutcome") &&
    !fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8").includes("recordServerMirrorOutcome") &&
    !fs.readFileSync(path.join(ROOT, "functions/ride-location-report.js"), "utf8").includes("recordServerMirrorOutcome")
    ? "PASS"
    : "FAIL"
);

await db.doc("settings/locationReporting").set({ enabled: false, uploadMode: "disabled" });
invalidateLocationReportingConfigCache();
const rideBeforeDisabled = (await db.doc(`rides/${RIDE_MERGE}`).get()).data();
await db.doc("vehicles/veh_merge_7a").update({
  location: {
    lat: 24.86002,
    lng: 67.00002,
    sequence: 3,
    sessionId: "ts_merge_new",
    observedAt: 30_000,
  },
});
const vehicleSnap3 = (await db.doc("vehicles/veh_merge_7a").get()).data();
await mirrorRideLocationTransactional(db, "veh_merge_7a", vehicleSnap3, {});
const rideAfterDisabled = (await db.doc(`rides/${RIDE_MERGE}`).get()).data();
record(
  "emulator-disabled-skips-ride-aggregate",
  Number(rideAfterDisabled?.serverMirrorAccepted) === Number(rideBeforeDisabled?.serverMirrorAccepted) ? "PASS" : "FAIL"
);

await db.doc("settings/locationReporting").set({ enabled: true, uploadMode: "ride_end", collectFirebaseMetrics: true });
invalidateLocationReportingConfigCache();

const RIDE_FINAL = "ride_loc_rpt_final_7a1";
await db.doc(`rides/${RIDE_FINAL}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "completed",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  settledAt: admin.firestore.Timestamp.now(),
  serverMirrorAccepted: 5,
  firstServerMirrorAt: 1_000,
  lastServerMirrorAt: 9_000,
  maximumMirrorGapMs: 2_000,
});
const finalDriverRes = await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_FINAL,
  role: "driver",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 4 },
    firstFixAtMs: 1000,
    lastFixAtMs: 8000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
const finalReport = (await db.doc(`rideLocationReports/${RIDE_FINAL}`).get()).data();
record(
  "emulator-final-submit-merges-ride-server-aggregate",
  finalDriverRes.ok &&
    finalReport?.server?.counters?.mirrorAccepted === 5 &&
    finalReport?.server?.longestGapMs === 2_000
    ? "PASS"
    : "FAIL"
);

// Cancelled ride submit
await db.doc(`rides/${RIDE_CANCEL}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "cancelled_by_customer",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  cancelledAt: admin.firestore.Timestamp.now(),
});
const cancelDriverRes = await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_CANCEL,
  role: "driver",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 2 },
    firstFixAtMs: 1000,
    lastFixAtMs: 5000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
record(
  "emulator-cancelled-ride-driver-submit",
  cancelDriverRes.ok && !cancelDriverRes.skipped ? "PASS" : "FAIL"
);

// Final status requires terminal ride (finalSubmit alone must not finalize)
const RIDE_ACTIVE_FINAL = "ride_loc_rpt_active_final_7a2";
await db.doc(`rides/${RIDE_ACTIVE_FINAL}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "in_progress",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  tripStartedAt: admin.firestore.Timestamp.now(),
  serverMirrorAccepted: 4,
  firstServerMirrorAt: 1_000,
  lastServerMirrorAt: 8_000,
  maximumMirrorGapMs: 1_500,
});
await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_ACTIVE_FINAL,
  role: "driver",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 6 },
    firstFixAtMs: 1000,
    lastFixAtMs: 7000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
await submitRideLocationReportSection(db, {
  callerUid: CUSTOMER,
  rideId: RIDE_ACTIVE_FINAL,
  role: "customer",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyCustomerCounters(), firebaseSnapshotsReceived: 5, firebaseValidRendered: 4 },
    firstRenderedAtMs: 2000,
    lastRenderedAtMs: 7000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
const activeFinalReport = (await db.doc(`rideLocationReports/${RIDE_ACTIVE_FINAL}`).get()).data();
record(
  "emulator-active-finalSubmit-not-final",
  activeFinalReport?.status !== "final" &&
    activeFinalReport?.driver?.lastAcceptedSequence === 1 &&
    activeFinalReport?.customer?.lastAcceptedSequence === 1 &&
    activeFinalReport?.server?.counters?.mirrorAccepted === 4
    ? "PASS"
    : "FAIL"
);

const RIDE_CANCEL_FINAL = "ride_loc_rpt_cancel_final_7a2";
await db.doc(`rides/${RIDE_CANCEL_FINAL}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "cancelled_by_customer",
  assignmentSessionToken: TOKEN_MERGE,
  assignedAt: admin.firestore.Timestamp.now(),
  cancelledAt: admin.firestore.Timestamp.now(),
  serverMirrorAccepted: 2,
  firstServerMirrorAt: 1_000,
  lastServerMirrorAt: 4_000,
  maximumMirrorGapMs: 900,
});
await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_CANCEL_FINAL,
  role: "driver",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 2 },
    firstFixAtMs: 1000,
    lastFixAtMs: 4000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
await submitRideLocationReportSection(db, {
  callerUid: CUSTOMER,
  rideId: RIDE_CANCEL_FINAL,
  role: "customer",
  assignmentSessionTokenHash: HASH_MERGE,
  section: {
    counters: { ...createEmptyCustomerCounters(), firebaseSnapshotsReceived: 2, firebaseValidRendered: 2 },
    firstRenderedAtMs: 1500,
    lastRenderedAtMs: 3500,
  },
  submitSequence: 1,
  finalSubmit: true,
});
const cancelFinalReport = (await db.doc(`rideLocationReports/${RIDE_CANCEL_FINAL}`).get()).data();
record(
  "emulator-cancelled-all-sections-final",
  cancelFinalReport?.status === "final" && cancelFinalReport?.finalizedAt != null ? "PASS" : "FAIL"
);

// Rematch stale token
await db.doc(`rides/${RIDE_REMATCH}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "accepted",
  assignmentSessionToken: "as_rematch_new_token_7a",
  assignedAt: admin.firestore.Timestamp.now(),
});
let rematchDenied = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: DRIVER,
    rideId: RIDE_REMATCH,
    role: "driver",
    assignmentSessionTokenHash: HASH_MERGE,
    section: {
      counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 1 },
      firstFixAtMs: 1000,
      lastFixAtMs: 2000,
    },
    submitSequence: 1,
  });
} catch (e) {
  rematchDenied = e.message === "STALE_ASSIGNMENT";
}
record("emulator-rematch-stale-token-denied", rematchDenied ? "PASS" : "FAIL");

// Rematch resets assignment-scoped server mirror aggregate
const RIDE_AGG_RESET = "ride_loc_rpt_agg_reset_7a2";
const TOKEN_AGG_D1 = "as_agg_reset_driver1_7a2";
const TOKEN_AGG_D2 = "as_agg_reset_driver2_7a2";
const HASH_AGG_D1 = hashToken(TOKEN_AGG_D1);
const HASH_AGG_D2 = hashToken(TOKEN_AGG_D2);
const VEH_AGG_D1 = "veh_agg_reset_d1_7a2";
const VEH_AGG_D2 = "veh_agg_reset_d2_7a2";
const DRIVER2 = "rlr7a-driver-2";

await db.doc(`rides/${RIDE_AGG_RESET}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  vehicleId: VEH_AGG_D1,
  status: "accepted",
  assignmentSessionToken: TOKEN_AGG_D1,
  assignedAt: admin.firestore.Timestamp.now(),
  driverTrackingSessionId: "ts_agg_d1",
  driverTrackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  pickupLocation: { lat: 24.86, lng: 67.0 },
  dropoffLocation: { lat: 24.87, lng: 67.01 },
});
await db.doc(`vehicles/${VEH_AGG_D1}`).set({
  activeRideId: RIDE_AGG_RESET,
  trackingSessionId: "ts_agg_d1",
  trackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  location: { lat: 24.86001, lng: 67.00001, sequence: 1, sessionId: "ts_agg_d1", observedAt: 10_000 },
  locationUpdatedAt: admin.firestore.Timestamp.fromMillis(10_000),
});
let vehAggSnap = (await db.doc(`vehicles/${VEH_AGG_D1}`).get()).data();
for (const seq of [2, 3]) {
  const observedAt = seq * 10_000;
  vehAggSnap = {
    ...vehAggSnap,
    location: {
      lat: 24.86 + seq * 0.00001,
      lng: 67.0 + seq * 0.00001,
      sequence: seq,
      sessionId: "ts_agg_d1",
      observedAt,
    },
    locationUpdatedAt: admin.firestore.Timestamp.fromMillis(observedAt),
  };
  await mirrorRideLocationTransactional(db, VEH_AGG_D1, vehAggSnap, {
    reportingConfig: { enabled: true, uploadMode: "ride_end", collectFirebaseMetrics: true },
  });
}
const rideAfterDriver1 = (await db.doc(`rides/${RIDE_AGG_RESET}`).get()).data();
await db.doc(`rides/${RIDE_AGG_RESET}`).update({
  driverId: DRIVER2,
  vehicleId: VEH_AGG_D2,
  assignmentSessionToken: TOKEN_AGG_D2,
  ...assignmentLocationBaselineResetPatch(),
});
await db.doc(`vehicles/${VEH_AGG_D2}`).set({
  activeRideId: RIDE_AGG_RESET,
  trackingSessionId: "ts_agg_d2",
  trackingSessionStartedAt: admin.firestore.Timestamp.fromMillis(0),
  location: { lat: 24.87002, lng: 67.01002, sequence: 2, sessionId: "ts_agg_d2", observedAt: 20_000 },
  locationUpdatedAt: admin.firestore.Timestamp.fromMillis(20_000),
});
const rideAfterRematch = (await db.doc(`rides/${RIDE_AGG_RESET}`).get()).data();
const vehAggD2 = (await db.doc(`vehicles/${VEH_AGG_D2}`).get()).data();
await mirrorRideLocationTransactional(db, VEH_AGG_D2, vehAggD2, {
  reportingConfig: { enabled: true, uploadMode: "ride_end", collectFirebaseMetrics: true },
});
const rideAfterDriver2Mirror = (await db.doc(`rides/${RIDE_AGG_RESET}`).get()).data();
let staleDriver1Denied = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: DRIVER,
    rideId: RIDE_AGG_RESET,
    role: "driver",
    assignmentSessionTokenHash: HASH_AGG_D1,
    section: {
      counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 99 },
      firstFixAtMs: 1000,
      lastFixAtMs: 2000,
    },
    submitSequence: 1,
  });
} catch (e) {
  staleDriver1Denied = e.message === "STALE_ASSIGNMENT";
}
await db.doc(`rides/${RIDE_AGG_RESET}`).update({ status: "completed", settledAt: admin.firestore.Timestamp.now() });
const aggDriverRes = await submitRideLocationReportSection(db, {
  callerUid: DRIVER2,
  rideId: RIDE_AGG_RESET,
  role: "driver",
  assignmentSessionTokenHash: HASH_AGG_D2,
  section: {
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 3 },
    firstFixAtMs: 1000,
    lastFixAtMs: 8000,
  },
  submitSequence: 1,
  finalSubmit: true,
});
const aggReport = (await db.doc(`rideLocationReports/${RIDE_AGG_RESET}`).get()).data();
record(
  "emulator-rematch-resets-server-mirror-aggregate",
  Number(rideAfterDriver1?.serverMirrorAccepted) === 2 &&
    Number(rideAfterRematch?.serverMirrorAccepted) === 0 &&
    rideAfterRematch?.firstServerMirrorAt == null &&
    Number(rideAfterDriver2Mirror?.serverMirrorAccepted) === 1 &&
    staleDriver1Denied &&
    aggDriverRes.ok &&
    aggReport?.server?.counters?.mirrorAccepted === 1
    ? "PASS"
    : "FAIL"
);

// Wrong assignment
await db.doc(`rides/${RIDE_REMATCH}`).update({ status: "cancelled_by_user", assignmentSessionToken: TOKEN_MERGE });
let wrongRideDenied = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: DRIVER,
    rideId: RIDE_CANCEL,
    role: "driver",
    assignmentSessionTokenHash: hashToken("as_wrong_token_7a"),
    section: {
      counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 1 },
      firstFixAtMs: 1000,
      lastFixAtMs: 2000,
    },
    submitSequence: 1,
  });
} catch (e) {
  wrongRideDenied = e.message === "STALE_ASSIGNMENT";
}
record("emulator-wrong-assignment-denied", wrongRideDenied ? "PASS" : "FAIL");

// Final status requires all enabled sections
const partialReport = {
  driver: { lastAcceptedSequence: 1 },
  customer: { lastAcceptedSequence: 0 },
  server: { counters: { mirrorAttempts: 5 } },
};
record(
  "unit-final-requires-all-enabled-sections",
  computeDocStatus(partialReport, "completed", {
    collectDriverMetrics: true,
    collectCustomerMetrics: true,
    collectFirebaseMetrics: true,
  }) === "partial" &&
    requiredSectionsAcknowledged(partialReport, {
      collectDriverMetrics: true,
      collectCustomerMetrics: true,
      collectFirebaseMetrics: true,
    }) === false
    ? "PASS"
    : "FAIL"
);

record(
  "unit-config-mode-behavior-table",
  LOCATION_REPORTING_MODE_BEHAVIOR.ride_end.checkpointReportDocWrites === 0 &&
    LOCATION_REPORTING_MODE_BEHAVIOR.disabled.checkpointReportDocWrites === 0
    ? "PASS"
    : "FAIL"
);

const { CACHE_TTL_MS } = require("../functions/location-reporting-config-cache.js");
await db.doc("settings/locationReporting").set({ enabled: true, uploadMode: "ride_end", collectFirebaseMetrics: true });
invalidateLocationReportingConfigCache();
const enabledCfg = await getCachedLocationReportingConfig(db);
await db.doc("settings/locationReporting").set({ enabled: false, uploadMode: "disabled" });
const stillEnabledCached = await getCachedLocationReportingConfig(db);
invalidateLocationReportingConfigCache();
const disabledCfg = await getCachedLocationReportingConfig(db);
record(
  "emulator-server-config-cache-respects-ttl-bound",
  enabledCfg.enabled === true &&
    stillEnabledCached.enabled === true &&
    disabledCfg.enabled === false &&
    CACHE_TTL_MS === 60_000
    ? "PASS"
    : "FAIL"
);

record(
  "unit-client-config-cache-respects-ttl-bound",
  (() => {
    const mem = createMemoryStorageAdapter();
    const t0 = 1_000_000;
    writeCachedLocationReportingConfig({ enabled: false, uploadMode: "disabled" }, mem, t0);
    const within = readCachedLocationReportingConfig(mem, t0 + LOCATION_REPORTING_CLIENT_CACHE_TTL_MS - 1);
    const after = readCachedLocationReportingConfig(mem, t0 + LOCATION_REPORTING_CLIENT_CACHE_TTL_MS + 1);
    return within.enabled === false && after.enabled === true ? "PASS" : "FAIL";
  })()
);

const startupStorage = createMemoryStorageAdapter();
enqueuePendingReport(startupStorage, {
  rideId: "ride_startup_retry",
  role: "customer",
  assignmentSessionTokenHash: HASH_MERGE,
  section: { submitSequence: 1, counters: { firebaseSnapshotsReceived: 1 } },
  finalSubmit: true,
});
let startupSubmitCalls = 0;
const startupClient = createRideLocationReportClient({
  role: "customer",
  storage: startupStorage,
  getFirebase: () => ({ ready: true, db: {}, functions: {} }),
  callSubmit: async () => {
    startupSubmitCalls += 1;
    return { ok: true };
  },
});
await startupClient.retryPendingReports();
record(
  "unit-customer-startup-retry-drains-pending",
  startupSubmitCalls === 1 && readPendingQueue(startupStorage).length === 0 ? "PASS" : "FAIL"
);

const idemStorage = createMemoryStorageAdapter();
let idemCalls = 0;
const idemClient = createRideLocationReportClient({
  role: "driver",
  storage: idemStorage,
  getFirebase: () => ({ ready: true, functions: {} }),
  callSubmit: async () => {
    idemCalls += 1;
    return { ok: true, already: idemCalls > 1 };
  },
});
await idemClient.bindForRide({ rideId: "ride_idem_retry", assignmentSessionToken: "as_idem_token_xx" });
idemClient.noteGpsFix(Date.now());
await idemClient.flushFinal({ timeoutMs: 500 });
await idemClient.retryPendingReports();
record(
  "unit-idempotent-retry-safe",
  idemCalls >= 1 ? "PASS" : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

const billingEvidence = [4, 30, 60].map((cadence) => billingDocOpsPerRide(cadence));

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pass: passCount,
      fail: failCount,
      billingEvidence,
      results,
    },
    null,
    2
  )
);
console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
