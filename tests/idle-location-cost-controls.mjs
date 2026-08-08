/**
 * Idle location cost controls — focused verification (P1-A restore on main).
 * Run: npm run test:idle-location-cost-controls
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  CHECKPOINT_POLICY,
  IDLE_LOCATION_INTERVAL_MS,
  IDLE_PUBLISH_BOUNDS,
  MIN_LOCATION_MOVE_M,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  normalizeIdlePublishConfig,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "idle-location-cost-controls-results.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// --- normalizeIdlePublishConfig ---

record(
  "missing-settings-defaults",
  (() => {
    const c = normalizeIdlePublishConfig({});
    return c.idleLocationIntervalMs === 4_000 && c.idleLocationMoveMeters === 10 ? "PASS" : "FAIL";
  })(),
  JSON.stringify(normalizeIdlePublishConfig({}))
);

record(
  "valid-minimum-interval",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 1_000 }).idleLocationIntervalMs === 1_000
    ? "PASS"
    : "FAIL"
);

record(
  "valid-maximum-interval",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 30 * 60_000 }).idleLocationIntervalMs ===
    30 * 60_000
    ? "PASS"
    : "FAIL"
);

record(
  "valid-default-interval",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 4_000 }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  "invalid-type-interval-fallback",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: "not-a-number" }).idleLocationIntervalMs ===
    IDLE_LOCATION_INTERVAL_MS
    ? "PASS"
    : "FAIL"
);

record(
  "negative-interval-clamped-to-min",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: -500 }).idleLocationIntervalMs ===
    IDLE_PUBLISH_BOUNDS.intervalMsMin
    ? "PASS"
    : "FAIL"
);

record(
  "zero-interval-clamped-to-min",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 0 }).idleLocationIntervalMs ===
    IDLE_PUBLISH_BOUNDS.intervalMsMin
    ? "PASS"
    : "FAIL"
);

record(
  "excessive-interval-clamped-to-max",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 999_999_999 }).idleLocationIntervalMs ===
    IDLE_PUBLISH_BOUNDS.intervalMsMax
    ? "PASS"
    : "FAIL"
);

record(
  "valid-move-meters",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 200 }).idleLocationMoveMeters === 200
    ? "PASS"
    : "FAIL"
);

record(
  "invalid-move-fallback",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: NaN }).idleLocationMoveMeters ===
    MIN_LOCATION_MOVE_M
    ? "PASS"
    : "FAIL"
);

// --- idle vs active ride policy ---

const idlePolicy = resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 60_000 });
record(
  "idle-path-uses-configured-interval",
  idlePolicy.policy === CHECKPOINT_POLICY.NO_ACTIVE_RIDE && idlePolicy.intervalMs === 60_000
    ? "PASS"
    : "FAIL",
  String(idlePolicy.intervalMs)
);

const activeVisible = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: VIEWER_LEASE.VISIBLE,
  idleIntervalMs: 60_000,
});
record(
  "active-ride-ignores-idle-interval",
  activeVisible.intervalMs === RESPONSIVE_INTERVAL_MS ? "PASS" : "FAIL",
  String(activeVisible.intervalMs)
);

const activeSparse = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: VIEWER_LEASE.VISIBLE,
  p2pHealthy: true,
  idleIntervalMs: 999_999,
});
record(
  "active-ride-p2p-sparse-unchanged",
  activeSparse.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS ? "PASS" : "FAIL"
);

const activeHiddenTrip = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "in_progress",
  viewerLease: VIEWER_LEASE.EXPIRED,
  idleIntervalMs: 999_999,
});
record(
  "active-ride-background-trip-unchanged",
  activeHiddenTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS ? "PASS" : "FAIL"
);

// --- controller consumer ---

const ctrl = createCheckpointPolicyController();
ctrl.setIdlePublishConfig({ idleLocationIntervalMs: 120_000, idleLocationMoveMeters: 50 });
record(
  "controller-applies-idle-config",
  ctrl.getIdlePublishConfig().idleLocationIntervalMs === 120_000 &&
    ctrl.getIdleMoveMeters() === 50
    ? "PASS"
    : "FAIL"
);

ctrl.setActiveRide({ active: true, rideId: "r1", status: "accepted" });
ctrl.setViewerLease(VIEWER_LEASE.VISIBLE);
const activeDecision = ctrl.currentDecision();
record(
  "controller-active-ride-not-idle-interval",
  activeDecision.intervalMs === RESPONSIVE_INTERVAL_MS ? "PASS" : "FAIL",
  String(activeDecision.intervalMs)
);

ctrl.setActiveRide({ active: false });
const idleDecision = ctrl.currentDecision();
record(
  "controller-idle-uses-stored-interval",
  idleDecision.intervalMs === 120_000 ? "PASS" : "FAIL",
  String(idleDecision.intervalMs)
);

// --- static wiring ---

const driverApp = read("driver-app/js/driver-app.js");
record(
  "one-dispatch-listener-fn",
  (driverApp.match(/function startDispatchIdleSettingsWatch/g) || []).length === 1 ? "PASS" : "FAIL"
);
record(
  "one-dispatch-unsubscribe-var",
  (driverApp.match(/unsubscribeDispatchIdleSettings/g) || []).length >= 2 ? "PASS" : "FAIL"
);
record(
  "single-settings-doc-listener",
  (driverApp.match(/onSnapshot\(\s*\n?\s*doc\(db, "settings", "dispatch"\)/g) || []).length === 1
    ? "PASS"
    : "FAIL"
);
record(
  "idle-move-threshold-when-waiting",
  driverApp.includes("checkpointPolicy.getIdleMoveMeters()") &&
    driverApp.includes("idleWaiting")
    ? "PASS"
    : "FAIL"
);
record(
  "no-ride-driverLocation-client-write",
  !driverApp.match(/updateDoc\([\s\S]{0,120}driverLocation/) ? "PASS" : "FAIL",
  "CF mirror remains sole ride.driverLocation writer"
);
record(
  "no-p2p-import-change",
  !driverApp.includes("dispatch-offer-settings") ? "PASS" : "FAIL"
);
record(
  "no-breadcrumb-change",
  driverApp.includes("createBreadcrumbCollector") ? "PASS" : "FAIL"
);

const adminApp = read("super-admin-panel/js/admin-app.js");
const adminHtml = read("super-admin-panel/index.html");
record(
  "admin-html-idle-fields",
  adminHtml.includes("idleLocationIntervalSeconds") &&
    adminHtml.includes("idleLocationMoveMeters") &&
    !adminHtml.includes("offerTimeoutSeconds") &&
    !adminHtml.includes("searchTimeoutSeconds")
    ? "PASS"
    : "FAIL"
);
record(
  "admin-atomic-save-payload",
  adminApp.includes("idleLocationIntervalMs: idleSeconds * 1000") &&
    adminApp.includes("idleLocationMoveMeters: idleMoveMeters") &&
    adminApp.includes("saveAdminDispatchSettings({")
    ? "PASS"
    : "FAIL"
);
record(
  "admin-one-dispatch-submit-handler",
  (adminApp.match(/dispatchForm\?\.addEventListener\("submit", saveDispatchSettings\)/g) || [])
    .length === 1
    ? "PASS"
    : "FAIL"
);

const fnIndex = read("functions/index.js");
record(
  "server-idle-interval-validation",
  fnIndex.includes("IDLE_INTERVAL_OUT_OF_RANGE") &&
    fnIndex.includes("idleMs < 1_000") &&
    fnIndex.includes("idleMs > 30 * 60_000")
    ? "PASS"
    : "FAIL"
);
record(
  "server-idle-move-validation",
  fnIndex.includes("IDLE_MOVE_OUT_OF_RANGE") &&
    fnIndex.includes("moveM < 1") &&
    fnIndex.includes("moveM > 5_000")
    ? "PASS"
    : "FAIL"
);
record(
  "no-offer-timeout-in-this-pr",
  !fnIndex.includes("offerTimeoutSeconds") ? "PASS" : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const summary = {
  generatedAt: new Date().toISOString(),
  suite: "idle-location-cost-controls",
  total: results.length,
  pass: results.filter((r) => r.status === "PASS").length,
  fail: failCount,
  results,
};
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`\nIdle location cost controls: ${summary.pass}/${summary.total} PASS`);
if (failCount > 0) process.exit(1);
