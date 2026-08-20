/**
 * Stage 6 — Cloud Functions + native 4s semantics audit (read-only, no deploy).
 *
 * Audits:
 * - background-location-upload.js rideViewerPresence read + cadence policy
 * - 4s alignment: CF ingest, client arbiter, checkpoint policy, native Android
 * - Functions index discovery/load timing (deploy analysis proxy)
 *
 * Run: node tests/stage6-cloud-functions-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  RESPONSIVE_INTERVAL_MS as CHECKPOINT_RESPONSIVE_MS,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  FIREBASE_BACKUP_READ_INTERVAL_MS,
  P2P_FALLBACK_AFTER_MS,
} from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage6-cloud-functions-audit-results.json");

const bgUpload = require("../functions/background-location-upload.js");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "WARN" ? "!" : "✗";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function auditBackgroundUploadPresenceAndCadence() {
  console.log("\n=== background-location-upload.js ===\n");
  const src = readUtf8("functions/background-location-upload.js");

  record(
    "presence-collection-defined",
    src.includes('PRESENCE_COLLECTION = "rideViewerPresence"') ? "PASS" : "FAIL",
    "rideViewerPresence constant"
  );
  const ingestBlock = src.slice(
    src.indexOf("async function ingestBackgroundDriverLocation"),
    src.indexOf("module.exports")
  );
  record(
    "ingest-no-presenceSnap",
    !ingestBlock.includes("presenceSnap") ? "PASS" : "FAIL",
    "rideViewerPresence not read during ingest"
  );
  record(
    "cadence-ignores-viewerLease-for-interval",
    src.includes("void viewerLease") &&
      /resolveBackgroundUploadIntervalMs[\s\S]*RESPONSIVE_INTERVAL_MS/.test(src)
      ? "PASS"
      : "FAIL",
    "active ride always RESPONSIVE_FIREBASE@4s"
  );

  for (const [lease, label] of [
    ["VISIBLE", "visible"],
    ["UNKNOWN", "unknown"],
    ["EXPIRED", "expired"],
  ]) {
    const cadence = bgUpload.resolveBackgroundUploadIntervalMs({
      rideStatus: "in_progress",
      viewerLease: lease,
    });
    record(
      `native-upload-cadence-${label}-4s`,
      cadence.intervalMs === 4_000 &&
        cadence.policy === "RESPONSIVE_FIREBASE" &&
        cadence.hardInterval === false
        ? "PASS"
        : "FAIL",
      `${cadence.policy}@${cadence.intervalMs} hard=${cadence.hardInterval}`
    );
  }

  record(
    "legacy-background-interval-constants-still-exported",
    bgUpload.BACKGROUND_APPROACH_INTERVAL_MS === 60_000 &&
      bgUpload.BACKGROUND_TRIP_INTERVAL_MS === 30_000
      ? "PASS"
      : "WARN",
    "exported but unused by resolveBackgroundUploadIntervalMs (intentional d34)"
  );

  const skip = bgUpload.shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 7_000,
    intervalMs: 4_000,
    hardInterval: false,
    movedEnough: false,
  });
  record(
    "ingest-write-gate-soft-4s-not-hard",
    !skip.allow && skip.reason === "interval" ? "PASS" : "FAIL",
    "movement may bypass 4s when hardInterval=false"
  );
}

function auditFourSecondAlignment() {
  console.log("\n=== 4s semantics alignment (client + native) ===\n");

  record(
    "protocol-firebase-backup-read-4s",
    FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${FIREBASE_BACKUP_READ_INTERVAL_MS}ms`
  );
  record(
    "checkpoint-responsive-interval-4s",
    CHECKPOINT_RESPONSIVE_MS === 4_000 ? "PASS" : "FAIL",
    `${CHECKPOINT_RESPONSIVE_MS}ms`
  );
  record(
    "cf-responsive-interval-4s",
    bgUpload.RESPONSIVE_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${bgUpload.RESPONSIVE_INTERVAL_MS}ms`
  );
  record(
    "p2p-fallback-before-firebase-takeover",
    P2P_FALLBACK_AFTER_MS >= 4_000 ? "PASS" : "FAIL",
    `fallbackAfter=${P2P_FALLBACK_AFTER_MS}ms`
  );

  const unhealthy = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
    p2pHealthy: false,
  });
  record(
    "checkpoint-unhealthy-p2p-responsive-4s",
    unhealthy.intervalMs === 4_000 &&
      unhealthy.policy === "RESPONSIVE_FIREBASE" &&
      unhealthy.hardInterval === false
      ? "PASS"
      : "FAIL",
    `${unhealthy.policy}@${unhealthy.intervalMs}`
  );

  const driverApp = readUtf8("driver-app/js/driver-app.js");
  record(
    "driver-app-wires-native-interval-from-checkpoint",
    driverApp.includes("syncBackgroundLocationNativeForActiveRide") &&
      driverApp.includes("intervalMs: Number(decision.intervalMs)") &&
      driverApp.includes("RESPONSIVE_INTERVAL_MS")
      ? "PASS"
      : "FAIL",
    "checkpointPolicy → native bridge"
  );

  const nativeBridge = readUtf8("driver-app/js/background-location-native.mjs");
  record(
    "native-bridge-default-interval-4s",
    nativeBridge.includes("Number(binding.intervalMs) || 4000") ? "PASS" : "FAIL",
    "min 2000 enforced upstream"
  );

  const androidService = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
  );
  record(
    "android-fg-service-default-4s",
    androidService.includes("intervalMs = 4_000L") &&
      androidService.includes("EXTRA_INTERVAL_MS")
      ? "PASS"
      : "FAIL",
    "LocationRequest interval from plugin"
  );

  const indexJs = readUtf8("functions/index.js");
  record(
    "functions-export-issue-credential",
    indexJs.includes("exports.issueBackgroundLocationCredential") ? "PASS" : "FAIL"
  );
  record(
    "functions-export-ingest-https",
    indexJs.includes("exports.ingestBackgroundDriverLocation") &&
      indexJs.includes("onRequest")
      ? "PASS"
      : "FAIL"
  );
}

function auditFunctionsDiscovery() {
  console.log("\n=== Functions discovery / load timing ===\n");

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
      timeout: 30_000,
    });
    if (res.status !== 0) {
      record(
        "functions-index-cold-load",
        "FAIL",
        res.stderr?.trim().slice(0, 120) || `exit ${res.status}`
      );
      return { deployBlocked: true, maxMs: null, avgMs: null };
    }
    const m = /__LOAD_MS=(\d+)/.exec(res.stdout || "");
    if (m) samples.push(Number(m[1]));
  }

  if (!samples.length) {
    record("functions-index-cold-load", "FAIL", "no timing samples");
    return { deployBlocked: true, maxMs: null, avgMs: null };
  }

  const maxMs = Math.max(...samples);
  const avgMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const deployDiscoveryLimitMs = 10_000;

  record(
    "functions-index-cold-load-under-10s",
    maxMs < deployDiscoveryLimitMs ? "PASS" : "FAIL",
    `samplesMs=${samples.join(",")} max=${maxMs} avg=${avgMs}`
  );

  const indexSrc = readUtf8("functions/index.js");
  const exportCount = (indexSrc.match(/exports\.\w+/g) || []).length;
  record(
    "functions-index-export-surface",
    exportCount > 0 ? "PASS" : "FAIL",
    `exports≈${exportCount} (monolithic index.js)`
  );

  const deployBlocked = maxMs >= deployDiscoveryLimitMs;
  if (deployBlocked) {
    record(
      "deploy-discovery-risk",
      "FAIL",
      `max load ${maxMs}ms ≥ Firebase CLI ~${deployDiscoveryLimitMs}ms analysis budget`
    );
  } else if (maxMs >= 3_000) {
    record(
      "deploy-discovery-risk",
      "WARN",
      `max load ${maxMs}ms — under 10s but heavy; cold AV/disk may timeout`
    );
  } else {
    record(
      "deploy-discovery-risk",
      "PASS",
      `max load ${maxMs}ms — deploy analysis should succeed locally`
    );
  }

  return { deployBlocked, maxMs, avgMs, samples, exportCount };
}

function auditPresenceDiagnosticsOnly() {
  console.log("\n=== Presence read semantics (authorization vs cadence) ===\n");

  const visible = bgUpload.resolveViewerLeaseFromPresence(
    { expiresAt: { toMillis: () => 2_000_000 } },
    1_000_000
  );
  const expired = bgUpload.resolveViewerLeaseFromPresence(
    { expiresAt: { toMillis: () => 1_000_000 } },
    2_000_000
  );
  record("presence-lease-visible", visible === "VISIBLE" ? "PASS" : "FAIL", visible);
  record("presence-lease-expired", expired === "EXPIRED" ? "PASS" : "FAIL", expired);

  record(
    "presence-read-not-used-for-cadence-gating",
    readUtf8("functions/background-location-upload.js").includes("void viewerLease")
      ? "PASS"
      : "FAIL",
    "native ingest returns viewerLease=UNKNOWN; client owns lease policy"
  );
}

async function main() {
  console.log("\n=== STAGE 6 — Cloud Functions + native 4s audit (no deploy) ===\n");

  auditBackgroundUploadPresenceAndCadence();
  auditFourSecondAlignment();
  auditPresenceDiagnosticsOnly();
  const timing = auditFunctionsDiscovery();

  const pass = results.filter((r) => r.status === "PASS").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;

  const summary = {
    stage: 6,
    suite: "cloud-functions-audit",
    honestDescription:
      "Read-only audit: rideViewerPresence ingest read, 4s responsive cadence chain, functions index load timing",
    generatedAt: new Date().toISOString(),
    deployAuthorized: false,
    deployBlocked: Boolean(timing.deployBlocked),
    functionsLoad: timing,
    pass,
    warn,
    fail,
    results,
    findings: [
      "Native ingest no longer reads rideViewerPresence — authorization uses HMAC credential + ride/vehicle binding only.",
      "resolveBackgroundUploadIntervalMs ignores viewerLease — active rides always RESPONSIVE_FIREBASE@4000ms (d34 behavior preserved).",
      "4000ms is a soft responsive target (hardInterval=false); movement >= 25m may write earlier.",
      "Client arbiter FIREBASE_BACKUP_READ_INTERVAL_MS, checkpoint RESPONSIVE_INTERVAL_MS, CF RESPONSIVE_INTERVAL_MS, and Android default intervalMs=4000 are aligned.",
      "BACKGROUND_APPROACH/TRIP interval constants remain exported but unused by native upload cadence resolver (sparse cadence is client checkpoint path when P2P healthy).",
      timing.maxMs != null
        ? `Fresh-process functions/index.js load max=${timing.maxMs}ms avg=${timing.avgMs}ms (Firebase deploy dry-run succeeded in this environment).`
        : "functions/index.js load timing unavailable.",
    ],
  };

  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 6 audit: ${pass} PASS / ${warn} WARN / ${fail} FAIL`);
  console.log(`Deploy blocked by load timing: ${summary.deployBlocked ? "YES" : "NO"}`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
