/**
 * Phase 4F — geo coverage + ops health callables on emulators.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const RESULTS = path.join(ROOT, "tests", "phase4f-ops-results.json");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];
function record(name, expected, actual, status, extra = {}) {
  results.push({ name, expected, actual, status, ...extra });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${status}] ${name}`);
}

const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
let adminApp;
try {
  adminApp = admin.app();
} catch {
  adminApp = admin.initializeApp({ projectId: PROJECT });
}
const adminDb = admin.firestore(adminApp);
const { BOOTSTRAP_ADMIN_EMAIL } = require(path.join(ROOT, "functions", "admin-claims.js"));

async function main() {
  const engines = JSON.parse(fs.readFileSync(path.join(ROOT, "functions", "package.json"), "utf8"));
  record("functions-engines-node22", "22", engines.engines?.node, engines.engines?.node === "22" ? "PASS" : "FAIL");

  const firebaseJson = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));
  const runtime = firebaseJson.functions?.[0]?.runtime;
  record("firebase-json-runtime-nodejs22", "nodejs22", runtime, runtime === "nodejs22" ? "PASS" : "FAIL");

  const geoMatch = fs.readFileSync(path.join(ROOT, "functions", "geo-match.js"), "utf8");
  record(
    "geo-match-no-full-fleet-scan",
    "usedFullFleetScan false",
    geoMatch.includes("usedFullFleetScan: false"),
    geoMatch.includes("usedFullFleetScan: false") ? "PASS" : "FAIL"
  );

  // Seed vehicles: one with geoCell, one online missing geoCell
  await adminDb.collection("vehicles").doc("cov-ok").set({
    status: "online",
    driverId: "d-ok",
    geoCell: "24.86_67.00",
    location: { lat: 24.86, lng: 67.0 },
    locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await adminDb.collection("vehicles").doc("cov-miss").set({
    status: "online",
    driverId: "d-miss",
    location: { lat: 24.87, lng: 67.01 },
    locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const password = "Phase4f-Ops-1!";
  const app = initializeApp(
    { apiKey: "demo", projectId: PROJECT, appId: "1:demo:web:phase4f" },
    "phase4f-ops"
  );
  const auth = getAuth(app);
  const functions = getFunctions(app, "us-central1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  try {
    // Bootstrap admin
    let adminUser;
    try {
      adminUser = await createUserWithEmailAndPassword(auth, BOOTSTRAP_ADMIN_EMAIL, password);
    } catch {
      adminUser = await signInWithEmailAndPassword(auth, BOOTSTRAP_ADMIN_EMAIL, password);
    }
    await admin.auth().updateUser(adminUser.user.uid, { emailVerified: true });
    // refresh token after verify
    await signInWithEmailAndPassword(auth, BOOTSTRAP_ADMIN_EMAIL, password);
    await httpsCallable(functions, "bootstrapAdminClaim")({});

    const coverage = await httpsCallable(functions, "getGeoCellCoverageReport")({ limit: 50 });
    const c = coverage.data || {};
    record(
      "geocell-coverage-detects-missing",
      "missingGeoCell >= 1",
      c.missingGeoCell,
      Number(c.missingGeoCell) >= 1 ? "PASS" : "FAIL",
      { scannedOnline: c.scannedOnline, withGeoCell: c.withGeoCell }
    );
    record(
      "geocell-fail-safe-note",
      "present",
      Boolean(c.failSafeNote),
      c.failSafeNote ? "PASS" : "FAIL"
    );

    const health = await httpsCallable(functions, "getOpsHealthSummary")({});
    record("ops-health-ok", true, Boolean(health.data?.ok), health.data?.ok ? "PASS" : "FAIL");

    // PIN inventory tool on emulator
    const { spawnSync } = await import("node:child_process");
    const inv = spawnSync(
      process.execPath,
      [path.join(ROOT, "tools", "phase4f-pin-inventory.cjs")],
      {
        env: { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", GCLOUD_PROJECT: PROJECT },
        encoding: "utf8",
      }
    );
    record(
      "pin-inventory-tool-exit",
      0,
      inv.status,
      inv.status === 0 ? "PASS" : "FAIL",
      { stderr: (inv.stderr || "").slice(0, 200) }
    );
    const invOut = String(inv.stdout || "");
    record(
      "pin-inventory-no-plaintext-dump",
      "no pin= values",
      !/\bpin\s*[:=]\s*["']?\d{4}/i.test(invOut),
      !/\bpin\s*[:=]\s*["']?\d{4}/i.test(invOut) ? "PASS" : "FAIL"
    );
  } finally {
    await deleteApp(app);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS,
    JSON.stringify(
      {
        phase: "4F-ops",
        generatedAt: new Date().toISOString(),
        pass: results.filter((r) => r.status === "PASS").length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nPhase 4F ops: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
