/**
 * Stage 4 — responsive Firebase fallback when P2P is not proven healthy.
 *
 * Run: node tests/stage4-responsive-firebase-fallback.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  CHECKPOINT_POLICY,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const require = createRequire(import.meta.url);
const { resolveBackgroundUploadIntervalMs } = require("../functions/background-location-upload.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage4-responsive-firebase-fallback-results.json");

const MATRIX = [
  {
    name: "visible-healthy-p2p",
    lease: VIEWER_LEASE.VISIBLE,
    p2pHealthy: true,
    status: "in_progress",
    expectPolicy: CHECKPOINT_POLICY.P2P_SPARSE_TRIP,
    expectMs: BACKGROUND_TRIP_INTERVAL_MS,
    expectHard: true,
  },
  {
    name: "visible-unhealthy-p2p",
    lease: VIEWER_LEASE.VISIBLE,
    p2pHealthy: false,
    status: "in_progress",
    expectPolicy: CHECKPOINT_POLICY.RESPONSIVE_FIREBASE,
    expectMs: RESPONSIVE_INTERVAL_MS,
    expectHard: false,
  },
  {
    name: "unknown-healthy-p2p",
    lease: VIEWER_LEASE.UNKNOWN,
    p2pHealthy: true,
    status: "accepted",
    expectPolicy: CHECKPOINT_POLICY.P2P_SPARSE_APPROACH,
    expectMs: BACKGROUND_APPROACH_INTERVAL_MS,
    expectHard: true,
  },
  {
    name: "unknown-unhealthy-p2p",
    lease: VIEWER_LEASE.UNKNOWN,
    p2pHealthy: false,
    status: "in_progress",
    expectPolicy: CHECKPOINT_POLICY.RESPONSIVE_FIREBASE,
    expectMs: RESPONSIVE_INTERVAL_MS,
    expectHard: false,
  },
  {
    name: "expired-unhealthy-p2p",
    lease: VIEWER_LEASE.EXPIRED,
    p2pHealthy: false,
    status: "in_progress",
    expectPolicy: CHECKPOINT_POLICY.RESPONSIVE_FIREBASE,
    expectMs: RESPONSIVE_INTERVAL_MS,
    expectHard: false,
  },
];

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function testPolicyMatrix() {
  console.log("\n=== Policy matrix (resolveCheckpointPolicy) ===\n");
  for (const row of MATRIX) {
    const d = resolveCheckpointPolicy({
      hasActiveRide: true,
      rideStatus: row.status,
      viewerLease: row.lease,
      p2pHealthy: row.p2pHealthy,
    });
    const ok =
      d.policy === row.expectPolicy &&
      d.intervalMs === row.expectMs &&
      d.hardInterval === row.expectHard;
    record(
      `matrix-${row.name}`,
      ok ? "PASS" : "FAIL",
      `${d.policy}@${d.intervalMs}ms hard=${d.hardInterval}`
    );
  }
}

function testControllerHysteresis() {
  console.log("\n=== Controller hysteresis (P2P health independent of lease) ===\n");
  let clock = 0;
  const ctrl = createCheckpointPolicyController({ nowMs: () => clock, diag: () => {} });
  ctrl.setActiveRide({ rideId: "r4", status: "in_progress", active: true });
  ctrl.setViewerLease(VIEWER_LEASE.EXPIRED);
  ctrl.setP2pHealthy(true);
  clock = P2P_SPARSE_ENTER_HYSTERESIS_MS + 50;
  const expiredHealthy = ctrl.currentDecision();
  record(
    "controller-expired-healthy-p2p-sparse-trip",
    expiredHealthy.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP &&
      expiredHealthy.intervalMs === BACKGROUND_TRIP_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${expiredHealthy.policy}@${expiredHealthy.intervalMs}`
  );

  ctrl.setP2pHealthy(false);
  clock += 4_000;
  const expiredUnhealthy = ctrl.currentDecision();
  record(
    "controller-expired-unhealthy-p2p-responsive",
    expiredUnhealthy.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      expiredUnhealthy.intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${expiredUnhealthy.policy}@${expiredUnhealthy.intervalMs}`
  );

  ctrl.setViewerLease(VIEWER_LEASE.UNKNOWN);
  ctrl.setP2pHealthy(true);
  clock += P2P_SPARSE_ENTER_HYSTERESIS_MS;
  const unknownHealthy = ctrl.currentDecision();
  record(
    "controller-unknown-healthy-p2p-sparse",
    unknownHealthy.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP
      ? "PASS"
      : "FAIL",
    `${unknownHealthy.policy}@${unknownHealthy.intervalMs}`
  );

  record(
    "controller-lease-change-does-not-clear-p2p-health",
    ctrl.getState().p2pRawHealthy === true ? "PASS" : "FAIL"
  );
}

function testNativeUploadFallback() {
  console.log("\n=== Native upload path (P2P assumed unavailable) ===\n");
  for (const lease of ["VISIBLE", "UNKNOWN", "EXPIRED"]) {
    const d = resolveBackgroundUploadIntervalMs({
      rideStatus: "in_progress",
      viewerLease: lease,
    });
    record(
      `native-upload-${lease.toLowerCase()}-responsive`,
      d.policy === "RESPONSIVE_FIREBASE" && d.intervalMs === RESPONSIVE_INTERVAL_MS
        ? "PASS"
        : "FAIL",
      `${d.policy}@${d.intervalMs}`
    );
  }
}

function testNoDeadZone() {
  console.log("\n=== No P2P-unhealthy + sparse dead zone ===\n");
  const leases = [VIEWER_LEASE.VISIBLE, VIEWER_LEASE.UNKNOWN, VIEWER_LEASE.EXPIRED];
  const statuses = ["accepted", "arrived", "in_progress"];
  let allResponsive = true;
  for (const lease of leases) {
    for (const status of statuses) {
      const d = resolveCheckpointPolicy({
        hasActiveRide: true,
        rideStatus: status,
        viewerLease: lease,
        p2pHealthy: false,
      });
      if (
        d.policy !== CHECKPOINT_POLICY.RESPONSIVE_FIREBASE ||
        d.intervalMs !== RESPONSIVE_INTERVAL_MS
      ) {
        allResponsive = false;
      }
    }
  }
  record(
    "unhealthy-p2p-never-sparse-for-active-ride",
    allResponsive ? "PASS" : "FAIL"
  );
}

function main() {
  console.log("\n=== STAGE 4 — responsive Firebase fallback ===\n");
  testPolicyMatrix();
  testControllerHysteresis();
  testNativeUploadFallback();
  testNoDeadZone();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 4,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    matrix: MATRIX.map((row) => {
      const d = resolveCheckpointPolicy({
        hasActiveRide: true,
        rideStatus: row.status,
        viewerLease: row.lease,
        p2pHealthy: row.p2pHealthy,
      });
      return {
        scenario: row.name,
        policy: d.policy,
        intervalMs: d.intervalMs,
        hardInterval: d.hardInterval,
      };
    }),
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 4 summary: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main();
