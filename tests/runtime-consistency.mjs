/**
 * Phase 2 focused — diagnostics CFG_* must equal production runtime constants.
 * Run: node tests/runtime-consistency.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_IDLE_LOCATION_INTERVAL_MS,
  CFG_BACKGROUND_APPROACH_INTERVAL_MS,
  CFG_BACKGROUND_TRIP_INTERVAL_MS,
  CFG_MIN_LOCATION_MOVE_M,
  CFG_P2P_SPARSE_ENTER_MS,
  CFG_P2P_SPARSE_EXIT_MS,
  CFG_P2P_FALLBACK_AFTER_MS,
  CFG_P2P_DEGRADED_AFTER_MS,
  CFG_P2P_SEND_INTERVAL_MS,
  CFG_P2P_HEARTBEAT_INTERVAL_MS,
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS,
  CFG_FRESHNESS_FRESH_MS,
  CFG_FRESHNESS_DELAYED_MS,
  CFG_MAX_ACCEPT_ACCURACY_M,
  PHASE1_DRIVER_CONFIG,
  PHASE1_P2P_CONFIG,
} from "../shared/js/phase1-billing-diagnostics.mjs";
import {
  RESPONSIVE_INTERVAL_MS,
  IDLE_LOCATION_INTERVAL_MS,
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  MIN_LOCATION_MOVE_M,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  P2P_SPARSE_EXIT_HYSTERESIS_MS,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  P2P_FALLBACK_AFTER_MS,
  P2P_DEGRADED_AFTER_MS,
  P2P_SEND_INTERVAL_MS,
  P2P_HEARTBEAT_INTERVAL_MS,
  FIREBASE_BACKUP_READ_INTERVAL_MS,
} from "../driver-app/js/p2p-protocol.mjs";
import {
  FRESHNESS_FRESH_MS,
  FRESHNESS_DELAYED_MS,
} from "../customer-app/js/live-location-render.mjs";
import { MAX_ACCEPT_ACCURACY_M } from "../driver-app/js/location-envelope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "runtime-consistency-report.json");
const results = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  results.push({
    name,
    status: ok ? "PASS" : "FAIL",
    runtime: expected,
    diagnostic: actual,
  });
  console.log(`${ok ? "✓" : "✗"} ${name} — runtime=${expected} diag=${actual}`);
}

check("responsive_interval", CFG_RESPONSIVE_INTERVAL_MS, RESPONSIVE_INTERVAL_MS);
check("idle_interval", CFG_IDLE_LOCATION_INTERVAL_MS, IDLE_LOCATION_INTERVAL_MS);
check("bg_approach", CFG_BACKGROUND_APPROACH_INTERVAL_MS, BACKGROUND_APPROACH_INTERVAL_MS);
check("bg_trip", CFG_BACKGROUND_TRIP_INTERVAL_MS, BACKGROUND_TRIP_INTERVAL_MS);
check("movement_m", CFG_MIN_LOCATION_MOVE_M, MIN_LOCATION_MOVE_M);
check("sparse_enter", CFG_P2P_SPARSE_ENTER_MS, P2P_SPARSE_ENTER_HYSTERESIS_MS);
check("sparse_exit", CFG_P2P_SPARSE_EXIT_MS, P2P_SPARSE_EXIT_HYSTERESIS_MS);
check("p2p_fallback", CFG_P2P_FALLBACK_AFTER_MS, P2P_FALLBACK_AFTER_MS);
check("p2p_degraded", CFG_P2P_DEGRADED_AFTER_MS, P2P_DEGRADED_AFTER_MS);
check("p2p_send", CFG_P2P_SEND_INTERVAL_MS, P2P_SEND_INTERVAL_MS);
check("p2p_heartbeat", CFG_P2P_HEARTBEAT_INTERVAL_MS, P2P_HEARTBEAT_INTERVAL_MS);
check("fb_backup_read", CFG_FIREBASE_BACKUP_READ_INTERVAL_MS, FIREBASE_BACKUP_READ_INTERVAL_MS);
check("freshness_fresh", CFG_FRESHNESS_FRESH_MS, FRESHNESS_FRESH_MS);
check("freshness_delayed", CFG_FRESHNESS_DELAYED_MS, FRESHNESS_DELAYED_MS);
check("max_accuracy", CFG_MAX_ACCEPT_ACCURACY_M, MAX_ACCEPT_ACCURACY_M);

const proseMoveOk = String(PHASE1_DRIVER_CONFIG.conditionsBeforeFirebaseWrite || "").includes(
  `moved≥${MIN_LOCATION_MOVE_M}m`
);
results.push({
  name: "driver_config_prose_uses_runtime_move",
  status: proseMoveOk ? "PASS" : "FAIL",
  detail: PHASE1_DRIVER_CONFIG.conditionsBeforeFirebaseWrite,
});
console.log(`${proseMoveOk ? "✓" : "✗"} driver_config_prose_uses_runtime_move`);

const proseFbOk = String(PHASE1_P2P_CONFIG.firebaseFallbackTrigger || "").includes(
  `>${P2P_FALLBACK_AFTER_MS / 1000}s`
);
results.push({
  name: "p2p_config_prose_uses_runtime_fallback",
  status: proseFbOk ? "PASS" : "FAIL",
  detail: PHASE1_P2P_CONFIG.firebaseFallbackTrigger,
});
console.log(`${proseFbOk ? "✓" : "✗"} p2p_config_prose_uses_runtime_fallback`);

const phase1Src = fs.readFileSync(
  path.join(ROOT, "shared/js/phase1-billing-diagnostics.mjs"),
  "utf8"
);
const noLiteralDupes =
  !/CFG_P2P_FALLBACK_AFTER_MS\s*=\s*12_000/.test(phase1Src) &&
  !/CFG_MIN_LOCATION_MOVE_M\s*=\s*10\b/.test(phase1Src) &&
  phase1Src.includes("from \"../../driver-app/js/location-checkpoint-policy.mjs\"") &&
  phase1Src.includes("from \"../../driver-app/js/p2p-protocol.mjs\"");
results.push({
  name: "no_hardcoded_duplicate_cfg_literals",
  status: noLiteralDupes ? "PASS" : "FAIL",
});
console.log(`${noLiteralDupes ? "✓" : "✗"} no_hardcoded_duplicate_cfg_literals`);

const phase3Src = fs.readFileSync(path.join(ROOT, "shared/js/phase3-billing-reports.mjs"), "utf8");
const phase3Ok = !phase3Src.includes("(12 seconds)") && phase3Src.includes("sec(configCheck.expectedFallbackMs)");
results.push({
  name: "phase3_prose_uses_runtime_sec",
  status: phase3Ok ? "PASS" : "FAIL",
  detail: "checked shared/js/phase3-billing-reports.mjs (lazy report subgraph)",
});
console.log(`${phase3Ok ? "✓" : "✗"} phase3_prose_uses_runtime_sec`);

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const report = {
  suite: "runtime-consistency",
  phase: 2,
  title: "Runtime Consistency Report",
  generatedAt: new Date().toISOString(),
  pass,
  fail,
  results,
  summary: {
    criticalMismatchesResolved: [
      "P2P fallback: diagnostic now aliases P2P_FALLBACK_AFTER_MS (30000)",
      "Movement threshold: diagnostic now aliases MIN_LOCATION_MOVE_M (200)",
    ],
    architecture:
      "shared/js/phase1-billing-diagnostics.mjs is a lightweight facade re-exporting runtime constants; report builders live in phase1-billing-reports.mjs (lazy via field-diagnostics).",
  },
  status: fail ? "FAIL" : "PASS — awaiting approval for Phase 3",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nRuntime Consistency: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
