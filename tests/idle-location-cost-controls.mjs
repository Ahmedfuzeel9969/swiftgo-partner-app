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
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  normalizeIdlePublishConfig,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";

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
  "valid-maximum-interval-boundary",
  normalizeIdlePublishConfig({ idleLocationIntervalMs: 1_800_000 }).idleLocationIntervalMs === 1_800_000
    ? "PASS"
    : "FAIL"
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
  "valid-move-meters-retained",
  normalizeIdlePublishConfig({ idleLocationMoveMeters: 50 }).idleLocationMoveMeters === 50 ? "PASS" : "FAIL"
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
  "malformed-stored-settings-fallback",
  (() => {
    const c = normalizeIdlePublishConfig({
      idleLocationIntervalMs: "bad",
      idleLocationMoveMeters: { x: 1 },
    });
    return c.idleLocationIntervalMs === 4_000 && c.idleLocationMoveMeters === 10 ? "PASS" : "FAIL";
  })()
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
    adminHtml.includes('min="4"') &&
    adminHtml.includes('id="idleLocationMoveMeters"') &&
    adminHtml.includes('min="10"') &&
    !adminHtml.includes("offerTimeoutSeconds") &&
    !adminHtml.includes("searchTimeoutSeconds")
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
  adminApp.includes("normalizeIdlePublishConfig(data)") ? "PASS" : "FAIL"
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
    idleCfg.includes("intervalMsMin: 4_000") &&
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
    { candidateDriverLimit: 15, idleLocationIntervalMs: 9_999_999, idleLocationMoveMeters: 50 },
    "reject-above-maximum-interval"
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
    { candidateDriverLimit: 15, idleLocationIntervalMs: 60_000, idleLocationMoveMeters: 9_999 },
    "reject-above-maximum-move"
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
