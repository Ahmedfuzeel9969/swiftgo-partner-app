/**
 * Regression checks for the real-ride frozen-marker incident.
 * Run: node tests/live-location-terminal-reliability.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRideLocationReportClient,
  mapDriverRuntimeCounters,
} from "../shared/js/ride-location-report-client.mjs";
import { classifyReportHealth } from "../shared/js/ride-location-report-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// A valid fix is still valid when the cost-aware checkpoint gate skips its
// Firebase write. The real ride had 11 validated fixes and only two writes;
// the old mapping incorrectly reported zero valid fixes.
{
  const mapped = mapDriverRuntimeCounters(
    {
      rawGpsFixes: 11,
      rejectedInterval: 8,
      rejectedMovementNoop: 3,
      writesAttempted: 2,
      writesCommitted: 2,
    },
    {},
    {}
  );
  record(
    "checkpoint-cadence-skips-remain-valid-gps",
    mapped.gpsFixesReceived === 11 &&
      mapped.validFixesAccepted === 11 &&
      mapped.duplicateOrOutOfOrderRejected === 0 &&
      mapped.vehicleWritesAcknowledged === 2,
    `gps=${mapped.gpsFixesReceived} valid=${mapped.validFixesAccepted}`
  );
}

// Accepted-fix counters must survive a terminal runtime reset. This guards the
// brief teardown window between the last live fix and the final report flush.
{
  const storage = memoryStorage();
  let submitted = null;
  const client = createRideLocationReportClient({
    role: "driver",
    storage,
    getFirebase: () => ({ ready: true, functions: {} }),
    getRuntimeCounters: () => ({ checkpoint: {}, p2p: {}, native: {} }),
    callSubmit: async (payload) => {
      submitted = payload;
      return { ok: true };
    },
  });
  await client.bindForRide({
    rideId: "ride_durable_driver_fix_01",
    assignmentSessionToken: "d".repeat(32),
  });
  for (let i = 0; i < 11; i += 1) client.noteGpsFix(1_000 + i * 1_000);
  await client.flushFinal({ finalSubmit: true });
  record(
    "accepted-driver-fixes-survive-terminal-runtime-reset",
    submitted?.section?.counters?.gpsFixesReceived === 11 &&
      submitted?.section?.counters?.validFixesAccepted === 11,
    `gps=${submitted?.section?.counters?.gpsFixesReceived || 0} valid=${submitted?.section?.counters?.validFixesAccepted || 0}`
  );
}

function memoryStorage() {
  return {
    data: {},
    getItem(key) {
      return this.data[key] ?? null;
    },
    setItem(key, value) {
      this.data[key] = value;
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
}

// A terminal flush must capture live counters before its first await. The UI is
// allowed to stop P2P immediately after calling flushFinal.
{
  const storage = memoryStorage();
  let runtime = {
    p2p: {
      sessionsStarted: 1,
      channelsOpened: 1,
      p2pAccepted: 6,
      p2pRendered: 6,
      firebaseAccepted: 2,
      firebaseRendered: 2,
    },
    display: {},
  };
  let submitted = null;
  const client = createRideLocationReportClient({
    role: "customer",
    storage,
    getFirebase: () => ({ ready: true, functions: {} }),
    getRuntimeCounters: () => runtime,
    callSubmit: async (payload) => {
      submitted = payload;
      return { ok: true };
    },
  });
  await client.bindForRide({
    rideId: "ride_terminal_capture_01",
    assignmentSessionToken: "t".repeat(32),
  });

  const flushing = client.flushFinal({ finalSubmit: true });
  runtime = { p2p: {}, display: {} };
  await flushing;

  record(
    "terminal-report-captures-before-teardown",
    submitted?.section?.counters?.p2pFramesReceived === 6 &&
      submitted?.section?.counters?.p2pValidRendered === 6,
    `received=${submitted?.section?.counters?.p2pFramesReceived || 0}`
  );
  record(
    "successful-terminal-report-clears-pending-queue",
    client.readPendingQueue().length === 0,
    `pending=${client.readPendingQueue().length}`
  );
}

// The incident report had one GPS fix, zero valid fixes, a long lifecycle, and
// no customer section. It must never be labelled healthy.
{
  const health = classifyReportHealth({
    driver: {
      submitSequence: 1,
      counters: { gpsFixesReceived: 1, validFixesAccepted: 0 },
    },
    server: { counters: { mirrorAttempts: 3, mirrorAccepted: 3 } },
    customer: { counters: {} },
    lifecycle: { totalLifecycleMs: 9 * 60_000 },
  });
  record(
    "sparse-partial-real-ride-is-critical",
    health.status === "critical" &&
      health.reasons.includes("driver_valid_fix_count_zero") &&
      health.reasons.includes("driver_fix_count_too_low_for_lifecycle") &&
      health.reasons.some((reason) => reason.startsWith("report_incomplete:")),
    `${health.status}:${health.reasons.join(",")}`
  );
}

// Static integration contracts cover ordering and authorization around modules
// that intentionally cannot be imported in Node because they use browser/CDN APIs.
{
  const rideFlow = fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8");
  const flushAt = rideFlow.indexOf("maybeFlushCustomerLocationReport(ride, previousStatus);");
  const stopAt = rideFlow.indexOf('} else if (ride.status === "completed")');
  record(
    "customer-terminal-snapshot-precedes-p2p-stop",
    flushAt >= 0 && stopAt >= 0 && flushAt < stopAt,
    `flushAt=${flushAt} stopAt=${stopAt}`
  );

  const driverApp = fs.readFileSync(path.join(ROOT, "driver-app/js/driver-app.js"), "utf8");
  record(
    "native-silence-has-browser-gps-fallback",
    driverApp.includes("NATIVE_GPS_FRESH_MS") &&
      driverApp.includes("recoverStalledLocationWatch") &&
      driverApp.includes('document.addEventListener("visibilitychange"'),
    "freshness gate + watchdog + correct visibility target"
  );

  const errorBlock = driverApp.slice(
    driverApp.indexOf("function handleLocationError"),
    driverApp.indexOf("function stopLocationRefreshRequestWatch")
  );
  record(
    "active-ride-location-error-does-not-force-driver-offline",
    errorBlock.includes("activeRideTracking") &&
      errorBlock.indexOf("if (activeRideTracking)") >= 0 &&
      errorBlock.indexOf('setDriverOffline("لائیو مقام') > errorBlock.indexOf("if (activeRideTracking)"),
    "active ride returns before idle-only offline transition"
  );

  const recoveryBlock = driverApp.slice(
    driverApp.indexOf("function recoverStalledLocationWatch"),
    driverApp.indexOf("function startLocationRecoveryWatchdog")
  );
  record(
    "hidden-active-ride-can-recover-location-watch",
    recoveryBlock.includes("activeExecutionRide?.id") &&
      !recoveryBlock.includes('document.visibilityState === "hidden"'),
    "watchdog remains eligible while app is backgrounded"
  );

  const driverTerminalBlock = driverApp.slice(
    driverApp.indexOf("function startActiveRideWatch"),
    driverApp.indexOf("async function markVehicleRideId")
  );
  record(
    "driver-terminal-snapshot-flushes-before-teardown",
    driverTerminalBlock.indexOf("driverLocationReport.flushFinal") >= 0 &&
      driverTerminalBlock.indexOf("driverLocationReport.flushFinal") <
        driverTerminalBlock.indexOf('detachCheckpointPresence("terminal_status")'),
    "final counters persist before peer/native stop"
  );

  record(
    "customer-report-retry-uses-document-visibility-event",
    rideFlow.includes('document.addEventListener("visibilitychange"') &&
      !rideFlow.includes('window.addEventListener("visibilitychange"'),
    "document owns the visibilitychange event"
  );

  const customerFlushBlock = rideFlow.slice(
    rideFlow.indexOf("function maybeFlushCustomerLocationReport"),
    rideFlow.indexOf("function scheduleCustomerLocationReportStartupRetry")
  );
  record(
    "terminal-customer-snapshot-can-bind-and-submit",
    customerFlushBlock.includes("await customerLocationReportBindingPromise") &&
      customerFlushBlock.includes("await report.bindForRide") &&
      customerFlushBlock.includes("await report.flushFinal"),
    "terminal snapshot recovers an unfinished active binding"
  );

  const functionsIndex = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
  const saveBlock = functionsIndex.slice(
    functionsIndex.indexOf("exports.saveAdminLocationReportingSettings"),
    functionsIndex.indexOf("exports.submitRideLocationReportSection")
  );
  record(
    "location-settings-write-is-super-admin-only",
    saveBlock.includes("isCallerAuthorizedForDiagnostic") &&
      !saveBlock.includes("ensureCallerCanAdminWrite") &&
      saveBlock.includes("SUPER_ADMIN_ONLY"),
    "callable authorization"
  );

  const driverP2p = fs.readFileSync(
    path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"),
    "utf8"
  );
  const customerP2p = fs.readFileSync(
    path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"),
    "utf8"
  );
  record(
    "p2p-counters-survive-session-destroy",
    driverP2p.includes("archiveSessionCounters(s)") &&
      driverP2p.includes("allSessionCounters()") &&
      customerP2p.includes("archiveSessionCounters(s)") &&
      customerP2p.includes("allSessionCounters()"),
    "driver + customer"
  );
}

const fail = results.filter((row) => row.status === "FAIL").length;
console.log(`\nlive-location-terminal-reliability: ${results.length - fail} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
