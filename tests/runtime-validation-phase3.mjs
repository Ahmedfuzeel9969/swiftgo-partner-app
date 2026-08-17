/**
 * Phase 3 — controlled runtime validation proof.
 * Verifies diagnostics report the same values production uses at execution.
 * Run: node tests/runtime-validation-phase3.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_IDLE_LOCATION_INTERVAL_MS,
  CFG_MIN_LOCATION_MOVE_M,
  CFG_P2P_FALLBACK_AFTER_MS,
  CFG_P2P_DEGRADED_AFTER_MS,
  CFG_BACKGROUND_APPROACH_INTERVAL_MS,
  CFG_BACKGROUND_TRIP_INTERVAL_MS,
  CFG_P2P_SPARSE_ENTER_MS,
  CFG_P2P_SPARSE_EXIT_MS,
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS,
  PHASE1_DRIVER_CONFIG,
  PHASE1_P2P_CONFIG,
} from "../shared/js/phase1-billing-diagnostics.mjs";
import {
  resolveCheckpointPolicy,
  CHECKPOINT_POLICY,
  VIEWER_LEASE,
  RESPONSIVE_INTERVAL_MS,
  IDLE_LOCATION_INTERVAL_MS,
  MIN_LOCATION_MOVE_M,
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  P2P_SPARSE_EXIT_HYSTERESIS_MS,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  P2P_FALLBACK_AFTER_MS,
  P2P_DEGRADED_AFTER_MS,
  FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "../customer-app/js/p2p-protocol.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "runtime-validation-phase3-report.json");
const items = [];

function row(item, pass, detail = "") {
  items.push({ item, result: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} | ${item}${detail ? ` — ${detail}` : ""}`);
}

row(
  "movement threshold",
  CFG_MIN_LOCATION_MOVE_M === MIN_LOCATION_MOVE_M && MIN_LOCATION_MOVE_M === 200,
  `diag=${CFG_MIN_LOCATION_MOVE_M} runtime=${MIN_LOCATION_MOVE_M}`
);

row(
  "publish interval (responsive)",
  CFG_RESPONSIVE_INTERVAL_MS === RESPONSIVE_INTERVAL_MS && RESPONSIVE_INTERVAL_MS === 4_000,
  `ms=${CFG_RESPONSIVE_INTERVAL_MS}`
);

row(
  "Firebase timeout / idle publish interval",
  CFG_IDLE_LOCATION_INTERVAL_MS === IDLE_LOCATION_INTERVAL_MS && IDLE_LOCATION_INTERVAL_MS === 300_000,
  `ms=${CFG_IDLE_LOCATION_INTERVAL_MS}`
);

row(
  "P2P fallback timeout",
  CFG_P2P_FALLBACK_AFTER_MS === P2P_FALLBACK_AFTER_MS && P2P_FALLBACK_AFTER_MS === 30_000,
  `ms=${CFG_P2P_FALLBACK_AFTER_MS}`
);

row(
  "P2P timeout (degraded)",
  CFG_P2P_DEGRADED_AFTER_MS === P2P_DEGRADED_AFTER_MS && P2P_DEGRADED_AFTER_MS === 9_000,
  `ms=${CFG_P2P_DEGRADED_AFTER_MS}`
);

row(
  "Firebase backup apply interval",
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS === FIREBASE_BACKUP_READ_INTERVAL_MS &&
    FIREBASE_BACKUP_READ_INTERVAL_MS === 15_000,
  `ms=${CFG_FIREBASE_BACKUP_READ_INTERVAL_MS}`
);

const idle = resolveCheckpointPolicy({
  hasActiveRide: false,
  viewerLease: VIEWER_LEASE.NONE,
  p2pHealthy: false,
});
row(
  "checkpoint policy (idle)",
  idle.policy === CHECKPOINT_POLICY.NO_ACTIVE_RIDE && idle.intervalMs === IDLE_LOCATION_INTERVAL_MS,
  `${idle.policy}@${idle.intervalMs}`
);

const responsive = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: VIEWER_LEASE.VISIBLE,
  p2pHealthy: false,
});
row(
  "checkpoint policy (responsive)",
  responsive.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
    responsive.intervalMs === RESPONSIVE_INTERVAL_MS,
  `${responsive.policy}@${responsive.intervalMs}`
);

const bgApproach = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: VIEWER_LEASE.EXPIRED,
  p2pHealthy: false,
});
row(
  "checkpoint policy (background approach)",
  bgApproach.policy === CHECKPOINT_POLICY.BACKGROUND_APPROACH_CHECKPOINT &&
    bgApproach.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS &&
    CFG_BACKGROUND_APPROACH_INTERVAL_MS === BACKGROUND_APPROACH_INTERVAL_MS,
  `${bgApproach.policy}@${bgApproach.intervalMs}`
);

const bgTrip = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "in_progress",
  viewerLease: VIEWER_LEASE.EXPIRED,
  p2pHealthy: false,
});
row(
  "checkpoint policy (background trip)",
  bgTrip.policy === CHECKPOINT_POLICY.BACKGROUND_TRIP_CHECKPOINT &&
    bgTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS &&
    CFG_BACKGROUND_TRIP_INTERVAL_MS === BACKGROUND_TRIP_INTERVAL_MS,
  `${bgTrip.policy}@${bgTrip.intervalMs}`
);

row(
  "checkpoint policy (sparse hysteresis diag≡runtime)",
  CFG_P2P_SPARSE_ENTER_MS === P2P_SPARSE_ENTER_HYSTERESIS_MS &&
    CFG_P2P_SPARSE_EXIT_MS === P2P_SPARSE_EXIT_HYSTERESIS_MS,
  `${CFG_P2P_SPARSE_ENTER_MS}/${CFG_P2P_SPARSE_EXIT_MS}`
);

let now = 1_000;
const arb = createLiveLocationSourceArbiter({ nowMs: () => now, onRender: () => {} });
const gen = arb.getGeneration();
arb.ingestP2p({ lat: 24.86, lng: 67.0, observedAt: 1_000, sequence: 1 }, gen);
now = 1_000 + P2P_FALLBACK_AFTER_MS + 1;
arb.ensureP2pHealth();
const st = arb.getState();
row(
  "P2P fallback timeout (execution via arbiter)",
  st.p2pHealthy === false && st.preferred === "firebase",
  `preferred=${st.preferred} afterSilenceMs=${P2P_FALLBACK_AFTER_MS + 1}`
);

row(
  "diagnostics PHASE1_DRIVER_CONFIG.movement",
  PHASE1_DRIVER_CONFIG.minimumMovementMeters === MIN_LOCATION_MOVE_M,
  String(PHASE1_DRIVER_CONFIG.minimumMovementMeters)
);

row(
  "diagnostics PHASE1_P2P_CONFIG.fallback",
  PHASE1_P2P_CONFIG.fallbackAfterMs === P2P_FALLBACK_AFTER_MS,
  String(PHASE1_P2P_CONFIG.fallbackAfterMs)
);

const pass = items.filter((i) => i.result === "PASS").length;
const fail = items.filter((i) => i.result === "FAIL").length;
const report = {
  suite: "runtime-validation",
  phase: 3,
  title: "Runtime Validation Proof",
  generatedAt: new Date().toISOString(),
  pass,
  fail,
  items,
  status: fail ? "FAIL" : "PASS — awaiting approval for Phase 4",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nPhase 3 proof: ${pass} PASS / ${fail} FAIL → ${OUT}`);
process.exit(fail ? 1 : 0);
