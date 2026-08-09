/**
 * Idle location cost controls — unit + static + authenticated emulator verification.
 * Run: npm run test:idle-location-cost-controls
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import {
  BACKGROUND_APPROACH_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  CHECKPOINT_POLICY,
  IDLE_PUBLISH_BOUNDS,
  IDLE_PUBLISH_DEFAULTS,
  MATCHING_STALE_LOCATION_MS,
  MAX_IDLE_INTERVAL_MS,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  normalizeIdlePublishConfig,
  resolveCheckpointPolicy,
  shouldAllowCheckpointWrite,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  isIdleMovementPublishEnabled,
  isLocationFreshForMatching,
  validateIdleIntervalMsForCallable,
  validateIdleMoveMetersForCallable,
  getSafeIdlePublishConfig,
  resolveIdleIntervalMsForPolicy,
  resolveIdleMoveMetersForPolicy,
} from "../driver-app/js/idle-publish-config.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "idle-location-cost-controls-results.json");
const PROJECT = "demo-swiftgo-phase1";
const COMMIT = process.env.GITHUB_SHA || execGitSha();

const unitResults = [];
const staticResults = [];
const emulatorResults = [];

function execGitSha() {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function record(bucket, name, status, detail = "") {
  bucket.push({ name, status, detail, category: bucket === unitResults ? "unit" : bucket === staticResults ? "static" : "emulator" });
  const tag = bucket === unitResults ? "unit" : bucket === staticResults ? "static" : "emulator";
  console.log(`${status === "PASS" ? "✓" : status === "BLOCKED" ? "○" : "✗"} [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function countStatus(list, status) {
  return list.filter((r) => r.status === status).length;
}

// ─── Unit: strict normalizeIdlePublishConfig ───

record(
  unitResults,
  "missing-settings-defaults",
  (() => {
    const c = normalizeIdlePublishConfig({});
    return c.idleLocationIntervalMs === 4_000 && c.idleLocationMoveMeters === 10 ? "PASS" : "FAIL";
  })(),
  JSON.stringify(normalizeIdlePublishConfig({}))
);

record(
  unitResults,
  "valid-custom-interval-retained",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 60_000 }).idleLocationIntervalMs === 60_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "valid-minimum-interval-boundary",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 4_000 }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "defaults-movement-trigger-enabled",
  normalizeIdlePublishConfig({}).idleMovementTriggerDisabled === false ? "PASS" : "FAIL"
);

record(
  unitResults,
  "valid-maximum-interval-boundary",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 300_000 }).idleLocationIntervalMs === 300_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "max-idle-interval-below-stale-threshold",
  MAX_IDLE_INTERVAL_MS < MATCHING_STALE_LOCATION_MS ? "PASS" : "FAIL",
  `${MAX_IDLE_INTERVAL_MS} < ${MATCHING_STALE_LOCATION_MS}`
);

record(
  unitResults,
  "below-min-interval-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 1_000 }).idleLocationIntervalMs ===
    IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "string-interval-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: "60000" }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "negative-interval-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: -500 }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "zero-interval-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 0 }).idleLocationIntervalMs === 4_000 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "fractional-interval-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 4000.5 }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "excessive-interval-falls-back-to-default-not-clamped",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 9_999_999 }).idleLocationIntervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "reject-infinity-interval-validation",
  !validateIdleIntervalMsForCallable(Infinity) && !validateIdleMoveMetersForCallable(Infinity)
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "valid-maximum-move-5000m",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 5_000 }).idleLocationMoveMeters === 5_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "above-max-move-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 5_001 }).idleLocationMoveMeters === 10
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "below-min-move-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 5 }).idleLocationMoveMeters === 10 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "string-move-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: "50" }).idleLocationMoveMeters === 10 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "invalid-move-falls-back-to-default",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: NaN }).idleLocationMoveMeters === 10 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "valid-move-meters-retained",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 50 }).idleLocationMoveMeters === 50 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "diagnostic-active-with-future-expiry",
  (() => {
    const c = normalizeIdlePublishConfig({
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: { toMillis: () => Date.now() + 60_000 },
    });
    return c.idleMovementTriggerDisabled === true && c.idleDiagnosticExpiresAtMs != null ? "PASS" : "FAIL";
  })()
);

function isFullSafeIdleConfig(config) {
  const safe = getSafeIdlePublishConfig();
  return (
    config.idleLocationIntervalMs === safe.idleLocationIntervalMs &&
    config.idleLocationMoveMeters === safe.idleLocationMoveMeters &&
    config.idleMovementTriggerDisabled === safe.idleMovementTriggerDisabled &&
    config.idleDiagnosticExpiresAtMs === safe.idleDiagnosticExpiresAtMs
  );
}

record(
  unitResults,
  "active-diagnostic-retains-custom-interval-move",
  (() => {
    const c = normalizeIdlePublishConfig({
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: { toMillis: () => Date.now() + 120_000 },
      idleLocationIntervalMs: 60_000,
      idleLocationMoveMeters: 50,
    });
    return (
      c.idleMovementTriggerDisabled === true &&
      c.idleLocationIntervalMs === 60_000 &&
      c.idleLocationMoveMeters === 50 &&
      c.idleDiagnosticExpiresAtMs != null
    )
      ? "PASS"
      : "FAIL";
  })()
);

record(
  unitResults,
  "expired-diagnostic-fails-closed-full-safe-defaults",
  (() => {
    const c = normalizeIdlePublishConfig(
      {
        idleMovementTriggerDisabled: true,
        idleDiagnosticExpiresAt: { toMillis: () => Date.now() - 1_000 },
        idleLocationIntervalMs: 120_000,
        idleLocationMoveMeters: 50,
      },
      { nowMs: Date.now() }
    );
    return isFullSafeIdleConfig(c) ? "PASS" : "FAIL";
  })(),
  JSON.stringify(
    normalizeIdlePublishConfig(
      {
        idleMovementTriggerDisabled: true,
        idleDiagnosticExpiresAt: { toMillis: () => Date.now() - 1_000 },
        idleLocationIntervalMs: 120_000,
        idleLocationMoveMeters: 50,
      },
      { nowMs: Date.now() }
    )
  )
);

record(
  unitResults,
  "malformed-diagnostic-expiry-fails-closed-full-safe-defaults",
  (() => {
    const c = normalizeIdlePublishConfig({
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: "not-a-timestamp",
      idleLocationIntervalMs: 120_000,
      idleLocationMoveMeters: 50,
    });
    return isFullSafeIdleConfig(c) ? "PASS" : "FAIL";
  })()
);

record(
  unitResults,
  "reload-after-expiry-stored-firestore-fails-closed",
  (() => {
    const stored = {
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: { _seconds: Math.floor(Date.now() / 1000) - 120, _nanoseconds: 0 },
      idleLocationIntervalMs: 60_000,
      idleLocationMoveMeters: 50,
    };
    return isFullSafeIdleConfig(normalizeIdlePublishConfig(stored, { nowMs: Date.now() }))
      ? "PASS"
      : "FAIL";
  })()
);

record(
  unitResults,
  "timer-expiry-reapply-safe-defaults-once",
  (() => {
    const raw = {
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: { toMillis: () => 1000 },
      idleLocationIntervalMs: 60_000,
      idleLocationMoveMeters: 50,
    };
    const active = normalizeIdlePublishConfig(raw, { nowMs: 500 });
    const expiredOnce = normalizeIdlePublishConfig(raw, { nowMs: 2000 });
    const expiredTwice = normalizeIdlePublishConfig(raw, { nowMs: 3000 });
    return (
      active.idleMovementTriggerDisabled === true &&
      active.idleLocationIntervalMs === 60_000 &&
      isFullSafeIdleConfig(expiredOnce) &&
      isFullSafeIdleConfig(expiredTwice)
    )
      ? "PASS"
      : "FAIL";
  })()
);

record(
  unitResults,
  "movement-disabled-blocks-move-only-publish",
  (() => {
    const now = 100_000;
    const gate = shouldAllowCheckpointWrite({
      nowMs: now,
      lastWriteMs: now - 5_000,
      intervalMs: 60_000,
      movedEnough: false,
      zoneChanged: false,
      matchCellChanged: false,
    });
    return gate.allow === false && gate.reason === "interval_and_move" ? "PASS" : "FAIL";
  })()
);

record(
  unitResults,
  "mandatory-heartbeat-still-publishes",
  (() => {
    const now = 200_000;
    const gate = shouldAllowCheckpointWrite({
      nowMs: now,
      lastWriteMs: now - 60_000,
      intervalMs: 60_000,
      movedEnough: false,
      zoneChanged: false,
      matchCellChanged: false,
    });
    return gate.allow === true ? "PASS" : "FAIL";
  })()
);

record(
  unitResults,
  "driver-matchable-before-mandatory-heartbeat",
  (() => {
    const now = Date.now();
    const lastWrite = now - MAX_IDLE_INTERVAL_MS + 30_000;
    return isLocationFreshForMatching(lastWrite, now, MATCHING_STALE_LOCATION_MS) ? "PASS" : "FAIL";
  })()
);

record(
  unitResults,
  "is-idle-movement-publish-disabled-flag",
  isIdleMovementPublishEnabled({ idleMovementTriggerDisabled: true }) === false &&
    isIdleMovementPublishEnabled({ idleMovementTriggerDisabled: false }) === true
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "malformed-stored-settings-fallback",
  (() => {
    const c = normalizeIdlePublishConfig({
      idleLocationIntervalMs: "bad",
      idleLocationMoveMeters: { x: 1 },
    });
    return c.idleLocationIntervalMs === 4_000 && c.idleLocationMoveMeters === 10 ? "PASS" : "FAIL";
  })()
);

record(
  unitResults,
  "controller-diagnostic-movement-flag",
  (() => {
    const c = createCheckpointPolicyController();
    c.setIdlePublishConfig({
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: { toMillis: () => Date.now() + 120_000 },
    });
    return c.isIdleMovementTriggerDisabled() === true ? "PASS" : "FAIL";
  })()
);

// ─── Unit: resolveCheckpointPolicy strict idle interval (no Number coercion) ───

record(
  unitResults,
  "resolve-policy-valid-idle-interval",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 60_000 }).intervalMs === 60_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-string-idle-interval-defaults",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: "60000" }).intervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-fractional-idle-interval-defaults",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 4000.5 }).intervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-infinity-idle-interval-defaults",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: Infinity }).intervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-below-min-idle-interval-defaults",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 1_000 }).intervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-above-max-idle-interval-defaults",
  resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 400_000 }).intervalMs === 4_000
    ? "PASS"
    : "FAIL"
);

record(
  unitResults,
  "resolve-policy-move-resolver-rejects-string",
  resolveIdleMoveMetersForPolicy("50") === 10 ? "PASS" : "FAIL"
);

record(
  unitResults,
  "resolve-policy-move-resolver-accepts-valid",
  resolveIdleMoveMetersForPolicy(50) === 50 ? "PASS" : "FAIL"
);

// ─── Unit: idle vs active ride policy (unchanged) ───

const idlePolicy = resolveCheckpointPolicy({ hasActiveRide: false, idleIntervalMs: 60_000 });
record(
  unitResults,
  "idle-path-uses-configured-interval",
  idlePolicy.policy === CHECKPOINT_POLICY.NO_ACTIVE_RIDE && idlePolicy.intervalMs === 60_000 ? "PASS" : "FAIL",
  String(idlePolicy.intervalMs)
);

const activeVisible = resolveCheckpointPolicy({
  hasActiveRide: true,
  rideStatus: "accepted",
  viewerLease: VIEWER_LEASE.VISIBLE,
  idleIntervalMs: 60_000,
});
record(
  unitResults,
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
  unitResults,
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
  unitResults,
  "active-ride-background-trip-unchanged",
  activeHiddenTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS ? "PASS" : "FAIL"
);

const ctrl = createCheckpointPolicyController();
ctrl.setIdlePublishConfig({ idleLocationIntervalMs: 120_000, idleLocationMoveMeters: 50 });
record(
  unitResults,
  "controller-applies-idle-config",
  ctrl.getIdlePublishConfig().idleLocationIntervalMs === 120_000 && ctrl.getIdleMoveMeters() === 50
    ? "PASS"
    : "FAIL"
);

ctrl.setActiveRide({ active: true, rideId: "r1", status: "accepted" });
ctrl.setViewerLease(VIEWER_LEASE.VISIBLE);
record(
  unitResults,
  "controller-active-ride-not-idle-interval",
  ctrl.currentDecision().intervalMs === RESPONSIVE_INTERVAL_MS ? "PASS" : "FAIL"
);

ctrl.setActiveRide({ active: false });
record(
  unitResults,
  "controller-idle-uses-stored-interval",
  ctrl.currentDecision().intervalMs === 120_000 ? "PASS" : "FAIL"
);

// ─── Unit: listener restart contract (mirrors driver-app) ───

function createDispatchIdleWatchHarness() {
  let active = 0;
  let unsub = () => {};
  return {
    start() {
      unsub();
      active = 1;
      unsub = () => {
        active = 0;
      };
    },
    stop() {
      unsub();
      unsub = () => {};
      active = 0;
    },
    activeCount() {
      return active;
    },
  };
}

const watch = createDispatchIdleWatchHarness();
watch.start();
watch.start();
record(
  unitResults,
  "listener-restart-replaces-not-duplicates",
  watch.activeCount() === 1 ? "PASS" : "FAIL",
  "double start leaves one active subscription"
);
watch.stop();
record(
  unitResults,
  "listener-stop-clears-subscription",
  watch.activeCount() === 0 ? "PASS" : "FAIL"
);

// ─── Static wiring ───

const driverApp = read("driver-app/js/driver-app.js");
const policySrc = read("driver-app/js/location-checkpoint-policy.mjs");
record(
  staticResults,
  "resolve-policy-no-number-coercion",
  !policySrc.match(/Number\(input\.idleIntervalMs\)/) &&
    policySrc.includes("resolveIdleIntervalMsForPolicy(input.idleIntervalMs)")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "one-dispatch-listener-fn",
  (driverApp.match(/function startDispatchIdleSettingsWatch/g) || []).length === 1 ? "PASS" : "FAIL"
);
record(
  staticResults,
  "stop-before-subscribe-pattern",
  driverApp.includes("stopDispatchIdleSettingsWatch();") &&
    /function startDispatchIdleSettingsWatch\(\)[\s\S]{0,120}stopDispatchIdleSettingsWatch\(\)/.test(
      driverApp
    )
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "single-settings-doc-listener",
  (driverApp.match(/onSnapshot\(\s*\n?\s*doc\(db, "settings", "dispatch"\)/g) || []).length === 1
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "idle-move-threshold-when-waiting",
  driverApp.includes("checkpointPolicy.getIdleMoveMeters()") && driverApp.includes("idleWaiting")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "no-p2p-import-change",
  !driverApp.includes("dispatch-offer-settings") ? "PASS" : "FAIL"
);

const adminApp = read("super-admin-panel/js/admin-app.js");
const adminHtml = read("super-admin-panel/index.html");
record(
  staticResults,
  "admin-html-idle-minimums",
  adminHtml.includes('id="idleLocationIntervalSeconds"') &&
    adminHtml.includes('max="300"') &&
    adminHtml.includes('id="idleLocationMoveMeters"') &&
    adminHtml.includes('max="5000"') &&
    adminHtml.includes('min="10"') &&
    !adminHtml.includes("offerTimeoutSeconds") &&
    !adminHtml.includes("searchTimeoutSeconds")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "admin-diagnostic-section-and-urdu",
  adminHtml.includes("idleDiagnosticSection") &&
    adminHtml.includes("idleMovementTriggerDisabled") &&
    adminHtml.includes("حرکت کی بنیاد پر لوکیشن بھیجنا") &&
    adminHtml.includes("idleReturnSafeDefaultsBtn") &&
    adminHtml.includes("idleDiagnosticRedWarning") &&
    adminHtml.includes("4 سیکنڈ / 10 میٹر") &&
    adminHtml.includes("idleHighMoveWarning")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "admin-diagnostic-confirmation-and-save",
  adminApp.includes("window.confirm") &&
    adminApp.includes("idleMovementTriggerDisabled") &&
    adminApp.includes("idleDiagnosticDurationMinutes") &&
    adminApp.includes("returnIdleToSafeDefaults")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "driver-movement-disabled-publish-path",
  driverApp.includes("isIdleMovementPublishAllowed") &&
    driverApp.includes("clearIdleDiagnosticExpiryTimer") &&
    driverApp.includes("applyDispatchIdleSettingsFromFirestore")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "no-financial-module-idle-coupling",
  !read("functions/bargaining.js").includes("idleMovementTriggerDisabled") &&
    !read("functions/matching.js").includes("idleMovementTriggerDisabled") &&
    !read("driver-app/js/settlement-client.js").includes("idleMovementTriggerDisabled")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "admin-urdu-cost-warning",
  adminHtml.includes("لاگت انتباہ") &&
    adminHtml.includes("Firebase") &&
    adminHtml.includes("فعال سواری کے بغیر")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "admin-uses-normalize-on-load",
  adminApp.includes("normalizeIdlePublishConfig(data, { nowMs: Date.now() })") ? "PASS" : "FAIL"
);
record(
  staticResults,
  "admin-save-minimum-validation",
  adminApp.includes("IDLE_PUBLISH_BOUNDS.moveMetersMin") &&
    adminApp.includes("IDLE_PUBLISH_BOUNDS.intervalMsMin")
    ? "PASS"
    : "FAIL"
);

const fnIndex = read("functions/index.js");
const idleCfg = read("functions/idle-publish-config.js");
record(
  staticResults,
  "server-strict-idle-validation-module",
  fnIndex.includes('require("./idle-publish-config")') &&
    fnIndex.includes("validateIdleIntervalMsForCallable") &&
    idleCfg.includes("intervalMsMax: 300_000") &&
    idleCfg.includes("moveMetersMin: 10")
    ? "PASS"
    : "FAIL"
);
record(
  staticResults,
  "server-no-number-coercion-on-idle",
  !fnIndex.match(/Math\.round\(Number\(request\.data\.idleLocation/) ? "PASS" : "FAIL"
);
record(
  staticResults,
  "no-offer-timeout-in-this-pr",
  !fnIndex.includes("offerTimeoutSeconds") ? "PASS" : "FAIL"
);

// ─── Emulator: Admin-save → Firestore → Driver-read ───

async function runEmulatorTests() {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.GCLOUD_PROJECT ||= PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

  const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
  let adminApp;
  try {
    adminApp = admin.app();
  } catch {
    adminApp = admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore(adminApp);
  const { BOOTSTRAP_ADMIN_EMAIL } = require(path.join(ROOT, "functions", "admin-claims.js"));

  function clientApp(name) {
    const app = initializeApp({ apiKey: "demo", projectId: PROJECT, appId: "demo" }, name);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    const firestore = getFirestore(app);
    connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
    const functions = getFunctions(app, "us-central1");
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    return { app, auth, firestore, functions };
  }

  async function ensureUser(email, password, uidHint) {
    try {
      return await admin.auth().createUser({
        uid: uidHint,
        email,
        password,
        emailVerified: true,
      });
    } catch (e) {
      if (e.code === "auth/uid-already-exists" || e.code === "auth/email-already-exists") {
        return admin.auth().getUser(uidHint).catch(() => admin.auth().getUserByEmail(email));
      }
      throw e;
    }
  }

  async function callAs(functions, name, data) {
    const fn = httpsCallable(functions, name);
    const res = await fn(data);
    return res?.data;
  }

  function errText(e) {
    return [e?.code, e?.message, e?.details].filter(Boolean).join(" | ");
  }

  async function expectCallableReject(functions, name, data, label) {
    try {
      await callAs(functions, name, data);
      record(emulatorResults, label, "FAIL", "expected rejection");
      return false;
    } catch (e) {
      const ok = String(e?.code || "").includes("invalid-argument") || String(e?.code || "").includes("permission-denied");
      record(emulatorResults, label, ok ? "PASS" : "FAIL", errText(e));
      return ok;
    }
  }

  await db.doc("settings/security").set({ adminBootstrapEnabled: true });
  await db.doc("settings/dispatch").set({
    candidateDriverLimit: 15,
    maxSearchRadiusKm: 5,
    maxSearchRadiusMeters: 500,
    searchRingsKm: [1, 2, 3, 4, 5],
    customMarkerField: "preserve-me",
  });

  await ensureUser(BOOTSTRAP_ADMIN_EMAIL, "IdleCost-test!", "idle-admin");
  await ensureUser("idle-driver@example.com", "IdleCost-test!", "idle-driver");
  await ensureUser("idle-user@example.com", "IdleCost-test!", "idle-user");

  const boot = clientApp("idle-boot");
  const driver = clientApp("idle-driver");
  const ordinary = clientApp("idle-user");

  await signInWithEmailAndPassword(boot.auth, BOOTSTRAP_ADMIN_EMAIL, "IdleCost-test!");
  await signInWithEmailAndPassword(driver.auth, "idle-driver@example.com", "IdleCost-test!");
  await signInWithEmailAndPassword(ordinary.auth, "idle-user@example.com", "IdleCost-test!");

  await callAs(boot.functions, "bootstrapAdminClaim", {});
  await boot.auth.currentUser.getIdToken(true);

  const saveRes = await callAs(boot.functions, "setCandidateDriverLimit", {
    candidateDriverLimit: 15,
    idleLocationIntervalMs: 60_000,
    idleLocationMoveMeters: 50,
  });
  record(
    emulatorResults,
    "admin-save-valid-60s-50m",
    saveRes?.idleLocationIntervalMs === 60_000 && saveRes?.idleLocationMoveMeters === 50 ? "PASS" : "FAIL",
    JSON.stringify(saveRes)
  );

  const dispatchSnap = await db.doc("settings/dispatch").get();
  const dispatchData = dispatchSnap.data() || {};
  record(
    emulatorResults,
    "firestore-idle-values-exact",
    dispatchData.idleLocationIntervalMs === 60_000 && dispatchData.idleLocationMoveMeters === 50
      ? "PASS"
      : "FAIL",
    JSON.stringify({
      idleLocationIntervalMs: dispatchData.idleLocationIntervalMs,
      idleLocationMoveMeters: dispatchData.idleLocationMoveMeters,
    })
  );

  const driverRead = await getDoc(doc(driver.firestore, "settings", "dispatch"));
  record(
    emulatorResults,
    "authenticated-driver-reads-dispatch",
    driverRead.exists() &&
      driverRead.data()?.idleLocationIntervalMs === 60_000 &&
      driverRead.data()?.idleLocationMoveMeters === 50
      ? "PASS"
      : "FAIL"
  );

  await expectCallableReject(
    ordinary.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 10, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 50 },
    "non-admin-cannot-save-settings"
  );

  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: "60000", idleLocationMoveMeters: 50 },
    "reject-numeric-string-interval"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: "50" },
    "reject-numeric-string-move"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60000.5, idleLocationMoveMeters: 50 },
    "reject-fractional-interval"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 50.5 },
    "reject-fractional-move"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: -1, idleLocationMoveMeters: 50 },
    "reject-negative-interval"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 0, idleLocationMoveMeters: 50 },
    "reject-zero-interval"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 1_000, idleLocationMoveMeters: 50 },
    "reject-below-minimum-interval"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 400_000, idleLocationMoveMeters: 50 },
    "reject-above-maximum-interval"
  );
  let infinityClientRejected = false;
  try {
    await callAs(boot.functions, "setCandidateDriverLimit", {
      candidateDriverLimit: 15,
      idleLocationIntervalMs: Infinity,
      idleLocationMoveMeters: 50,
    });
  } catch (e) {
    infinityClientRejected =
      String(e?.message || "").includes("JSON") ||
      String(e?.code || "").includes("invalid-argument");
  }
  record(
    emulatorResults,
    "reject-infinity-interval",
    infinityClientRejected ? "PASS" : "FAIL",
    "Infinity cannot be encoded or accepted"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: -1 },
    "reject-negative-move"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 0 },
    "reject-zero-move"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 5 },
    "reject-below-minimum-move"
  );
  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 5_001 },
    "reject-above-maximum-move-5001m"
  );

  const move5kRes = await callAs(boot.functions, "setCandidateDriverLimit", {
    candidateDriverLimit: 15,
    idleLocationMoveMeters: 5_000,
  });
  record(
    emulatorResults,
    "accept-5000m-move-testing-range",
    move5kRes?.idleLocationMoveMeters === 5_000 ? "PASS" : "FAIL",
    JSON.stringify({ move: move5kRes?.idleLocationMoveMeters })
  );

  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    {
      candidateDriverLimit: 15,
      idleMovementTriggerDisabled: true,
      idleDiagnosticDurationMinutes: 10,
      idleDiagnosticExpiresAt: { seconds: 9999999999, nanoseconds: 0 },
    },
    "reject-client-supplied-diagnostic-expiry"
  );

  await expectCallableReject(
    ordinary.functions,
    "setCandidateDriverLimit",
    {
      candidateDriverLimit: 15,
      idleMovementTriggerDisabled: true,
      idleDiagnosticDurationMinutes: 5,
    },
    "non-admin-cannot-enable-diagnostic"
  );

  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    {
      candidateDriverLimit: 15,
      idleMovementTriggerDisabled: true,
      idleDiagnosticDurationMinutes: 31,
    },
    "reject-diagnostic-duration-above-30m"
  );

  await expectCallableReject(
    boot.functions,
    "setCandidateDriverLimit",
    {
      candidateDriverLimit: 15,
      idleMovementTriggerDisabled: "true",
      idleDiagnosticDurationMinutes: 5,
    },
    "reject-diagnostic-flag-string"
  );

  const diagRes = await callAs(boot.functions, "setCandidateDriverLimit", {
    candidateDriverLimit: 15,
    idleLocationIntervalMs: 60_000,
    idleMovementTriggerDisabled: true,
    idleDiagnosticDurationMinutes: 10,
    idleDiagnosticReason: "field-test-grid",
  });
  record(
    emulatorResults,
    "admin-enable-diagnostic-movement-disabled",
    diagRes?.idleMovementTriggerDisabled === true ? "PASS" : "FAIL",
    JSON.stringify(diagRes)
  );

  const diagDoc = (await db.doc("settings/dispatch").get()).data() || {};
  record(
    emulatorResults,
    "diagnostic-audit-metadata-non-pii",
    diagDoc.idleMovementTriggerDisabled === true &&
      typeof diagDoc.idleDiagnosticEnabledBy === "string" &&
      diagDoc.idleDiagnosticExpiresAt != null &&
      diagDoc.idleDiagnosticReason === "field-test-grid" &&
      !String(diagDoc.idleDiagnosticEnabledBy).includes("@")
      ? "PASS"
      : "FAIL",
    JSON.stringify({
      enabledBy: diagDoc.idleDiagnosticEnabledBy,
      reason: diagDoc.idleDiagnosticReason,
      hasExpiry: Boolean(diagDoc.idleDiagnosticExpiresAt),
    })
  );

  const expiredNorm = normalizeIdlePublishConfig(
    {
      idleMovementTriggerDisabled: true,
      idleDiagnosticExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000),
    },
    { nowMs: Date.now() }
  );
  record(
    emulatorResults,
    "expired-diagnostic-emulator-fails-closed-full-safe-defaults",
    isFullSafeIdleConfig(expiredNorm) ? "PASS" : "FAIL",
    JSON.stringify(expiredNorm)
  );

  await callAs(boot.functions, "setCandidateDriverLimit", {
    candidateDriverLimit: 15,
    idleMovementTriggerDisabled: false,
  });
  const clearedDoc = (await db.doc("settings/dispatch").get()).data() || {};
  record(
    emulatorResults,
    "admin-disable-diagnostic-clears-flag",
    clearedDoc.idleMovementTriggerDisabled === false ? "PASS" : "FAIL"
  );

  await db.doc("settings/dispatch-empty").set({});
  const emptyNorm = normalizeIdlePublishConfig((await db.doc("settings/dispatch-empty").get()).data() || {});
  record(
    emulatorResults,
    "missing-idle-settings-use-defaults",
    emptyNorm.idleLocationIntervalMs === 4_000 && emptyNorm.idleLocationMoveMeters === 10 ? "PASS" : "FAIL",
    JSON.stringify(emptyNorm)
  );

  await db.doc("settings/dispatch-bad").set({
    idleLocationIntervalMs: "60000",
    idleLocationMoveMeters: 1.5,
  });
  const badNorm = normalizeIdlePublishConfig((await db.doc("settings/dispatch-bad").get()).data() || {});
  record(
    emulatorResults,
    "malformed-stored-settings-consumer-defaults",
    badNorm.idleLocationIntervalMs === 4_000 && badNorm.idleLocationMoveMeters === 10 ? "PASS" : "FAIL",
    JSON.stringify(badNorm)
  );

  record(
    emulatorResults,
    "unrelated-dispatch-fields-preserved",
    dispatchData.candidateDriverLimit === 15 &&
      dispatchData.maxSearchRadiusKm === 5 &&
      dispatchData.maxSearchRadiusMeters === 500 &&
      dispatchData.customMarkerField === "preserve-me"
      ? "PASS"
      : "FAIL",
    JSON.stringify({
      candidateDriverLimit: dispatchData.candidateDriverLimit,
      maxSearchRadiusKm: dispatchData.maxSearchRadiusKm,
      maxSearchRadiusMeters: dispatchData.maxSearchRadiusMeters,
      customMarkerField: dispatchData.customMarkerField,
    })
  );

  for (const c of [boot, driver, ordinary]) {
    try {
      await deleteApp(c.app);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const emulatorRequested = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (emulatorRequested) {
    try {
      await runEmulatorTests();
    } catch (err) {
      record(emulatorResults, "emulator-suite-bootstrap", "FAIL", err?.message || String(err));
    }
  } else {
    record(
      emulatorResults,
      "emulator-suite",
      "BLOCKED",
      "Run via npm run test:idle-location-cost-controls (firebase emulators:exec)"
    );
  }

  const allResults = [...unitResults, ...staticResults, ...emulatorResults];
  const summary = {
    generatedAt: new Date().toISOString(),
    commit: COMMIT,
    suite: "idle-location-cost-controls",
    categories: {
      unit: {
        total: unitResults.length,
        pass: countStatus(unitResults, "PASS"),
        fail: countStatus(unitResults, "FAIL"),
        blocked: countStatus(unitResults, "BLOCKED"),
      },
      static: {
        total: staticResults.length,
        pass: countStatus(staticResults, "PASS"),
        fail: countStatus(staticResults, "FAIL"),
        blocked: countStatus(staticResults, "BLOCKED"),
      },
      emulator: {
        total: emulatorResults.length,
        pass: countStatus(emulatorResults, "PASS"),
        fail: countStatus(emulatorResults, "FAIL"),
        blocked: countStatus(emulatorResults, "BLOCKED"),
      },
    },
    total: allResults.length,
    pass: countStatus(allResults, "PASS"),
    fail: countStatus(allResults, "FAIL"),
    blocked: countStatus(allResults, "BLOCKED"),
    results: allResults,
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `\nIdle location cost controls: unit ${summary.categories.unit.pass}/${summary.categories.unit.total}, static ${summary.categories.static.pass}/${summary.categories.static.total}, emulator ${summary.categories.emulator.pass}/${summary.categories.emulator.total} (fail=${summary.fail}, blocked=${summary.blocked})`
  );
  if (summary.fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
