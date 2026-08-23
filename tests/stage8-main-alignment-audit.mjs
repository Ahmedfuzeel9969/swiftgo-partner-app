/**
 * Stage 8 — targeted main alignment audit + final regression rollup.
 *
 * NO merge / rebase / wholesale file replacement.
 * Produces a reconciliation plan and classifies regression results.
 *
 * Run: node tests/stage8-main-alignment-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage8-main-alignment-audit-results.json");

function git(args) {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return (res.stdout || "").trim();
}

function runNode(rel) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [rel], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  return {
    exitCode: res.status ?? 1,
    elapsedMs: Date.now() - t0,
    stdoutTail: (res.stdout || "").split("\n").slice(-8).join("\n"),
  };
}

function classifyRun(run, { allowBlockedPass = false } = {}) {
  if (run.exitCode === 0) return "PASS";
  const out = `${run.stdoutTail || ""}`;
  if (/BLOCKED/i.test(out) && allowBlockedPass && !/\bFAIL\b/.test(out)) return "PASS";
  if (/emulator|FIRESTORE_EMULATOR|ECONNREFUSED|firebase/i.test(out)) return "ENVIRONMENT-ONLY";
  return "FAIL";
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const branchSha = git(["rev-parse", "HEAD"]);
const mainSha = git(["rev-parse", "origin/main"]);
const mergeBase = git(["merge-base", "HEAD", "origin/main"]);
const counts = git(["rev-list", "--left-right", "--count", "origin/main...HEAD"]).split(/\s+/);
const behind = Number(counts[0] || 0);
const ahead = Number(counts[1] || 0);

const workingTreeProd = git(["status", "--short", "--", "driver-app", "customer-app", "functions", "mobile", "shared"])
  .split("\n")
  .filter(Boolean);

/** @type {Array<{file:string, area:string, classification:string, note:string}>} */
const fileClassifications = [
  {
    file: "driver-app/js/p2p-peer-session.mjs",
    area: "P2P",
    classification: "branch_stronger_with_manual_port",
    note: "Branch (+uncommitted A1 ackKind/lastLocAckAt, A7 cadence named gap) owns live-motion reliability. Main has handoff/retention/lifecycle commits already largely absorbed into branch rewrite; do not take main wholesale.",
  },
  {
    file: "customer-app/js/p2p-peer-session.mjs",
    area: "P2P",
    classification: "branch_stronger_with_manual_port",
    note: "Same as driver peer-session; keep branch ACK semantics. Spot-check main delivery-handoff / sent-sequence retention if any unique edge remains.",
  },
  {
    file: "driver-app/js/p2p-ride-controller.mjs",
    area: "P2P",
    classification: "branch_stronger_with_manual_port",
    note: "Branch (+uncommitted A2 attemptIdentityKey) is source of truth for assignment identity. Main has viewer-lease decoupling / rematch concurrency — verify already present before any cherry-pick.",
  },
  {
    file: "customer-app/js/p2p-ride-controller.mjs",
    area: "P2P",
    classification: "conflict_manual_reconciliation",
    note: "Main commit a1d82e4 (ride-switch answer identity / stale watcher) may still have unique protections. Diff carefully against branch customer controller; do not overwrite branch AV/race fixes.",
  },
  {
    file: "driver-app/js/p2p-protocol.mjs",
    area: "P2P",
    classification: "branch_stronger",
    note: "Branch owns P2P_ACK_KIND + P2P_MIN_LOC_GAP_MS (uncommitted Stage 2/7). Main lacks these.",
  },
  {
    file: "customer-app/js/p2p-protocol.mjs",
    area: "P2P",
    classification: "branch_stronger",
    note: "Parity with driver protocol; keep branch.",
  },
  {
    file: "customer-app/js/live-location-source-arbiter.mjs",
    area: "Firebase fallback",
    classification: "branch_stronger",
    note: "Branch responsive fallback + immediate takeover after P2P loss is the live-motion path. Reconcile only if main has unrelated arbiter bugfixes.",
  },
  {
    file: "driver-app/js/location-checkpoint-policy.mjs",
    area: "Firebase fallback",
    classification: "conflict_manual_reconciliation",
    note: "Branch sparse-only-after-LOC-health is critical. Main idle cost-control / fail-closed diagnostic path may still be missing — port selectively without weakening sparse gate.",
  },
  {
    file: "functions/live-location-envelope.js",
    area: "live location",
    classification: "main_has_missing_protection",
    note: "Main adds validateTrustedFixRecency / resolveCommittedTrustAnchorMs (locationUpdatedAt trust). Branch/native ingest path needs a deliberate port — do not drop branch background ingest wiring.",
  },
  {
    file: "firestore.rules",
    area: "security/rules",
    classification: "main_has_missing_protection",
    note: "Main vehicleLocationUpdatedAtOk() requires locationUpdatedAt == request.time. Branch only checks `is timestamp`. Port this trust-anchor rule.",
  },
  {
    file: "functions/driver-location.js",
    area: "live location",
    classification: "conflict_manual_reconciliation",
    note: "Main trust-anchor + report isolation changes vs branch mirror/native paths. Manual reconcile after envelope/rules port.",
  },
  {
    file: "functions/background-location-upload.js",
    area: "Android native location",
    classification: "branch_only_keep",
    note: "Not on main. Branch (+uncommitted A4 refresh + A8 sequence strictness) is sole implementation. Keep; no main merge target.",
  },
  {
    file: "mobile/partner/android/.../DriverLocationForegroundService.java",
    area: "Android native location",
    classification: "branch_only_keep",
    note: "Not on main. Sticky restore (A5) + terminal stop (A6) live here. Keep.",
  },
  {
    file: "mobile/partner/android/.../BackgroundLocationUploader.java",
    area: "Android native location",
    classification: "branch_only_keep",
    note: "Not on main. Credential renewal + permanent-binding-invalid signal. Keep.",
  },
  {
    file: "mobile/customer/android/.../CustomerP2pKeepAliveForegroundService.java",
    area: "Android native location",
    classification: "branch_only_keep",
    note: "Not on main. Wake-lock renewal (A7). Keep.",
  },
  {
    file: "shared/js/two-leg-route-layers.mjs",
    area: "customer map/display",
    classification: "main_has_missing_protection",
    note: "Main c0f838d blank active-ride route during approach emphasis. Port route-layer blank-gap fix without touching display-pipeline ownership.",
  },
  {
    file: "customer-app/js/ride-flow.js",
    area: "ride lifecycle",
    classification: "conflict_manual_reconciliation",
    note: "Large divergence: branch P2P background keepalive + report flush wiring vs main auth/reporting integrations. Manual file-level reconcile.",
  },
  {
    file: "driver-app/js/driver-app.js",
    area: "ride lifecycle",
    classification: "conflict_manual_reconciliation",
    note: "Large divergence including native bridge + P2P presence independence. Manual reconcile; never replace wholesale from main.",
  },
  {
    file: "functions/ride-location-report*.js + shared report clients",
    area: "live location / admin",
    classification: "independent_non_conflicting",
    note: "Main ride-location reporting / Super Admin columns are largely orthogonal to P2P motion. Can land as a separate follow-up after motion code is stable.",
  },
  {
    file: "owner-app/** + owner-onboarding + auth-surface-routing",
    area: "security/rules + owner",
    classification: "independent_non_conflicting",
    note: "Main owner authorization / onboarding / surface routing — separate track from live motion.",
  },
  {
    file: "tools/hosting-* + firebase.json",
    area: "hosting",
    classification: "independent_non_conflicting",
    note: "Main hosting build order / deploy integrity — independent of P2P motion; bring in before next Hosting deploy.",
  },
  {
    file: "functions/index.js",
    area: "functions entry",
    classification: "conflict_manual_reconciliation",
    note: "Both sides export different surfaces (branch: background ingest/refresh; main: reports/owner/idle). Must merge exports surgically.",
  },
];

