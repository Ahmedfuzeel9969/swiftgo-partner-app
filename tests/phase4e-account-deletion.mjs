/**
 * Phase 4E — account deletion CF behavior on emulators.
 * Preserves ledger/audit; soft-disables Auth.
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
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } from "firebase/firestore";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-swiftgo-phase1";
const RESULTS = path.join(ROOT, "tests", "phase4e-account-deletion-results.json");

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
const adminAuth = admin.auth(adminApp);

async function main() {
  const email = `phase4e-del-${Date.now()}@example.com`;
  const password = "Phase4e-Delete-1";

  const app = initializeApp(
    {
      apiKey: "demo",
      projectId: PROJECT,
      appId: "1:demo:web:phase4e",
    },
    "phase4e-del"
  );
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await setDoc(doc(db, "users", uid), {
      displayName: "Phase4E User",
      email,
      walletBalance: 0,
    });

    // Seed a ledger row that must survive deletion request
    await adminDb.collection("ledger_transactions").doc(`keep-${uid}`).set({
      uid,
      amount: 100,
      type: "test_seed",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await adminDb.collection("audit_logs").doc(`keep-audit-${uid}`).set({
      type: "seed",
      uid,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    const fn = httpsCallable(functions, "requestAccountDeletion");
    const res = await fn({ reason: "phase4e test", roleHint: "customer", appId: "customer" });
    const data = res.data || {};
    record("deletion CF ok", true, Boolean(data.ok), data.ok ? "PASS" : "FAIL", { data });
    record(
      "retained categories returned",
      "ledger_transactions",
      Array.isArray(data.retainedCategories) && data.retainedCategories.includes("ledger_transactions"),
      Array.isArray(data.retainedCategories) && data.retainedCategories.includes("ledger_transactions")
        ? "PASS"
        : "FAIL"
    );

    const reqSnap = await adminDb.collection("account_deletion_requests").doc(uid).get();
    record("deletion request doc", "pending", reqSnap.data()?.status, reqSnap.data()?.status === "pending" ? "PASS" : "FAIL");

    const userSnap = await adminDb.collection("users").doc(uid).get();
    record(
      "user soft-marked",
      "deletion_pending",
      userSnap.data()?.accountStatus,
      userSnap.data()?.accountStatus === "deletion_pending" && userSnap.data()?.deletionRequested === true
        ? "PASS"
        : "FAIL"
    );

    const ledger = await adminDb.collection("ledger_transactions").doc(`keep-${uid}`).get();
    const audit = await adminDb.collection("audit_logs").doc(`keep-audit-${uid}`).get();
    record("ledger retained", true, ledger.exists, ledger.exists ? "PASS" : "FAIL");
    record("audit retained", true, audit.exists, audit.exists ? "PASS" : "FAIL");

    const authUser = await adminAuth.getUser(uid);
    record("auth disabled", true, authUser.disabled === true, authUser.disabled === true ? "PASS" : "FAIL");

    // Support report from a fresh enabled user
    const email2 = `phase4e-rep-${Date.now()}@example.com`;
    const cred2 = await createUserWithEmailAndPassword(auth, email2, password);
    // previous user is disabled; sign in as new
    await signInWithEmailAndPassword(auth, email2, password);
    const reportFn = httpsCallable(functions, "submitSupportReport");
    const report = await reportFn({
      message: "Phase 4E complaint test message",
      category: "complaint",
      appId: "customer",
    });
    record("support report ok", true, Boolean(report.data?.ok), report.data?.ok ? "PASS" : "FAIL");
    const reportDoc = await adminDb.collection("support_reports").doc(report.data.reportId).get();
    record("support report stored", true, reportDoc.exists, reportDoc.exists ? "PASS" : "FAIL");
  } finally {
    await deleteApp(app);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS,
    JSON.stringify(
      {
        phase: "4E-account-deletion",
        generatedAt: new Date().toISOString(),
        pass: results.filter((r) => r.status === "PASS").length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nPhase 4E deletion: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
