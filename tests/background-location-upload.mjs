/**
 * Background driver location — credential, cadence, ingest authorization.
 * Run: node tests/background-location-upload.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "background-location-upload-results.json");

const {
  mintBackgroundLocationCredential,
  verifyBackgroundLocationCredential,
  resolveBackgroundUploadIntervalMs,
  shouldAllowCadenceWrite,
  resolveViewerLeaseFromPresence,
  RESPONSIVE_INTERVAL_MS,
  BACKGROUND_TRIP_INTERVAL_MS,
  BACKGROUND_APPROACH_INTERVAL_MS,
} = require(path.join(ROOT, "functions", "background-location-upload.js"));

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

const SECRET = "unit-test-bg-location-secret-v1";

function baseClaims(over = {}) {
  return {
    driverUid: "drv_1",
    rideId: "ride_1",
    vehicleId: "veh_1",
    trackingSessionId: "s_abc123_xyz",
    assignmentSessionToken: "ast_token_1",
    secret: SECRET,
    nowMs: 1_700_000_000_000,
    ...over,
  };
}

{
  const minted = mintBackgroundLocationCredential(baseClaims());
  record(
    "mint-ok",
    minted.ok && minted.token && minted.expiresAtMs > 1_700_000_000_000 ? "PASS" : "FAIL",
    minted.ok ? `ttl=${minted.ttlMs}` : minted.reason
  );
  const verified = verifyBackgroundLocationCredential(minted.token, {
    secret: SECRET,
    nowMs: 1_700_000_000_000 + 60_000,
  });
  record(
    "verify-ok",
    verified.ok && verified.claims?.rideId === "ride_1" ? "PASS" : "FAIL",
    verified.ok ? "" : verified.reason
  );
}

{
  const minted = mintBackgroundLocationCredential(baseClaims());
  const bad = minted.token.replace(/\.[^.]+$/, ".AAAA");
  const verified = verifyBackgroundLocationCredential(bad, {
    secret: SECRET,
    nowMs: 1_700_000_000_000,
  });
  record("verify-rejects-tamper", !verified.ok && verified.reason === "INVALID_SIGNATURE" ? "PASS" : "FAIL", verified.reason);
}

{
  const minted = mintBackgroundLocationCredential(baseClaims({ ttlMs: 5 * 60_000 }));
  const verified = verifyBackgroundLocationCredential(minted.token, {
    secret: SECRET,
    nowMs: minted.expiresAtMs + 1,
  });
  record("verify-rejects-expired", !verified.ok && verified.reason === "TOKEN_EXPIRED" ? "PASS" : "FAIL", verified.reason);
}

{
  const minted = mintBackgroundLocationCredential(baseClaims({ secret: null }));
  record(
    "mint-requires-secret",
    !minted.ok && minted.reason === "SECRET_NOT_CONFIGURED" ? "PASS" : "FAIL",
    minted.reason
  );
}

{
  const visibleTrip = resolveBackgroundUploadIntervalMs({
    rideStatus: "in_progress",
    viewerLease: "VISIBLE",
  });
  record(
    "cadence-visible-responsive",
    visibleTrip.intervalMs === RESPONSIVE_INTERVAL_MS && visibleTrip.policy === "RESPONSIVE_FIREBASE"
      ? "PASS"
      : "FAIL",
    `${visibleTrip.policy}:${visibleTrip.intervalMs}`
  );

  const hiddenTrip = resolveBackgroundUploadIntervalMs({
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
  });
  record(
    "cadence-hidden-trip-30s",
    hiddenTrip.intervalMs === BACKGROUND_TRIP_INTERVAL_MS ? "PASS" : "FAIL",
    `${hiddenTrip.policy}:${hiddenTrip.intervalMs}`
  );

  const hiddenApproach = resolveBackgroundUploadIntervalMs({
    rideStatus: "accepted",
    viewerLease: "UNKNOWN",
  });
  record(
    "cadence-unknown-approach-60s",
    hiddenApproach.intervalMs === BACKGROUND_APPROACH_INTERVAL_MS ? "PASS" : "FAIL",
    `${hiddenApproach.policy}:${hiddenApproach.intervalMs}`
  );
}

{
  const skip = shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 8_000,
    intervalMs: 4_000,
    hardInterval: false,
    movedEnough: false,
  });
  record("write-gate-skip-interval", !skip.allow ? "PASS" : "FAIL", skip.reason);

  const hardSkip = shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 0,
    intervalMs: 30_000,
    hardInterval: true,
  });
  record("write-gate-first", hardSkip.allow ? "PASS" : "FAIL", hardSkip.reason);

  const hardWait = shouldAllowCadenceWrite({
    nowMs: 10_000,
    lastWriteMs: 5_000,
    intervalMs: 30_000,
    hardInterval: true,
  });
  record("write-gate-hard-wait", !hardWait.allow ? "PASS" : "FAIL", hardWait.reason);
}

{
  const lease = resolveViewerLeaseFromPresence(
    { expiresAt: { toMillis: () => 1_700_000_090_000 } },
    1_700_000_000_000
  );
  record("presence-visible", lease === "VISIBLE" ? "PASS" : "FAIL", lease);
  const expired = resolveViewerLeaseFromPresence(
    { expiresAt: { toMillis: () => 1_700_000_000_000 } },
    1_700_000_000_001
  );
  record("presence-expired", expired === "EXPIRED" ? "PASS" : "FAIL", expired);
}

// Static integration markers
{
  const indexJs = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
  record(
    "exports-issue-credential",
    indexJs.includes("exports.issueBackgroundLocationCredential") ? "PASS" : "FAIL"
  );
  record(
    "exports-ingest-https",
    indexJs.includes("exports.ingestBackgroundDriverLocation") && indexJs.includes("onRequest")
      ? "PASS"
      : "FAIL"
  );

  const driverApp = fs.readFileSync(path.join(ROOT, "driver-app", "js", "driver-app.js"), "utf8");
  record(
    "driver-wires-native-bridge",
    driverApp.includes("background-location-native") &&
      driverApp.includes("syncBackgroundLocationNativeForActiveRide")
      ? "PASS"
      : "FAIL"
  );

  const bridge = fs.readFileSync(
    path.join(ROOT, "driver-app", "js", "background-location-native.mjs"),
    "utf8"
  );
  record(
    "bridge-p2p-first-comment",
    bridge.includes("P2P") || bridge.includes("native foreground") ? "PASS" : "FAIL"
  );

  const service = fs.readFileSync(
    path.join(
      ROOT,
      "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
    ),
    "utf8"
  );
  record(
    "android-service-sticky-task-removed",
    service.includes("START_STICKY") && service.includes("onTaskRemoved") ? "PASS" : "FAIL"
  );
  record(
    "android-webview-alive-gate",
    service.includes("WEB_ALIVE_TIMEOUT_MS") && service.includes("enqueueFix") ? "PASS" : "FAIL"
  );

  const manifest = fs.readFileSync(
    path.join(ROOT, "mobile/partner/android/app/src/main/AndroidManifest.xml"),
    "utf8"
  );
  record(
    "manifest-fg-location-service",
    manifest.includes("DriverLocationForegroundService") &&
      manifest.includes('foregroundServiceType="location"')
      ? "PASS"
      : "FAIL"
  );

  const main = fs.readFileSync(
    path.join(ROOT, "mobile/partner/android/app/src/main/java/com/swiftgo/partner/MainActivity.java"),
    "utf8"
  );
  record(
    "mainactivity-registers-plugin",
    main.includes("DriverLocationPlugin") ? "PASS" : "FAIL"
  );

  const uploaderSrc = fs.readFileSync(
    path.join(
      ROOT,
      "mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java"
    ),
    "utf8"
  );
  record(
    "uploader-network-reconnect-flush",
    uploaderSrc.includes("registerDefaultNetworkCallback") &&
      uploaderSrc.includes("QUEUE_RETRY_INTERVAL_MS")
      ? "PASS"
      : "FAIL"
  );
}

{
  const { mapDriverRuntimeCounters } = await import(
    "../shared/js/ride-location-report-client.mjs"
  );
  const mapped = mapDriverRuntimeCounters(
    { rawGpsFixes: 2, writesAttempted: 2, writesCommitted: 2 },
    {},
    { fixCount: 5, uploaded: 3, rejected: 1, queued: 2 }
  );
  record(
    "driver-native-diagnostics-merge",
    mapped.gpsFixesReceived === 7 &&
      mapped.vehicleWritesAcknowledged === 5 &&
      mapped.vehicleWritesAttempted === 6
      ? "PASS"
      : "FAIL",
    `gps=${mapped.gpsFixesReceived} ack=${mapped.vehicleWritesAcknowledged}`
  );
}

const failed = results.filter((r) => r.status === "FAIL");
const payload = {
  suite: "background-location-upload",
  generatedAt: new Date().toISOString(),
  pass: results.filter((r) => r.status === "PASS").length,
  fail: failed.length,
  results,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`\nBackground location: ${payload.pass} PASS / ${payload.fail} FAIL`);
if (failed.length) process.exitCode = 1;