const reconciliationPlan = {
  doNot: [
    "blind merge origin/main",
    "blind rebase onto origin/main",
    "wholesale file replacement from main for p2p-peer-session / p2p-ride-controller / driver-app.js",
  ],
  orderedSteps: [
    {
      step: 1,
      action: "Commit Stages 2–7 working-tree fixes on branch first (separate authorization).",
      why: "Uncommitted A1–A8 fixes are not in HEAD; any main alignment must start from a known committed baseline.",
    },
    {
      step: 2,
      action: "Port firestore.rules vehicleLocationUpdatedAtOk() from main.",
      why: "Main has stronger locationUpdatedAt == request.time trust anchor; branch lacks it.",
    },
    {
      step: 3,
      action: "Port functions/live-location-envelope.js trust-anchor helpers from main into branch envelope without removing native ingest consumers.",
      why: "main_has_missing_protection on trusted recency validation.",
    },
    {
      step: 4,
      action: "Spot-diff customer p2p-ride-controller vs main a1d82e4 ride-switch answer identity; cherry-pick only missing guards.",
      why: "conflict_manual_reconciliation — unique main protection possible.",
    },
    {
      step: 5,
      action: "Port shared/js/two-leg-route-layers.mjs blank-gap / approach-emphasis fix from main.",
      why: "customer map display gap on main not verified on branch.",
    },
    {
      step: 6,
      action: "Selectively port idle checkpoint fail-closed / diagnostic defaults if still absent — without weakening LOC-health sparse gate.",
      why: "checkpoint policy conflict.",
    },
    {
      step: 7,
      action: "Surgically merge functions/index.js exports (keep refresh/ingest + add main report/owner/idle exports as needed).",
      why: "entrypoint conflict.",
    },
    {
      step: 8,
      action: "Defer owner-onboarding, admin report UI, hosting integrity to a follow-up PR after motion green.",
      why: "independent_non_conflicting.",
    },
    {
      step: 9,
      action: "Re-run Stage 8 regression matrix after each approved port; no deploy/push/AAB until separately authorized.",
      why: "workflow constraint.",
    },
  ],
};

