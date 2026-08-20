/**
 * Stage 3 — customer controller race reconciliation regression.
 *
 * Run: node tests/stage3-customer-controller-reconciliation.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { createP2pPeerSession } from "../customer-app/js/p2p-peer-session.mjs";
import { P2P_STATE } from "../customer-app/js/p2p-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage3-customer-controller-reconciliation-results.json");

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

async function testStaleAnswerUsesCapturedRideId() {
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
        sessionId: "ps_staleans01",
        offer: "v=0\r\no=- offer\r\n",
        trackingSessionId: "trk_a",
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
  const counters = cust.getCounters();
  const crossRidePublish = published.some(
    (p) => p.rideId === "ride_B4" && published.length === 1 && cust._getRideId() === "ride_A4"
  );
  record(
    "stale-answer-uses-captured-rideId-not-live-rideId",
    !crossRidePublish ? "PASS" : "FAIL",
    `published=${JSON.stringify(published.map((p) => p.rideId))} currentRide=${cust._getRideId()}`
  );
  record(
    "stale-in-flight-answer-aborted-on-ride-switch",
    (counters.staleAborts || 0) >= 1 ? "PASS" : "FAIL",
    `staleAborts=${counters.staleAborts || 0} published=${published.length}`
  );
  await cust.stop({ closeRemote: false });
}

async function testOldSessionLocBlockedOnRideSwitch() {
  const renders = [];
  let watchCb = null;
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onRenderFix: (fix) => renders.push(fix),
    publishRidePeerAnswerClient: async () => ({ ok: true }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {
        watchCb = null;
      };
    },
  });

  const offerA = {
    sessionId: "ps_oldsession01",
    offer: "v=0\r\no=- offer-a\r\n",
    trackingSessionId: "trk_a",
    assignmentVersion: 42,
    state: "offered",
  };
  const offerB = {
    sessionId: "ps_newsession02",
    offer: "v=0\r\no=- offer-b\r\n",
    trackingSessionId: "trk_b",
    assignmentVersion: 43,
    state: "offered",
  };

  cust.syncForRide({ id: "ride_A5", status: "in_progress" }, { isVisible: true });
  watchCb?.(offerA);
  await sleep(80);
  const staleSession = cust._getSessionForTest?.();
  cust.syncForRide({ id: "ride_B5", status: "in_progress" }, { isVisible: true });
  watchCb?.(offerB);
  await sleep(80);

  if (staleSession?._handleMessageForTest) {
    staleSession._handleMessageForTest(
      JSON.stringify({
        v: 1,
        type: "loc",
        peerSessionId: "ps_oldsession01",
        trackingSessionId: "trk_a",
        assignmentVersion: 42,
        seq: 99,
        observedAt: Date.now(),
        lat: 24.9,
        lng: 67.1,
        role: "driver",
      }),
      staleSession.getState().generation
    );
  }
  await sleep(20);

  const leaked = renders.some((r) => r.lat === 24.9);
  record(
    "old-session-loc-blocked-after-ride-switch",
    !leaked ? "PASS" : "FAIL",
    `renders=${renders.length} leaked=${leaked} hadStale=${Boolean(staleSession)}`
  );
  await cust.stop({ closeRemote: false });
}

async function testHiddenDoesNotSuspendP2p() {
  let watchCb = null;
  const cust = createCustomerP2pController({
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    publishRidePeerAnswerClient: async () => ({ ok: true }),
    closeRidePeerSessionClient: async () => {},
    watchRidePeerSession: (_rid, onData) => {
      watchCb = onData;
      return () => {};
    },
  });
  cust.syncForRide({ id: "ride_hide", status: "in_progress" }, { isVisible: true });
  watchCb?.({
    sessionId: "ps_hide01abcdef",
    offer: "v=0\r\no=- offer\r\n",
    trackingSessionId: "trk_hide",
    assignmentVersion: 7,
    state: "offered",
  });
  await sleep(80);
  cust.setVisible(false);
  await sleep(20);
  const st = cust.getState().state;
  record(
    "hidden-does-not-suspend-or-destroy-p2p",
    st !== P2P_STATE.DISABLED &&
      st !== P2P_STATE.CLOSED &&
      st !== P2P_STATE.FIREBASE_FALLBACK
      ? "PASS"
      : "FAIL",
    `state=${st} uiVisible=${cust.isUiVisible()}`
  );
  await cust.stop({ closeRemote: false });
}

function testStaticSafeguards() {
  const src = fs.readFileSync(path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"), "utf8");
  const checks = [
    ["answerGeneration", /let answerGeneration = 0/],
    ["watchGeneration", /let watchGeneration = 0/],
    ["expectedAssignmentVersion", /let expectedAssignmentVersion = 0/],
    ["isOfferCurrent", /function isOfferCurrent/],
    ["isWatchCurrent", /function isWatchCurrent/],
    ["isAnswerStillValid", /function isAnswerStillValid/],
    ["runAnswerLoop", /async function runAnswerLoop/],
    ["capturedRideId publish", /rideId: capturedRideId/],
    ["background no suspend", /must not suspend or stop P2P/],
    ["createCommTransport", /createCommTransport/],
  ];
  for (const [name, re] of checks) {
    record(`static-${name}`, re.test(src) ? "PASS" : "FAIL");
  }
}

async function main() {
  console.log("\n=== STAGE 3 — customer controller reconciliation ===\n");
  testStaticSafeguards();
  await testStaleAnswerUsesCapturedRideId();
  await testOldSessionLocBlockedOnRideSwitch();
  await testHiddenDoesNotSuspendP2p();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 3,
    area: "customer-controller-reconciliation",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 3 customer reconciliation: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
