/**
 * Phase 4 — cross-device consistency (Driver ↔ Customer ↔ Diagnostics).
 * Run: node tests/cross-device-validation-phase4.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_IDLE_LOCATION_INTERVAL_MS,
  CFG_MIN_LOCATION_MOVE_M,
  CFG_P2P_FALLBACK_AFTER_MS,
  CFG_BACKGROUND_APPROACH_INTERVAL_MS,
  CFG_BACKGROUND_TRIP_INTERVAL_MS,
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS,
  PHASE1_DRIVER_CONFIG,
  PHASE1_P2P_CONFIG,
  PHASE1_CUSTOMER_CONFIG,
} from "../shared/js/phase1-billing-diagnostics.mjs";
import * as drvP2p from "../driver-app/js/p2p-protocol.mjs";
import * as custP2p from "../customer-app/js/p2p-protocol.mjs";
import * as drvCp from "../driver-app/js/location-checkpoint-policy.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import {
  FRESHNESS_FRESH_MS,
  FRESHNESS_DELAYED_MS,
} from "../customer-app/js/live-location-render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "cross-device-validation-phase4-report.json");
const items = [];

function row(item, pass, detail = "") {
  items.push({ item, result: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} | ${item}${detail ? ` — ${detail}` : ""}`);
}

row(
  "driver↔customer P2P_FALLBACK_AFTER_MS",
  drvP2p.P2P_FALLBACK_AFTER_MS === custP2p.P2P_FALLBACK_AFTER_MS,
  `${drvP2p.P2P_FALLBACK_AFTER_MS}==${custP2p.P2P_FALLBACK_AFTER_MS}`
);
row(
  "driver↔customer P2P_DEGRADED_AFTER_MS",
  drvP2p.P2P_DEGRADED_AFTER_MS === custP2p.P2P_DEGRADED_AFTER_MS,
  String(drvP2p.P2P_DEGRADED_AFTER_MS)
);
row(
  "driver↔customer FIREBASE_BACKUP_READ",
  drvP2p.FIREBASE_BACKUP_READ_INTERVAL_MS === custP2p.FIREBASE_BACKUP_READ_INTERVAL_MS,
  String(drvP2p.FIREBASE_BACKUP_READ_INTERVAL_MS)
);
row(
  "driver↔customer P2P_SEND_INTERVAL",
  drvP2p.P2P_SEND_INTERVAL_MS === custP2p.P2P_SEND_INTERVAL_MS,
  String(drvP2p.P2P_SEND_INTERVAL_MS)
);

row(
  "Driver runtime → Diagnostics movement",
  CFG_MIN_LOCATION_MOVE_M === drvCp.MIN_LOCATION_MOVE_M,
  String(CFG_MIN_LOCATION_MOVE_M)
);
row(
  "Driver runtime → Diagnostics responsive",
  CFG_RESPONSIVE_INTERVAL_MS === drvCp.RESPONSIVE_INTERVAL_MS,
  String(CFG_RESPONSIVE_INTERVAL_MS)
);
row(
  "Driver runtime → Diagnostics idle",
  CFG_IDLE_LOCATION_INTERVAL_MS === drvCp.IDLE_LOCATION_INTERVAL_MS,
  String(CFG_IDLE_LOCATION_INTERVAL_MS)
);
row(
  "Driver runtime → Diagnostics P2P fallback",
  CFG_P2P_FALLBACK_AFTER_MS === drvP2p.P2P_FALLBACK_AFTER_MS,
  String(CFG_P2P_FALLBACK_AFTER_MS)
);

const drvWrap = fs.readFileSync(path.join(ROOT, "driver-app/js/phase1-billing-diagnostics.mjs"), "utf8");
const custWrap = fs.readFileSync(path.join(ROOT, "customer-app/js/phase1-billing-diagnostics.mjs"), "utf8");
row("Driver diagnostics wrapper → shared", drvWrap.includes("shared/js/phase1-billing-diagnostics.mjs"));
row("Customer diagnostics wrapper → shared", custWrap.includes("shared/js/phase1-billing-diagnostics.mjs"));
row(
  "Driver≡Customer diagnostic CFG fallback",
  CFG_P2P_FALLBACK_AFTER_MS === custP2p.P2P_FALLBACK_AFTER_MS,
  String(CFG_P2P_FALLBACK_AFTER_MS)
);
row(
  "Customer PHASE1_P2P_CONFIG ≡ protocol",
  PHASE1_P2P_CONFIG.fallbackAfterMs === custP2p.P2P_FALLBACK_AFTER_MS,
  String(PHASE1_P2P_CONFIG.fallbackAfterMs)
);
row(
  "Customer PHASE1 freshness ≡ render",
  PHASE1_CUSTOMER_CONFIG.freshnessFreshMs === FRESHNESS_FRESH_MS &&
    PHASE1_CUSTOMER_CONFIG.freshnessDelayedMs === FRESHNESS_DELAYED_MS,
  `${FRESHNESS_FRESH_MS}/${FRESHNESS_DELAYED_MS}`
);

let now = 5_000;
const arb = createLiveLocationSourceArbiter({ nowMs: () => now, onRender: () => {} });
const g = arb.getGeneration();
arb.ingestP2p({ lat: 24.86, lng: 67.0, observedAt: 5_000, sequence: 1 }, g);
now = 5_000 + custP2p.P2P_FALLBACK_AFTER_MS + 1;
arb.ensureP2pHealth();
const st = arb.getState();
row(
  "Observed behaviour: customer arbiter fallback uses same 30s",
  st.preferred === "firebase" && !st.p2pHealthy,
  `preferred=${st.preferred}`
);

const policy = drvCp.resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: drvCp.VIEWER_LEASE.VISIBLE,
  p2pHealthy: false,
});
row(
  "Observed behaviour: driver checkpoint responsive when P2P down",
  policy.policy === drvCp.CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
    policy.intervalMs === CFG_RESPONSIVE_INTERVAL_MS,
  `${policy.policy}@${policy.intervalMs}`
);

row(
  "Chain consistency: move threshold across reports",
  PHASE1_DRIVER_CONFIG.minimumMovementMeters === CFG_MIN_LOCATION_MOVE_M &&
    CFG_MIN_LOCATION_MOVE_M === 200,
  String(PHASE1_DRIVER_CONFIG.minimumMovementMeters)
);
row(
  "Chain consistency: approach/trip intervals",
  CFG_BACKGROUND_APPROACH_INTERVAL_MS === drvCp.BACKGROUND_APPROACH_INTERVAL_MS &&
    CFG_BACKGROUND_TRIP_INTERVAL_MS === drvCp.BACKGROUND_TRIP_INTERVAL_MS,
  `${CFG_BACKGROUND_APPROACH_INTERVAL_MS}/${CFG_BACKGROUND_TRIP_INTERVAL_MS}`
);
row(
  "Chain consistency: backup read",
  CFG_FIREBASE_BACKUP_READ_INTERVAL_MS === custP2p.FIREBASE_BACKUP_READ_INTERVAL_MS,
  String(CFG_FIREBASE_BACKUP_READ_INTERVAL_MS)
);

const drvProto = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-protocol.mjs"));
const custProto = fs.readFileSync(path.join(ROOT, "customer-app/js/p2p-protocol.mjs"));
row(
  "driver↔customer p2p-protocol.mjs identical",
  Buffer.compare(drvProto, custProto) === 0,
  `bytes=${drvProto.length}`
);

const pass = items.filter((i) => i.result === "PASS").length;
const fail = items.filter((i) => i.result === "FAIL").length;
const report = {
  suite: "cross-device-validation",
  phase: 4,
  title: "Cross-device validation report",
  generatedAt: new Date().toISOString(),
  method:
    "Code-path + shared-module proof (Driver runtime → shared diagnostics → Customer diagnostics → observed arbiter/checkpoint behaviour). Physical dual-handset field run not executed in this agent environment.",
  chain: [
    "Driver runtime (location-checkpoint-policy + p2p-protocol)",
    "Diagnostics CFG_* (shared/js/phase1-billing-diagnostics.mjs)",
    "Customer diagnostics (same shared via wrapper)",
    "Observed behaviour (customer arbiter fallback + driver checkpoint when P2P unhealthy)",
  ],
  pass,
  fail,
  items,
  fieldPending: [
    "Physical Driver+Customer phones observing Diagnostics screen copy reports side-by-side during a live ride",
  ],
  status: fail ? "FAIL" : "PASS — awaiting approval for Phase 5",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nPhase 4: ${pass} PASS / ${fail} FAIL → ${OUT}`);
process.exit(fail ? 1 : 0);