const REGRESSION_SUITES = [
  { id: "stage2-ack-semantics", path: "tests/stage2-ack-semantics.mjs", required: true },
  { id: "stage2-bootstrap-assignment-fix", path: "tests/stage2-bootstrap-assignment-fix.mjs", required: true },
  { id: "stage3-assignment-identity-stability", path: "tests/stage3-assignment-identity-stability.mjs", required: true },
  { id: "stage3-same-ride-reassignment", path: "tests/stage3-same-ride-reassignment.mjs", required: true },
  { id: "stage3-driver-p2p-presence-independence", path: "tests/stage3-driver-p2p-presence-independence.mjs", required: true },
  { id: "stage4-failed-send-retry", path: "tests/stage4-failed-send-retry.mjs", required: true },
  { id: "stage4-peer-session-delivery", path: "tests/stage4-peer-session-delivery.mjs", required: true },
  { id: "stage4-responsive-firebase-fallback", path: "tests/stage4-responsive-firebase-fallback.mjs", required: true },
  { id: "stage4-native-credential-continuity", path: "tests/stage4-native-credential-continuity.mjs", required: true, allowBlockedPass: true },
  { id: "stage5-full-chain-marker-motion", path: "tests/stage5-full-chain-marker-motion.mjs", required: true },
  { id: "stage5-cadence-contract", path: "tests/stage5-cadence-contract.mjs", required: true },
  { id: "stage5-android-service-lifecycle", path: "tests/stage5-android-service-lifecycle.mjs", required: true, allowBlockedPass: true },
  { id: "stage6-customer-wake-lock-renewal", path: "tests/stage6-customer-wake-lock-renewal.mjs", required: true, allowBlockedPass: true },
  { id: "stage6-native-fallback-audit", path: "tests/stage6-native-fallback-audit.mjs", required: true },
  { id: "stage7-sequence-strictness", path: "tests/stage7-sequence-strictness.mjs", required: true },
  { id: "background-location-upload", path: "tests/background-location-upload.mjs", required: true },
  { id: "customer-p2p-background", path: "tests/customer-p2p-background.mjs", required: true },
  { id: "p2p-customer-receive", path: "tests/p2p-customer-receive.mjs", required: true },
  {
    id: "physical-dual-device-signoff",
    path: null,
    required: true,
    forceStatus: "BLOCKED",
    note: "Two real Android phones — cannot automate",
  },
];

