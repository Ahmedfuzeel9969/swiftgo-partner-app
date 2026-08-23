/**
 * Stage 8 tranche 3 — selective idle fail-closed + index idle validation.
 *
 * Preserves branch active-ride P2P-health sparse gate and 5min/200m idle defaults.
 * Does NOT port owner-onboarding / lifecycle stamps (deferred).
 *
 * Run: node tests/stage8-tranche3-idle-index.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  IDLE_PUBLISH_DEFAULTS,
  IDLE_PUBLISH_BOUNDS,
  MATCHING_STALE_LOCATION_MS,
  MAX_IDLE_INTERVAL_MS,
  normalizeIdlePublishConfig,
  resolveIdleIntervalMsForPolicy,
  getSafeIdlePublishConfig,
} from "../shared/js/idle-publish-config.mjs";
import {
  resolveCheckpointPolicy,
  CHECKPOINT_POLICY,
  RESPONSIVE_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
} from "../driver-app/js/location-checkpoint-policy.mjs";

const require = createRequire(import.meta.url);
const idleCjs = require("../functions/idle-publish-config.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage8-tranche3-idle-index-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

console.log("\n=== Stage 8 tranche 3 — idle fail-closed + index ===\n");

record(
  "branch-idle-defaults-preserved",
  IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs === 5 * 60_000 &&
    IDLE_PUBLISH_DEFAULTS.idleLocationMoveMeters === 200
    ? "PASS"
    : "FAIL",
  JSON.stringify(IDLE_PUBLISH_DEFAULTS)
);

record(
  "max-idle-below-matching-stale",
  MAX_IDLE_INTERVAL_MS < MATCHING_STALE_LOCATION_MS ? "PASS" : "FAIL",
  `max=${MAX_IDLE_INTERVAL_MS} stale=${MATCHING_STALE_LOCATION_MS}`
);

record(
  "rejects-string-interval-coercion",
  resolveIdleIntervalMsForPolicy("120000") === IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs
    ? "PASS"
    : "FAIL"
);

record(
  "rejects-fractional-interval",
  resolveIdleIntervalMsForPolicy(120000.5) === IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs
    ? "PASS"
    : "FAIL"
);

record(
  "accepts-strict-integer-interval",
  resolveIdleIntervalMsForPolicy(120_000) === 120_000 ? "PASS" : "FAIL"
);

record(
  "expired-diagnostic-fails-closed",
  (() => {
    const cfg = normalizeIdlePublishConfig(
      {
        idleLocationIntervalMs: 120_000,
        idleLocationMoveMeters: 100,
        idleMovementTriggerDisabled: true,
        idleDiagnosticExpiresAt: { toMillis: () => 1 },
      },
      { nowMs: 1_000_000 }
    );
    return (
      cfg.idleLocationIntervalMs === IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs &&
      cfg.idleLocationMoveMeters === IDLE_PUBLISH_DEFAULTS.idleLocationMoveMeters &&
      cfg.idleMovementTriggerDisabled === false
    );
  })()
    ? "PASS"
    : "FAIL"
);

record(
  "safe-defaults-helper",
  getSafeIdlePublishConfig().idleLocationIntervalMs ===
    IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs
    ? "PASS"
    : "FAIL"
);

record(
  "cjs-mirror-parity-defaults",
  idleCjs.IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs ===
    IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs &&
    idleCjs.IDLE_PUBLISH_BOUNDS.intervalMsMax === IDLE_PUBLISH_BOUNDS.intervalMsMax
    ? "PASS"
    : "FAIL"
);

{
  const unhealthyExpired = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
    p2pHealthy: false,
  });
  record(
    "active-ride-unhealthy-p2p-stays-responsive-4s",
    unhealthyExpired.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      unhealthyExpired.intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${unhealthyExpired.policy}@${unhealthyExpired.intervalMs}`
  );

  const healthy = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
    p2pHealthy: true,
  });
  record(
    "active-ride-healthy-p2p-sparse-ignores-lease",
    healthy.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP &&
      healthy.intervalMs === BACKGROUND_TRIP_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${healthy.policy}@${healthy.intervalMs}`
  );

  const idle = resolveCheckpointPolicy({
    hasActiveRide: false,
    idleIntervalMs: "not-a-number",
  });
  record(
    "idle-policy-uses-strict-resolver-defaults",
    idle.policy === CHECKPOINT_POLICY.NO_ACTIVE_RIDE &&
      idle.intervalMs === IDLE_PUBLISH_DEFAULTS.idleLocationIntervalMs
      ? "PASS"
      : "FAIL",
    `interval=${idle.intervalMs}`
  );
}

const indexSrc = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
record(
  "index-idle-uses-strict-callable-validators",
  indexSrc.includes("validateIdleIntervalMsForCallable") &&
    indexSrc.includes("validateIdleMoveMetersForCallable") &&
    !/idleLocationIntervalMs[\s\S]{0,120}Math\.round\(Number\(request\.data\.idleLocationIntervalMs\)\)/.test(
      indexSrc
    )
    ? "PASS"
    : "FAIL"
);

record(
  "index-rejects-client-diagnostic-expiry",
  indexSrc.includes("IDLE_DIAGNOSTIC_EXPIRY_CLIENT_FORBIDDEN") ? "PASS" : "FAIL"
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
  "index-exports-owner-onboarding-and-lifecycle",
  indexSrc.includes("exports.requestOwnerAccess") &&
    indexSrc.includes("exports.approveOwnerAccess") &&
    indexSrc.includes("exports.rejectOwnerAccess") &&
    indexSrc.includes("exports.grantSuperAdminClaim") &&
    indexSrc.includes("exports.stampRideLifecycleTimestamps") &&
    fs.existsSync(path.join(ROOT, "functions/owner-onboarding.js")) &&
    fs.existsSync(path.join(ROOT, "functions/ride-lifecycle-timestamps.js"))
    ? "PASS"
    : "FAIL",
  "tranche 4 ported owner/admin/lifecycle"
);

const fail = results.filter((r) => r.status === "FAIL").length;
const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\nStage 8 tranche 3: ${pass} PASS / ${fail} FAIL`);
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 8,
      tranche: 3,
      scope: "idle-fail-closed-and-index-idle-validation",
      generatedAt: new Date().toISOString(),
      deferredFromMain: [
        "full admin idle diagnostic UI surface polish (callables already gated)",
      ],
      summary: { pass, fail },
      results,
    },
    null,
    2
  )
);
console.log(`Wrote ${OUT}\n`);
if (fail > 0) process.exit(1);
