/**
 * Stage 4 — native credential continuity (cache binding + HTTPS renewal).
 *
 * Run: node tests/stage4-native-credential-continuity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  credentialCacheMatches,
  resolveRefreshUrl,
} from "../driver-app/js/background-location-credential-policy.mjs";

const require = createRequire(import.meta.url);
const bgUpload = require("../functions/background-location-upload.js");
const {
  issueBackgroundLocationCredential,
  refreshBackgroundLocationCredential,
  mintBackgroundLocationCredential,
  verifyBackgroundLocationCredential,
  DEFAULT_CREDENTIAL_TTL_MS,
} = bgUpload;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage4-native-credential-continuity-results.json");

const SECRET = "stage4-native-credential-secret";
const DRIVER_UID = "drv_stage4_cred";
const CUSTOMER_UID = "cust_stage4_cred";
const RIDE_ID = "ride_stage4_cred";
const VEHICLE_A = "veh_stage4_a";
const VEHICLE_B = "veh_stage4_b";
const TRACKING = "trk_stage4_cred01";
const AST_A = "ast_stage4_a";
const AST_B = "ast_stage4_b";
const NOW = 5_000_000;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function baseBinding(over = {}) {
  return {
    rideId: RIDE_ID,
    vehicleId: VEHICLE_A,
    driverUid: DRIVER_UID,
    trackingSessionId: TRACKING,
    assignmentSessionToken: AST_A,
    ...over,
  };
}

function cachedCredential(over = {}) {
  return {
    token: "tok_cached",
    expiresAtMs: NOW + DEFAULT_CREDENTIAL_TTL_MS,
    rideId: RIDE_ID,
    vehicleId: VEHICLE_A,
    trackingSessionId: TRACKING,
    assignmentSessionToken: AST_A,
    driverUid: DRIVER_UID,
    ...over,
  };
}

function createMockDb(ride, vehicle) {
  let rideDoc = { ...ride };
  let vehicleDoc = { ...vehicle };
  return {
    collection(name) {
      return { doc(id) { return { _collection: name, _id: id }; } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          if (ref._collection === "rides") {
            return { exists: true, data: () => rideDoc };
          }
          if (ref._collection === "vehicles") {
            return { exists: true, data: () => vehicleDoc };
          }
          return { exists: false };
        },
        update(ref, patch) {
          if (ref._collection === "vehicles") {
            vehicleDoc = { ...vehicleDoc, ...patch };
          }
        },
      };
      return fn(tx);
    },
    async collection(name) {
      return this.collection(name);
    },
    async get(ref) {
      if (ref._collection === "rides") {
        return { exists: true, data: () => rideDoc };
      }
      if (ref._collection === "vehicles") {
        return { exists: true, data: () => vehicleDoc };
      }
      return { exists: false };
    },
  };
}

// Fix mock db - issue uses .get() not runTransaction
function createIssueMockDb(ride, vehicle) {
  const rideDoc = { ...ride };
  const vehicleDoc = { ...vehicle };
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === "rides") {
                return { exists: true, data: () => rideDoc };
              }
              if (name === "vehicles") {
                return { exists: true, data: () => vehicleDoc };
              }
              return { exists: false };
            },
          };
        },
      };
    },
  };
}

async function simulateEnsureCredential(lastCredential, binding, now, issueFn) {
  if (credentialCacheMatches(lastCredential, binding, now)) {
    return { credential: lastCredential, issued: false };
  }
  const issued = await issueFn(binding);
  const cred = {
    token: issued.token,
    expiresAtMs: issued.expiresAtMs,
    rideId: binding.rideId,
    vehicleId: binding.vehicleId,
    trackingSessionId: binding.trackingSessionId,
    assignmentSessionToken: binding.assignmentSessionToken,
    driverUid: binding.driverUid,
  };
  return { credential: cred, issued: true };
}

function testCacheBinding() {
  console.log("\n=== JS credential cache binding ===\n");
  const binding = baseBinding();
  const cached = cachedCredential();

  record(
    "same-binding-reuses-cache",
    credentialCacheMatches(cached, binding, NOW) ? "PASS" : "FAIL"
  );
  record(
    "vehicle-change-invalidates-cache",
    !credentialCacheMatches(cached, baseBinding({ vehicleId: VEHICLE_B }), NOW)
      ? "PASS"
      : "FAIL"
  );
  record(
    "assignment-token-change-invalidates-cache",
    !credentialCacheMatches(cached, baseBinding({ assignmentSessionToken: AST_B }), NOW)
      ? "PASS"
      : "FAIL"
  );
  record(
    "driver-change-invalidates-cache",
    !credentialCacheMatches(cached, baseBinding({ driverUid: "other_driver" }), NOW)
      ? "PASS"
      : "FAIL"
  );
  record(
    "tracking-session-change-invalidates-cache",
    !credentialCacheMatches(cached, baseBinding({ trackingSessionId: "trk_other" }), NOW)
      ? "PASS"
      : "FAIL"
  );
}

function testResolveRefreshUrl() {
  console.log("\n=== Refresh URL resolution ===\n");
  const upload =
    "https://us-central1-swiftgo-ride-app.cloudfunctions.net/ingestBackgroundDriverLocation";
  const refresh = resolveRefreshUrl(upload);
  record(
    "refresh-url-derived-from-ingest",
    refresh.includes("refreshBackgroundDriverLocationCredential") ? "PASS" : "FAIL",
    refresh
  );
}

async function testSimulatedIssueCounts() {
  console.log("\n=== Simulated ensureCredential issue counts ===\n");
  let issueCount = 0;
  const issueFn = async () => {
    issueCount += 1;
    return mintBackgroundLocationCredential({
      driverUid: DRIVER_UID,
      rideId: RIDE_ID,
      vehicleId: VEHICLE_A,
      trackingSessionId: TRACKING,
      assignmentSessionToken: AST_A,
      secret: SECRET,
      nowMs: NOW,
    });
  };

  let last = null;
  let r = await simulateEnsureCredential(last, baseBinding(), NOW, issueFn);
  last = r.credential;
  r = await simulateEnsureCredential(last, baseBinding(), NOW, issueFn);
  record("same-binding-issues-once", issueCount === 1 && !r.issued ? "PASS" : "FAIL", `issues=${issueCount}`);

  r = await simulateEnsureCredential(last, baseBinding({ vehicleId: VEHICLE_B }), NOW, issueFn);
  last = r.credential;
  record("vehicle-change-issues-again", issueCount === 2 && r.issued ? "PASS" : "FAIL", `issues=${issueCount}`);

  r = await simulateEnsureCredential(last, baseBinding({ vehicleId: VEHICLE_B, assignmentSessionToken: AST_B }), NOW, issueFn);
  record("token-change-issues-again", issueCount === 3 && r.issued ? "PASS" : "FAIL", `issues=${issueCount}`);
}

async function testRefreshCredential() {
  console.log("\n=== Server refresh credential ===\n");
  const activeRide = {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: VEHICLE_A,
    status: "in_progress",
    assignmentSessionToken: AST_A,
  };
  const db = createIssueMockDb(activeRide, { location: null });

  const issued = await issueBackgroundLocationCredential(db, {
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    vehicleId: VEHICLE_A,
    trackingSessionId: TRACKING,
    assignmentSessionToken: AST_A,
    secret: SECRET,
    nowMs: NOW,
  });

  const refreshed = await refreshBackgroundLocationCredential(db, {
    token: issued.token,
    secret: SECRET,
    nowMs: NOW + 60_000,
  });
  record(
    "valid-token-refreshes-successor",
    refreshed.ok && refreshed.token && refreshed.token !== issued.token ? "PASS" : "FAIL",
    `expires=${refreshed.expiresAtMs}`
  );

  const oldVerify = verifyBackgroundLocationCredential(refreshed.token, {
    secret: SECRET,
    nowMs: NOW + 120_000,
  });
  record(
    "refreshed-token-verifies",
    oldVerify.ok && oldVerify.claims?.rideId === RIDE_ID ? "PASS" : "FAIL",
    oldVerify.reason || ""
  );

  const expired = await refreshBackgroundLocationCredential(db, {
    token: issued.token,
    secret: SECRET,
    nowMs: issued.expiresAtMs + 1,
  });
  record(
    "expired-token-cannot-refresh",
    !expired.ok && expired.reason === "TOKEN_EXPIRED" ? "PASS" : "FAIL",
    expired.reason || ""
  );

  const terminalDb = createIssueMockDb(
    { ...activeRide, status: "completed" },
    { location: null }
  );
  const terminalRefresh = await refreshBackgroundLocationCredential(terminalDb, {
    token: issued.token,
    secret: SECRET,
    nowMs: NOW + 60_000,
  });
  record(
    "terminal-ride-refresh-denied",
    !terminalRefresh.ok && terminalRefresh.reason === "RIDE_NOT_ACTIVE" ? "PASS" : "FAIL",
    terminalRefresh.reason || ""
  );

  const wrongDriverDb = createIssueMockDb(
    { ...activeRide, driverId: "other_driver" },
    { location: null }
  );
  const wrongDriverRefresh = await refreshBackgroundLocationCredential(wrongDriverDb, {
    token: issued.token,
    secret: SECRET,
    nowMs: NOW + 60_000,
  });
  record(
    "reassignment-refresh-denied",
    !wrongDriverRefresh.ok && wrongDriverRefresh.reason === "NOT_ASSIGNED_DRIVER"
      ? "PASS"
      : "FAIL",
    wrongDriverRefresh.reason || ""
  );
}

function testNativeRenewalStatic() {
  console.log("\n=== Native renewal static evidence ===\n");
  const uploaderSrc = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java"
  );
  record(
    "native-has-pre-expiry-renew-window",
    uploaderSrc.includes("RENEW_BEFORE_MS") && uploaderSrc.includes("3 * 60_000L") ? "PASS" : "FAIL"
  );
  record(
    "native-postRefresh-https",
    uploaderSrc.includes("postRefresh") && uploaderSrc.includes("refreshUrl") ? "PASS" : "FAIL"
  );
  record(
    "native-renew-before-flush",
    uploaderSrc.includes("tryRenewCredentialLocked") &&
      uploaderSrc.indexOf("tryRenewCredentialLocked") <
        uploaderSrc.indexOf("credential_missing_or_expired")
      ? "PASS"
      : "FAIL"
  );
  record(
    "plugin-passes-refresh-url",
    readUtf8(
      "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationPlugin.java"
    ).includes("EXTRA_REFRESH_URL")
      ? "PASS"
      : "FAIL"
  );
  record(
    "android-runtime-webview-dead-30min-soak",
    "BLOCKED",
    "Requires device soak; static + server refresh tests only"
  );
}

async function main() {
  console.log("\n=== STAGE 4 — native credential continuity ===\n");
  testCacheBinding();
  testResolveRefreshUrl();
  await testSimulatedIssueCounts();
  await testRefreshCredential();
  testNativeRenewalStatic();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const summary = {
    stage: 4,
    suite: "native-credential-continuity",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    blocked,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 4 native credential: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED`);
  console.log(`Wrote ${OUT}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
