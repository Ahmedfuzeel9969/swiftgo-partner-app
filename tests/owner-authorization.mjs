/**
 * Owner authorization boundary — Firestore rules + routing policy emulator proofs.
 *
 * Run: npm run test:owner-authorization
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { resolveSurfaceEntry } from "../shared/js/auth-surface-routing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RULES = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const OUT = path.join(ROOT, "tests", "owner-authorization-results.json");

const PROJECT = "demo-swiftgo-owner-auth";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function runStaticProofs() {
  const ownerJs = read("owner-app/js/owner-app.js");
  const rules = read("firestore.rules");

  record(
    "static-owner-uses-canonical-policy",
    ownerJs.includes('from "./auth-surface-routing.mjs"') &&
      ownerJs.includes("resolveSurfaceEntry"),
    "owner-app imports shared policy"
  );
  record(
    "static-no-client-owner-promotion-write",
    !ownerJs.match(/setDoc\([\s\S]{0,500}role:\s*"owner"/),
    "no setDoc role:owner in owner-app"
  );
  record(
    "static-owner-dashboard-gated",
    ownerJs.includes('entry.outcome === "app_shell"') &&
      ownerJs.includes("showOwnerDashboard()"),
    "dashboard only after policy app_shell"
  );
  record(
    "static-rules-self-create-owner-blocked",
    rules.includes("request.resource.data.role == 'driver'") &&
      !rules.includes("request.resource.data.role in ['owner', 'driver']"),
    "partners self-create cannot choose owner role"
  );
  record(
    "static-rules-owner-vehicles-scoped",
    rules.includes("resource.data.ownerId == request.auth.uid"),
    "vehicles remain ownerId scoped"
  );
}

function runPolicyProofs() {
  record(
    "policy-driver-denied-owner-surface",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "driver",
      partnerDocExists: true,
    }).outcome === "login_denied",
    "driver cannot enter owner dashboard"
  );
  record(
    "policy-missing-role-denied-owner-surface",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "",
      partnerDocExists: false,
    }).outcome === "login_denied" &&
      resolveSurfaceEntry({
        surface: "owner",
        signedIn: true,
        partnerRole: "",
        partnerDocExists: false,
      }).allowRoleWrite === false,
    "missing role denied with no promotion"
  );
  record(
    "policy-legitimate-owner-allowed",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      partnerDocExists: true,
    }).outcome === "app_shell",
    "saved owner role enters dashboard"
  );
  record(
    "policy-blocked-owner",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      accountStatus: "blocked",
      partnerDocExists: true,
    }).outcome === "blocked_overlay",
    "blocked owner stops at overlay"
  );
  record(
    "policy-suspended-owner",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      accountStatus: "suspended",
      partnerDocExists: true,
    }).outcome === "blocked_overlay",
    "suspended owner stops at overlay"
  );
  record(
    "policy-owner-on-partner-allowed",
    resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole: "owner",
      partnerDocExists: true,
    }).outcome === "app_shell",
    "owner-as-driver intentionally allowed on /partner/"
  );
  record(
    "policy-customer-no-partner-denied-owner",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "",
      partnerDocExists: false,
    }).outcome === "login_denied",
    "customer without partners doc denied"
  );
}

async function runRulesProofs() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: RULES },
  });

  await env.withSecurityRulesDisabled(async (context) => {
    const seed = context.firestore();
    await setDoc(doc(seed, "settings/security"), { adminBootstrapEnabled: true });
    await setDoc(doc(seed, "partners/owner-1"), { role: "owner", accountStatus: "active" });
    await setDoc(doc(seed, "partners/driver-1"), { role: "driver", accountStatus: "active" });
    await setDoc(doc(seed, "vehicles/veh-1"), { ownerId: "owner-1", plate: "ABC-1" });
  });

  const driverDb = env.authenticatedContext("driver-1").firestore();
  const strangerDb = env.authenticatedContext("customer-1").firestore();
  const ownerDb = env.authenticatedContext("owner-1").firestore();

  try {
    await assertFails(
      setDoc(doc(driverDb, "partners/driver-new"), {
        role: "owner",
        accountStatus: "active",
        walletBalance: 0,
        totalEarnings: 0,
        totalRidesCompleted: 0,
      })
    );
    record("rules-driver-cannot-self-create-owner", true, "create role owner denied");
  } catch (e) {
    record("rules-driver-cannot-self-create-owner", false, String(e.message));
  }

  try {
    await assertSucceeds(
      setDoc(doc(strangerDb, "partners/customer-1"), {
        role: "driver",
        accountStatus: "active",
        walletBalance: 0,
        totalEarnings: 0,
        totalRidesCompleted: 0,
      })
    );
    record("rules-stranger-can-self-create-driver-only", true, "driver onboarding still allowed");
  } catch (e) {
    record("rules-stranger-can-self-create-driver-only", false, String(e.message));
  }

  try {
    await assertFails(
      setDoc(doc(strangerDb, "partners/customer-2"), {
        role: "owner",
        accountStatus: "active",
        walletBalance: 0,
        totalEarnings: 0,
        totalRidesCompleted: 0,
      })
    );
    record("rules-stranger-cannot-self-create-owner", true, "visit /owner/ cannot forge owner create");
  } catch (e) {
    record("rules-stranger-cannot-self-create-owner", false, String(e.message));
  }

  try {
    await assertFails(updateDoc(doc(driverDb, "partners/driver-1"), { role: "owner" }));
    record("rules-driver-cannot-update-role-to-owner", true, "role flip denied");
  } catch (e) {
    record("rules-driver-cannot-update-role-to-owner", false, String(e.message));
  }

  try {
    const snap = await getDoc(doc(ownerDb, "vehicles/veh-1"));
    record("rules-owner-can-read-owned-vehicle", snap.exists(), "ownerId scoped read");
  } catch (e) {
    record("rules-owner-can-read-owned-vehicle", false, String(e.message));
  }

  try {
    await assertFails(getDoc(doc(driverDb, "vehicles/veh-1")));
    record("rules-driver-cannot-read-owner-vehicle", true, "cross-owner vehicle read denied");
  } catch (e) {
    record("rules-driver-cannot-read-owner-vehicle", false, String(e.message));
  }

  await env.cleanup();
}

async function main() {
  runStaticProofs();
  runPolicyProofs();
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
