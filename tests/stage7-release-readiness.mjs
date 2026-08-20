/**
 * Stage 7 — full regression rollup + release readiness report (no commit/deploy).
 *
 * Runs reconciliation suites (stages 2–6) + supporting tests; classifies each as
 * PASS | FAIL | BLOCKED | ENVIRONMENT-ONLY.
 *
 * Stage 1 is retained as historical d34-vs-main audit — many checks expect d34 gaps;
 * after Stages 2–5 fixes they flip to FAIL/gap-not-reproduced (ENVIRONMENT-ONLY).
 *
 * Run: node tests/stage7-release-readiness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage7-release-readiness-report.json");

/** @typedef {"PASS"|"FAIL"|"BLOCKED"|"ENVIRONMENT-ONLY"|"WARN"} SuiteStatus */

const SUITE_MATRIX = [
  {
    id: "stage2-driver-controller",
    path: "tests/stage2-driver-controller-reconciliation.mjs",
    resultsPath: "tests/stage2-driver-controller-reconciliation-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage2-assignment-version-sync",
    path: "tests/stage2-assignment-version-sync.mjs",
    resultsPath: "tests/stage2-assignment-version-sync-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage3-customer-controller",
    path: "tests/stage3-customer-controller-reconciliation.mjs",
    resultsPath: "tests/stage3-customer-controller-reconciliation-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage3-driver-presence-independence",
    path: "tests/stage3-driver-p2p-presence-independence.mjs",
    resultsPath: "tests/stage3-driver-p2p-presence-independence-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage4-peer-session-delivery",
    path: "tests/stage4-peer-session-delivery.mjs",
    resultsPath: "tests/stage4-peer-session-delivery-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage4-responsive-firebase",
    path: "tests/stage4-responsive-firebase-fallback.mjs",
    resultsPath: "tests/stage4-responsive-firebase-fallback-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "stage5-peer-bridge-motion",
    path: "tests/stage5-e2e-marker-motion.mjs",
    resultsPath: "tests/stage5-e2e-marker-motion-results.json",
    category: "reconciliation",
    requiredForRelease: true,
    note: "Peer-session bridge + arbiter/display — not full controller chain",
  },
  {
    id: "stage5-full-chain-motion",
    path: "tests/stage5-full-chain-marker-motion.mjs",
    resultsPath: "tests/stage5-full-chain-marker-motion-results.json",
    category: "reconciliation",
    requiredForRelease: true,
    note: "True driver+customer controller chain through channel.send",
  },
  {
    id: "stage6-cloud-functions-audit",
    path: "tests/stage6-cloud-functions-audit.mjs",
    resultsPath: "tests/stage6-cloud-functions-audit-results.json",
    category: "reconciliation",
    requiredForRelease: true,
  },
  {
    id: "p2p-customer-receive",
    path: "tests/p2p-customer-receive.mjs",
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
    requiredForRelease: true,
    note: "Arbiter + display inject only",
  },
  {
    id: "background-location-upload",
    path: "tests/background-location-upload.mjs",
    resultsPath: "tests/background-location-upload-results.json",
    category: "supporting",
    requiredForRelease: true,
  },
  {
    id: "runtime-validation-phase3",
    path: "tests/runtime-validation-phase3.mjs",
    resultsPath: "tests/runtime-validation-phase3-report.json",
    category: "supporting",
    requiredForRelease: true,
  },
  {
    id: "stage1-reconciliation-audit",
    path: "tests/stage1-reconciliation-audit.mjs",
    resultsPath: "tests/stage1-reconciliation-audit-results.json",
    category: "historical-audit",
    requiredForRelease: false,
    classificationOverride: "ENVIRONMENT-ONLY",
    note: "Compares git HEAD (d34) vs origin/main; post-fix working tree expected to diverge",
  },
  {
    id: "physical-dual-device-ride",
    path: null,
    category: "physical",
    requiredForRelease: true,
    classificationOverride: "BLOCKED",
    note: "Two real phones + Gmail accounts + one live ride — agent cannot execute",
  },
  {
    id: "p2p-webrtc-emulator",
    path: "tests/p2p-webrtc.mjs",
    category: "emulator",
    requiredForRelease: false,
    classificationOverride: "ENVIRONMENT-ONLY",
    skipRun: true,
    note: "Requires firebase emulators:exec — run manually before deploy",
  },
  {
    id: "checkpoint-policy-emulator",
    path: "tests/checkpoint-policy.mjs",
    category: "emulator",
    requiredForRelease: false,
    classificationOverride: "ENVIRONMENT-ONLY",
    skipRun: true,
    note: "Requires firebase emulators:exec",
  },
];

function runSuite(relPath) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [relPath], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    exitCode: res.status ?? 1,
    elapsedMs: Date.now() - t0,
    stdoutTail: (res.stdout || "").split("\n").slice(-8).join("\n"),
    stderrTail: (res.stderr || "").slice(0, 300),
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
    return /** @type {SuiteStatus} */ (entry.classificationOverride);
  }
  if (run.exitCode === 0) return "PASS";
  return "FAIL";
}

