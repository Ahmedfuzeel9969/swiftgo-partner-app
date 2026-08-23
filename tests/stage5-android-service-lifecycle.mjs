/**
 * Stage 5 — Android service sticky restore + terminal binding stop.
 *
 * Run: node tests/stage5-android-service-lifecycle.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage5-android-service-lifecycle-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const svcSrc = readUtf8(
  "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
);
const uploaderSrc = readUtf8(
  "mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java"
);

// ---------------------------------------------------------------------------
// A5 — sticky null-intent restore
// ---------------------------------------------------------------------------

{
  const nullBlock = svcSrc.slice(
    svcSrc.indexOf("if (intent == null)"),
    svcSrc.indexOf("String action = intent.getAction")
  );

  record(
    "null-intent-restores-foreground-and-gps",
    nullBlock.includes("restoreStickyBinding()") &&
      nullBlock.includes("startAsForeground()") &&
      nullBlock.includes("startLocationUpdates()") &&
      nullBlock.includes("restored_sticky")
      ? "PASS"
      : "FAIL",
    "onStartCommand(null) rehydrates service state"
  );

  record(
    "null-intent-no-binding-stops-not-sticky",
    nullBlock.includes('stopSelfSafe("sticky_no_binding")') &&
      nullBlock.includes("START_NOT_STICKY")
      ? "PASS"
      : "FAIL",
    "invalid sticky restart stops safely"
  );

  record(
    "persisted-active-binding",
    svcSrc.includes("BINDING_PREFS") &&
      svcSrc.includes("persistActiveBinding") &&
      svcSrc.includes("SharedPreferences")
      ? "PASS"
      : "FAIL",
    "ride binding survives process death"
  );

  record(
    "restore-requires-upload-config",
    svcSrc.includes("hasPersistedUploadConfig()") ? "PASS" : "FAIL",
    "sticky restore needs persisted uploader URL"
  );

  record(
    "android-runtime-sticky-restore",
    "BLOCKED",
    "Requires Android instrumentation harness"
  );
}

// ---------------------------------------------------------------------------
// A6 — terminal binding rejection stops native tracking
// ---------------------------------------------------------------------------

const terminalReasons = [
  "RIDE_NOT_ACTIVE",
  "NOT_ASSIGNED_DRIVER",
  "ASSIGNMENT_TOKEN_MISMATCH",
  "VEHICLE_MISMATCH",
];
const recoverableReasons = ["TOKEN_EXPIRED", "INVALID_SIGNATURE", "INVALID_TOKEN"];

const permBlock = uploaderSrc.slice(
  uploaderSrc.indexOf("isPermanentBindingInvalid"),
  uploaderSrc.indexOf("private void notifyPermanentBindingInvalid")
);

for (const reason of terminalReasons) {
  record(
    `permanent-binding-includes-${reason}`,
    permBlock.includes(`"${reason}"`) ? "PASS" : "FAIL",
    "BackgroundLocationUploader.isPermanentBindingInvalid"
  );
}

for (const reason of recoverableReasons) {
  record(
    `recoverable-auth-includes-${reason}`,
    uploaderSrc.includes(`"${reason}"`) &&
      uploaderSrc.includes("isRecoverableAuthFailure")
      ? "PASS"
      : "FAIL",
    "recoverable auth separated from terminal stop"
  );
}

record(
  "terminal-flush-clears-queue-and-notifies",
  uploaderSrc.includes("if (isPermanentBindingInvalid(result.reason))") &&
    uploaderSrc.includes("writeQueue(new JSONArray())") &&
    uploaderSrc.includes("notifyPermanentBindingInvalid")
    ? "PASS"
    : "FAIL",
  "permanent rejection does not retain backlog"
);

record(
  "recoverable-auth-retains-queue",
  uploaderSrc.includes("if (isRecoverableAuthFailure(result.reason))") &&
    uploaderSrc.includes("remaining.add(item)")
    ? "PASS"
    : "FAIL",
    "TOKEN_EXPIRED etc. still wait for web refresh"
);

record(
  "service-wires-terminal-stop-listener",
  svcSrc.includes("setPermanentBindingInvalidListener") &&
    svcSrc.includes('stopSelfSafe("binding_invalid:"')
    ? "PASS"
    : "FAIL",
    "uploader permanent rejection stops foreground service"
);

record(
  "stop-clears-binding-queue-credentials",
  svcSrc.includes("clearPersistedBinding()") &&
    svcSrc.includes("clearQueue()") &&
    svcSrc.includes("clearCredentialState()")
    ? "PASS"
    : "FAIL",
    "stopSelfSafe clears persisted native state"
);

record(
  "refresh-denial-can-stop-service",
  uploaderSrc.includes("isPermanentBindingInvalid(result.reason)") &&
    uploaderSrc.slice(uploaderSrc.indexOf("tryRenewCredentialLocked")).includes(
      "notifyPermanentBindingInvalid"
    )
    ? "PASS"
    : "FAIL",
    "HTTPS refresh denial with terminal reason stops tracking"
);

// ---------------------------------------------------------------------------
// Simulated flush policy (mirrors Java split)
// ---------------------------------------------------------------------------

function isPermanentBindingInvalid(reason) {
  return (
    reason === "ASSIGNMENT_TOKEN_MISMATCH" ||
    reason === "NOT_ASSIGNED_DRIVER" ||
    reason === "RIDE_NOT_ACTIVE" ||
    reason === "VEHICLE_MISMATCH"
  );
}

function isRecoverableAuthFailure(reason) {
  return (
    reason === "TOKEN_EXPIRED" ||
    reason === "INVALID_SIGNATURE" ||
    reason === "INVALID_TOKEN"
  );
}

function simulateFlush(results) {
  const queue = results.map((reason, i) => ({ id: i, reason }));
  let stopped = false;
  let remaining = [];
  for (const item of queue) {
    if (isPermanentBindingInvalid(item.reason)) {
      stopped = true;
      remaining = [];
      break;
    }
    if (isRecoverableAuthFailure(item.reason)) {
      remaining = queue.slice(item.id);
      break;
    }
    if (item.reason === "CADENCE_SKIP" || item.reason === "upload_failed") {
      continue;
    }
  }
  return { stopped, remainingCount: remaining.length };
}

{
  const perm = simulateFlush(["CADENCE_SKIP", "RIDE_NOT_ACTIVE", "upload_failed"]);
  record(
    "sim-terminal-stops-and-clears",
    perm.stopped && perm.remainingCount === 0 ? "PASS" : "FAIL",
    "RIDE_NOT_ACTIVE halts flush with empty queue"
  );
}

{
  const rec = simulateFlush(["TOKEN_EXPIRED"]);
  record(
    "sim-recoverable-retains-item",
    !rec.stopped && rec.remainingCount === 1 ? "PASS" : "FAIL",
    "TOKEN_EXPIRED keeps item for later retry"
  );
}

{
  const transient = simulateFlush(["upload_failed", "CADENCE_SKIP"]);
  record(
    "sim-transient-does-not-stop",
    !transient.stopped ? "PASS" : "FAIL",
    "network/5xx path does not trigger terminal stop"
  );
}

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;
const blockedCount = results.filter((r) => r.status === "BLOCKED").length;

console.log(
  `\nStage 5 android service lifecycle: ${passCount} PASS / ${failCount} FAIL / ${blockedCount} BLOCKED`
);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 5,
      scope: "android-service-lifecycle",
      generatedAt: new Date().toISOString(),
      summary: { pass: passCount, fail: failCount, blocked: blockedCount },
      results,
    },
    null,
    2
  )
);
console.log(`Wrote ${OUT}\n`);

if (failCount > 0) process.exit(1);
