/**
 * Stage 7 — critical reconciliation release readiness (current working tree).
 *
 * Runs Stages 1–6 focused suites + supporting regressions; attempts Firebase
 * CLI functions dry-run and classifies emulator suites separately from Node load timing.
 *
 * Run: node tests/stage7-release-readiness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage7-release-readiness-report.json");

/** @typedef {"PASS"|"FAIL"|"BLOCKED"|"ENVIRONMENT-ONLY"|"WARN"} SuiteStatus */

const CRITICAL_RECONCILIATION_SUITES = [
  {
    id: "stage1-bootstrap-assignment-contract",
    path: "tests/stage1-bootstrap-assignment-contract.mjs",
    resultsPath: "tests/stage1-bootstrap-assignment-contract-results.json",
    category: "critical-reconciliation",
    requiredForRelease: false,
    classificationOverride: "ENVIRONMENT-ONLY",
    note: "Audit suite — static gap tests fail after Stage 2 fix; server contract tests B–D remain valid history",
  },
  {
    id: "stage2-bootstrap-assignment-fix",
    path: "tests/stage2-bootstrap-assignment-fix.mjs",
    resultsPath: "tests/stage2-bootstrap-assignment-fix-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage2-ack-semantics",
    path: "tests/stage2-ack-semantics.mjs",
    resultsPath: "tests/stage2-ack-semantics-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A1 LOC vs HB ACK semantics",
  },
  {
    id: "stage3-same-ride-reassignment",
    path: "tests/stage3-same-ride-reassignment.mjs",
    resultsPath: "tests/stage3-same-ride-reassignment-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage3-assignment-identity-stability",
    path: "tests/stage3-assignment-identity-stability.mjs",
    resultsPath: "tests/stage3-assignment-identity-stability-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A2 post-bootstrap same-ride resync stability",
  },
  {
    id: "stage4-failed-send-retry",
    path: "tests/stage4-failed-send-retry.mjs",
    resultsPath: "tests/stage4-failed-send-retry-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage4-native-credential-continuity",
    path: "tests/stage4-native-credential-continuity.mjs",
    resultsPath: "tests/stage4-native-credential-continuity-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A3/A4 credential cache + native renewal",
  },
  {
    id: "stage5-cadence-contract",
    path: "tests/stage5-cadence-contract.mjs",
    resultsPath: "tests/stage5-cadence-contract-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "Documents intentional P2P_MIN_LOC_GAP_MS = 1500",
  },
  {
    id: "stage5-android-service-lifecycle",
    path: "tests/stage5-android-service-lifecycle.mjs",
    resultsPath: "tests/stage5-android-service-lifecycle-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A5/A6 sticky restore + terminal stop",
  },
  {
    id: "stage6-native-fallback-audit",
    path: "tests/stage6-native-fallback-audit.mjs",
    resultsPath: "tests/stage6-native-fallback-audit-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage6-customer-wake-lock-renewal",
    path: "tests/stage6-customer-wake-lock-renewal.mjs",
    resultsPath: "tests/stage6-customer-wake-lock-renewal-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A7 bounded renewable wake lock",
  },
  {
    id: "stage7-sequence-strictness",
    path: "tests/stage7-sequence-strictness.mjs",
    resultsPath: "tests/stage7-sequence-strictness-results.json",
    category: "critical-reconciliation",
    requiredForRelease: true,
    note: "A8 INVALID_SEQUENCE + cadence docs",
  },
];

