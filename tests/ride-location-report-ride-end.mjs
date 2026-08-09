/**
 * Ride-end location report integration tests (client + static wiring).
 * Run: npm run test:ride-location-report-ride-end
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapDriverRuntimeCounters,
  mapCustomerRuntimeCounters,
  createRideLocationReportClient,
  RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS,
} from "../shared/js/ride-location-report-client.mjs";
import { createMemoryStorageAdapter } from "../shared/js/ride-location-local-counter-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-ride-end-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

record(
  "unit-map-driver-runtime-counters",
  (() => {
    const mapped = mapDriverRuntimeCounters(
      { rawGpsFixes: 10, rejectedInterval: 2, writesAttempted: 5, writesCommitted: 4 },
      { fixesSent: 3, sessionsStarted: 1, fallbackTransitions: 2 }
    );
    return mapped.gpsFixesReceived === 10 &&
      mapped.validFixesAccepted === 8 &&
      mapped.vehicleWritesFailed === 1 &&
      mapped.p2pFramesSent === 3
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "unit-map-customer-runtime-counters",
  (() => {
    const mapped = mapCustomerRuntimeCounters(
      { firebaseAccepted: 4, firebaseRendered: 3, p2pAccepted: 2, p2pRendered: 5, sourceSwitchFirebaseToP2p: 1 },
      { backwardJitterRejects: 1 }
    );
    return mapped.firebaseSnapshotsReceived === 4 &&
      mapped.firebaseValidRendered === 3 &&
      mapped.p2pValidRendered === 5
      ? "PASS"
      : "FAIL";
  })()
);

record(
  "static-final-flush-timeout-4s",
  RIDE_LOCATION_REPORT_FINAL_FLUSH_TIMEOUT_MS === 4_000 ? "PASS" : "FAIL"
);

record(
  "static-driver-flush-before-settlement",
  read("driver-app/js/driver-app.js").includes("flushLocationReportBeforeSettlement") &&
    read("driver-app/js/driver-app.js").includes("await flushLocationReportBeforeSettlement()")
    ? "PASS"
    : "FAIL"
);

record(
  "static-driver-settlement-order",
  (() => {
    const src = read("driver-app/js/driver-app.js");
    const flushIdx = src.indexOf("flushLocationReportBeforeSettlement");
    const settleIdx = src.indexOf("completeRideWithEarnings");
    return flushIdx > 0 && settleIdx > flushIdx ? "PASS" : "FAIL";
  })()
);

record(
  "static-customer-terminal-flush",
  read("customer-app/js/ride-flow.js").includes("maybeFlushCustomerLocationReport") &&
    read("customer-app/js/ride-flow.js").includes("createRideLocationReportClient")
    ? "PASS"
    : "FAIL"
);

record(
  "static-pending-queue-module",
  fs.existsSync(path.join(ROOT, "shared/js/ride-location-report-pending-queue.mjs")) ? "PASS" : "FAIL"
);

record(
  "static-retry-on-startup-driver",
  read("driver-app/js/driver-app.js").includes("retryPendingReports") ? "PASS" : "FAIL"
);

record(
  "static-retry-on-startup-customer",
  read("customer-app/js/ride-flow.js").includes("scheduleCustomerLocationReportStartupRetry") ? "PASS" : "FAIL"
);

const timeoutClient = createRideLocationReportClient({
  role: "driver",
  storage: createMemoryStorageAdapter(),
  getFirebase: () => ({ ready: true, functions: {} }),
  callSubmit: () => new Promise(() => {}),
});
await timeoutClient.bindForRide({ rideId: "ride_end_test_01", assignmentSessionToken: "as_end_token_xx" });
timeoutClient.noteGpsFix(Date.now());
const timeoutStarted = Date.now();
const timeoutRes = await timeoutClient.flushFinal({ timeoutMs: 200 });
const timeoutElapsed = Date.now() - timeoutStarted;
record(
  "unit-flush-final-timeout-non-blocking",
  timeoutRes.ok === false &&
    timeoutRes.reason === "FLUSH_TIMEOUT" &&
    timeoutElapsed >= 180 &&
    timeoutElapsed < 800
    ? "PASS"
    : "FAIL"
);

const successClient = createRideLocationReportClient({
  role: "customer",
  storage: createMemoryStorageAdapter(),
  getFirebase: () => ({ ready: true, functions: {} }),
  callSubmit: async () => ({ ok: true }),
});
await successClient.bindForRide({ rideId: "ride_end_test_02", assignmentSessionToken: "as_end_token_yy" });
const successRes = await successClient.flushFinal({ timeoutMs: 500 });
record(
  "unit-flush-success-clears-binding",
  successRes.ok === true && !successClient.isBound() ? "PASS" : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass: passCount, fail: failCount, results }, null, 2)
);
console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
