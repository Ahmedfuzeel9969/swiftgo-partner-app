/**
 * Stage 2 — driver controller race reconciliation regression.
 *
 * Run: node tests/stage2-driver-controller-reconciliation.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage2-driver-controller-reconciliation-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
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

async function testRideBNotLostDuringRideAOffer() {
  let releaseOffer;
  const gate = new Promise((r) => {
    releaseOffer = r;
  });
  const offers = [];
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async (payload) => {
      offers.push(payload.rideId);
      await gate;
      return { assignmentVersion: 424242, sessionId: "ps_s2_01" };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });

  void drv.start({ rideId: "ride_A", trackingSessionId: "trk_A", vehicleId: "v1" });
  await sleep(50);
  drv.syncForRide({
    ride: { id: "ride_B", status: "in_progress", vehicleId: "v1" },
    trackingSessionId: "trk_B",
  });
  releaseOffer({ assignmentVersion: 424242, sessionId: "ps_s2_01" });
  await sleep(120);
  const currentRide = drv._getRideId();
  const lastOffer = offers.at(-1);
  record(
    "rideB-not-lost-while-rideA-offer-in-flight",
    currentRide === "ride_B" && lastOffer === "ride_B" ? "PASS" : "FAIL",
    `currentRide=${currentRide} offers=${offers.join(",")}`
  );
  await drv.stop({ closeRemote: false });
}

async function testStopInvalidatesLateOffer() {
  let releaseOffer;
  const gate = new Promise((r) => {
    releaseOffer = r;
  });
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => {
      await gate;
      return { assignmentVersion: 999, sessionId: "ps_s2_02" };
    },
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  void drv.start({ rideId: "ride_stop", trackingSessionId: "trk_stop", vehicleId: "v" });
  await sleep(40);
  await drv.stop({ closeRemote: false });
  releaseOffer({ assignmentVersion: 999, sessionId: "ps_s2_02" });
  await sleep(80);
  record(
    "stop-invalidates-late-offer-callback",
    drv.getState().state === P2P_STATE.DISABLED && drv._getRideId() === "" ? "PASS" : "FAIL",
    `state=${drv.getState().state} rideId=${drv._getRideId()}`
  );
}

async function testStaleWatchCannotPoisonRideB() {
  const watchCallbacks = [];
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({
      assignmentVersion: 100,
      sessionId: "ps_s2_03",
    }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (rid, onData) => {
      watchCallbacks.push({ rid, onData });
      return () => {};
    },
  });
  await drv.start({ rideId: "ride_A3", trackingSessionId: "trk_A3", vehicleId: "v" });
  await sleep(60);
  await drv.start({ rideId: "ride_B3", trackingSessionId: "trk_B3", vehicleId: "v" });
  await sleep(80);
  const avBefore = drv.getState().assignmentVersion;
  const sidB = drv.getState().peerSessionId;
  watchCallbacks.find((w) => w.rid === "ride_A3")?.onData({
    sessionId: sidB,
    assignmentVersion: 777777,
    answer: "v=0\r\no=- stale\r\n",
    state: "answered",
  });
  await sleep(40);
  const avAfter = drv.getState().assignmentVersion;
  record(
    "stale-rideA-watch-cannot-poison-rideB-assignmentVersion",
    avAfter !== 777777 && avBefore === avAfter ? "PASS" : "FAIL",
    `avBefore=${avBefore} avAfter=${avAfter}`
  );
  await drv.stop({ closeRemote: false });
}

async function testAssignmentVersionSyncAfterOffer() {
  const drv = createDriverP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({
      assignmentVersion: 880088,
      sessionId: "ps_s2_04",
    }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: () => () => {},
  });
  await drv.start({ rideId: "ride_av", trackingSessionId: "trk_av", vehicleId: "v" });
  await sleep(80);
  const av = drv.getState().assignmentVersion;
  record(
    "server-assignmentVersion-synced-after-offer",
    av === 880088 ? "PASS" : "FAIL",
    `sessionAv=${av}`
  );
  await drv.stop({ closeRemote: false });
}

async function testHasRaceSafeguards() {
  const src = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"), "utf8");
  const checks = [
    ["assignmentKey", /function assignmentKey/],
    ["runStartLoop", /async function runStartLoop/],
    ["pendingTarget", /let pendingTarget/],
    ["isStartCurrent", /function isStartCurrent/],
    ["abortStaleAttempt", /function abortStaleAttempt/],
    ["invalidateInFlight", /function invalidateInFlight/],
    ["syncAssignmentVersion", /syncAssignmentVersion/],
    ["presence-independent syncForRide", /regardless of customer viewer presence/],
  ];
  for (const [name, re] of checks) {
    record(`static-${name}`, re.test(src) ? "PASS" : "FAIL");
  }
}

async function main() {
  console.log("\n=== STAGE 2 — driver controller reconciliation ===\n");
  await testHasRaceSafeguards();
  await testRideBNotLostDuringRideAOffer();
  await testStopInvalidatesLateOffer();
  await testStaleWatchCannotPoisonRideB();
  await testAssignmentVersionSyncAfterOffer();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 2,
    area: "driver-controller-reconciliation",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 2 driver reconciliation: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
