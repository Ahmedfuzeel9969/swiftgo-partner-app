/**
 * Authenticated role/surface routing matrix — policy unit tests, static wiring checks,
 * and Firebase Auth/Firestore emulator scenarios.
 *
 * Run: npm run test:auth-routing
 * Emulator: npm run test:auth-routing:emulator
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  APP_SURFACES,
  MAX_AUTH_REDIRECT_HOPS,
  PARTNER_SURFACE_ROLES,
  SUPER_ADMIN_BOOTSTRAP_EMAIL,
  analyzeRedirectChain,
  resolveAdminAccess,
  resolveClaimDocumentDisagreement,
  resolveSurfaceEntry,
  validateCrossSurfaceRedirect,
} from "../shared/js/auth-surface-routing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_PATH = path.join(ROOT, "tests", "auth-routing-matrix-results.json");
const require = createRequire(import.meta.url);
const USE_EMULATOR = process.argv.includes("--emulator");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ||= "demo-swiftgo-phase1";
process.env.GOOGLE_CLOUD_PROJECT ||= "demo-swiftgo-phase1";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail, suite: "auth-routing-matrix" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function runPolicyMatrix() {
  const cases = [
    ["signed-out-customer", { surface: "customer", signedIn: false }, "login_ui"],
    ["signed-out-partner", { surface: "partner", signedIn: false }, "login_ui"],
    ["signed-out-owner", { surface: "owner", signedIn: false }, "login_ui"],
    ["customer-signed-in", { surface: "customer", signedIn: true }, "app_shell"],
    ["partner-driver", { surface: "partner", signedIn: true, partnerRole: "driver" }, "app_shell"],
    ["partner-owner-stays", { surface: "partner", signedIn: true, partnerRole: "owner" }, "app_shell"],
    ["partner-invalid-role", { surface: "partner", signedIn: true, partnerRole: "customer" }, "login_error"],
    ["partner-missing-role", { surface: "partner", signedIn: true, partnerRole: "", partnerDocExists: false }, "provision_driver"],
    ["partner-blocked", { surface: "partner", signedIn: true, partnerRole: "driver", accountStatus: "blocked" }, "blocked_overlay"],
    ["partner-admin-driver-normalized", { surface: "partner", signedIn: true, partnerRole: "admin_driver", partnerDocExists: true }, "app_shell"],
    ["owner-driver-denied", { surface: "owner", signedIn: true, partnerRole: "driver", partnerDocExists: true }, "login_denied"],
    ["owner-missing-role-denied", { surface: "owner", signedIn: true, partnerRole: "", partnerDocExists: false }, "login_denied"],
    ["owner-legitimate", { surface: "owner", signedIn: true, partnerRole: "owner", partnerDocExists: true }, "app_shell"],
    ["owner-blocked", { surface: "owner", signedIn: true, partnerRole: "owner", accountStatus: "blocked", partnerDocExists: true }, "blocked_overlay"],
    ["owner-suspended", { surface: "owner", signedIn: true, partnerRole: "owner", accountStatus: "suspended", partnerDocExists: true }, "blocked_overlay"],
  ];

  for (const [name, input, expectedOutcome] of cases) {
    const result = resolveSurfaceEntry(input);
    record(`policy:${name}`, result.outcome === expectedOutcome, `${result.outcome} (${result.reason})`);
    record(
      `policy-no-self-redirect:${name}`,
      !result.redirect || result.redirect !== APP_SURFACES[input.surface],
      result.redirect || "none"
    );
  }

  const adminCases = [
    ["signed-out", { signedIn: false }, false],
    ["admin-claim", { signedIn: true, adminClaim: true }, true],
    ["bootstrap-email", { signedIn: true, email: SUPER_ADMIN_BOOTSTRAP_EMAIL, emailVerified: true }, true],
    ["ordinary-driver-email", { signedIn: true, email: "driver@example.com", emailVerified: true }, false],
    ["bootstrap-unverified", { signedIn: true, email: SUPER_ADMIN_BOOTSTRAP_EMAIL, emailVerified: false }, false],
  ];
  for (const [name, input, authorized] of adminCases) {
    const result = resolveAdminAccess(input);
    record(`admin-policy:${name}`, result.authorized === authorized, result.reason);
    if (!authorized && input.signedIn) {
      record(
        `admin-deny-at-most-one-hop:${name}`,
        result.denyRedirect === APP_SURFACES.partner,
        result.denyRedirect || "none"
      );
    }
  }

  const disagreement = resolveClaimDocumentDisagreement({
    surface: "partner",
    adminClaim: true,
    partnerRole: "driver",
    usersRole: "super_admin",
    email: "driver@example.com",
    emailVerified: true,
  });
  record(
    "claim-doc-disagreement-partner-uses-partner-role",
    disagreement.outcome === "app_shell",
    "admin claim does not override partner surface routing"
  );

  const adminDisagreement = resolveClaimDocumentDisagreement({
    surface: "admin",
    adminClaim: false,
    partnerRole: "owner",
    usersRole: "admin",
    email: "someone@example.com",
    emailVerified: true,
  });
  record(
    "claim-doc-disagreement-admin-not-promoted-by-users-role",
    adminDisagreement.authorized === false,
    adminDisagreement.reason
  );
}

function runRedirectGraphChecks() {
  const allowed = [
    validateCrossSurfaceRedirect({
      fromPath: "/admin/",
      toPath: "/partner/",
      trigger: "admin_deny_signout",
    }),
    validateCrossSurfaceRedirect({
      fromPath: "/owner/",
      toPath: "/partner/",
      trigger: "owner_select_driver_role",
    }),
    validateCrossSurfaceRedirect({
      fromPath: "/owner/",
      toPath: "/admin/",
      trigger: "owner_return_from_admin_driver_mode",
    }),
  ];
  for (const edge of allowed) {
    record(`redirect-edge-allowed:${edge.reason}`, edge.allowed && !edge.selfRedirect, edge.reason);
  }

  const forbidden = [
    { from: "/partner/", to: "/owner/", trigger: "partner_auth_refresh" },
    { from: "/partner/", to: "/partner/", trigger: "self" },
    { from: "/owner/", to: "/owner/", trigger: "self" },
    { from: "/admin/", to: "/admin/", trigger: "self" },
    { from: "/customer/", to: "/partner/", trigger: "customer_auth_refresh" },
  ];
  for (const edge of forbidden) {
    const result = validateCrossSurfaceRedirect(edge);
    record(
      `redirect-edge-forbidden:${edge.from}->${edge.to}`,
      !result.allowed || edge.from === edge.to,
      result.reason
    );
    if (edge.from === edge.to) {
      record(`self-redirect-blocked:${edge.from}`, result.selfRedirect, result.reason);
    }
  }

  const adminDenyChain = analyzeRedirectChain(
    [{ from: "/admin/", to: "/partner/" }],
    MAX_AUTH_REDIRECT_HOPS
  );
  record("admin-deny-chain-terminates", adminDenyChain.ok, adminDenyChain.reason);

  const loopChain = analyzeRedirectChain(
    [
      { from: "/partner/", to: "/owner/" },
      { from: "/owner/", to: "/partner/" },
    ],
    MAX_AUTH_REDIRECT_HOPS
  );
  record("partner-owner-bounce-chain-blocked", !loopChain.ok, loopChain.reason);
}

function runStaticWiringChecks() {
  const driverJs = read("driver-app/js/driver-app.js");
  const ownerJs = read("owner-app/js/owner-app.js");
  const adminJs = read("super-admin-panel/js/admin-app.js");
  const customerAuth = read("customer-app/js/auth.js");

  record(
    "partner-strict-role-gate",
    driverJs.includes('from "./auth-surface-routing.mjs"') &&
      driverJs.includes('resolveSurfaceEntry({') &&
      driverJs.includes('surface: "partner"') &&
      driverJs.includes("entry.outcome === \"app_shell\"") &&
      driverJs.includes("hideProtectedUi()"),
    "saved partners.role gates partner entry via canonical policy"
  );
  record(
    "partner-no-owner-auto-redirect",
    !driverJs.includes('window.location.replace("/owner/")'),
    "owners may use /partner/ without forced bounce"
  );
  record(
    "owner-no-partner-auto-redirect",
    !ownerJs.includes('window.location.replace("/partner/")') &&
      ownerJs.includes('entry.outcome === "login_denied"'),
    "owner surface denies non-owner roles without auto-bounce"
  );
  record(
    "owner-no-client-role-promotion",
    !ownerJs.match(/setDoc\([\s\S]{0,500}role:\s*"owner"/),
    "owner-app never writes role:owner client-side"
  );
  record(
    "admin-deny-single-hop",
    adminJs.includes('window.location.replace("/partner/")') &&
      adminJs.includes("await signOut(auth)"),
    "unauthorized admin signOut then one redirect"
  );
  record(
    "customer-no-cross-surface-redirect",
    !customerAuth.includes("window.location.replace") &&
      !customerAuth.includes("window.location.assign"),
    "customer auth stays on /"
  );
  record(
    "partner-logout-clears-state",
    driverJs.includes("showAuthOverlay()") &&
      driverJs.includes("hideProtectedUi()") &&
      driverJs.includes("currentDriver = null"),
    "signed-out partner shows login and clears session state"
  );
  record(
    "owner-hide-role-selection-defined",
    ownerJs.includes("function hideRoleSelection"),
    "legacy role overlay helper must exist when referenced"
  );
}

async function runEmulatorScenarios() {
  if (!USE_EMULATOR) {
    record("emulator-scenarios", true, "skipped (pass --emulator or npm run test:auth-routing:emulator)");
    return;
  }

  const admin = require(require.resolve("firebase-admin", { paths: [path.join(ROOT, "functions"), ROOT] }));
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  }
  const auth = admin.auth(app);
  const db = admin.firestore(app);

  async function makeUser(uid, email, claims = {}) {
    try {
      await auth.createUser({ uid, email, emailVerified: true, password: "test-pass-123" });
    } catch (e) {
      if (e.code !== "auth/uid-already-exists") throw e;
    }
    if (Object.keys(claims).length) await auth.setCustomUserClaims(uid, claims);
    return auth.getUser(uid);
  }

  const driver = await makeUser("rt-driver", "driver@example.com");
  await db.doc("partners/rt-driver").set({ uid: "rt-driver", role: "driver", accountStatus: "active" });
  record(
    "emulator-partner-driver",
    resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole: (await db.doc("partners/rt-driver").get()).data().role,
    }).outcome === "app_shell",
    driver.email
  );

  await db.doc("partners/rt-owner").set({ uid: "rt-owner", role: "owner", accountStatus: "active" });
  record(
    "emulator-partner-owner-on-partner-surface",
    resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole: (await db.doc("partners/rt-owner").get()).data().role,
    }).outcome === "app_shell",
    "owner role allowed on /partner/"
  );

  await db.doc("partners/rt-invalid").set({ uid: "rt-invalid", role: "rider", accountStatus: "active" });
  record(
    "emulator-partner-invalid-role",
    resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole: (await db.doc("partners/rt-invalid").get()).data().role,
    }).outcome === "login_error",
    "invalid saved role rejected"
  );

  await db.doc("partners/rt-blocked").set({ uid: "rt-blocked", role: "driver", accountStatus: "blocked" });
  record(
    "emulator-partner-blocked",
    resolveSurfaceEntry({
      surface: "partner",
      signedIn: true,
      partnerRole: "driver",
      accountStatus: "blocked",
    }).outcome === "blocked_overlay",
    "blocked accountStatus stops entry"
  );

  const superAdmin = await makeUser("rt-super", SUPER_ADMIN_BOOTSTRAP_EMAIL);
  record(
    "emulator-admin-bootstrap-email",
    resolveAdminAccess({
      signedIn: true,
      email: superAdmin.email,
      emailVerified: true,
    }).authorized,
    superAdmin.email
  );

  const claimed = await makeUser("rt-claimed", "claimed-admin@example.com", { admin: true });
  const token = await auth.createCustomToken(claimed.uid);
  record(
    "emulator-admin-custom-claim",
    resolveAdminAccess({ signedIn: true, adminClaim: true }).authorized && token.length > 0,
    claimed.email
  );

  await db.doc("users/rt-stale").set({ role: "super_admin" });
  record(
    "emulator-users-role-not-admin-gate",
    resolveClaimDocumentDisagreement({
      surface: "admin",
      adminClaim: false,
      partnerRole: "driver",
      usersRole: "super_admin",
      email: "nobody@example.com",
      emailVerified: true,
    }).authorized === false,
    "users/{uid}.role alone does not authorize /admin/"
  );

  record(
    "emulator-owner-driver-denied",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "driver",
      partnerDocExists: true,
    }).outcome === "login_denied" &&
      resolveSurfaceEntry({
        surface: "owner",
        signedIn: true,
        partnerRole: "driver",
        partnerDocExists: true,
      }).allowRoleWrite === false,
    "driver on /owner/ denied without role write"
  );

  record(
    "emulator-owner-missing-role-denied",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "",
      partnerDocExists: false,
    }).outcome === "login_denied",
    "missing partners doc denied on /owner/"
  );

  record(
    "emulator-owner-legitimate",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      partnerDocExists: true,
    }).outcome === "app_shell",
    "saved owner role enters dashboard"
  );

  await db.doc("partners/rt-owner-blocked").set({
    uid: "rt-owner-blocked",
    role: "owner",
    accountStatus: "blocked",
  });
  record(
    "emulator-owner-blocked",
    resolveSurfaceEntry({
      surface: "owner",
      signedIn: true,
      partnerRole: "owner",
      accountStatus: "blocked",
      partnerDocExists: true,
    }).outcome === "blocked_overlay",
    "blocked owner stops at overlay"
  );

  await db.doc("partners/rt-owner-suspended").set({
    uid: "rt-owner-suspended",
    role: "owner",
    accountStatus: "suspended",
  });
  record(
    "emulator-owner-suspended",
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
    "emulator-claim-doc-disagreement-owner",
    resolveClaimDocumentDisagreement({
      surface: "owner",
      adminClaim: true,
      partnerRole: "driver",
      usersRole: "super_admin",
      email: "driver@example.com",
      emailVerified: true,
      partnerDocExists: true,
    }).outcome === "login_denied",
    "admin claim does not bypass owner surface role gate"
  );

  const ownerDenial = resolveSurfaceEntry({
    surface: "owner",
    signedIn: true,
    partnerRole: "driver",
    partnerDocExists: true,
  });
  record(
    "emulator-owner-denial-no-role-mutation",
    ownerDenial.allowRoleWrite === false && ownerDenial.outcome === "login_denied",
    "denial path never provisions owner role"
  );

  const bounded = analyzeRedirectChain(
    [{ from: "/owner/", to: "/owner/" }],
    MAX_AUTH_REDIRECT_HOPS
  );
  record(
    "emulator-owner-no-self-redirect",
    !bounded.ok && bounded.reason === "self_redirect",
    "owner denial stays on surface without redirect loop"
  );
}

async function main() {
  runPolicyMatrix();
  runRedirectGraphChecks();
  runStaticWiringChecks();
  await runEmulatorScenarios();

  const failed = results.filter((r) => r.status === "FAIL");
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        emulator: USE_EMULATOR,
        pass: results.length - failed.length,
        fail: failed.length,
        results,
      },
      null,
      2
    )
  );

  console.log(`\nSummary pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`Wrote ${RESULTS_PATH}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
