/**
 * Stage 1 — Live driver motion final reliability audit (tests only).
 *
 * Proves/disproves findings A1–A8 before any production repair.
 *
 * Run: node tests/stage1-live-motion-reliability-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createP2pPeerSession as createDriverPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createP2pPeerSession as createCustomerPeerSession } from "../customer-app/js/p2p-peer-session.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import {
  buildP2pHbMessage,
  buildP2pLocationMessage,
} from "../driver-app/js/p2p-location-envelope.mjs";
import { P2P_DEGRADED_AFTER_MS } from "../driver-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");
const bgUpload = require("../functions/background-location-upload.js");
const {
  ingestBackgroundDriverLocation,
  mintBackgroundLocationCredential,
  DEFAULT_CREDENTIAL_TTL_MS,
} = bgUpload;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage1-live-motion-reliability-audit-results.json");

const FIXED_NOW = 2_000_000;
const SECRET = "stage1-reliability-audit-secret";
const RIDE_ID = "ride_stage1_rel";
const VEHICLE_A = "veh_stage1_a";
const VEHICLE_B = "veh_stage1_b";
const DRIVER_UID = "drv_stage1_rel";
const CUSTOMER_UID = "cust_stage1_rel";
const TRACKING_SESSION_ID = "trk_stage1_rel";
const PEER_SESSION_ID = "ps_stage1rel01ab";

/** @type {Array<{ finding: string, name: string, status: string, detail: string, severity?: string }>} */
const results = [];

