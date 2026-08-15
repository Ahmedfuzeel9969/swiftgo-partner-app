/**
 * Super Admin per-ride location report UI tests.
 * Run: npm run test:ride-location-report-admin-ui
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRideLocationReportViewModel,
  renderRideLocationReportPanelHtml,
  computeReportCompleteness,
  formatReportDurationMs,
  RIDE_LOCATION_REPORT_COLLECTION,
} from "../super-admin-panel/js/ride-location-report-view.mjs";
import {
  createEmptyDriverCounters,
  createEmptyCustomerCounters,
  createEmptyServerCounters,
  computeDerivedMetrics,
  classifyReportHealth,
} from "../super-admin-panel/js/ride-location-report-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-admin-ui-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

record(
  "static-admin-ui-modal-present",
  read("super-admin-panel/index.html").includes("locationReportModal") &&
    read("super-admin-panel/index.html").includes("locationReportModalBody")
    ? "PASS"
    : "FAIL"
);

record(
  "static-admin-table-report-button",
  read("super-admin-panel/js/admin-app.js").includes("data-open-location-report") &&
    read("super-admin-panel/js/admin-app.js").includes("openRideLocationReportModal")
    ? "PASS"
    : "FAIL"
);

record(
  "static-view-module-present",
  fs.existsSync(path.join(ROOT, "super-admin-panel/js/ride-location-report-view.mjs")) ? "PASS" : "FAIL"
);

record(
  "static-collection-name",
  RIDE_LOCATION_REPORT_COLLECTION === "rideLocationReports" ? "PASS" : "FAIL"
);

record(
  "unit-format-duration-ms",
  formatReportDurationMs(65_000) === "1m 5s" && formatReportDurationMs(null) === "—" ? "PASS" : "FAIL"
);

record(
  "unit-completeness-missing",
  computeReportCompleteness({}) === "missing" ? "PASS" : "FAIL"
);

record(
  "unit-completeness-complete",
  (() => {
    const report = {
      driver: { lastAcceptedSequence: 1, counters: createEmptyDriverCounters() },
      customer: { lastAcceptedSequence: 1, counters: createEmptyCustomerCounters() },
      server: { counters: { ...createEmptyServerCounters(), mirrorAttempts: 2, mirrorAccepted: 1 } },
    };
    return computeReportCompleteness(report) === "complete" ? "PASS" : "FAIL";
  })()
);

const sampleReport = {
  schemaVersion: 1,
  rideId: "ride_admin_ui_01",
  assignmentSessionTokenHash: "a".repeat(64),
  status: "final",
  completeness: "complete",
  lifecycle: {
    bookingCreatedAtMs: 1_000,
    assignedAtMs: 60_000,
    tripStartedAtMs: 120_000,
    settledAtMs: 420_000,
    bookingToAssignmentMs: 59_000,
    driverApproachMs: 60_000,
    inProgressMs: 300_000,
    totalLifecycleMs: 419_000,
  },
  driver: {
    lastAcceptedSequence: 1,
    counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 12, vehicleWritesAcknowledged: 10 },
    firstFixAtMs: 70_000,
    lastFixAtMs: 400_000,
    longestGapMs: 8_000,
  },
  server: {
    counters: { ...createEmptyServerCounters(), mirrorAttempts: 10, mirrorAccepted: 9 },
    firstMirrorAtMs: 80_000,
    lastMirrorAtMs: 390_000,
  },
  customer: {
    lastAcceptedSequence: 1,
    counters: {
      ...createEmptyCustomerCounters(),
      firebaseSnapshotsReceived: 8,
      firebaseValidRendered: 7,
      p2pFramesReceived: 4,
      p2pValidRendered: 3,
    },
    firstRenderedAtMs: 90_000,
    lastRenderedAtMs: 395_000,
  },
  configSnapshot: { enabled: true, uploadMode: "ride_end", retentionDays: 30 },
};

sampleReport.derived = computeDerivedMetrics({
  driver: sampleReport.driver,
  server: sampleReport.server,
  customer: sampleReport.customer,
});
sampleReport.health = classifyReportHealth({
  driver: sampleReport.driver,
  server: sampleReport.server,
  customer: sampleReport.customer,
  derived: sampleReport.derived,
});

const viewModel = buildRideLocationReportViewModel(sampleReport, {
  rideId: "ride_admin_ui_01",
  rideStatus: "completed",
});
record(
  "unit-view-model-found",
  viewModel.found === true && viewModel.completeness === "complete" ? "PASS" : "FAIL"
);

const html = renderRideLocationReportPanelHtml(viewModel);
record(
  "unit-render-includes-counters",
  html.includes("GPS fixes received") && html.includes("Mirror accepted") ? "PASS" : "FAIL"
);

record(
  "unit-render-no-coordinates",
  !html.includes("lat") &&
    !html.includes("lng") &&
    !html.includes("assignmentSessionToken") &&
    !/24\.\d{2,}/.test(html)
    ? "PASS"
    : "FAIL"
);

const missingHtml = renderRideLocationReportPanelHtml(
  buildRideLocationReportViewModel(null, { rideId: "ride_missing_01", rideStatus: "completed" })
);
record(
  "unit-render-missing-safe",
  missingHtml.includes("location report") && !missingHtml.includes("undefined") ? "PASS" : "FAIL"
);

record(
  "unit-forbidden-key-rejected",
  (() => {
    try {
      buildRideLocationReportViewModel({ lat: 24.86, rideId: "x".repeat(8) }, { rideId: "x".repeat(8) });
      return "FAIL";
    } catch (e) {
      return String(e.message || e).includes("forbidden_key:lat") ? "PASS" : "FAIL";
    }
  })()
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass: passCount, fail: failCount, results }, null, 2)
);
console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