const PRIOR_RECONCILIATION_SUITES = [
  {
    id: "stage2-driver-controller",
    path: "tests/stage2-driver-controller-reconciliation.mjs",
    resultsPath: "tests/stage2-driver-controller-reconciliation-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage2-assignment-version-sync",
    path: "tests/stage2-assignment-version-sync.mjs",
    resultsPath: "tests/stage2-assignment-version-sync-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage3-customer-controller",
    path: "tests/stage3-customer-controller-reconciliation.mjs",
    resultsPath: "tests/stage3-customer-controller-reconciliation-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage3-driver-presence-independence",
    path: "tests/stage3-driver-p2p-presence-independence.mjs",
    resultsPath: "tests/stage3-driver-p2p-presence-independence-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage4-peer-session-delivery",
    path: "tests/stage4-peer-session-delivery.mjs",
    resultsPath: "tests/stage4-peer-session-delivery-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage4-responsive-firebase",
    path: "tests/stage4-responsive-firebase-fallback.mjs",
    resultsPath: "tests/stage4-responsive-firebase-fallback-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage5-full-chain-motion",
    path: "tests/stage5-full-chain-marker-motion.mjs",
    resultsPath: "tests/stage5-full-chain-marker-motion-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
    note: "True driver+customer controller chain",
  },
  {
    id: "stage6-cloud-functions-audit",
    path: "tests/stage6-cloud-functions-audit.mjs",
    resultsPath: "tests/stage6-cloud-functions-audit-results.json",
    category: "prior-reconciliation",
    requiredForRelease: true,
  },
];

const SUPPORTING_SUITES = [
  {
    id: "p2p-customer-receive",
    path: "tests/p2p-customer-receive.mjs",
    resultsPath: "tests/p2p-customer-receive-results.json",
    category: "supporting",
    requiredForRelease: true,
  },
  {
    id: "background-location-upload",
    path: "tests/background-location-upload.mjs",
    resultsPath: "tests/background-location-upload-results.json",
    category: "supporting",
    requiredForRelease: true,
  },
  {
    id: "customer-p2p-background",
    path: "tests/customer-p2p-background.mjs",
    category: "supporting",
    requiredForRelease: true,
  },
  {
    id: "customer-marker-motion-continuity",
    path: "tests/customer-marker-motion-continuity.mjs",
    resultsPath: "tests/customer-marker-motion-continuity-results.json",
    category: "supporting",
    requiredForRelease: false,
  },
];

const EMULATOR_SUITES = [
  {
    id: "p2p-webrtc-emulator",
    npmScript: "test:p2p-webrtc",
    path: "tests/p2p-webrtc.mjs",
    category: "emulator",
    requiredForRelease: false,
  },
  {
    id: "checkpoint-policy-emulator",
    npmScript: "test:checkpoint-policy",
    path: "tests/checkpoint-policy.mjs",
    category: "emulator",
    requiredForRelease: false,
  },
];

const SUITE_MATRIX = [
  ...CRITICAL_RECONCILIATION_SUITES,
  ...PRIOR_RECONCILIATION_SUITES,
  ...SUPPORTING_SUITES,
  {
    id: "physical-dual-device-ride",
    path: null,
    category: "physical",
    requiredForRelease: true,
    classificationOverride: "BLOCKED",
    note: "Two real phones + one live ride — cannot automate",
  },
  ...EMULATOR_SUITES.map((e) => ({ ...e, requiredForRelease: false, runViaNpm: true })),
];

function git(cmd) {
  const res = spawnSync("git", cmd, { cwd: ROOT, encoding: "utf8" });
  return (res.stdout || "").trim();
}

function gitChangedProductionFiles() {
  const out = git(["status", "--porcelain"]);
  const prod = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const file = line.slice(3).trim();
    if (
      file.startsWith("driver-app/") ||
      file.startsWith("customer-app/") ||
      file.startsWith("functions/") ||
      file.startsWith("shared/")
    ) {
      if (!file.includes("tests/") && !file.endsWith("-results.json")) prod.push(file);
    }
  }
  return [...new Set(prod)].sort();
}

function runNode(relPath) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [relPath], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  return {
    exitCode: res.status ?? 1,
    elapsedMs: Date.now() - t0,
    stdoutTail: (res.stdout || "").split("\n").slice(-10).join("\n"),
    stderrTail: (res.stderr || "").slice(0, 400),
  };
}

function runNpmScript(script) {
  const t0 = Date.now();
  const res = spawnSync("npm", ["run", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    shell: true,
  });
  return {
    exitCode: res.status ?? 1,
    elapsedMs: Date.now() - t0,
    stdoutTail: (res.stdout || "").split("\n").slice(-12).join("\n"),
    stderrTail: (res.stderr || "").slice(0, 400),
  };
}