async function main() {
  console.log("\n=== STAGE 7 — release readiness regression rollup ===\n");

  /** @type {object[]} */
  const suites = [];
  let requiredPass = 0;
  let requiredFail = 0;
  let requiredBlocked = 0;

  for (const entry of SUITE_MATRIX) {
    if (entry.skipRun || !entry.path) {
      const status = /** @type {SuiteStatus} */ (entry.classificationOverride || "BLOCKED");
      const row = {
        id: entry.id,
        category: entry.category,
        requiredForRelease: entry.requiredForRelease,
        status,
        exitCode: null,
        elapsedMs: null,
        note: entry.note || "",
        counts: {},
      };
      suites.push(row);
      if (entry.requiredForRelease) {
        if (status === "PASS") requiredPass += 1;
        else if (status === "BLOCKED") requiredBlocked += 1;
        else if (status === "FAIL") requiredFail += 1;
      }
      console.log(`${status === "PASS" ? "✓" : status === "BLOCKED" ? "○" : "!"} ${entry.id} — ${status}`);
      continue;
    }

    const rel = entry.path;
    console.log(`… running ${rel}`);
    const run = runSuite(rel);
    const status = classifySuite(entry, run);
    const counts = summarizeResultsJson(
      entry.resultsPath ? readJsonIfExists(entry.resultsPath) : null
    );
    const row = {
      id: entry.id,
      category: entry.category,
      requiredForRelease: entry.requiredForRelease,
      status,
      exitCode: run.exitCode,
      elapsedMs: run.elapsedMs,
      counts,
      note: entry.note || "",
      stdoutTail: run.stdoutTail,
    };
    suites.push(row);

    const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "!";
    const countStr =
      counts.total != null && counts.total > 0
        ? ` (${counts.pass ?? 0}/${counts.total} assertions)`
        : "";
    console.log(`${mark} ${entry.id} — ${status} exit=${run.exitCode}${countStr} ${run.elapsedMs}ms`);

    if (entry.requiredForRelease) {
      if (status === "PASS") requiredPass += 1;
      else if (status === "BLOCKED") requiredBlocked += 1;
      else if (status === "FAIL") requiredFail += 1;
    }
  }

  const reconciliationSuites = suites.filter((s) => s.category === "reconciliation");
  const reconPass = reconciliationSuites.every((s) => s.status === "PASS");

  const stage6 = readJsonIfExists("tests/stage6-cloud-functions-audit-results.json");
  const deployDiscoveryOk = stage6?.deployBlocked === false;

  const readiness = {
    reconciliationComplete: reconPass,
    automatedRegressionGreen: requiredFail === 0,
    physicalValidationBlocked: true,
    deployAuthorized: false,
    deployDiscoveryOk,
    commitAuthorized: false,
  };

  const verdict =
    reconPass && requiredFail === 0
      ? "READY_FOR_PHYSICAL_SIGNOFF"
      : requiredFail > 0
        ? "NOT_READY_AUTOMATED_FAIL"
        : "NOT_READY";

  const report = {
    stage: 7,
    suite: "release-readiness",
    generatedAt: new Date().toISOString(),
    branch: "chore/local-unpushed-files-20260818",
    reconciliationCommit: "d34cca44f718296a9a5c373f53697d85878f285e",
    verdict,
    readiness,
    summary: {
      suitesTotal: suites.length,
      pass: suites.filter((s) => s.status === "PASS").length,
      fail: suites.filter((s) => s.status === "FAIL").length,
      blocked: suites.filter((s) => s.status === "BLOCKED").length,
      environmentOnly: suites.filter((s) => s.status === "ENVIRONMENT-ONLY").length,
      requiredForRelease: {
        pass: requiredPass,
        fail: requiredFail,
        blocked: requiredBlocked,
      },
    },
    suites,
    productionChangesUncommitted: [
      "driver-app/js/p2p-ride-controller.mjs",
      "customer-app/js/p2p-ride-controller.mjs",
      "driver-app/js/p2p-peer-session.mjs",
      "customer-app/js/p2p-peer-session.mjs",
      "driver-app/js/p2p-protocol.mjs",
      "customer-app/js/p2p-protocol.mjs",
    ],
    testArtifactsAdded: [
      "tests/stage1-reconciliation-audit.mjs",
      "tests/stage2-driver-controller-reconciliation.mjs",
      "tests/stage2-assignment-version-sync.mjs",
      "tests/stage3-customer-controller-reconciliation.mjs",
      "tests/stage3-driver-p2p-presence-independence.mjs",
      "tests/stage4-peer-session-delivery.mjs",
      "tests/stage4-responsive-firebase-fallback.mjs",
      "tests/stage5-e2e-marker-motion.mjs",
      "tests/stage5-full-chain-marker-motion.mjs",
      "tests/stage6-cloud-functions-audit.mjs",
      "tests/stage7-release-readiness.mjs",
    ],
    physicalSignoffCriteria: [
      "Two real phones, one real ride",
      "Customer marker moves smoothly on P2P",
      "Customer counters: fixesReceived increases, invalidMessages=0",
      "P2P silent → Firebase fallback within ~4s responsive window",
      "P2P recovery without coordinate rollback",
    ],
    preDeployManualChecks: [
      "firebase deploy --only functions --dry-run (already succeeded in Stage 6 environment)",
      "npm run test:p2p-webrtc (emulator)",
      "npm run test:checkpoint-policy (emulator)",
      "Partner AAB smoke on Android with native background path",
    ],
    notes: [
      "Stage 1 exit=1 is expected after Stages 2–5: static git compare targets d34 HEAD, gaps are fixed in working tree.",
      "Stage 5 full-chain proved synchronous ACK loopback fix in p2p-peer-session (trackSentSequence before trySend).",
      "No git commit, push, hosting deploy, or Functions deploy performed in this reconciliation pass.",
    ],
  };

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log("\n--- Release readiness ---");
  console.log(`Verdict: ${verdict}`);
  console.log(
    `Reconciliation suites (2–6): ${reconciliationSuites.filter((s) => s.status === "PASS").length}/${reconciliationSuites.length} PASS`
  );
  console.log(
    `Required automated: ${requiredPass} PASS, ${requiredFail} FAIL, ${requiredBlocked} BLOCKED`
  );
  console.log(`Deploy discovery OK: ${deployDiscoveryOk}`);
  console.log(`Wrote ${OUT}\n`);

  if (requiredFail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
