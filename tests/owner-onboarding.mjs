/**
 * Task 3B — Owner onboarding callable + rules emulator proofs.
 *
 * Run: npm run test:owner-onboarding
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { resolveSurfaceEntry } from "../shared/js/auth-surface-routing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RULES = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const OUT = path.join(ROOT, "tests", "owner-onboarding-results.json");
const require = createRequire(import.meta.url);
const PROJECT = "demo-swiftgo-owner-onboard";

const {
  requestOwnerAccess,
  approveOwnerAccess,
} = require("../functions/owner-onboarding.js");
const { ensureSuperAdminUserDocForUid } = require("../functions/admin-claims.js");

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function auth(uid, email = `${uid}@example.com`, extra = {}) {
  return {
    uid,
    token: {
      email,
      email_verified: true,
      name: `User ${uid}`,
      ...extra,
    },
  };
}

async function initAdmin(db, uid = "admin-1") {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  await ensureSuperAdminUserDocForUid(db, uid, {
    email: "admin@example.com",
    displayName: "Admin One",
  });
  return auth(uid, "admin@example.com", { admin: true });
}

function runStaticProofs() {
  const ownerJs = read("owner-app/js/owner-app.js");
  const rules = read("firestore.rules");
  const indexJs = read("functions/index.js");

  record(
    "static-callables-exported",
    indexJs.includes("exports.requestOwnerAccess") &&
      indexJs.includes("exports.approveOwnerAccess"),
    "Cloud Functions exported"
  );
  record(
    "static-owner-app-uses-request-callable",
    ownerJs.includes("requestOwnerAccessClient") &&
      ownerJs.includes("ownerRequestAccessBtn") &&
      !ownerJs.match(/setDoc\([\s\S]{0,500}role:\s*"owner"/),
    "owner app requests access via callable only"
  );
  record(
    "static-owner-applications-rules",
    rules.includes("match /owner_applications/{appId}") &&
      rules.includes("allow create, update, delete: if false"),
    "owner_applications client writes blocked"
  );
}

async function ensureAuthUser(authAdmin, uid, email, displayName) {
  try {
    await authAdmin.createUser({ uid, email, emailVerified: true, displayName });
  } catch (e) {
    if (e.code !== "auth/uid-already-exists") throw e;
  }
}

async function runCallableProofs() {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST =
    process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  const admin = require(require.resolve("firebase-admin", {
    paths: [path.join(ROOT, "functions"), ROOT],
  }));
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore(app);
  const authAdmin = admin.auth(app);

  const adminAuth = await initAdmin(db);
  await ensureAuthUser(authAdmin, "admin-1", "admin@example.com", "Admin One");

  // Legitimate new-owner onboarding
  const applicant = auth("new-owner-1", "newowner@example.com");
  await ensureAuthUser(authAdmin, "new-owner-1", "newowner@example.com", "Fleet Owner One");
  const req1 = await requestOwnerAccess(db, applicant, { fullName: "Fleet Owner One" });
  record(
    "callable-legitimate-request-pending",
    req1.ok === true && req1.status === "pending",
    "request creates pending application"
  );

  const appSnap = await db.collection("owner_applications").doc("new-owner-1").get();
  record(
    "callable-request-writes-pending-doc",
    appSnap.exists && appSnap.data()?.status === "pending",
    "owner_applications pending persisted"
  );
  record(
    "callable-request-does-not-write-partner-role",
    !(await db.collection("partners").doc("new-owner-1").get()).exists,
    "partners doc not created on request alone"
  );

  const grant = await approveOwnerAccess(db, adminAuth, { targetUid: "new-owner-1" });
  record(
    "callable-admin-grants-owner",
    grant.ok === true && grant.status === "granted",
    "admin approval provisions owner"
  );

  const partnerSnap = await db.collection("partners").doc("new-owner-1").get();
  record(
    "callable-grant-writes-partner-owner-role",
    partnerSnap.exists && partnerSnap.data()?.role === "owner",
    "partners.role owner after approval"
  );
  record(
    "callable-grant-zero-wallet",
    partnerSnap.data()?.walletBalance === 0,
    "no financial privilege from client payload"
  );
  record(
    "policy-provisioned-owner-enters-dashboard",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: partnerSnap.data()?.role,
      partnerDocExists: true,
    }).outcome === "app_shell",
    "routing allows provisioned owner"
  );

  // Idempotent request
  const req2 = await requestOwnerAccess(db, applicant, { fullName: "Fleet Owner One" });
  record(
    "callable-idempotent-request-existing-owner",
    req2.idempotent === true && req2.status === "already_owner",
    "repeat request after grant is idempotent"
  );

  // Idempotent approve
  const grant2 = await approveOwnerAccess(db, adminAuth, { targetUid: "new-owner-1" });
  record(
    "callable-idempotent-approve",
    grant2.idempotent === true && grant2.status === "already_owner",
    "repeat approve is idempotent"
  );

  // Driver cannot silently elevate via visit-only path (no partner write on request from driver without approval)
  await db.collection("partners").doc("driver-1").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
  });
  await ensureAuthUser(authAdmin, "driver-1", "driver@example.com", "Driver One");
  const driverAuth = auth("driver-1", "driver@example.com");
  const driverReq = await requestOwnerAccess(db, driverAuth, { fullName: "Driver One" });
  record(
    "callable-driver-may-request-not-elevate",
    driverReq.status === "pending",
    "driver may request but stays driver until approval"
  );
  record(
    "callable-driver-still-driver-after-request",
    (await db.collection("partners").doc("driver-1").get()).data()?.role === "driver",
    "no silent elevation on request"
  );
  record(
    "policy-driver-still-denied-owner-surface",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "driver",
      partnerDocExists: true,
    }).outcome === "login_denied",
    "driver still denied /owner/ until approved"
  );

  // Customer / missing role visiting /owner/ — no partners write
  const customerAuth = auth("customer-1", "customer@example.com");
  await ensureAuthUser(authAdmin, "customer-1", "customer@example.com", "Customer One");
  record(
    "policy-missing-role-denied",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "",
      partnerDocExists: false,
    }).outcome === "login_denied",
    "visit alone does not authorize owner surface"
  );
  await requestOwnerAccess(db, customerAuth, { fullName: "Customer One" });
  record(
    "callable-customer-request-no-partner-yet",
    !(await db.collection("partners").doc("customer-1").get()).exists,
    "customer request does not create partners doc"
  );

  // Blocked user denied
  await db.collection("partners").doc("blocked-1").set({
    role: "driver",
    accountStatus: "blocked",
  });
  await ensureAuthUser(authAdmin, "blocked-1", "blocked@example.com", "Blocked User");
  let blockedDenied = false;
  try {
    await requestOwnerAccess(db, auth("blocked-1"), { fullName: "Blocked User" });
  } catch (e) {
    blockedDenied = e.code === "permission-denied";
  }
  record("callable-blocked-user-denied", blockedDenied, "blocked user cannot request");

  await ensureAuthUser(authAdmin, "forged-1", "forged@example.com", "Forged");
  await ensureAuthUser(authAdmin, "self-1", "self@example.com", "Self");
  await ensureAuthUser(authAdmin, "random-1", "random@example.com", "Random");
  await ensureAuthUser(authAdmin, "blocked-owner-target", "blocked-target@example.com", "Blocked Target");
  let forgedDenied = false;
  try {
    await requestOwnerAccess(db, auth("forged-1"), { fullName: "Forged", role: "owner" });
  } catch (e) {
    forgedDenied = e.code === "invalid-argument";
  }
  record("callable-forged-role-rejected", forgedDenied, "client role field rejected");

  // Cannot change another UID
  let otherUidDenied = false;
  try {
    await requestOwnerAccess(db, auth("self-1"), { fullName: "Self", targetUid: "other-1" });
  } catch (e) {
    otherUidDenied = e.code === "permission-denied";
  }
  record("callable-other-uid-denied", otherUidDenied, "cannot request for another uid");

  // Non-admin cannot approve
  let nonAdminDenied = false;
  try {
    await approveOwnerAccess(db, auth("random-1"), { targetUid: "customer-1" });
  } catch (e) {
    nonAdminDenied = e.code === "permission-denied";
  }
  record("callable-non-admin-approve-denied", nonAdminDenied, "approve is admin-only");

  // Denial leaves no partial partner doc for failed approve of blocked target
  await db.collection("partners").doc("blocked-owner-target").set({
    role: "driver",
    accountStatus: "blocked",
  });
  let approveBlockedDenied = false;
  try {
    await approveOwnerAccess(db, adminAuth, { targetUid: "blocked-owner-target" });
  } catch (e) {
    approveBlockedDenied = e.code === "permission-denied";
  }
  const blockedTarget = await db.collection("partners").doc("blocked-owner-target").get();
  record(
    "callable-denied-approve-no-role-flip",
    approveBlockedDenied && blockedTarget.data()?.role === "driver",
    "denied approve does not promote blocked user"
  );

  // Existing owner login path unchanged
  await db.collection("partners").doc("legacy-owner-1").set({
    role: "owner",
    accountStatus: "active",
    email: "legacy@example.com",
    name: "Legacy Owner",
  });
  await ensureAuthUser(authAdmin, "legacy-owner-1", "legacy@example.com", "Legacy Owner");
  record(
    "callable-existing-owner-login-compatible",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      partnerDocExists: true,
    }).outcome === "app_shell",
    "legacy owner documents still enter dashboard"
  );
}

async function runRulesProofs() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: RULES },
  });

  await env.withSecurityRulesDisabled(async (context) => {
    const seed = context.firestore();
    await setDoc(doc(seed, "owner_applications/applicant-1"), {
      uid: "applicant-1",
      fullName: "Applicant",
      status: "pending",
      createdAt: new Date(),
    });
  });

  const applicantDb = env.authenticatedContext("applicant-1").firestore();
  const strangerDb = env.authenticatedContext("stranger-1").firestore();

  try {
    const snap = await getDoc(doc(applicantDb, "owner_applications/applicant-1"));
    record("rules-applicant-reads-own-application", snap.exists(), "pending application readable");
  } catch (e) {
    record("rules-applicant-reads-own-application", false, String(e.message));
  }

  try {
    await assertFails(
      setDoc(doc(applicantDb, "owner_applications/applicant-1"), {
        uid: "applicant-1",
        fullName: "Hack",
        status: "approved",
        createdAt: new Date(),
      })
    );
    record("rules-client-cannot-write-owner-applications", true, "writes blocked");
  } catch (e) {
    record("rules-client-cannot-write-owner-applications", false, String(e.message));
  }

  try {
    await assertFails(
      setDoc(doc(strangerDb, "owner_applications/stranger-1"), {
        uid: "applicant-1",
        fullName: "Spoof",
        status: "pending",
        createdAt: new Date(),
      })
    );
    record("rules-cannot-forge-other-application", true, "uid/doc mismatch blocked");
  } catch (e) {
    record("rules-cannot-forge-other-application", false, String(e.message));
  }

  await env.cleanup();
}

async function main() {
  runStaticProofs();
  await runCallableProofs();
  await runRulesProofs();

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pass: results.length - failed.length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );

  console.log(`\nSummary pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`Wrote ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