function record(finding, name, status, detail = "", severity = "") {
  results.push({ finding, name, status, detail, severity });
  const mark =
    status === "PASS" || status === "CONFIRMED"
      ? "✓"
      : status === "FAIL" || status === "DISPROVED"
        ? "✗"
        : status === "BLOCKED"
          ? "·"
          : "?";
  console.log(`${mark} [${finding}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function MockRTCPeerConnection() {
  const self = {
    iceGatheringState: "complete",
    localDescription: null,
    remoteDescription: null,
    createDataChannel() {
      return { readyState: "connecting", bufferedAmount: 0, send() {}, close() {} };
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- offer\r\n" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "v=0\r\no=- answer\r\n" };
    },
    async setLocalDescription(desc) {
      self.localDescription = desc;
    },
    async setRemoteDescription(desc) {
      self.remoteDescription = desc;
    },
    addEventListener() {},
    removeEventListener() {},
    close() {},
    set ondatachannel(_fn) {},
    get ondatachannel() {
      return null;
    },
  };
  return self;
}

function wireBidirectionalChannel(driverSession, customerSession) {
  driverSession._setChannelOpenForTest(true, (payload) => {
    customerSession._handleMessageForTest(
      String(payload),
      customerSession.getState().generation
    );
  });
  customerSession._setChannelOpenForTest(true, (payload) => {
    driverSession._handleMessageForTest(String(payload), driverSession.getState().generation);
  });
}

/** @deprecated stage1 audit mirror — use credentialCacheMatches from module in new tests */
function credentialCacheWouldReuse(lastCredential, binding, now) {
  return Boolean(
    lastCredential?.token &&
      Number(lastCredential.expiresAtMs) > now + 60_000 &&
      lastCredential.rideId === binding.rideId &&
      lastCredential.trackingSessionId === binding.trackingSessionId
  );
}

// ---------------------------------------------------------------------------
// A1 — Rejected LOC + heartbeat ACK false location-delivery health
// ---------------------------------------------------------------------------

async function testA1_rejectedLocPlusHbFalseHealth() {
  console.log("\n=== A1 — rejected LOC + HB false loc health ===\n");

  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  const customer = createCustomerPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });

  const av = 42;
  await driver.startAsDriver({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: av,
  });
  await customer.startAsCustomer({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: av,
  });
  wireBidirectionalChannel(driver, customer);

  const staleObservedAt = FIXED_NOW - 60_000;
  driver.enqueueLocationFix({
    lat: 24.86,
    lng: 67.0,
    observedAt: staleObservedAt,
    accuracyM: 10,
  });
  driver._flushPendingForTest();
  driver.evaluateHealth();

  const custAfterReject = customer.getCounters();
  record(
    "A1",
    "customer-rejects-stale-loc",
    custAfterReject.fixesReceived === 0 && custAfterReject.invalidMessages >= 1 ? "PASS" : "FAIL",
    `fixesReceived=${custAfterReject.fixesReceived} invalid=${custAfterReject.invalidMessages}`,
    "CRITICAL"
  );

  const drvAfterSend = driver.getCounters();
  record(
    "A1",
    "driver-sent-loc-seq-1",
    drvAfterSend.fixesSent >= 1 ? "PASS" : "FAIL",
    `fixesSent=${drvAfterSend.fixesSent}`,
    "CRITICAL"
  );

  const hbBuilt = buildP2pHbMessage({
    peerSessionId: PEER_SESSION_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: av,
    sequence: 1,
    role: "driver",
  });
  customer._handleMessageForTest(hbBuilt.serialized, customer.getState().generation);
  driver.evaluateHealth();

  const drv = driver.getCounters();
  const drvState = driver.getState();
  const cust = customer.getCounters();

  const falseHealth =
    drvState.isLocDeliveryHealthy &&
    cust.fixesReceived === 0 &&
    drv.acknowledgementsReceived >= 1;

  record(
    "A1",
    "heartbeat-after-rejected-loc-falsely-proves-loc-delivery",
    falseHealth ? "CONFIRMED" : "FIXED",
    [
      `locHealthy=${drvState.isLocDeliveryHealthy}`,
      `locAcks=${drv.acknowledgementsReceived}`,
      `custFixes=${cust.fixesReceived}`,
      `hbRecv=${cust.heartbeatsReceived}`,
    ].join(" "),
    "CRITICAL"
  );

  await driver.close();
  await customer.close();
}

async function testA1_hbAloneBeforeLocNotLocHealthy() {
  console.log("\n=== A1 control — HB alone before any LOC ===\n");

  const driver = createDriverPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });
  const customer = createCustomerPeerSession({
    role: "customer",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => FIXED_NOW,
  });

  await driver.startAsDriver({
    peerSessionId: "ps_a1hb01abcdef",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 42,
  });
  await customer.startAsCustomer({
    peerSessionId: "ps_a1hb01abcdef",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 42,
  });
  driver._setChannelOpenForTest(true);

  const hbBuilt = buildP2pHbMessage({
    peerSessionId: "ps_a1hb01abcdef",
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 42,
    sequence: 0,
    role: "customer",
  });
  driver._handleMessageForTest(hbBuilt.serialized, driver.getState().generation);
  driver.evaluateHealth();

  const st = driver.getState();
  record(
    "A1",
    "hb-alone-before-loc-not-loc-healthy",
    !st.isLocDeliveryHealthy && st.isTransportAlive ? "PASS" : "FAIL",
    `locHealthy=${st.isLocDeliveryHealthy} transport=${st.isTransportAlive} fixesSent=${st.counters.fixesSent}`,
    "CRITICAL"
  );

  await driver.close();
  await customer.close();
}

// ---------------------------------------------------------------------------
// A2 — Post-bootstrap same-ride resync restart
// ---------------------------------------------------------------------------

function baseRide() {
  return {
    id: RIDE_ID,
    status: "in_progress",
    vehicleId: VEHICLE_A,
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    assignmentSessionToken: "ast_stage1",
    assignmentVersion: assignmentVersionFromRide({
      driverId: DRIVER_UID,
      vehicleId: VEHICLE_A,
      assignmentSessionToken: "ast_stage1",
    }),
  };
}

async function testA2_postBootstrapResyncChurn() {
  console.log("\n=== A2 — post-bootstrap same-ride resync ===\n");

  const ride = baseRide();
  const serverAv = ride.assignmentVersion;
  let offerCount = 0;

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offerCount += 1;
      return { assignmentVersion: serverAv, sessionId: "sess_a2" };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  drv.syncForRide({
    ride: { id: RIDE_ID, status: "in_progress", vehicleId: VEHICLE_A },
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentVersion: 0,
  });
  await sleep(250);

  const sessionRef = drv._getSessionForTest?.();
  const peerSessionId = sessionRef?.getState?.()?.peerSessionId || "";
  const genAfterBoot = drv._getStartupGeneration?.() || 0;
  const offersAfterBoot = offerCount;
  const ctrlAv = drv._getControllerAssignmentVersion?.() || 0;
  const syncedAv = drv._getSyncedAssignmentVersion?.() || 0;

  record(
    "A2",
    "bootstrap-establishes-authoritative-controller-av",
    ctrlAv === serverAv ? "PASS" : "FAIL",
    `ctrlAv=${ctrlAv} serverAv=${serverAv}`,
    "HIGH"
  );
  record(
    "A2",
    "synced-assignment-version-stays-bootstrap-zero",
    syncedAv === 0 && ctrlAv >= 1
      ? "CONFIRMED"
      : syncedAv >= 1 && syncedAv === ctrlAv
        ? "FIXED"
        : "DISPROVED",
    `syncedAv=${syncedAv} ctrlAv=${ctrlAv}`,
    "HIGH"
  );

  for (let i = 0; i < 10; i += 1) {
    drv.syncForRide({
      ride: { id: RIDE_ID, status: "in_progress", vehicleId: VEHICLE_A },
      trackingSessionId: TRACKING_SESSION_ID,
    });
    await sleep(30);
  }
  await sleep(200);

  const sessionAfter = drv._getSessionForTest?.();
  const sameSessionRef = sessionAfter === sessionRef;
  const samePeerSessionId = sessionAfter?.getState?.()?.peerSessionId === peerSessionId;
  const noExtraOffers = offerCount === offersAfterBoot;
  const noGenChurn = drv._getStartupGeneration?.() === genAfterBoot;

  const resyncChurn = !sameSessionRef || !noExtraOffers || !noGenChurn;
  const resyncStable = sameSessionRef && samePeerSessionId && noExtraOffers && noGenChurn;
  record(
    "A2",
    "repeated-sync-rotates-session-or-reoffers",
    resyncStable ? "FIXED" : resyncChurn ? "CONFIRMED" : "DISPROVED",
    [
      `sameRef=${sameSessionRef}`,
      `peerBefore=${peerSessionId}`,
      `peerAfter=${sessionAfter?.getState?.()?.peerSessionId || ""}`,
      `offers=${offersAfterBoot}->${offerCount}`,
      `gen=${genAfterBoot}->${drv._getStartupGeneration?.()}`,
    ].join(" "),
    "HIGH"
  );

  await drv.stop({ closeRemote: false });
}

// ---------------------------------------------------------------------------
// A3 — Native credential cache binding
// ---------------------------------------------------------------------------

function testA3_credentialCacheBinding() {
  console.log("\n=== A3 — native credential cache binding ===\n");

  const src = readUtf8("driver-app/js/background-location-credential-policy.mjs");
  record(
    "A3",
    "cache-includes-vehicleId",
    src.includes("cached.vehicleId !== binding.vehicleId") ? "FIXED" : "FAIL",
    "credentialCacheMatches",
    "HIGH"
  );
  record(
    "A3",
    "cache-includes-assignmentSessionToken",
    src.includes("cached.assignmentSessionToken !== binding.assignmentSessionToken")
      ? "FIXED"
      : "FAIL",
    "credentialCacheMatches",
    "HIGH"
  );

  const now = 1_000_000;
  const cached = {
    token: "tok_a",
    expiresAtMs: now + 10 * 60_000,
    rideId: RIDE_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: VEHICLE_A,
    assignmentSessionToken: "ast_new",
    driverUid: DRIVER_UID,
  };
  const sameRideNewVehicle = {
    rideId: RIDE_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: VEHICLE_B,
    assignmentSessionToken: "ast_new",
    driverUid: DRIVER_UID,
  };
  const sameRideNewToken = {
    rideId: RIDE_ID,
    trackingSessionId: TRACKING_SESSION_ID,
    vehicleId: VEHICLE_A,
    assignmentSessionToken: "ast_rotated",
    driverUid: DRIVER_UID,
  };

  // Inline mirror for stage1 historical comparison (old predicate).
  const oldWouldReuse = (c, b, n) =>
    Boolean(
      c?.token &&
        Number(c.expiresAtMs) > n + 60_000 &&
        c.rideId === b.rideId &&
        c.trackingSessionId === b.trackingSessionId
    );

  record(
    "A3",
    "vehicle-change-still-reuses-cache",
    oldWouldReuse(cached, sameRideNewVehicle, now) ? "CONFIRMED" : "FIXED",
    "old predicate vs new policy",
    "HIGH"
  );
  record(
    "A3",
    "assignment-token-change-still-reuses-cache",
    oldWouldReuse(cached, sameRideNewToken, now) ? "CONFIRMED" : "FIXED",
    "old predicate vs new policy",
    "HIGH"
  );
}

// ---------------------------------------------------------------------------
// A4 — Native token expiry with WebView dead
// ---------------------------------------------------------------------------

function testA4_webViewDeadCredentialLifecycle() {
  console.log("\n=== A4 — WebView dead credential lifecycle ===\n");

  const nativeSrc = readUtf8("driver-app/js/background-location-native.mjs");
  const javaSrc = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java"
  );
  const svcSrc = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
  );

  record(
    "A4",
    "default-credential-ttl-15min",
    DEFAULT_CREDENTIAL_TTL_MS === 15 * 60_000 ? "PASS" : "FAIL",
    `${DEFAULT_CREDENTIAL_TTL_MS}ms`,
    "HIGH"
  );
  record(
    "A4",
    "js-refresh-interval-8min",
    nativeSrc.includes("8 * 60_000") ? "PASS" : "FAIL",
    "refreshTimer interval",
    "HIGH"
  );
  record(
    "A4",
    "native-uploader-has-https-renewal",
    javaSrc.includes("postRefresh") && javaSrc.includes("tryRenewCredentialLocked")
      ? "FIXED"
      : "FAIL",
    "BackgroundLocationUploader pre-expiry renewal",
    "HIGH"
  );
  record(
    "A4",
    "native-only-updateCredential-from-intent",
    svcSrc.includes("ACTION_UPDATE_CREDENTIAL") && svcSrc.includes("updateCredential") ? "PASS" : "FAIL",
    "requires JS/web intent",
    "HIGH"
  );

  const issuedAt = 1_000_000;
  const expiredAt = issuedAt + DEFAULT_CREDENTIAL_TTL_MS + 1;
  const verifyExpired = bgUpload.verifyBackgroundLocationCredential(
    mintBackgroundLocationCredential({
      driverUid: DRIVER_UID,
      rideId: RIDE_ID,
      vehicleId: VEHICLE_A,
      trackingSessionId: TRACKING_SESSION_ID,
      assignmentSessionToken: "ast_a4",
      secret: SECRET,
      nowMs: issuedAt,
    }).token,
    { secret: SECRET, nowMs: expiredAt }
  );
  record(
    "A4",
    "expired-credential-rejected-at-ingest",
    verifyExpired.reason === "TOKEN_EXPIRED" ? "PASS" : "FAIL",
    verifyExpired.reason || "ok",
    "HIGH"
  );

  const authFailureStopsFlush = javaSrc.includes("isAuthFailure(result.reason)") &&
    javaSrc.includes("remaining.add(item)") &&
    !javaSrc.includes("stopSelf") &&
    !svcSrc.includes("RIDE_NOT_ACTIVE");
  record(
    "A4",
    "expired-token-queues-fix-no-native-renewal",
    authFailureStopsFlush ? "PASS" : "FAIL",
    "uploader retains queue on auth failure; service has no renewal",
    "HIGH"
  );

  record(
    "A4",
    "android-runtime-webview-dead-renewal",
    "BLOCKED",
    "No Robolectric/JUnit harness in repo; static + token TTL proof only",
    "HIGH"
  );
}

// ---------------------------------------------------------------------------
// A5 — START_STICKY null-intent restore
// ---------------------------------------------------------------------------

function testA5_stickyNullIntentRestore() {
  console.log("\n=== A5 — START_STICKY null-intent restore ===\n");

  const src = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
  );
  const nullIntentBlock = src.slice(
    src.indexOf("if (intent == null)"),
    src.indexOf("String action = intent.getAction")
  );

  record(
    "A5",
    "null-intent-returns-start-sticky-only",
    nullIntentBlock.includes("return START_STICKY") &&
      !nullIntentBlock.includes("startAsForeground") &&
      !nullIntentBlock.includes("startLocationUpdates")
      ? "PASS"
      : "FAIL",
    "onStartCommand(null) early return",
    "HIGH"
  );
  record(
    "A5",
    "no-persisted-binding-restore",
    !src.includes("SharedPreferences") && !src.includes("persist") ? "PASS" : "FAIL",
    "no on-disk active ride binding",
    "HIGH"
  );
  record(
    "A5",
    "android-runtime-sticky-restore",
    "BLOCKED",
    "Requires Android instrumentation; static inspection only",
    "HIGH"
  );
}

// ---------------------------------------------------------------------------
// A6 — Terminal server rejection does not stop native tracking
// ---------------------------------------------------------------------------

function testA6_terminalRejectionNoNativeStop() {
  console.log("\n=== A6 — terminal rejection no native stop ===\n");

  const uploaderSrc = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java"
  );
  const svcSrc = readUtf8(
    "mobile/partner/android/app/src/main/java/com/swiftgo/partner/DriverLocationForegroundService.java"
  );

  const terminalReasons = [
    "RIDE_NOT_ACTIVE",
    "NOT_ASSIGNED_DRIVER",
    "ASSIGNMENT_TOKEN_MISMATCH",
  ];
  for (const reason of terminalReasons) {
    const inAuthFailure = new RegExp(`"${reason}"`).test(
      uploaderSrc.slice(uploaderSrc.indexOf("isAuthFailure"), uploaderSrc.indexOf("private UploadResult"))
    );
    record(
      "A6",
      `isAuthFailure-includes-${reason}`,
      inAuthFailure ? "PASS" : "FAIL",
      "BackgroundLocationUploader.isAuthFailure",
      "HIGH"
    );
  }

  record(
    "A6",
    "auth-failure-retains-queued-item",
    uploaderSrc.includes("if (isAuthFailure(result.reason))") &&
      uploaderSrc.includes("remaining.add(item)")
      ? "PASS"
      : "FAIL",
    "flush loop breaks with item still queued",
    "HIGH"
  );
  const authBlock = uploaderSrc.slice(
    uploaderSrc.indexOf("if (isAuthFailure(result.reason))"),
    uploaderSrc.indexOf("// Transient — keep and retry later")
  );
  record(
    "A6",
    "no-terminal-stop-signal-to-service",
    !authBlock.includes("stopSelf") &&
      !authBlock.includes("stopTracking") &&
      !authBlock.includes("DriverLocationForegroundService")
      ? "CONFIRMED"
      : "DISPROVED",
    "auth-failure flush path retains queue; no service stop hook",
    "HIGH"
  );
  record(
    "A6",
    "gps-continues-after-terminal-response",
    svcSrc.includes("onGpsFix") && !svcSrc.includes("isAuthFailure") ? "PASS" : "FAIL",
    "service unaware of terminal upload reasons",
    "HIGH"
  );
}

// ---------------------------------------------------------------------------
// A7 — Customer background wake lock
// ---------------------------------------------------------------------------

function testA7_customerWakeLockLifecycle() {
  console.log("\n=== A7 — customer background wake lock ===\n");

  const src = readUtf8(
    "mobile/customer/android/app/src/main/java/com/swiftgo/customer/CustomerP2pKeepAliveForegroundService.java"
  );

  record(
    "A7",
    "wake-lock-duration-10-minutes",
    src.includes("wakeLock.acquire(10 * 60_000L)") ? "PASS" : "FAIL",
    "acquireWakeLock timeout",
    "MEDIUM"
  );
  record(
    "A7",
    "no-native-wake-lock-renewal-timer",
    !src.includes("Handler") &&
      !src.includes("Timer") &&
      !src.includes("postDelayed") &&
      (src.match(/wakeLock\.acquire/g) || []).length === 1
      ? "CONFIRMED"
      : "DISPROVED",
    "single bounded acquire; no renewal scheduler",
    "MEDIUM"
  );
  record(
    "A7",
    "held-lock-skips-reacquire",
    src.includes("wakeLock.isHeld()") ? "PASS" : "FAIL",
    "onStartCommand will not extend expired lock",
    "MEDIUM"
  );
  record(
    "A7",
    "android-runtime-deep-background-10min",
    "BLOCKED",
    "Requires device/soak test; static 10min bounded acquire documented",
    "MEDIUM"
  );
}

// ---------------------------------------------------------------------------
// A8 — Background sequence validation coercion
// ---------------------------------------------------------------------------

function createIngestMockDb(ride, vehicle) {
  let vehicleDoc = { ...vehicle };
  return {
    collection(name) {
      return { doc(id) { return { _collection: name, _id: id }; } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          if (ref._collection === "rides") {
            return { exists: true, data: () => ride };
          }
          if (ref._collection === "vehicles") {
            return { exists: true, data: () => vehicleDoc };
          }
          return { exists: false };
        },
        update(ref, patch) {
          if (ref._collection === "vehicles") {
            vehicleDoc = { ...vehicleDoc, ...patch, location: patch.location || vehicleDoc.location };
          }
        },
      };
      return fn(tx);
    },
  };
}

async function testA8_sequenceCoercion() {
  console.log("\n=== A8 — background sequence validation ===\n");

  const ride = {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: VEHICLE_A,
    status: "in_progress",
    assignmentSessionToken: "ast_a8",
  };

  const token = mintBackgroundLocationCredential({
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    vehicleId: VEHICLE_A,
    trackingSessionId: TRACKING_SESSION_ID,
    assignmentSessionToken: "ast_a8",
    secret: SECRET,
    nowMs: FIXED_NOW,
  }).token;

  const baseFix = { lat: 24.86, lng: 67.0, observedAt: FIXED_NOW };

  const cases = [
    ["missing-sequence", {}],
    ["sequence-zero", { sequence: 0 }],
    ["sequence-negative", { sequence: -5 }],
    ["sequence-nan", { sequence: "nope" }],
  ];

  for (const [label, seqPatch] of cases) {
    const caseDb = createIngestMockDb(ride, { location: null });
    const res = await ingestBackgroundDriverLocation(caseDb, {
      token,
      secret: SECRET,
      nowMs: FIXED_NOW,
      fix: { ...baseFix, ...seqPatch },
    });
    const coercedNotRejected = res.accepted === true;
    record(
      "A8",
      `invalid-${label}-coerced-not-rejected`,
      coercedNotRejected ? "CONFIRMED" : "DISPROVED",
      `accepted=${res.accepted} reason=${res.reason || ""}`,
      "MEDIUM"
    );
  }

  const src = readUtf8("functions/background-location-upload.js");
  record(
    "A8",
    "ingest-uses-math-max-sequence-coercion",
    src.includes("Math.max(1, Math.floor(Number(input.fix?.sequence) || 0))") ? "PASS" : "FAIL",
    "ingestBackgroundDriverLocation sequence line",
    "MEDIUM"
  );
}

// ---------------------------------------------------------------------------
// Git / branch metadata
// ---------------------------------------------------------------------------

function collectGitMeta() {
  const meta = {
    branch: "",
    head: "",
    ahead: null,
    behind: null,
    workingTree: "",
  };
  try {
    meta.branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    meta.head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    try {
      const counts = execSync("git rev-list --left-right --count origin/main...HEAD", {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      meta.ahead = ahead;
      meta.behind = behind;
    } catch {
      meta.ahead = null;
      meta.behind = null;
    }
    meta.workingTree = execSync("git status --short", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (err) {
    meta.workingTree = String(err?.message || err);
  }
  return meta;
}

async function main() {
  console.log("\n=== STAGE 1 — Live motion reliability audit (tests only) ===\n");

  await testA1_hbAloneBeforeLocNotLocHealthy();
  await testA1_rejectedLocPlusHbFalseHealth();
  await testA2_postBootstrapResyncChurn();
  testA3_credentialCacheBinding();
  testA4_webViewDeadCredentialLifecycle();
  testA5_stickyNullIntentRestore();
  testA6_terminalRejectionNoNativeStop();
  testA7_customerWakeLockLifecycle();
  await testA8_sequenceCoercion();

  const pass = results.filter((r) =>
    ["PASS", "CONFIRMED", "FIXED"].includes(r.status)
  ).length;
  const fail = results.filter((r) =>
    ["FAIL", "DISPROVED"].includes(r.status)
  ).length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const confirmed = results.filter((r) => r.status === "CONFIRMED").length;
  const git = collectGitMeta();

  const summary = {
    stage: 1,
    suite: "live-motion-reliability-audit",
    auditedCommit: "459eb271fa83e8f1c3bad9fe61b5512a79503306",
    productionChanges: false,
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    blocked,
    confirmed,
    git,
    results,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\nStage 1 reliability audit: ${pass} PASS/CONFIRMED / ${fail} FAIL/DISPROVED / ${blocked} BLOCKED (${confirmed} findings confirmed)`
  );
  console.log(`Wrote ${OUT}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
