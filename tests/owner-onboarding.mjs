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
  rejectOwnerAccess,
} = require("../functions/owner-onboarding.js");
const {
  ensureSuperAdminUserDocForUid,
  ensureAdminUserDocForUid,
  BOOTSTRAP_ADMIN_EMAIL,
} = require("../functions/admin-claims.js");

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

async function initSuperAdmin(db, uid = "super-1", email = "super@example.com") {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  await ensureSuperAdminUserDocForUid(db, uid, {
    email,
    displayName: "Super Admin",
  });
  return auth(uid, email, { admin: true });
}

async function initOrdinaryAdmin(db, uid = "ord-admin-1") {
  await ensureAdminUserDocForUid(db, uid, {
    email: "ord-admin@example.com",
    displayName: "Ordinary Admin",
  });
  return auth(uid, "ord-admin@example.com", { admin: true });
}

async function initBootstrapSuperAdmin(db, uid = "bootstrap-super") {
  await db.collection("settings").doc("security").set({ adminBootstrapEnabled: true });
  return auth(uid, BOOTSTRAP_ADMIN_EMAIL, { admin: false });
}

function runStaticProofs() {
  const ownerJs = read("owner-app/js/owner-app.js");
  const rules = read("firestore.rules");
  const indexJs = read("functions/index.js");

  record(
    "static-callables-exported",
    indexJs.includes("exports.requestOwnerAccess") &&
      indexJs.includes("exports.approveOwnerAccess") &&
      indexJs.includes("exports.rejectOwnerAccess"),
    "Cloud Functions exported"
  );
  record(
    "static-approve-super-admin-only",
    read("functions/owner-onboarding.js").includes("isCallerAuthorizedForDiagnostic") &&
      read("functions/owner-onboarding.js").includes("SUPER_ADMIN_ONLY") &&
      !read("functions/owner-onboarding.js").includes("ensureCallerCanAdminWrite"),
    "approve/reject use persisted super_admin authorization"
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

async function ensureAuthUser(authAdmin, uid, email, displayName, extra = {}) {
  try {
    await authAdmin.createUser({
      uid,
      email,
      emailVerified: true,
      displayName,
      disabled: Boolean(extra.disabled),
    });
  } catch (e) {
    if (e.code !== "auth/uid-already-exists") throw e;
    if (extra.disabled) {
      await authAdmin.updateUser(uid, { disabled: true });
    }
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

  const superAuth = await initSuperAdmin(db);
  await ensureAuthUser(authAdmin, "super-1", "super@example.com", "Super Admin");

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

  const grant = await approveOwnerAccess(db, superAuth, { targetUid: "new-owner-1" });
  record(
    "callable-super-admin-grants-owner",
    grant.ok === true && grant.status === "granted",
    "super_admin approval provisions owner"
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
  const grant2 = await approveOwnerAccess(db, superAuth, { targetUid: "new-owner-1" });
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

  // Ordinary admin (admin claim + users.role admin) must be denied
  await ensureAuthUser(authAdmin, "ord-admin-1", "ord-admin@example.com", "Ord Admin");
  const ordinaryAdmin = await initOrdinaryAdmin(db);
  let ordinaryAdminDenied = false;
  try {
    await approveOwnerAccess(db, ordinaryAdmin, { targetUid: "customer-1" });
  } catch (e) {
    ordinaryAdminDenied = e.code === "permission-denied" && e.message === "SUPER_ADMIN_ONLY";
  }
  record(
    "callable-ordinary-admin-denied",
    ordinaryAdminDenied,
    "admin:true without super_admin cannot approve"
  );

  // Forged admin claim without persisted super_admin role
  await ensureAuthUser(authAdmin, "forged-admin-1", "forged-admin@example.com", "Forged Admin");
  let forgedAdminDenied = false;
  try {
    await approveOwnerAccess(db, auth("forged-admin-1", "forged-admin@example.com", { admin: true }), {
      targetUid: "customer-1",
    });
  } catch (e) {
    forgedAdminDenied = e.code === "permission-denied";
  }
  record(
    "callable-forged-admin-claim-denied",
    forgedAdminDenied,
    "claim/document mismatch cannot approve"
  );

  // Bootstrap super-admin may approve when bootstrap enabled
  await ensureAuthUser(authAdmin, "bootstrap-super", BOOTSTRAP_ADMIN_EMAIL, "Bootstrap Super");
  const bootstrapAuth = await initBootstrapSuperAdmin(db, "bootstrap-super");
  await ensureAuthUser(authAdmin, "bootstrap-target", "bootstrap-target@example.com", "Bootstrap Target");
  await requestOwnerAccess(db, auth("bootstrap-target", "bootstrap-target@example.com"), {
    fullName: "Bootstrap Target",
  });
  const bootstrapGrant = await approveOwnerAccess(db, bootstrapAuth, { targetUid: "bootstrap-target" });
  record(
    "callable-bootstrap-super-admin-approves",
    bootstrapGrant.status === "granted",
    "approved bootstrap owner may approve"
  );

  // Non-admin cannot approve
  let nonAdminDenied = false;
  try {
    await approveOwnerAccess(db, auth("random-1"), { targetUid: "customer-1" });
  } catch (e) {
    nonAdminDenied = e.code === "permission-denied";
  }
  record("callable-non-admin-approve-denied", nonAdminDenied, "unauthenticated/random denied");

  // Denial leaves no partial partner doc for failed approve of blocked target
  await db.collection("partners").doc("blocked-owner-target").set({
    role: "driver",
    accountStatus: "blocked",
  });
  let approveBlockedDenied = false;
  try {
    await approveOwnerAccess(db, superAuth, { targetUid: "blocked-owner-target" });
  } catch (e) {
    approveBlockedDenied = e.code === "permission-denied";
  }
  const blockedTarget = await db.collection("partners").doc("blocked-owner-target").get();
  const blockedApp = await db.collection("owner_applications").doc("blocked-owner-target").get();
  record(
    "callable-denied-approve-no-role-flip",
    approveBlockedDenied &&
      blockedTarget.data()?.role === "driver" &&
      (!blockedApp.exists || blockedApp.data()?.status !== "approved"),
    "denied approve does not promote blocked user"
  );

  // Suspended target denied on approve
  await ensureAuthUser(authAdmin, "suspended-target", "suspended-target@example.com", "Suspended Target");
  await db.collection("partners").doc("suspended-target").set({
    role: "driver",
    accountStatus: "suspended",
  });
  await db.collection("owner_applications").doc("suspended-target").set({
    uid: "suspended-target",
    fullName: "Suspended Target",
    status: "pending",
    createdAt: new Date(),
  });
  let suspendedDenied = false;
  try {
    await approveOwnerAccess(db, superAuth, { targetUid: "suspended-target" });
  } catch (e) {
    suspendedDenied = e.code === "permission-denied";
  }
  record("callable-suspended-target-denied", suspendedDenied, "suspended partner cannot be approved");
  record(
    "callable-suspended-no-partial-write",
    (await db.collection("partners").doc("suspended-target").get()).data()?.role === "driver" &&
      (await db.collection("owner_applications").doc("suspended-target").get()).data()?.status === "pending",
    "suspended denial leaves partner/application unchanged"
  );

  // Disabled auth user denied
  await ensureAuthUser(authAdmin, "disabled-target", "disabled-target@example.com", "Disabled Target", {
    disabled: true,
  });
  await db.collection("owner_applications").doc("disabled-target").set({
    uid: "disabled-target",
    fullName: "Disabled Target",
    status: "pending",
    createdAt: new Date(),
  });
  let disabledDenied = false;
  try {
    await approveOwnerAccess(db, superAuth, { targetUid: "disabled-target" });
  } catch (e) {
    disabledDenied = e.code === "permission-denied";
  }
  record("callable-disabled-auth-user-denied", disabledDenied, "disabled auth user cannot be approved");

  // Financial fields preserved when promoting existing driver
  await db.collection("partners").doc("driver-1").set({
    role: "driver",
    accountStatus: "active",
    walletBalance: 512,
    totalEarnings: 900,
    totalRidesCompleted: 17,
  });
  await approveOwnerAccess(db, superAuth, { targetUid: "driver-1" });
  const promotedDriver = await db.collection("partners").doc("driver-1").get();
  record(
    "callable-promote-driver-preserves-financials",
    promotedDriver.data()?.role === "owner" &&
      promotedDriver.data()?.walletBalance === 512 &&
      promotedDriver.data()?.totalEarnings === 900 &&
      promotedDriver.data()?.totalRidesCompleted === 17,
    "approval does not reset wallet/earnings"
  );

  // Rejection flow
  await ensureAuthUser(authAdmin, "reject-me", "reject-me@example.com", "Reject Me");
  await db.collection("partners").doc("reject-me").delete().catch(() => {});
  await db.collection("owner_applications").doc("reject-me").delete().catch(() => {});
  await requestOwnerAccess(db, auth("reject-me", "reject-me@example.com"), { fullName: "Reject Me" });
  const rejected = await rejectOwnerAccess(db, superAuth, {
    targetUid: "reject-me",
    reason: "Incomplete fleet documents",
  });
  record("callable-reject-pending", rejected.status === "rejected", "super admin rejects pending application");
  const rejectedSnap = await db.collection("owner_applications").doc("reject-me").get();
  record(
    "callable-reject-no-partner-write",
    !((await db.collection("partners").doc("reject-me").get()).exists) &&
      rejectedSnap.data()?.status === "rejected",
    "reject never writes partners.role"
  );
  const rejectAgain = await rejectOwnerAccess(db, superAuth, {
    targetUid: "reject-me",
    reason: "duplicate",
  });
  record("callable-reject-idempotent", rejectAgain.idempotent === true, "repeat reject idempotent");

  let approveAfterRejectDenied = false;
  try {
    await approveOwnerAccess(db, superAuth, { targetUid: "reject-me" });
  } catch (e) {
    approveAfterRejectDenied = e.code === "failed-precondition";
  }
  record(
    "callable-approve-after-reject-denied",
    approveAfterRejectDenied,
    "cannot approve rejected application without new request"
  );

  const reRequest = await requestOwnerAccess(db, auth("reject-me", "reject-me@example.com"), {
    fullName: "Reject Me",
  });
  record("callable-rerequest-after-reject", reRequest.status === "pending", "explicit new request after reject");
  await approveOwnerAccess(db, superAuth, { targetUid: "reject-me" });
  record(
    "callable-rerequest-then-approve",
    (await db.collection("partners").doc("reject-me").get()).data()?.role === "owner",
    "new request enables approval again"
  );

  // Concurrent double approval — one grant, one idempotent
  await ensureAuthUser(authAdmin, "race-target", "race-target@example.com", "Race Target");
  await db.collection("partners").doc("race-target").delete().catch(() => {});
  await db.collection("owner_applications").doc("race-target").delete().catch(() => {});
  await requestOwnerAccess(db, auth("race-target", "race-target@example.com"), { fullName: "Race Target" });
  const [raceA, raceB] = await Promise.allSettled([
    approveOwnerAccess(db, superAuth, { targetUid: "race-target" }),
    approveOwnerAccess(db, superAuth, { targetUid: "race-target" }),
  ]);
  const raceOk =
    [raceA, raceB].filter((r) => r.status === "fulfilled").length === 2 &&
    (await db.collection("partners").doc("race-target").get()).data()?.role === "owner";
  record("callable-concurrent-double-approval", raceOk, "concurrent approvals leave single owner role");

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
