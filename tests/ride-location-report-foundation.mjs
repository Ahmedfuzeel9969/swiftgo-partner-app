/**
 * Ride location report foundation — schema, config, local counter store unit tests.
 * Run: npm run test:ride-location-report-foundation
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  LOCATION_REPORTING_DEFAULTS,
  normalizeLocationReportingConfig,
  getSafeLocationReportingConfig,
  validateRetentionDaysForCallable,
  validateUploadModeForCallable,
  buildValidatedLocationReportingSettings,
} from "../shared/js/location-reporting-config.mjs";
import {
  averageIntervalMs,
  buildLocalReportSummary,
  classifyReportHealth,
  computeDerivedMetrics,
  computeLifecycleDurations,
  createEmptyDriverCounters,
  safeRatio,
  shouldAcceptSubmitSequence,
  validateCustomerSubmitSection,
  validateDriverSubmitSection,
  hashAssignmentSessionTokenAsync,
} from "../shared/js/ride-location-report-schema.mjs";
import {
  createMemoryStorageAdapter,
  createRideLocationLocalCounterStore,
} from "../shared/js/ride-location-local-counter-store.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-foundation-results.json");

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const RIDE_A = "ride_loc_report_a1";
const RIDE_B = "ride_loc_report_b2";
const TOKEN_1 = "as_test_token_loc_01";
const TOKEN_2 = "as_test_token_loc_02";
const HASH_1 = hashToken(TOKEN_1);
const HASH_2 = hashToken(TOKEN_2);

record(
  "config-safe-defaults",
  (() => {
    const cfg = getSafeLocationReportingConfig();
    return cfg.uploadMode === "ride_end" &&
      cfg.enabled === true &&
      cfg.retentionDays === 30 &&
      cfg.finalUploadRequired === true
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "config-rejects-string-retention",
  normalizeLocationReportingConfig({ retentionDays: "30" }).retentionDays ===
    LOCATION_REPORTING_DEFAULTS.retentionDays
    ? "PASS"
    : "FAIL"
);

record(
  "config-rejects-invalid-upload-mode",
  normalizeLocationReportingConfig({ uploadMode: "every_second" }).uploadMode === "ride_end"
    ? "PASS"
    : "FAIL"
);

record(
  "config-disabled-mode-forces-enabled-false",
  normalizeLocationReportingConfig({ uploadMode: "disabled" }).enabled === false ? "PASS" : "FAIL"
);

record(
  "config-callable-validators-strict-integers",
  validateRetentionDaysForCallable(30) &&
    !validateRetentionDaysForCallable(6.5) &&
    validateUploadModeForCallable("ride_end") &&
    !validateUploadModeForCallable("bogus")
    ? "PASS"
    : "FAIL"
);

record(
  "config-callable-build-validated-settings",
  (() => {
    try {
      const cfg = buildValidatedLocationReportingSettings({
        enabled: true,
        uploadMode: "ride_end",
        periodicIntervalMinutes: 10,
        uploadOnAnomaly: false,
        finalUploadRequired: true,
        collectDriverMetrics: true,
        collectCustomerMetrics: true,
        collectFirebaseMetrics: true,
        collectP2pMetrics: true,
        retentionDays: 30,
      });
      return cfg.uploadMode === "ride_end" ? "PASS" : "FAIL";
    } catch {
      return "FAIL";
    }
  })()
);

record(
  "driver-submit-rejects-forbidden-lat",
  validateDriverSubmitSection({ lat: 24.8, counters: createEmptyDriverCounters() }).ok === false
    ? "PASS"
    : "FAIL"
);

record(
  "driver-submit-rejects-string-counter",
  validateDriverSubmitSection({
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: "5" },
  }).ok === false
    ? "PASS"
    : "FAIL"
);

record(
  "customer-submit-accepts-valid-section",
  validateCustomerSubmitSection({
    counters: { firebaseSnapshotsReceived: 3, firebaseValidRendered: 2 },
    firstRenderedAtMs: 1_000,
    lastRenderedAtMs: 10_000,
  }).ok
    ? "PASS"
    : "FAIL"
);

record(
  "derived-average-null-when-count-lt-2",
  averageIntervalMs(1_000, 10_000, 1) === null ? "PASS" : "FAIL"
);

record(
  "derived-average-computed-when-count-ge_2",
  averageIntervalMs(1_000, 10_000, 3) === 4500 ? "PASS" : "FAIL"
);

record(
  "derived-safe-ratio-null-on-zero-denominator",
  safeRatio(5, 0) === null ? "PASS" : "FAIL"
);

record(
  "compute-derived-all-null-with-empty-sections",
  (() => {
    const d = computeDerivedMetrics({});
    return (
      d.avgDriverGpsIntervalMs === null &&
      d.deliveryRatios.mirrorToGps === null &&
      d.deliveryRatios.renderedToReceived === null
    )
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "compute-derived-populated-sample",
  (() => {
    const d = computeDerivedMetrics({
      driver: {
        counters: { gpsFixesReceived: 4, vehicleWritesAcknowledged: 4, p2pFramesSent: 2 },
        firstFixAtMs: 0,
        lastFixAtMs: 12_000,
      },
      server: {
        counters: { mirrorAccepted: 4 },
        firstMirrorAtMs: 1_000,
        lastMirrorAtMs: 10_000,
      },
      customer: {
        counters: {
          firebaseSnapshotsReceived: 4,
          firebaseValidRendered: 3,
          p2pFramesReceived: 2,
          p2pValidRendered: 2,
        },
        firstRenderedAtMs: 2_000,
        lastRenderedAtMs: 11_000,
      },
    });
    return d.avgDriverGpsIntervalMs === 4000 && d.deliveryRatios.mirrorToGps === 1 ? "PASS" : "FAIL";
  })()
);

record(
  "lifecycle-duration-derived",
  (() => {
    const lc = computeLifecycleDurations({
      bookingCreatedAtMs: 1_000,
      assignedAtMs: 61_000,
      tripStartedAtMs: 121_000,
      settledAtMs: 301_000,
    });
    return lc.bookingToAssignmentMs === 60_000 && lc.inProgressMs === 180_000 ? "PASS" : "FAIL";
  })()
);

record(
  "health-insufficient-data-empty",
  classifyReportHealth({}).status === "insufficient_data" ? "PASS" : "FAIL"
);

record(
  "health-warning-on-long-gap",
  classifyReportHealth({
    driver: { counters: { gpsFixesReceived: 5 }, longestGapMs: 35_000 },
  }).status === "warning"
    ? "PASS"
    : "FAIL"
);

record(
  "submit-sequence-monotonic",
  shouldAcceptSubmitSequence(2, 2) === false &&
    shouldAcceptSubmitSequence(2, 3) === true &&
    shouldAcceptSubmitSequence(0, 1) === true
    ? "PASS"
    : "FAIL"
);

record(
  "build-local-report-summary-driver",
  (() => {
    const built = buildLocalReportSummary({
      rideId: RIDE_A,
      assignmentSessionTokenHash: HASH_1,
      role: "driver",
      section: {
        counters: { gpsFixesReceived: 2 },
        firstFixAtMs: 100,
        lastFixAtMs: 5000,
      },
    });
    return built.ok && built.summary.role === "driver" ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-bind-and-increment",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "driver", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.incrementCounter("gpsFixesReceived", 2);
    store.recordEventAtMs(1_000);
    store.recordEventAtMs(5_000);
    const section = store.snapshotSection();
    return section?.counters?.gpsFixesReceived === 2 && section.firstFixAtMs === 1_000
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "counter-store-persists-across-instance",
  (() => {
    const storage = createMemoryStorageAdapter();
    const a = createRideLocationLocalCounterStore({ role: "driver", storage });
    a.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    a.incrementCounter("vehicleWritesAcknowledged", 7);
    const b = createRideLocationLocalCounterStore({ role: "driver", storage });
    b.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    return b.snapshotSection()?.counters?.vehicleWritesAcknowledged === 7 ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-isolated-by-token-hash",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "driver", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.incrementCounter("gpsFixesReceived", 4);
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_2 });
    return store.snapshotSection()?.counters?.gpsFixesReceived === 0 ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-isolated-by-ride-id",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "customer", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.incrementCounter("firebaseSnapshotsReceived", 9);
    store.bind({ rideId: RIDE_B, assignmentSessionTokenHash: HASH_1 });
    return store.snapshotSection()?.counters?.firebaseSnapshotsReceived === 0 ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-gap-tracking",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "driver", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.recordEventAtMs(1_000);
    store.recordEventAtMs(4_000);
    store.recordEventAtMs(10_000);
    return store.snapshotSection()?.longestGapMs === 6_000 ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-customer-visible-duration",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "customer", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.addVisibleDurationMs(1500);
    store.addBackgroundDurationMs(500);
    const section = store.snapshotSection();
    return section?.visibleDurationMs === 1500 && section?.backgroundDurationMs === 500
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "counter-store-clear-removes-binding",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "driver", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.incrementCounter("gpsFixesReceived", 1);
    store.clear();
    return store.isBound() === false && store.snapshotSection() === null ? "PASS" : "FAIL";
  })()
);

record(
  "counter-store-apply-counter-snapshot",
  (() => {
    const storage = createMemoryStorageAdapter();
    const store = createRideLocationLocalCounterStore({ role: "driver", storage });
    store.bind({ rideId: RIDE_A, assignmentSessionTokenHash: HASH_1 });
    store.applyCounterSnapshot({ gpsFixesReceived: 7, vehicleWritesAcknowledged: 4 });
    const section = store.snapshotSection();
    return section?.counters?.gpsFixesReceived === 7 &&
      section?.counters?.vehicleWritesAcknowledged === 4
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "static-forbidden-keys-documented",
  read("shared/js/ride-location-report-schema.mjs").includes("FORBIDDEN_REPORT_PAYLOAD_KEYS")
    ? "PASS"
    : "FAIL"
);

record(
  "static-functions-cjs-mirrors-exist",
  fs.existsSync(path.join(ROOT, "functions/location-reporting-config.js")) &&
    fs.existsSync(path.join(ROOT, "functions/ride-location-report-schema.js"))
    ? "PASS"
    : "FAIL"
);

record(
  "cjs-config-parity",
  (() => {
    const cjs = require("../functions/location-reporting-config.js");
    const esm = normalizeLocationReportingConfig({ retentionDays: 45, uploadMode: "ride_end" });
    const cjsNorm = cjs.normalizeLocationReportingConfig({ retentionDays: 45, uploadMode: "ride_end" });
    return esm.retentionDays === cjsNorm.retentionDays && esm.uploadMode === cjsNorm.uploadMode
      ? "PASS"
      : "FAIL";
  })()
);

const hashTest = await hashAssignmentSessionTokenAsync(TOKEN_1);
record("hash-assignment-token-async", hashTest === HASH_1 ? "PASS" : "FAIL");

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pass: passCount,
      fail: failCount,
      results,
    },
    null,
    2
  )
);

console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
