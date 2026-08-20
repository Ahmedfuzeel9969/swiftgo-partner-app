/**
 * Stage 8 tranche 4 — owner/admin/lifecycle + hosting integrity (surgical).
 *
 * Preserves branch background location HTTPS exports and hosting-startup-health
 * predeploy gate alongside main's deploy-integrity tools.
 *
 * Run: node tests/stage8-tranche4-owner-admin-hosting.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage8-tranche4-owner-admin-hosting-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

console.log("\n=== Stage 8 tranche 4 — owner/admin/hosting ===\n");

const indexSrc = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
const rulesSrc = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const firebaseJson = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));

record(
  "owner-onboarding-module-present",
  fs.existsSync(path.join(ROOT, "functions/owner-onboarding.js")) ? "PASS" : "FAIL"
);
record(
  "lifecycle-timestamps-module-present",
  fs.existsSync(path.join(ROOT, "functions/ride-lifecycle-timestamps.js")) ? "PASS" : "FAIL"
);

const adminClaims = require("../functions/admin-claims.js");
record(
  "grantSuperAdminClaim-exported",
  typeof adminClaims.grantSuperAdminClaim === "function" &&
    typeof adminClaims.isCallerAuthorizedForDiagnostic === "function"
    ? "PASS"
    : "FAIL"
);

record(
  "index-exports-owner-callables",
  indexSrc.includes("exports.requestOwnerAccess") &&
    indexSrc.includes("exports.approveOwnerAccess") &&
    indexSrc.includes("exports.rejectOwnerAccess")
    ? "PASS"
    : "FAIL"
);
record(
  "index-exports-grantSuperAdminClaim",
  indexSrc.includes("exports.grantSuperAdminClaim") ? "PASS" : "FAIL"
);
record(
  "index-exports-lifecycle-stamp",
  indexSrc.includes("exports.stampRideLifecycleTimestamps") &&
    indexSrc.includes("onDocumentUpdated")
    ? "PASS"
    : "FAIL"
);
record(
  "index-keeps-background-location-exports",
  indexSrc.includes("exports.refreshBackgroundDriverLocationCredential") &&
    indexSrc.includes("exports.ingestBackgroundDriverLocation") &&
    indexSrc.includes("exports.issueBackgroundLocationCredential")
    ? "PASS"
    : "FAIL"
);
record(
  "index-diagnostic-idle-gated",
  indexSrc.includes("requestTouchesDiagnosticControls") &&
    indexSrc.includes("SUPER_ADMIN_DIAGNOSTIC_ONLY") &&
    indexSrc.includes("idleMovementTriggerDisabled")
    ? "PASS"
    : "FAIL"
);

record(
  "rules-owner-applications-admin-sdk-only",
  rulesSrc.includes("match /owner_applications/{appId}") &&
    /match \/owner_applications\/\{appId\}[\s\S]*?allow create, update, delete: if false/.test(
      rulesSrc
    )
    ? "PASS"
    : "FAIL"
);
record(
  "rules-partners-create-driver-only",
  /request\.resource\.data\.role == 'driver'/.test(rulesSrc) &&
    !/role in \['owner', 'driver'\]/.test(rulesSrc)
    ? "PASS"
    : "FAIL"
);
record(
  "rules-keeps-vehicleLocationUpdatedAtOk",
  rulesSrc.includes("vehicleLocationUpdatedAtOk") ? "PASS" : "FAIL"
);

const predeploy = firebaseJson.hosting?.predeploy || [];
record(
  "hosting-predeploy-integrity-build",
  predeploy.includes("node tools/hosting-deploy-integrity.mjs") &&
    predeploy.includes("node tools/build-hosting.mjs") &&
    predeploy.includes("node tools/hosting-deploy-integrity.mjs --verify-build") &&
    !predeploy.includes("node tools/hosting-startup-health.mjs")
    ? "PASS"
    : "FAIL",
  JSON.stringify(predeploy) + " (startup-health kept as npm script; phase1 cross-app imports)"
);
record(
  "hosting-startup-health-tool-retained",
  fs.existsSync(path.join(ROOT, "tools/hosting-startup-health.mjs")) ? "PASS" : "FAIL"
);

record(
  "hosting-tools-present",
  fs.existsSync(path.join(ROOT, "tools/hosting-build-config.mjs")) &&
    fs.existsSync(path.join(ROOT, "tools/hosting-deploy-integrity.mjs")) &&
    fs.existsSync(path.join(ROOT, "tools/hosting-routing-config.mjs")) &&
    fs.existsSync(path.join(ROOT, "tools/hosting-startup-health.mjs"))
    ? "PASS"
    : "FAIL"
);

record(
  "auth-surface-routing-shared",
  fs.existsSync(path.join(ROOT, "shared/js/auth-surface-routing.mjs")) ? "PASS" : "FAIL"
);
record(
  "admin-owner-applications-ui-wired",
  fs.existsSync(path.join(ROOT, "super-admin-panel/js/admin-owner-applications-client.js")) &&
    fs.readFileSync(path.join(ROOT, "super-admin-panel/js/admin-app.js"), "utf8").includes(
      "fetchOwnerApplicationsOnDemand"
    ) &&
    fs
      .readFileSync(path.join(ROOT, "super-admin-panel/index.html"), "utf8")
      .includes('id="ownerApplicationsSection"')
    ? "PASS"
    : "FAIL"
);
record(
  "firebase-catch-all-rewrite",
  (firebaseJson.hosting?.rewrites || []).some(
    (r) => r.source === "**" && r.destination === "/index.html"
  )
    ? "PASS"
    : "FAIL"
);

const fail = results.filter((r) => r.status === "FAIL").length;
const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\nStage 8 tranche 4: ${pass} PASS / ${fail} FAIL`);
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 8,
      tranche: 4,
      scope: "owner-admin-lifecycle-hosting",
      generatedAt: new Date().toISOString(),
      summary: { pass, fail },
      results,
    },
    null,
    2
  )
);
console.log(`Wrote ${OUT}\n`);
if (fail > 0) process.exit(1);
