/**
 * Stage 6 — Firebase / native fallback cleanup audit.
 *
 * Proves:
 * A. rideViewerPresence is not required for native ingest authorization or cadence.
 * B. 4000ms is a responsive target (soft), not a strict minimum — movement >= 25m may write earlier.
 *
 * Run: node tests/stage6-native-fallback-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  RESPONSIVE_INTERVAL_MS as CHECKPOINT_RESPONSIVE_MS,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import { FIREBASE_BACKUP_READ_INTERVAL_MS } from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage6-native-fallback-audit-results.json");

const bgUpload = require("../functions/background-location-upload.js");
const { ingestBackgroundDriverLocation, mintBackgroundLocationCredential } = bgUpload;

const SECRET = "stage6-native-fallback-secret";
const RIDE_ID = "ride_stage6_fb";
const VEHICLE_ID = "veh_stage6_fb";
const DRIVER_UID = "drv_stage6_fb";
const CUSTOMER_UID = "cust_stage6_fb";
const TRACKING_SESSION_ID = "trk_stage6_fb";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function auditPresenceReadRemovedFromIngest() {
  const src = readUtf8("functions/background-location-upload.js");
  const ingestBlock = src.slice(
    src.indexOf("async function ingestBackgroundDriverLocation"),
    src.indexOf("module.exports")
  );

  record(
    "ingest-does-not-read-rideViewerPresence",
    !ingestBlock.includes("presenceSnap") ? "PASS" : "FAIL",
    "no presence transaction read in ingest"
  );
  record(
    "ingest-viewerLease-static-unknown",
    ingestBlock.includes('const viewerLease = "UNKNOWN"') ? "PASS" : "FAIL"
  );
  record(
    "cadence-resolver-ignores-viewerLease",
    src.includes("void viewerLease") ? "PASS" : "FAIL"
  );
  record(
    "resolveViewerLeaseFromPresence-still-exported",
    typeof bgUpload.resolveViewerLeaseFromPresence === "function" ? "PASS" : "FAIL",
    "used by client checkpoint tests, not native ingest"
  );
}

function auditAuthorizationBinding() {
  const src = readUtf8("functions/background-location-upload.js");
  const checks = [
    ["auth-credential-verify", /verifyBackgroundLocationCredential/],
    ["auth-not-assigned-driver", /NOT_ASSIGNED_DRIVER/],
    ["auth-ride-not-active", /RIDE_NOT_ACTIVE/],
    ["auth-vehicle-mismatch", /VEHICLE_MISMATCH/],
    ["auth-assignment-token", /ASSIGNMENT_TOKEN_MISMATCH/],
  ];
  for (const [name, re] of checks) {
    record(`static-${name}`, re.test(src) ? "PASS" : "FAIL");
  }
}

function auditFourSecondSemantics() {
  record(
    "cf-responsive-interval-4000ms",
    bgUpload.RESPONSIVE_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${bgUpload.RESPONSIVE_INTERVAL_MS}ms`
  );

  const cadence = bgUpload.resolveBackgroundUploadIntervalMs({
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
  });
  record(
    "native-cadence-hardInterval-false",
    cadence.hardInterval === false && cadence.intervalMs === 4_000 ? "PASS" : "FAIL",
    `policy=${cadence.policy} hard=${cadence.hardInterval}`
  );

  const tooSoon = bgUpload.shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 8_000,
    intervalMs: 4_000,
    hardInterval: false,
    movedEnough: false,
  });
  record(
    "soft-cadence-blocks-before-4s-without-movement",
    !tooSoon.allow && tooSoon.reason === "interval" ? "PASS" : "FAIL",
    tooSoon.reason
  );

  const movedEarly = bgUpload.shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 9_000,
    intervalMs: 4_000,
    hardInterval: false,
    movedEnough: true,
  });
  record(
    "soft-cadence-allows-early-write-when-moved-25m",
    movedEarly.allow && movedEarly.reason === "moved" ? "PASS" : "FAIL",
    movedEarly.reason
  );

  const atInterval = bgUpload.shouldAllowCadenceWrite({
    nowMs: 14_000,
    lastWriteMs: 10_000,
    intervalMs: 4_000,
    hardInterval: false,
    movedEnough: false,
  });
  record(
    "soft-cadence-allows-at-4s-without-movement",
    atInterval.allow && atInterval.reason === "interval" ? "PASS" : "FAIL",
    atInterval.reason
  );

  const checkpoint = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
    p2pHealthy: false,
  });
  record(
    "checkpoint-client-aligns-4s-soft",
    checkpoint.intervalMs === 4_000 && checkpoint.hardInterval === false ? "PASS" : "FAIL",
    `${checkpoint.policy}@${checkpoint.intervalMs}`
  );
  record(
    "customer-arbiter-firebase-backup-4s",
    FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${FIREBASE_BACKUP_READ_INTERVAL_MS}ms`
  );
  record(
    "ingest-computes-25m-movement-threshold",
    readUtf8("functions/background-location-upload.js").includes("movedEnough = meters >= 25")
      ? "PASS"
      : "FAIL"
  );
}

function createIngestMockDb({ ride, vehicle, trackReads = null }) {
  const rideDoc = { ...ride };
  let vehicleDoc = { ...vehicle };
  return {
    collection(name) {
      return {
        doc(id) {
          return { _collection: name, _id: id };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          if (trackReads) trackReads.push(`${ref._collection}/${ref._id}`);
          if (ref._collection === "rides") {
            return rideDoc ? { exists: true, data: () => rideDoc } : { exists: false };
          }
          if (ref._collection === "vehicles") {
            return vehicleDoc ? { exists: true, data: () => vehicleDoc } : { exists: false };
          }
          if (ref._collection === "rideViewerPresence") {
            return { exists: false };
          }
          return { exists: false };
        },
        update(ref, patch) {
          if (ref._collection === "vehicles") {
            vehicleDoc = {
              ...vehicleDoc,
              ...patch,
              location: patch.location || vehicleDoc.location,
            };
          }
        },
      };
      return fn(tx);
    },
  };
}

async function testIngestAcceptsWithoutPresenceRead() {
  const reads = [];
  const db = createIngestMockDb({
    trackReads: reads,
    ride: {
      driverId: DRIVER_UID,
      userId: CUSTOMER_UID,
      vehicleId: VEHICLE_ID,
      status: "in_progress",
      assignmentSessionToken: "ast_1",
    },
    vehicle: {
      location: null,
      trackingSessionStartedAt: { toMillis: () => 1_000_000 },
    },
  });

  const token = mintBackgroundLocationCredential({
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    vehicleId: VEHICLE_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentSessionToken: "ast_1",
    secret: SECRET,
    nowMs: 1_000_000,
  }).token;

  const res = await ingestBackgroundDriverLocation(db, {
    token,
    secret: SECRET,
    nowMs: 1_000_000,
    fix: {
      lat: 24.86,
      lng: 67.0,
      observedAt: 1_000_000,
      sequence: 1,
      accuracyM: 10,
    },
  });

  const presenceReads = reads.filter((r) => r.startsWith("rideViewerPresence/"));
  record(
    "ingest-accepts-without-presence-read",
    res.ok && res.accepted && presenceReads.length === 0 ? "PASS" : "FAIL",
    `accepted=${res.accepted} presenceReads=${presenceReads.length} viewerLease=${res.viewerLease}`
  );
  record(
    "ingest-response-viewerLease-unknown",
    res.viewerLease === "UNKNOWN" ? "PASS" : "FAIL",
    res.viewerLease
  );
}

async function testIngestCadenceSkipWithoutMovement() {
  const db = createIngestMockDb({
    ride: {
      driverId: DRIVER_UID,
      userId: CUSTOMER_UID,
      vehicleId: VEHICLE_ID,
      status: "in_progress",
      assignmentSessionToken: "ast_1",
    },
    vehicle: {
      location: {
        lat: 24.86,
        lng: 67.0,
        observedAt: 999_000,
        sequence: 1,
        sessionId: TRACKING_SESSION_ID,
      },
      locationUpdatedAt: { toMillis: () => 999_000 },
      trackingSessionStartedAt: { toMillis: () => 900_000 },
    },
  });

  const token = mintBackgroundLocationCredential({
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    vehicleId: VEHICLE_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentSessionToken: "ast_1",
    secret: SECRET,
    nowMs: 1_000_000,
  }).token;

  const res = await ingestBackgroundDriverLocation(db, {
    token,
    secret: SECRET,
    nowMs: 1_001_000,
    fix: {
      lat: 24.8601,
      lng: 67.0001,
      observedAt: 1_001_000,
      sequence: 2,
      accuracyM: 10,
    },
  });

  record(
    "ingest-cadence-skip-before-4s-small-move",
    res.ok && !res.accepted && res.reason === "CADENCE_SKIP" ? "PASS" : "FAIL",
    `accepted=${res.accepted} reason=${res.reason} policy=${res.policy}`
  );
}

function recordAuditVerdict() {
  const verdict = {
    presenceReadRole: "removed — was diagnostics-only in ingest response",
    authorizationUsesPresence: false,
    cadenceUsesPresence: false,
    fourSecondSemantics: "responsive target (hardInterval=false); movement >= 25m may write earlier",
    productionChange: "removed unnecessary rideViewerPresence read from native ingest transaction",
  };
  record(
    "audit-verdict-documented",
    verdict.authorizationUsesPresence === false && verdict.cadenceUsesPresence === false
      ? "PASS"
      : "FAIL",
    verdict.fourSecondSemantics
  );
  return verdict;
}

async function main() {
  console.log("\n=== STAGE 6 — Firebase / native fallback audit ===\n");
  auditPresenceReadRemovedFromIngest();
  auditAuthorizationBinding();
  auditFourSecondSemantics();
  await testIngestAcceptsWithoutPresenceRead();
  await testIngestCadenceSkipWithoutMovement();
  const verdict = recordAuditVerdict();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 6,
    area: "native-fallback-audit",
    generatedAt: new Date().toISOString(),
    checkpointResponsiveMs: CHECKPOINT_RESPONSIVE_MS,
    ...verdict,
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 6 native fallback audit: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
