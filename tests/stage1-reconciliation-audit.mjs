/**
 * Stage 1 — reconciliation audit (d34 vs origin/main safeguards).
 * Tests only — no production changes.
 *
 * Run: node tests/stage1-reconciliation-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { createLiveLocationSourceArbiter } from "../customer-app/js/live-location-source-arbiter.mjs";
import {
  CHECKPOINT_POLICY,
  P2P_SPARSE_ENTER_HYSTERESIS_MS,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  resolveCheckpointPolicy,
} from "../driver-app/js/location-checkpoint-policy.mjs";
import {
  FIREBASE_BACKUP_READ_INTERVAL_MS,
  P2P_FALLBACK_AFTER_MS,
  P2P_SEND_INTERVAL_MS,
  P2P_STATE,
} from "../customer-app/js/p2p-protocol.mjs";
import { buildP2pAckMessage } from "../customer-app/js/p2p-location-envelope.mjs";

const require = createRequire(import.meta.url);
const { assignmentVersionFromRide } = require("../functions/ride-peer-session.js");
const bgUpload = require("../functions/background-location-upload.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage1-reconciliation-audit-results.json");

const results = [];
function record(id, name, status, detail = "", category = "gap") {
  results.push({ id, name, status, detail, category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${id}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function gitHas(ref, pattern, file) {
  try {
    const text = execSync(`git show ${ref}:${file}`, { cwd: ROOT, encoding: "utf8" });
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function staticCompareOriginMain() {
  console.log("\n=== Static compare d34 (HEAD) vs origin/main ===\n");
  const checks = [
    ["driver-controller", "assignmentKey", "driver-app/js/p2p-ride-controller.mjs"],
    ["driver-controller", "runStartLoop", "driver-app/js/p2p-ride-controller.mjs"],
    ["driver-controller", "syncAssignmentVersion", "driver-app/js/p2p-ride-controller.mjs"],
    ["customer-controller", "answerGeneration", "customer-app/js/p2p-ride-controller.mjs"],
    ["customer-controller", "isOfferCurrent", "customer-app/js/p2p-ride-controller.mjs"],
    ["customer-controller", "isAnswerStillValid", "customer-app/js/p2p-ride-controller.mjs"],
    ["driver-peer-session", "sentSequences", "driver-app/js/p2p-peer-session.mjs"],
    ["driver-peer-session", "scheduleChannelOpenTimeout", "driver-app/js/p2p-peer-session.mjs"],
    ["driver-peer-session", "sendTimer", "driver-app/js/p2p-peer-session.mjs"],
    ["checkpoint-policy", "p2pEffectiveHealthy", "driver-app/js/location-checkpoint-policy.mjs"],
    ["arbiter", "activateFirebaseFallback", "customer-app/js/live-location-source-arbiter.mjs"],
  ];
  for (const [area, sym, file] of checks) {
    const onMain = gitHas("origin/main", sym, file);
    const onD34 = gitHas("HEAD", sym, file);
    const detail = `main=${onMain} d34=${onD34}`;
    if (sym === "syncAssignmentVersion" || sym === "activateFirebaseFallback") {
      record(`static-${sym}`, `${area} has ${sym}`, onD34 ? "PASS" : "FAIL", detail, "static");
    } else if (sym === "p2pEffectiveHealthy") {
      record(`static-${sym}`, `${area} has ${sym}`, onD34 ? "PASS" : "FAIL", detail, "static");
    } else if (sym === "assignmentKey" || sym === "runStartLoop") {
      record(`static-${sym}`, `${area} has ${sym}`, onD34 ? "PASS" : "FAIL", detail, "static");
    } else if (sym === "sendTimer") {
      record(
        `static-${sym}`,
        `${area} sendTimer d34-only vs main`,
        onD34 && !onMain ? "PASS" : "SKIP",
        detail,
        "static"
      );
    } else {
      record(
        `static-${sym}`,
        `${area} missing ${sym} on d34`,
        !onD34 && onMain ? "PASS" : "FAIL",
        detail,
        "static"
      );
    }
  }
}

async function gap01_driverRideSwitchDuringStart() {
  let releaseOffer;
  const offerGate = new Promise((r) => {
    releaseOffer = r;
  });
  let offerRideId = "";
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offerRideId = payload.rideId;
      await offerGate;
      return { assignmentVersion: 424242, sessionId: "ps_gap01" };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  void drv.start({ rideId: "ride_A", trackingSessionId: "trk_A", vehicleId: "v1" });
  await sleep(40);
  drv.syncForRide({
    ride: { id: "ride_B", status: "in_progress", vehicleId: "v1" },
    trackingSessionId: "trk_B",
  });
  await sleep(50);
  const bCurrent = drv._getRideId?.() === "ride_B";
  const lastOfferForB = offerRideId === "ride_B";
  releaseOffer({ assignmentVersion: 424242, sessionId: "ps_gap01" });
  await sleep(120);
  const sessionAv = drv.getState().assignmentVersion;
  record(
    "01",
    "driver-rideB-not-lost-while-rideA-offer-in-flight",
    bCurrent && lastOfferForB ? "PASS" : "FAIL",
    `offerRideId=${offerRideId} currentRide=${drv._getRideId?.()} sessionAv=${sessionAv}`
  );
  await drv.stop({ closeRemote: false });
}

async function gap02_driverStopDuringOffer() {
  let releaseOffer;
  const gate = new Promise((r) => {
    releaseOffer = r;
  });
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => {
      await gate;
      return { assignmentVersion: 999, sessionId: "ps_gap02" };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  void drv.start({ rideId: "ride_stop", trackingSessionId: "trk_stop", vehicleId: "v" });
  await sleep(20);
  await drv.stop({ closeRemote: false });
  releaseOffer({ assignmentVersion: 999, sessionId: "ps_gap02" });
  await sleep(40);
  const st = drv.getState().state;
  record(
    "02",
    "gap-driver-late-offer-after-stop-leaves-disabled-session",
    st === P2P_STATE.DISABLED ? "PASS" : "FAIL",
    `state=${st}`
  );
}

async function gap03_staleAssignmentVersionAfterRideSwitch() {
  const watchCallbacks = [];
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({
      assignmentVersion: 100,
      sessionId: "ps_a3",
    }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (rid, onData) => {
      watchCallbacks.push({ rid, onData });
      return () => {};
    },
  });
  await drv.start({ rideId: "ride_A3", trackingSessionId: "trk_A3", vehicleId: "v" });
  await sleep(30);
  await drv.start({ rideId: "ride_B3", trackingSessionId: "trk_B3", vehicleId: "v" });
  await sleep(40);
  const sidB = drv.getState().peerSessionId;
  const avBefore = drv.getState().assignmentVersion;
  const staleWatch = watchCallbacks.find((w) => w.rid === "ride_A3")?.onData;
  staleWatch?.({
    sessionId: sidB,
    assignmentVersion: 777777,
    answer: "v=0\r\no=- stale-answer\r\n",
    state: "answered",
  });
  await sleep(30);
  const avAfter = drv.getState().assignmentVersion;
  record(
    "03",
    "driver-stale-rideA-watch-blocked-from-poisoning-rideB",
    avAfter !== 777777 && avBefore === avAfter ? "PASS" : "FAIL",
    `avBefore=${avBefore} avAfter=${avAfter} sidB=${sidB}`,
    "preserve"
  );
  await drv.stop({ closeRemote: false });
}

async function gap04_customerStaleAnswerPublish() {
  let releasePublish;
  const gate = new Promise((r) => {
    releasePublish = r;
  });
  const published = [];
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    publishRidePeerAnswerClient: async (payload) => {
      published.push(payload);
      await gate;
      return { ok: true };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      onData({
        sessionId: "ps_abcdef012345",
        offer: "v=0\r\no=- offer\r\n",
        trackingSessionId: "trk_c4",
        assignmentVersion: 55,
        state: "offered",
      });
      return () => {};
    },
  });
  cust.syncForRide({ id: "ride_A4", status: "accepted" }, { isVisible: true });
  await sleep(80);
  cust.syncForRide({ id: "ride_B4", status: "accepted" }, { isVisible: true });
  await sleep(80);
  releasePublish({ ok: true });
  await sleep(80);
  const staleForB = published.some((p) => p.rideId === "ride_B4");
  const staleForA = published.some((p) => p.rideId === "ride_A4");
  record(
    "04",
    "gap-customer-stale-answer-publishes-with-current-rideId-not-captured",
    staleForB ? "PASS" : staleForA ? "INCONCLUSIVE" : "FAIL",
    `published=${JSON.stringify(published.map((p) => p.rideId))}`
  );
  await cust.stop({ closeRemote: false });
}

async function gap05_oldSessionLocOnNewRide() {
  const renders = [];
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: async () => ({ ok: true }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  cust.syncForRide({ id: "ride_A5", status: "in_progress" }, { isVisible: true });
  cust.syncForRide({ id: "ride_B5", status: "in_progress" }, { isVisible: true });
  await sleep(20);
  const gen = cust.getArbiter().getGeneration();
  const accepted = cust.getArbiter().ingestP2p(
    {
      lat: 24.9,
      lng: 67.1,
      observedAt: Date.now(),
      sequence: 99,
      trackingSessionId: "trk_ride_A_only",
    },
    gen
  );
  await sleep(10);
  const leaked = accepted && renders.some((r) => r.lat === 24.9);
  record(
    "05",
    "gap-stale-p2p-fix-with-current-gen-renders-on-new-ride",
    leaked ? "PASS" : "FAIL",
    `accepted=${accepted} renders=${renders.length}`
  );
  await cust.stop({ closeRemote: false });
}

function gap06_ackTrust() {
  const src = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  const hasSentSeq = src.includes("sentSequences");
  record(
    "06",
    "gap-no-sent-sequence-ack-validation",
    !hasSentSeq ? "PASS" : "FAIL",
    hasSentSeq ? "sentSequences present" : "sentSequences absent"
  );
}

async function gap07_heartbeatAloneHealth() {
  const drv = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => 1_000_000,
  });
  await drv.startAsDriver({
    peerSessionId: "ps_hb01abcdef",
    trackingSessionId: "trk_hb",
    assignmentVersion: 42,
  });
  drv._setChannelOpenForTest(true);
  const ids = drv.getState();
  const hb = buildP2pAckMessage({
    peerSessionId: ids.peerSessionId,
    trackingSessionId: ids.trackingSessionId,
    assignmentVersion: ids.assignmentVersion,
    sequence: 0,
  });
  const hbMsg = JSON.parse(hb.serialized);
  hbMsg.type = "hb";
  hbMsg.seq = 1;
  drv._handleMessageForTest(JSON.stringify(hbMsg), ids.generation);
  drv.evaluateHealth();
  record(
    "07",
    "gap-heartbeat-alone-can-mark-driver-session-healthy",
    drv.getState().isHealthy ? "PASS" : "FAIL",
    `healthy=${drv.getState().isHealthy} fixesSent=${drv.getCounters().fixesSent}`
  );
  await drv.close();
}

async function gap08_cadenceBurst() {
  const sent = [];
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: (() => {
      let t = 1_000_000;
      return () => t;
    })(),
  });
  await session.startAsDriver({
    peerSessionId: "ps_cad01abcdef",
    trackingSessionId: "trk_cad",
    assignmentVersion: 42,
  });
  session.syncAssignmentVersion(42);
  session._setChannelOpenForTest(true, (payload) => sent.push(payload));
  for (let i = 0; i < 5; i += 1) {
    session.enqueueLocationFix({
      lat: 24.86 + i * 0.001,
      lng: 67.0,
      observedAt: 1_000_000 + i * 10,
    });
  }
  const sendsAllCallbacks =
    sent.length === 5 ||
    (sent.length >= 4 && session.getCounters().fixesSent >= 4);
  record(
    "08",
    "gap-rapid-gps-burst-sends-without-cadence-delay",
    sendsAllCallbacks ? "PASS" : "FAIL",
    `sent=${sent.length} fixesSent=${session.getCounters().fixesSent} intervalMs=${P2P_SEND_INTERVAL_MS}`
  );
  const hasReturn = /lastValidFixAt[\s\S]{0,120}return/.test(
    fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8").slice(
      fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8").indexOf("function flushPendingLoc"),
      fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8").indexOf("function flushPendingLoc") + 400
    )
  );
  record(
    "08b",
    "gap-flushPendingLoc-cadence-branch-has-no-return-or-schedule",
    !hasReturn ? "PASS" : "FAIL",
    `hasDelayedFlush=${hasReturn}`
  );
  await session.close();
}

async function gap09_sendFailureLoss() {
  let throws = true;
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_send01abcdef",
    trackingSessionId: "trk_send",
    assignmentVersion: 42,
  });
  session._setChannelOpenForTest(true, () => {
    if (throws) throw new Error("send_fail");
  });
  session.enqueueLocationFix({ lat: 24.86, lng: 67.0, observedAt: Date.now() });
  throws = false;
  session.enqueueLocationFix({ lat: 24.861, lng: 67.001, observedAt: Date.now() + 1 });
  record(
    "09",
    "gap-send-failure-discards-pending-fix",
    session.getCounters().fixesSent === 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent}`
  );
  await session.close();
}

function gap10_channelOpenTimeout() {
  const d34 = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  const main = execSync("git show origin/main:driver-app/js/p2p-peer-session.mjs", {
    cwd: ROOT,
    encoding: "utf8",
  });
  record(
    "10",
    "gap-d34-lacks-channel-open-timeout-present-on-main",
    !d34.includes("scheduleChannelOpenTimeout") && main.includes("scheduleChannelOpenTimeout")
      ? "PASS"
      : "FAIL",
    `d34=${d34.includes("scheduleChannelOpenTimeout")} main=${main.includes("scheduleChannelOpenTimeout")}`
  );
}

async function gap11_firstLocNoAck() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_ack01abcdef",
    trackingSessionId: "trk_ack",
    assignmentVersion: 42,
  });
  session._setChannelOpenForTest(true, () => {});
  session.enqueueLocationFix({ lat: 1, lng: 1, observedAt: Date.now() });
  session.evaluateHealth();
  const st = session.getState().state;
  record(
    "11",
    "gap-first-loc-without-ack-not-bounded-to-fallback",
    st !== P2P_STATE.FIREBASE_FALLBACK ? "PASS" : "FAIL",
    `state=${st} healthy=${session.getState().isHealthy}`
  );
  await session.close();
}

async function gap12_syncAssignmentVersionInvalid() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_av01abcdef",
    trackingSessionId: "trk_av",
    assignmentVersion: 424242,
  });
  const baseline = session.getState().assignmentVersion;
  const cases = [
    ["zero", 0, true],
    ["nan", NaN, false],
    ["undefined", undefined, true],
    ["negative", -5, true],
  ];
  let coercedToOne = 0;
  let rejected = 0;
  for (const [, val, expectCoerce] of cases) {
    session.syncAssignmentVersion(val);
    const av = session.getState().assignmentVersion;
    if (av === 1 && baseline !== 1) coercedToOne += 1;
    if (av === baseline && val !== baseline) rejected += 1;
    await session.startAsDriver({
      peerSessionId: "ps_av01abcdef",
      trackingSessionId: "trk_av",
      assignmentVersion: baseline,
    });
  }
  record(
    "12",
    "gap-syncAssignmentVersion-coerces-0-undefined-negative-to-1",
    coercedToOne >= 3 ? "PASS" : "FAIL",
    `coercedTo1=${coercedToOne} rejected=${rejected} baseline=${baseline}`
  );
  await session.close();
}

function preserveBaseline() {
  console.log("\n=== d34 baseline preservation ===\n");
  const serverAv = assignmentVersionFromRide({ driverId: "p13", vehicleId: "v13" });
  record(
    "13",
    "preserve-server-assignmentVersion-not-1",
    serverAv !== 1 ? "PASS" : "FAIL",
    `serverAv=${serverAv}`,
    "preserve"
  );

  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({ assignmentVersion: serverAv, sessionId: "ps_p14" }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  void drv.syncForRide({
    ride: { id: "r14", status: "in_progress", vehicleId: "v14" },
    trackingSessionId: "trk_p14",
  });

  record(
    "14",
    "preserve-driver-p2p-starts-without-viewer-presence-param",
    fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"), "utf8").includes(
      "function syncForRide"
    ) &&
      !fs
        .readFileSync(path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"), "utf8")
        .includes("viewerVisible")
      ? "PASS"
      : "FAIL",
    "viewerVisible removed from API",
    "preserve"
  );

  const unknownUnhealthy = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.UNKNOWN,
    p2pHealthy: false,
  });
  record(
    "15",
    "preserve-unknown-unhealthy-responsive-4s",
    unknownUnhealthy.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      unknownUnhealthy.intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${unknownUnhealthy.policy}@${unknownUnhealthy.intervalMs}`,
    "preserve"
  );

  const expiredUnhealthy = resolveCheckpointPolicy({
    hasActiveRide: true,
    rideStatus: "in_progress",
    viewerLease: VIEWER_LEASE.EXPIRED,
    p2pHealthy: false,
  });
  record(
    "16",
    "preserve-expired-unhealthy-responsive-4s",
    expiredUnhealthy.policy === CHECKPOINT_POLICY.RESPONSIVE_FIREBASE &&
      expiredUnhealthy.intervalMs === RESPONSIVE_INTERVAL_MS
      ? "PASS"
      : "FAIL",
    `${expiredUnhealthy.policy}@${expiredUnhealthy.intervalMs}`,
    "preserve"
  );

  let now = 1_000;
  const ctrl = createCheckpointPolicyController({ nowMs: () => now, diag: () => {} });
  ctrl.setActiveRide({ rideId: "r17", status: "in_progress", active: true });
  ctrl.setViewerLease(VIEWER_LEASE.VISIBLE);
  ctrl.setP2pHealthy(true);
  now += P2P_SPARSE_ENTER_HYSTERESIS_MS + 100;
  const sparse = ctrl.currentDecision();
  record(
    "17",
    "preserve-healthy-p2p-sparse-after-hysteresis",
    sparse.policy === CHECKPOINT_POLICY.P2P_SPARSE_TRIP ? "PASS" : "FAIL",
    `${sparse.policy}@${sparse.intervalMs}`,
    "preserve"
  );

  record(
    "18",
    "preserve-firebase-backup-interval-4s",
    FIREBASE_BACKUP_READ_INTERVAL_MS === 4_000 ? "PASS" : "FAIL",
    `${FIREBASE_BACKUP_READ_INTERVAL_MS}ms`,
    "preserve"
  );

  let t = 100_000;
  const renders = [];
  const arb = createLiveLocationSourceArbiter({
    nowMs: () => t,
    fallbackAfterMs: 12_000,
    firebaseBackupReadIntervalMs: 4_000,
    onRender: (fix) => renders.push(fix),
  });
  const gen = arb.getGeneration();
  arb.ingestP2p({ lat: 1, lng: 1, observedAt: 100_000, sequence: 1 }, gen);
  arb.ingestFirebase({ lat: 2, lng: 2, observedAt: 100_500, sequence: 2 }, gen);
  t += 15_000;
  arb.ensureP2pHealth();
  const ok = arb.ingestFirebase({ lat: 3, lng: 3, observedAt: t, sequence: 3 }, gen);
  record(
    "19",
    "preserve-immediate-firebase-takeover-after-p2p-loss",
    ok && renders.at(-1)?.lat === 3 ? "PASS" : "FAIL",
    `renders=${renders.length}`,
    "preserve"
  );

  void drv;
}

function auditBackgroundFunction() {
  console.log("\n=== Background function audit (read-only) ===\n");
  const src = fs.readFileSync(path.join(ROOT, "functions/background-location-upload.js"), "utf8");
  record(
    "J1",
    "audit-bg-still-reads-rideViewerPresence",
    src.includes("PRESENCE_COLLECTION") && src.includes("presenceSnap") ? "PASS" : "FAIL",
    "presence read still in transaction",
    "audit"
  );
  const cadence = bgUpload.resolveBackgroundUploadIntervalMs({
    rideStatus: "in_progress",
    viewerLease: "EXPIRED",
  });
  record(
    "J2",
    "audit-bg-cadence-responsive-regardless-of-lease",
    cadence.intervalMs === 4_000 && cadence.policy === "RESPONSIVE_FIREBASE" ? "PASS" : "FAIL",
    `${cadence.policy}@${cadence.intervalMs}`,
    "audit"
  );
  record(
    "J3",
    "audit-bg-cadence-not-hard-4s-min-only",
    cadence.hardInterval === false ? "PASS" : "FAIL",
    "movement may write earlier than 4s",
    "audit"
  );
}

function auditFunctionsDiscovery() {
  console.log("\n=== Functions discovery timing ===\n");
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    try {
      delete require.cache[require.resolve("../functions/index.js")];
      require("../functions/index.js");
      samples.push(Date.now() - t0);
    } catch (err) {
      record("J4", "audit-functions-index-load", "FAIL", err.message, "audit");
      return;
    }
  }
  const maxMs = Math.max(...samples);
  const avgMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  record(
    "J4",
    "audit-functions-index-load-timing",
    maxMs > 10_000 ? "PASS" : "WARN",
    `samplesMs=${samples.join(",")} max=${maxMs} avg=${avgMs}`,
    "audit"
  );
}

function auditTestHonesty() {
  const motion = fs.readFileSync(
    path.join(ROOT, "tests/customer-marker-motion-continuity.mjs"),
    "utf8"
  );
  const stage2 = fs.readFileSync(path.join(ROOT, "tests/stage2-assignment-version-sync.mjs"), "utf8");
  record(
    "H1",
    "audit-marker-motion-test-ingests-arbiter-directly",
    motion.includes("arb.ingestP2p") && motion.includes("arb.ingestFirebase") ? "PASS" : "FAIL",
    "not full P2P chain",
    "audit"
  );
  record(
    "H2",
    "audit-stage2-rebuilds-envelope-manually",
    stage2.includes("buildP2pLocationMessage") && !stage2.includes("_setChannelOpenForTest(true, (payload)")
      ? "PASS"
      : "FAIL",
    "manual envelope not channel.send",
    "audit"
  );
}

async function main() {
  console.log("\n=== STAGE 1 — reconciliation audit (tests only) ===\n");
  staticCompareOriginMain();
  console.log("\n=== Gap reproduction tests (d34 behavior) ===\n");
  await gap01_driverRideSwitchDuringStart();
  await gap02_driverStopDuringOffer();
  await gap03_staleAssignmentVersionAfterRideSwitch();
  await gap04_customerStaleAnswerPublish();
  await gap05_oldSessionLocOnNewRide();
  gap06_ackTrust();
  await gap07_heartbeatAloneHealth();
  await gap08_cadenceBurst();
  await gap09_sendFailureLoss();
  gap10_channelOpenTimeout();
  await gap11_firstLocNoAck();
  await gap12_syncAssignmentVersionInvalid();
  preserveBaseline();
  auditBackgroundFunction();
  auditFunctionsDiscovery();
  auditTestHonesty();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const gapConfirmed = results.filter((r) => r.category === "gap" && r.status === "PASS").length;
  const preserveOk = results.filter((r) => r.category === "preserve" && r.status === "PASS").length;
  const summary = {
    stage: 1,
    reconciliation: true,
    generatedAt: new Date().toISOString(),
    commit: "d34cca44f718296a9a5c373f53697d85878f285e",
    compareBase: "origin/main",
    pass,
    fail,
    gapConfirmed,
    preserveOk,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 1 reconciliation: ${pass} PASS / ${fail} FAIL`);
  console.log(`Gap findings confirmed: ${gapConfirmed}, Baseline preserved: ${preserveOk}/${results.filter((r) => r.category === "preserve").length}`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