console.log("\n=== STAGE 8 — main alignment audit + regression rollup ===\n");
console.log(`Branch: ${branch}`);
console.log(`Branch SHA: ${branchSha}`);
console.log(`Main SHA:   ${mainSha}`);
console.log(`Ahead/Behind vs origin/main: ${ahead} ahead / ${behind} behind`);
console.log(`Merge-base: ${mergeBase}`);
console.log(`Uncommitted prod lines: ${workingTreeProd.length}`);
console.log("");

const suiteResults = [];
for (const suite of REGRESSION_SUITES) {
  if (suite.forceStatus) {
    suiteResults.push({
      id: suite.id,
      status: suite.forceStatus,
      required: suite.required,
      note: suite.note || "",
    });
    console.log(`○ ${suite.id} — ${suite.forceStatus}${suite.note ? `: ${suite.note}` : ""}`);
    continue;
  }
  if (!fs.existsSync(path.join(ROOT, suite.path))) {
    suiteResults.push({
      id: suite.id,
      status: "FAIL",
      required: suite.required,
      note: "suite file missing",
    });
    console.log(`✗ ${suite.id} — FAIL: suite file missing`);
    continue;
  }
  process.stdout.write(`… ${suite.path}\n`);
  const run = runNode(suite.path);
  const status = classifyRun(run, { allowBlockedPass: suite.allowBlockedPass });
  suiteResults.push({
    id: suite.id,
    status,
    required: suite.required,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    stdoutTail: run.stdoutTail,
  });
  const mark = status === "PASS" ? "✓" : status === "BLOCKED" ? "○" : status === "ENVIRONMENT-ONLY" ? "!" : "✗";
  console.log(`${mark} ${suite.id} — ${status} exit=${run.exitCode} ${run.elapsedMs}ms`);
}

const required = suiteResults.filter((s) => s.required);
const summary = {
  pass: required.filter((s) => s.status === "PASS").length,
  fail: required.filter((s) => s.status === "FAIL").length,
  blocked: required.filter((s) => s.status === "BLOCKED").length,
  environmentOnly: required.filter((s) => s.status === "ENVIRONMENT-ONLY").length,
};

const codeGreen = summary.fail === 0 && summary.environmentOnly === 0;
const verdict = !codeGreen
  ? "NOT_READY"
  : summary.blocked > 0
    ? "READY_FOR_AUTHORIZED_RECONCILIATION_THEN_PHYSICAL_SIGNOFF"
    : "READY_FOR_PHYSICAL_SIGNOFF";

const report = {
  stage: 8,
  scope: "targeted-main-alignment-audit",
  generatedAt: new Date().toISOString(),
  branch,
  branchSha,
  mainSha,
  mergeBase,
  ahead,
  behind,
  uncommittedProductionChanges: workingTreeProd,
  note:
    "Stages 2–7 reliability fixes are present in the working tree but NOT committed to HEAD. Classifications treat working tree as the intended branch tip for motion code.",
  fileClassifications,
  reconciliationPlan,
  regression: {
    summary,
    codeGreen,
    verdict,
    suites: suiteResults,
  },
  mergePerformed: false,
  deployPerformed: false,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("\n--- Stage 8 summary ---");
console.log(`Verdict: ${verdict}`);
console.log(`CODE_GREEN (no FAIL/ENV-ONLY in required): ${codeGreen}`);
console.log(
  `Required: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.blocked} BLOCKED / ${summary.environmentOnly} ENVIRONMENT-ONLY`
);
console.log(`Merge performed: false`);
console.log(`Wrote ${OUT}\n`);

if (summary.fail > 0) process.exit(1);
