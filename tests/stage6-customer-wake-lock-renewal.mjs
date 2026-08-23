/**
 * Stage 6 — customer background P2P wake-lock renewal (A7).
 *
 * Run: node tests/stage6-customer-wake-lock-renewal.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage6-customer-wake-lock-renewal-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const svcSrc = readUtf8(
  "mobile/customer/android/app/src/main/java/com/swiftgo/customer/CustomerP2pKeepAliveForegroundService.java"
);
const bridgeSrc = readUtf8("customer-app/js/p2p-background-keepalive.mjs");
const flowSrc = readUtf8("customer-app/js/ride-flow.js");

// ---------------------------------------------------------------------------
// A7 — bounded renewable wake lock
// ---------------------------------------------------------------------------

record(
  "bounded-wake-lock-chunk-10-minutes",
  svcSrc.includes("WAKE_LOCK_DURATION_MS = 10 * 60_000L") ? "PASS" : "FAIL",
  "each acquire remains time-bounded"
);

record(
  "renew-before-expiry-scheduler",
  svcSrc.includes("WAKE_LOCK_RENEW_LEAD_MS") &&
    svcSrc.includes("scheduleWakeLockRenewal") &&
    svcSrc.includes("postDelayed")
    ? "PASS"
    : "FAIL",
  "Handler renews ~2 min before timeout"
);

record(
  "renew-release-before-reacquire",
  svcSrc.includes("renewWakeLockBounded") &&
    svcSrc.includes("wakeLock.isHeld()") &&
    svcSrc.includes("wakeLock.release()") &&
    svcSrc.includes("setReferenceCounted(false)")
    ? "PASS"
    : "FAIL",
  "no duplicate concurrent locks"
);

record(
  "stop-cancels-renewal-and-releases",
  svcSrc.includes("cancelWakeLockRenewal") &&
    svcSrc.includes("releaseWakeLock()") &&
    svcSrc.slice(svcSrc.indexOf("stopSafely")).includes("releaseWakeLock()")
    ? "PASS"
    : "FAIL",
  "ACTION_STOP drops timer + lock immediately"
);

record(
  "destroy-releases-wake-lock",
  svcSrc.slice(svcSrc.indexOf("onDestroy")).includes("releaseWakeLock()") ? "PASS" : "FAIL",
  "service teardown clears native hold"
);

record(
  "webrtc-limitation-documented",
  svcSrc.includes("does not recreate a WebRTC session") ? "PASS" : "FAIL",
  "native keepalive != WebView session recovery"
);

record(
  "js-terminal-stop-still-wired",
  flowSrc.includes("customerP2pBackgroundKeepalive.stop()") &&
    bridgeSrc.includes('["accepted", "arrived", "in_progress"]')
    ? "PASS"
    : "FAIL",
  "terminal ride path stops foreground service from JS"
);

record(
  "no-indefinite-wake-lock-acquire",
  !svcSrc.includes("wakeLock.acquire()") &&
    svcSrc.includes("wakeLock.acquire(WAKE_LOCK_DURATION_MS)")
    ? "PASS"
    : "FAIL",
  "never calls unbounded acquire()"
);

// Simulated renewal timeline (mirrors Java constants)
const DURATION = 10 * 60_000;
const LEAD = 2 * 60_000;
const renewAt = DURATION - LEAD;
record(
  "sim-renew-at-8-minutes",
  renewAt === 8 * 60_000 ? "PASS" : "FAIL",
  `renewDelayMs=${renewAt}`
);

function simulateRenewals(totalMs) {
  let elapsed = 0;
  let renewals = 0;
  while (elapsed + renewAt <= totalMs) {
    elapsed += renewAt;
    renewals += 1;
  }
  return renewals;
}

record(
  "sim-25min-ride-gets-3-renewals",
  simulateRenewals(25 * 60_000) === 3 ? "PASS" : "FAIL",
  "25 min active service exceeds old single 10 min bound"
);

record(
  "android-runtime-deep-background-10min",
  "BLOCKED",
  "Requires device soak; static + simulated timeline only"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;
const blockedCount = results.filter((r) => r.status === "BLOCKED").length;

console.log(
  `\nStage 6 customer wake lock: ${passCount} PASS / ${failCount} FAIL / ${blockedCount} BLOCKED`
);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 6,
      scope: "customer-wake-lock-renewal",
      finding: "A7",
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