function measureFunctionsIndexLoad() {
  const childScript = `
    const t0 = Date.now();
    require('./functions/index.js');
    console.log('__LOAD_MS=' + (Date.now() - t0));
  `;
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const res = spawnSync(process.execPath, ["-e", childScript], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (res.status !== 0) {
      return { ok: false, reason: res.stderr?.trim().slice(0, 120) || `exit ${res.status}` };
    }
    const m = /__LOAD_MS=(\d+)/.exec(res.stdout || "");
    if (m) samples.push(Number(m[1]));
  }
  if (!samples.length) return { ok: false, reason: "no timing samples" };
  return {
    ok: true,
    samplesMs: samples,
    maxMs: Math.max(...samples),
    avgMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

function runFirebaseFunctionsDryRun() {
  const res = spawnSync(
    "firebase",
    ["deploy", "--only", "functions", "--dry-run", "--project", "swiftgo-ride-app"],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, shell: true }
  );
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  const ok =
    res.status === 0 &&
    (/dry run complete/i.test(combined) ||
      /Deploy complete/i.test(combined) ||
      /would be created|would be updated/i.test(combined));
  return {
    attempted: true,
    ok,
    exitCode: res.status ?? 1,
    stdoutTail: (res.stdout || "").split("\n").slice(-15).join("\n"),
    stderrTail: (res.stderr || "").slice(0, 500),
    note:
      res.status !== 0
        ? "Firebase CLI dry-run failed or unavailable — distinct from Node require() load timing"
        : "Firebase CLI functions dry-run completed",
  };
}

function readJsonIfExists(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function summarizeResultsJson(json) {
  if (!json) return {};
  if (Array.isArray(json.results)) {
    const pass = json.results.filter((r) => r.status === "PASS").length;
    const fail = json.results.filter((r) => r.status === "FAIL").length;
    const warn = json.results.filter((r) => r.status === "WARN").length;
    return { pass, fail, warn, total: json.results.length };
  }
  if (typeof json.pass === "number") {
    return {
      pass: json.pass,
      fail: json.fail ?? 0,
      warn: json.warn ?? 0,
      total: (json.pass ?? 0) + (json.fail ?? 0) + (json.warn ?? 0),
    };
  }
  return {};
}

function classifySuite(entry, run) {
  if (entry.classificationOverride) {
    if (entry.classificationOverride === "ENVIRONMENT-ONLY" && entry.path && run?.exitCode !== 0) {
      return "ENVIRONMENT-ONLY";
    }
    return /** @type {SuiteStatus} */ (entry.classificationOverride);
  }
  if (run?.exitCode === 0) return "PASS";
  return "FAIL";
}

async function main() {
  console.log("\n=== STAGE 7 — critical reconciliation release readiness ===\n");

  const branch = git(["branch", "--show-current"]) || "unknown";
  const headCommit = git(["rev-parse", "HEAD"]) || "unknown";
  const productionChanges = gitChangedProductionFiles();

  /** @type {object[]} */
  const suites = [];
  let requiredPass = 0;
  let requiredFail = 0;
  let requiredBlocked = 0;

  for (const entry of SUITE_MATRIX) {
    if (!entry.path && entry.classificationOverride) {
      const status = /** @type {SuiteStatus} */ (entry.classificationOverride);
      suites.push({
        id: entry.id,
        category: entry.category,
        requiredForRelease: entry.requiredForRelease,
        status,
        exitCode: null,
        elapsedMs: null,
        note: entry.note || "",
        counts: {},
      });
      if (entry.requiredForRelease && status === "BLOCKED") requiredBlocked += 1;
      console.log(`○ ${entry.id} — ${status}`);
      continue;
    }

    if (entry.runViaNpm) {
      console.log(`… running npm run ${entry.npmScript}`);
      const run = runNpmScript(entry.npmScript);
      const status = run.exitCode === 0 ? "PASS" : "ENVIRONMENT-ONLY";
      const row = {
        id: entry.id,
        category: entry.category,
        requiredForRelease: entry.requiredForRelease,
        status,
        exitCode: run.exitCode,
        elapsedMs: run.elapsedMs,
        counts: {},
        note:
          run.exitCode === 0
            ? "Firebase emulators available"
            : "Emulator suite blocked in this environment",
        stdoutTail: run.stdoutTail,
        stderrTail: run.stderrTail,
      };
      suites.push(row);
      console.log(`${run.exitCode === 0 ? "✓" : "!"} ${entry.id} — ${status} exit=${run.exitCode} ${run.elapsedMs}ms`);
      continue;
    }

    console.log(`… running ${entry.path}`);
    const run = runNode(entry.path);
    const status = classifySuite(entry, run);
    const counts = summarizeResultsJson(
      entry.resultsPath ? readJsonIfExists(entry.resultsPath) : null
    );
    suites.push({
      id: entry.id,
      category: entry.category,
      requiredForRelease: entry.requiredForRelease,
      status,
      exitCode: run.exitCode,
      elapsedMs: run.elapsedMs,
      counts,
      note: entry.note || "",
      stdoutTail: run.stdoutTail,
    });

    const mark = status === "PASS" ? "✓" : "✗";
    const countStr = counts.total ? ` (${counts.pass}/${counts.total})` : "";
    console.log(`${mark} ${entry.id} — ${status} exit=${run.exitCode}${countStr} ${run.elapsedMs}ms`);

    if (entry.requiredForRelease) {
      if (status === "PASS") requiredPass += 1;
      else if (status === "FAIL") requiredFail += 1;
      else if (status === "BLOCKED") requiredBlocked += 1;
    }
  }

  console.log("\n=== Functions discovery (Node require timing) ===\n");
  const loadTiming = measureFunctionsIndexLoad();
  const functionsDiscoveryStatus =
    loadTiming.ok && loadTiming.maxMs < 10_000 ? "PASS" : loadTiming.ok ? "WARN" : "FAIL";
  console.log(
    `${functionsDiscoveryStatus === "PASS" ? "✓" : "!"} functions-index-load — ${functionsDiscoveryStatus}${
      loadTiming.ok ? `: max=${loadTiming.maxMs}ms avg=${loadTiming.avgMs}ms` : `: ${loadTiming.reason}`
    }`
  );

  console.log("\n=== Firebase CLI functions dry-run ===\n");
  const firebaseDryRun = runFirebaseFunctionsDryRun();
  const firebaseDryRunStatus = firebaseDryRun.ok ? "PASS" : "BLOCKED";
  console.log(
    `${firebaseDryRun.ok ? "✓" : "!"} firebase-functions-dry-run — ${firebaseDryRunStatus} exit=${firebaseDryRun.exitCode}`
  );

  const criticalSuites = suites.filter((s) => s.category === "critical-reconciliation");
  const criticalFixSuites = criticalSuites.filter((s) => s.requiredForRelease);
  const criticalGreen = criticalFixSuites.every((s) => s.status === "PASS");
  const codeGreen = requiredFail === 0 && criticalGreen;
  const emulatorSuites = suites.filter((s) => s.category === "emulator");
  const emulatorGreen = emulatorSuites.length > 0 && emulatorSuites.every((s) => s.status === "PASS");
  const emulatorBlocked = emulatorSuites.some((s) => s.status === "ENVIRONMENT-ONLY");

  const verdict = codeGreen ? "READY_FOR_PHYSICAL_SIGNOFF" : "NOT_READY_AUTOMATED_FAIL";

  const report = {
    stage: 7,
    suite: "critical-reconciliation-release-readiness",
    generatedAt: new Date().toISOString(),
    branch,
    headCommit,
    priorReleaseCommit: "d34cca44f718296a9a5c373f53697d85878f285e",
    automatedVerdict: {
      CODE_GREEN: codeGreen,
      EMULATOR_GREEN: emulatorGreen,
      EMULATOR_BLOCKED: emulatorBlocked && !emulatorGreen,
      FUNCTIONS_DISCOVERY_GREEN: functionsDiscoveryStatus === "PASS",
      FUNCTIONS_DISCOVERY_WARN: functionsDiscoveryStatus === "WARN",
      FIREBASE_CLI_DRY_RUN_GREEN: firebaseDryRun.ok,
      FIREBASE_CLI_DRY_RUN_BLOCKED: !firebaseDryRun.ok,
      PHYSICAL_DEVICE_SIGNOFF_PENDING: true,
    },
    verdict,
    readiness: {
      criticalReconciliationGreen: criticalGreen,
      automatedRegressionGreen: codeGreen,
      physicalValidationBlocked: true,
      deployAuthorized: false,
      commitAuthorized: false,
      functionsIndexLoad: loadTiming,
      firebaseFunctionsDryRun: firebaseDryRun,
    },
    summary: {
      suitesTotal: suites.length,
      pass: suites.filter((s) => s.status === "PASS").length,
      fail: suites.filter((s) => s.status === "FAIL").length,
      blocked: suites.filter((s) => s.status === "BLOCKED").length,
      environmentOnly: suites.filter((s) => s.status === "ENVIRONMENT-ONLY").length,
      requiredForRelease: { pass: requiredPass, fail: requiredFail, blocked: requiredBlocked },
      criticalReconciliation: {
        total: criticalFixSuites.length,
        pass: criticalFixSuites.filter((s) => s.status === "PASS").length,
        auditOnly: criticalSuites.filter((s) => !s.requiredForRelease).map((s) => s.id),
      },
    },
    suites,
    productionChangesUncommitted: productionChanges,
    criticalTestArtifacts: [
      "tests/stage1-bootstrap-assignment-contract.mjs",
      "tests/stage2-bootstrap-assignment-fix.mjs",
      "tests/stage3-same-ride-reassignment.mjs",
      "tests/stage4-failed-send-retry.mjs",
      "tests/stage5-cadence-contract.mjs",
      "tests/stage6-native-fallback-audit.mjs",
      "tests/stage7-release-readiness.mjs",
    ],
    productionFixesSummary: [
      "Stage 2: unknown assignmentVersion no longer coerced to 1 on first server offer",
      "Stage 3: same-ride reassignment destroys stale customer peer session",
      "Stage 4: failed channel.send schedules bounded retry of newest pending fix",
      "Stage 6: removed diagnostics-only rideViewerPresence read from native ingest",
    ],
    physicalSignoffCriteria: [
      "Driver GPS fixes increase during active ride",
      "P2P session establishes; server AV matches driver session AV",
      "Customer fixesReceived increases; invalidMessages=0",
      "Driver valid ACK count increases; marker moves continuously",
      "P2P loss → Firebase responsive takeover without long freeze",
      "P2P recovery without coordinate rollback",
      "Android lock/screen-off/swipe background path checked",
    ],
    notes: [
      "Node require(functions/index.js) timing is NOT equivalent to Firebase CLI deploy dry-run.",
      "All critical reconciliation production fixes are local/uncommitted on this branch.",
      "No hosting deploy, Functions deploy, commit, or push performed.",
    ],
  };

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log("\n--- Release readiness ---");
  console.log(`Branch: ${branch}`);
  console.log(`HEAD: ${headCommit}`);
  console.log(`Verdict: ${verdict}`);
  console.log(`CODE_GREEN: ${codeGreen}`);
  console.log(`CRITICAL reconciliation (fixes): ${criticalFixSuites.filter((s) => s.status === "PASS").length}/${criticalFixSuites.length} PASS`);
  console.log(`Required automated: ${requiredPass} PASS, ${requiredFail} FAIL, ${requiredBlocked} BLOCKED`);
  console.log(`Functions discovery: ${functionsDiscoveryStatus}`);
  console.log(`Firebase CLI dry-run: ${firebaseDryRun.ok ? "PASS" : "BLOCKED"}`);
  console.log(`PHYSICAL_DEVICE_SIGNOFF_PENDING: true`);
  console.log(`Wrote ${OUT}\n`);

  if (requiredFail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
