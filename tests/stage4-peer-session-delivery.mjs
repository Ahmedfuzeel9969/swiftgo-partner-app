/**
 * Stage 4 — peer session delivery guarantees regression.
 *
 * Run: node tests/stage4-peer-session-delivery.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { P2P_SEND_INTERVAL_MS, P2P_STATE } from "../driver-app/js/p2p-protocol.mjs";
import { buildP2pAckMessage } from "../customer-app/js/p2p-location-envelope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "stage4-peer-session-delivery-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
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

async function testAckTrust() {
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    onLocalDescription: async () => {},
  });
  await session.startAsDriver({
    peerSessionId: "ps_ack01abcdef",
    trackingSessionId: "trk_ack",
    assignmentVersion: 42,
  });
  session._setChannelOpenForTest(true);
  session.enqueueLocationFix({ lat: 1, lng: 1, observedAt: Date.now() });
  session._flushPendingForTest();
  const st = session.getState();
  const gen = st.generation;

  const mkAck = (seq) => {
    const built = buildP2pAckMessage({
      peerSessionId: st.peerSessionId,
      trackingSessionId: st.trackingSessionId,
      assignmentVersion: st.assignmentVersion,
      sequence: seq,
    });
    return JSON.parse(built.serialized);
  };

  session._handleMessageForTest(JSON.stringify({ ...mkAck(99), type: "ack", seq: 99 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(1), type: "ack", seq: 1 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(1), type: "ack", seq: 1 }), gen);
  session._handleMessageForTest(JSON.stringify({ ...mkAck(2), type: "ack", seq: 2 }), gen);

  const invalid = session.getCounters().invalidMessages;
  record(
    "ack-trust-rejects-future-duplicate-unsent",
    invalid >= 3 ? "PASS" : "FAIL",
    `invalidMessages=${invalid}`
  );
  record(
    "ack-trust-valid-seq1-establishes-loc-delivery",
    session.getState().isLocDeliveryHealthy ? "PASS" : "FAIL",
    `locHealthy=${session.getState().isLocDeliveryHealthy}`
  );
  await session.close();
}

async function testHeartbeatAloneNotLocHealthy() {
  let t = 1_000_000;
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => t,
  });
  await session.startAsDriver({
    peerSessionId: "ps_hb01abcdef",
    trackingSessionId: "trk_hb",
    assignmentVersion: 42,
  });
  session._setChannelOpenForTest(true);
  const st = session.getState();
  const hb = buildP2pAckMessage({
    peerSessionId: st.peerSessionId,
    trackingSessionId: st.trackingSessionId,
    assignmentVersion: st.assignmentVersion,
    sequence: 0,
  });
  const hbMsg = JSON.parse(hb.serialized);
  hbMsg.type = "hb";
  hbMsg.seq = 1;
  session._handleMessageForTest(JSON.stringify(hbMsg), st.generation);
  session.evaluateHealth();
  record(
    "heartbeat-alone-not-loc-delivery-healthy",
    !session.getState().isLocDeliveryHealthy && session.getState().isTransportAlive ? "PASS" : "FAIL",
    `locHealthy=${session.getState().isLocDeliveryHealthy} transport=${session.getState().isTransportAlive}`
  );
  await session.close();
}

async function testCadenceCoalescesBurst() {
  let t = 1_000_000;
  const sent = [];
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: MockRTCPeerConnection,
    ensureIceConfiguration: async () => {},
    nowMs: () => t,
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
      observedAt: t + i * 10,
    });
    t += 10;
  }
  await sleep(50);
  session._flushPendingForTest();
  await sleep(50);
  record(
    "cadence-coalesces-rapid-gps-burst",
    sent.length <= 2 && session.getCounters().fixesSent <= 2 ? "PASS" : "FAIL",
    `sent=${sent.length} fixesSent=${session.getCounters().fixesSent} intervalMs=${P2P_SEND_INTERVAL_MS}`
  );
  await session.close();
}

async function testSendFailureRetainsPending() {
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
  session._flushPendingForTest();
  record(
    "send-failure-retains-newest-pending-fix",
    session.getCounters().fixesSent === 1 && session.getCounters().sendFailures >= 1 ? "PASS" : "FAIL",
    `fixesSent=${session.getCounters().fixesSent} sendFailures=${session.getCounters().sendFailures}`
  );
  await session.close();
}

async function testSyncAssignmentVersionRejectsInvalid() {
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
  const rejects = [
    session.syncAssignmentVersion(0),
    session.syncAssignmentVersion(NaN),
    session.syncAssignmentVersion(undefined),
    session.syncAssignmentVersion(-5),
  ].every((ok) => ok === false);
  record(
    "syncAssignmentVersion-rejects-invalid-inputs",
    rejects && session.getState().assignmentVersion === baseline ? "PASS" : "FAIL",
    `baseline=${baseline} after=${session.getState().assignmentVersion}`
  );
  await session.close();
}

function testStaticDeliveryGuards() {
  const src = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  const checks = [
    ["sentSequences", /const sentSequences = new Set\(\)/],
    ["validateDriverAck", /function validateDriverAck/],
    ["scheduleCadenceFlush", /function scheduleCadenceFlush/],
    ["scheduleChannelOpenTimeout", /function scheduleChannelOpenTimeout/],
    ["isLocDeliveryHealthy", /isLocDeliveryHealthy:/],
    ["pendingLocGen", /let pendingLocGen = 0/],
  ];
  for (const [name, re] of checks) {
    record(`static-${name}`, re.test(src) ? "PASS" : "FAIL");
  }
}

async function main() {
  console.log("\n=== STAGE 4 — peer session delivery guarantees ===\n");
  testStaticDeliveryGuards();
  await testAckTrust();
  await testHeartbeatAloneNotLocHealthy();
  await testCadenceCoalescesBurst();
  await testSendFailureRetainsPending();
  await testSyncAssignmentVersionRejectsInvalid();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const summary = {
    stage: 4,
    area: "peer-session-delivery",
    generatedAt: new Date().toISOString(),
    pass,
    fail,
    results,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nStage 4 peer session delivery: ${pass} PASS / ${fail} FAIL`);
  console.log(`Wrote ${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
