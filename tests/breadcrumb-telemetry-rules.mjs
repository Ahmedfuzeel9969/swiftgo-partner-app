/**
 * Isolated Firestore rules tests for rideBreadcrumbTelemetry.
 * Must run in its own Node process under the Firestore emulator.
 *
 * Run:
 *   npm run test:breadcrumb-telemetry-rules
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "breadcrumb-telemetry-rules-results.json");
const PROJECT = "demo-swiftgo-phase1";
const TELEMETRY_COLLECTION = "rideBreadcrumbTelemetry";
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];
function record(name, status, detail = "", category = "rules") {
  results.push({ name, status, detail, suite: "breadcrumb-telemetry-rules", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function staticDenyAll() {
  const block = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  const staticOk =
    /match \/rideBreadcrumbTelemetry\/\{rideId\}[\s\S]*?allow get, list: if false/.test(block) &&
    /match \/rideBreadcrumbTelemetry\/\{rideId\}[\s\S]*?allow create, update, delete: if false/.test(
      block
    );
  record(
    "static-telemetry-deny-all-architecture",
    staticOk ? "PASS" : "FAIL",
    "static architecture",
    "static"
  );
  return staticOk;
}

function writeOut() {
  const summary = {
    suite: "breadcrumb-telemetry-rules",
    generatedAt: new Date().toISOString(),
    total: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `\nSummary: ${summary.pass}/${summary.total} PASS, ${summary.fail} FAIL, ${summary.blocked} BLOCKED → ${OUT}`
  );
  return summary;
}

async function main() {
  console.log("\n=== breadcrumb telemetry rules (isolated) ===\n");
  staticDenyAll();

  let testEnv;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: rulesText, host: "127.0.0.1", port: 8080 },
    });
  } catch (e) {
    record("rules-client-read-denied", "BLOCKED", String(e.message || e).slice(0, 160));
    record("rules-client-write-denied", "BLOCKED", String(e.message || e).slice(0, 160));
    writeOut();
    process.exitCode = 1;
    return;
  }

  const admin = require(
    require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] })
  );
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const adminDb = admin.firestore();

  try {
    await testEnv.clearFirestore();
    await adminDb.collection(TELEMETRY_COLLECTION).doc("ride_rules").set({
      denseChordDistanceMeters: 1,
      rideId: "ride_rules",
    });

    // Reuse one Firestore instance per auth context (matches checkpoint-policy pattern).
    const driverDb = testEnv.authenticatedContext("driver_bc_rules_1").firestore();
    const customerDb = testEnv.authenticatedContext("customer_bc_rules_1").firestore();
    const ownerDb = testEnv.authenticatedContext("owner_bc_rules_1").firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();

    let readOk = true;
    try {
      await assertFails(getDoc(doc(driverDb, TELEMETRY_COLLECTION, "ride_rules")));
      await assertFails(getDoc(doc(customerDb, TELEMETRY_COLLECTION, "ride_rules")));
      await assertFails(getDoc(doc(anonDb, TELEMETRY_COLLECTION, "ride_rules")));
    } catch (e) {
      readOk = false;
      const msg = String(e.message || e).slice(0, 160);
      const blocked = /already been started|settings can no longer be changed|ECONNREFUSED/i.test(
        msg
      );
      record("rules-client-read-denied", blocked ? "BLOCKED" : "FAIL", msg);
    }
    if (readOk) {
      record("rules-client-read-denied", "PASS", "authenticated emulator rules");
    }

    let writeOk = true;
    try {
      await assertFails(updateDoc(doc(driverDb, TELEMETRY_COLLECTION, "ride_rules"), { x: 1 }));
      await assertFails(setDoc(doc(ownerDb, TELEMETRY_COLLECTION, "ride_hack"), { y: 1 }));
      await assertFails(deleteDoc(doc(driverDb, TELEMETRY_COLLECTION, "ride_rules")));
    } catch (e) {
      writeOk = false;
      const msg = String(e.message || e).slice(0, 160);
      const blocked = /already been started|settings can no longer be changed|ECONNREFUSED/i.test(
        msg
      );
      record("rules-client-write-denied", blocked ? "BLOCKED" : "FAIL", msg);
    }
    if (writeOk) {
      record("rules-client-write-denied", "PASS", "authenticated emulator rules");
    }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    const blocked = /already been started|settings can no longer be changed|ECONNREFUSED/i.test(msg);
    if (!results.some((r) => r.name === "rules-client-read-denied")) {
      record("rules-client-read-denied", blocked ? "BLOCKED" : "FAIL", msg);
    }
    if (!results.some((r) => r.name === "rules-client-write-denied")) {
      record("rules-client-write-denied", blocked ? "BLOCKED" : "FAIL", msg);
    }
  } finally {
    await testEnv?.cleanup?.();
  }

  const summary = writeOut();
  process.exitCode = summary.fail > 0 || summary.blocked > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  record("rules-uncaught", "FAIL", String(e.message || e).slice(0, 160));
  writeOut();
  process.exitCode = 1;
});
