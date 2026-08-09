/**
 * Ride location report submit + server mirror aggregation tests.
 * Run: npm run test:ride-location-report-submit
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-submit-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const {
  submitRideLocationReportSection,
  recordServerMirrorOutcome,
  mapMirrorReasonToCounter,
  hashAssignmentSessionTokenSync,
  computeCompleteness,
} = require("../functions/ride-location-report.js");
const { LOCATION_DIAG } = require("../functions/live-location-envelope.js");
const { createEmptyDriverCounters, createEmptyCustomerCounters } = require("../functions/ride-location-report-schema.js");

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ─── Unit ───

record(
  "unit-map-mirror-accepted",
  mapMirrorReasonToCounter(LOCATION_DIAG.MIRRORED, true) === "mirrorAccepted" ? "PASS" : "FAIL"
);

record(
  "unit-map-mirror-noop",
  mapMirrorReasonToCounter(LOCATION_DIAG.NOOP_UNCHANGED, false) === "mirrorSkippedNoop" ? "PASS" : "FAIL"
);

record(
  "unit-hash-token",
  hashAssignmentSessionTokenSync("as_test_token_loc_01") === hashToken("as_test_token_loc_01")
    ? "PASS"
    : "FAIL"
);

record(
  "static-callable-exported",
  read("functions/index.js").includes("exports.submitRideLocationReportSection") ? "PASS" : "FAIL"
);

record(
  "static-no-settlement-import",
  !read("functions/ride-location-report.js").includes('require("./settlement') ? "PASS" : "FAIL"
);

// ─── Emulator ───

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

let app;
try {
  app = admin.app();
} catch {
  app = admin.initializeApp({ projectId: "demo-swiftgo-phase1" });
}
const db = admin.firestore(app);

const RIDE_ID = "ride_loc_rpt_submit_01";
const TOKEN = "as_report_submit_token_01";
const TOKEN_HASH = hashToken(TOKEN);
const DRIVER = "rlr-driver";
const CUSTOMER = "rlr-customer";
const OTHER = "rlr-other";

await db.doc(`rides/${RIDE_ID}`).set({
  userId: CUSTOMER,
  driverId: DRIVER,
  status: "accepted",
  assignmentSessionToken: TOKEN,
  assignedAt: admin.firestore.Timestamp.now(),
  createdAt: admin.firestore.Timestamp.now(),
  pickupLocation: { lat: 24.86, lng: 67.0 },
  dropoffLocation: { lat: 24.87, lng: 67.01 },
});

const driverSection1 = {
  counters: { ...createEmptyDriverCounters(), gpsFixesReceived: 5, vehicleWritesAcknowledged: 4 },
  firstFixAtMs: 1_000,
  lastFixAtMs: 20_000,
  longestGapMs: 3_000,
};

const driverRes = await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_ID,
  role: "driver",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: driverSection1,
  submitSequence: 1,
});
record(
  "emulator-driver-submit-ok",
  driverRes.ok && driverRes.completeness === "partial_driver_only" ? "PASS" : "FAIL"
);

let wrongParticipant = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: OTHER,
    rideId: RIDE_ID,
    role: "driver",
    assignmentSessionTokenHash: TOKEN_HASH,
    section: driverSection1,
    submitSequence: 2,
  });
} catch (e) {
  wrongParticipant = e.message === "NOT_RIDE_DRIVER";
}
record("emulator-wrong-driver-denied", wrongParticipant ? "PASS" : "FAIL");

let staleToken = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: DRIVER,
    rideId: RIDE_ID,
    role: "driver",
    assignmentSessionTokenHash: "b".repeat(64),
    section: driverSection1,
    submitSequence: 2,
  });
} catch (e) {
  staleToken = e.message === "STALE_ASSIGNMENT";
}
record("emulator-stale-token-denied", staleToken ? "PASS" : "FAIL");

const driverRes2 = await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_ID,
  role: "driver",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: {
    ...driverSection1,
    counters: { ...driverSection1.counters, gpsFixesReceived: 8 },
  },
  submitSequence: 2,
});
const reportAfterDriver2 = (await db.doc(`rideLocationReports/${RIDE_ID}`).get()).data();
record(
  "emulator-driver-sequence-advance-merge",
  driverRes2.ok &&
    reportAfterDriver2.driver.counters.gpsFixesReceived === 8 &&
    reportAfterDriver2.driver.lastAcceptedSequence === 2
    ? "PASS"
    : "FAIL"
);

const idem = await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_ID,
  role: "driver",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: driverSection1,
  submitSequence: 2,
});
record("emulator-idempotent-same-sequence", idem.ok && idem.already === true ? "PASS" : "FAIL");

let staleSeq = false;
try {
  await submitRideLocationReportSection(db, {
    callerUid: DRIVER,
    rideId: RIDE_ID,
    role: "driver",
    assignmentSessionTokenHash: TOKEN_HASH,
    section: driverSection1,
    submitSequence: 1,
  });
} catch (e) {
  staleSeq = e.message === "STALE_SUBMIT_SEQUENCE";
}
record("emulator-stale-sequence-denied", staleSeq ? "PASS" : "FAIL");

const customerSection = {
  counters: { ...createEmptyCustomerCounters(), firebaseSnapshotsReceived: 4, firebaseValidRendered: 3 },
  firstRenderedAtMs: 2_000,
  lastRenderedAtMs: 18_000,
};
const customerRes = await submitRideLocationReportSection(db, {
  callerUid: CUSTOMER,
  rideId: RIDE_ID,
  role: "customer",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: customerSection,
  submitSequence: 1,
});
const reportAfterCustomer = (await db.doc(`rideLocationReports/${RIDE_ID}`).get()).data();
record(
  "emulator-customer-submit-ok",
  customerRes.ok && reportAfterCustomer.customer?.lastAcceptedSequence === 1 ? "PASS" : "FAIL"
);

await recordServerMirrorOutcome(db, RIDE_ID, { mirrored: true, reason: LOCATION_DIAG.MIRRORED });
await recordServerMirrorOutcome(db, RIDE_ID, { mirrored: false, reason: LOCATION_DIAG.NOOP_UNCHANGED });
await submitRideLocationReportSection(db, {
  callerUid: DRIVER,
  rideId: RIDE_ID,
  role: "driver",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: {
    ...driverSection1,
    counters: { ...driverSection1.counters, gpsFixesReceived: 8 },
  },
  submitSequence: 2,
});
const reportAfterMirror = (await db.doc(`rideLocationReports/${RIDE_ID}`).get()).data();
record(
  "emulator-server-mirror-counters",
  reportAfterMirror.server.counters.mirrorAttempts === 1 &&
    reportAfterMirror.server.counters.mirrorAccepted === 1
    ? "PASS"
    : "FAIL"
);

record(
  "emulator-completeness-complete",
  computeCompleteness(reportAfterMirror) === "complete" ? "PASS" : "FAIL"
);

record(
  "emulator-derived-health-present",
  reportAfterMirror.derived &&
    reportAfterMirror.health &&
    reportAfterMirror.health.status !== undefined
    ? "PASS"
    : "FAIL"
);

record(
  "emulator-lifecycle-assigned-at",
  reportAfterMirror.lifecycle && reportAfterMirror.lifecycle.assignedAtMs != null ? "PASS" : "FAIL"
);

await db.doc(`rides/${RIDE_ID}`).update({ status: "completed", settledAt: admin.firestore.Timestamp.now() });
await submitRideLocationReportSection(db, {
  callerUid: CUSTOMER,
  rideId: RIDE_ID,
  role: "customer",
  assignmentSessionTokenHash: TOKEN_HASH,
  section: customerSection,
  submitSequence: 2,
  finalSubmit: true,
});
const finalReport = (await db.doc(`rideLocationReports/${RIDE_ID}`).get()).data();
record(
  "emulator-final-status-after-terminal",
  finalReport.status === "final" && finalReport.finalizedAt != null ? "PASS" : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;
fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), pass: passCount, fail: failCount, results }, null, 2)
);
console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL`);
if (failCount > 0) process.exit(1);
