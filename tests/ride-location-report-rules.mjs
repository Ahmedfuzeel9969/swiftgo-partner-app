/**
 * Firestore rules tests for rideLocationReports (super_admin read, client deny writes).
 * Run: npm run test:ride-location-report-rules
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "ride-location-report-rules-results.json");
const PROJECT = "demo-swiftgo-phase1";
const COLLECTION = "rideLocationReports";
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function writeOut() {
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        suite: "ride-location-report-rules",
        generatedAt: new Date().toISOString(),
        total: results.length,
        pass,
        fail,
        blocked,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nSummary: ${pass} PASS, ${fail} FAIL, ${blocked} BLOCKED`);
  return { pass, fail, blocked };
}

async function main() {
  console.log("\n=== ride location report rules ===\n");

  record(
    "static-rules-block-present",
    /match \/rideLocationReports\/\{rideId\}/.test(rulesText) &&
      /allow get, list: if isSuperAdmin\(\)/.test(rulesText) &&
      /allow create, update, delete: if false/.test(rulesText)
      ? "PASS"
      : "FAIL"
  );

  let testEnv;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: rulesText, host: "127.0.0.1", port: 8080 },
    });
  } catch (e) {
    record("rules-super-admin-read", "BLOCKED", String(e.message || e).slice(0, 160));
    record("rules-driver-read-denied", "BLOCKED", String(e.message || e).slice(0, 160));
    record("rules-client-create-denied", "BLOCKED", String(e.message || e).slice(0, 160));
    writeOut();
    process.exit(1);
    return;
  }

  const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const adminDb = admin.firestore();

  try {
    await testEnv.clearFirestore();
    await adminDb.collection(COLLECTION).doc("ride_rules_test_01").set({
      schemaVersion: 1,
      rideId: "ride_rules_test_01",
      assignmentSessionTokenHash: "a".repeat(64),
      status: "partial",
    });
    await adminDb.collection("users").doc("admin1").set({ role: "super_admin" });

    const superDb = testEnv.authenticatedContext("admin1", { admin: true }).firestore();
    const driverDb = testEnv.authenticatedContext("driver1").firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(superDb, COLLECTION, "ride_rules_test_01")));
    record("rules-super-admin-read", "PASS");

    await assertFails(getDoc(doc(driverDb, COLLECTION, "ride_rules_test_01")));
    record("rules-driver-read-denied", "PASS");

    await assertFails(setDoc(doc(driverDb, COLLECTION, "ride_rules_hack"), { hacked: true }));
    record("rules-client-create-denied", "PASS");

    await assertFails(
      updateDoc(doc(superDb, COLLECTION, "ride_rules_test_01"), { status: "final" })
    );
    record("rules-admin-client-write-denied", "PASS");

    await assertFails(getDoc(doc(anonDb, COLLECTION, "ride_rules_test_01")));
    record("rules-anon-read-denied", "PASS");
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    record("rules-runtime", /already been started/i.test(msg) ? "BLOCKED" : "FAIL", msg);
  } finally {
    await testEnv?.cleanup?.();
  }

  const summary = writeOut();
  if (summary.fail > 0 || summary.blocked > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  record("rules-uncaught", "FAIL", String(e.message || e).slice(0, 160));
  writeOut();
  process.exit(1);
});
